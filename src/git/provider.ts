import { isAbsolute, resolve } from 'node:path';

import { effectiveExclusions, type ExclusionRule } from '../config/index.js';
import {
  RelationshipType,
  type CanonicalEntity,
  type CanonicalEvidence,
  type CanonicalRelationship,
} from '../domain/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { VERSION } from '../version.js';
import {
  RepositoryIdentityKind,
  RepositoryOperation,
  SkipReason,
  type BranchPage,
  type DiscoveredBranch,
  type DiscoveredRepository,
  type DiscoveredWorktree,
  type RepositoryDiscoveryRequest,
  type RepositoryDiscoveryResult,
  type RepositoryRemote,
  type RepositorySource,
  type SkippedPath,
} from '../providers/contracts/source-repository.js';
import {
  BaseProvider,
  Capability,
  CAPABILITY_VERSIONS,
  Emitter,
  ProviderKind,
  decodeCursor,
  encodeCursor,
  type CapabilityDeclaration,
  type PageRequest,
  type ProviderContext,
  type ProviderOperationContext,
} from '../providers/index.js';

import { walkForRepositories, type RepositoryCandidate } from './discovery.js';
import { listBranches, listWorktrees } from './refs.js';
import { RepositoryIdentitySource, maskRemote, normalizeRemote, repositoryIdentity } from './identity.js';
import { runGit } from './runner.js';

/**
 * The local Git source provider.
 *
 * The first real provider, and therefore the first test of whether the last two
 * Epics were worth building. It extends `BaseProvider` rather than writing a
 * lifecycle, emits through an `Emitter` rather than calling `createEntity`, and
 * pages through the SDK's cursor protocol — which means the interesting code in
 * this file is entirely about Git, which is the point.
 *
 * It also carries the property that matters most in this Epic: **nothing outside
 * `src/git/` names it**. The core asks the registry for `source.repository` and
 * is handed whichever provider offers it; `boundaries.test.ts` proves the core
 * cannot reach here even if someone tries.
 */

export const GIT_PROVIDER_ID = 'ferret.source.git';

/** The system these observations are about, for evidence and identity. */
export const GIT_SOURCE_SYSTEM = 'git';

export interface GitProviderOptions {
  /** Milliseconds any single Git invocation may take. Default 30s. */
  readonly gitTimeoutMs?: number;
  /** Exclusions on top of the configured ones, for a caller with its own policy. */
  readonly exclusions?: readonly ExclusionRule[];
}

export class GitSourceProvider extends BaseProvider implements RepositorySource {
  readonly id = GIT_PROVIDER_ID;
  readonly kind = ProviderKind.SOURCE;
  readonly description = 'Local Git repository discovery through the git executable';

  /**
   * What this provider offers.
   *
   * Both operations are named explicitly rather than left implicit. EPIC-018
   * will add worktree and branch operations to this same capability, and a
   * declaration that said "everything" would silently start claiming them
   * before they existed.
   *
   * The limits are honest rather than optimistic. A filesystem walk pages (by
   * re-walking to a known position — see `discoverRepositories`), cannot filter
   * server-side because there is no server, and has no rate limit. Incremental
   * discovery is not claimed: knowing which repositories appeared since a given
   * moment would need a watcher, which is EPIC-032's problem.
   */
  readonly capabilities: readonly CapabilityDeclaration[] = [
    {
      capability: Capability.SOURCE_REPOSITORY,
      version: CAPABILITY_VERSIONS[Capability.SOURCE_REPOSITORY],
      operations: [
        RepositoryOperation.DISCOVER,
        RepositoryOperation.DESCRIBE,
        RepositoryOperation.LIST_WORKTREES,
        RepositoryOperation.LIST_BRANCHES,
      ],
      systems: [GIT_SOURCE_SYSTEM],
      limits: {
        supportsPagination: true,
        supportsServerSideFilter: false,
        notes: 'Paging re-walks the tree to the last returned repository; a page is not a snapshot.',
      },
    },
  ];

  readonly #options: GitProviderOptions;
  #emitter: Emitter | undefined;
  #exclusions: readonly ExclusionRule[] = [];

  constructor(options: GitProviderOptions = {}) {
    super();
    this.#options = options;
  }

  protected override onInitialize(context: ProviderContext): void {
    this.#emitter = new Emitter({
      sourceSystem: GIT_SOURCE_SYSTEM,
      producer: GIT_PROVIDER_ID,
      // Governance §21: what produced this, at which version. Without it,
      // "re-read everything the old discovery emitted" is unanswerable.
      producerVersion: VERSION,
    });
    this.#exclusions = [...effectiveExclusions(context.config), ...(this.#options.exclusions ?? [])];
  }

  /** Reports whether Git is usable, without deciding whether that matters. */
  async checkDependencies(context: ProviderContext): Promise<readonly DependencyCheckResult[]> {
    const git = context.environment.git;
    return Promise.resolve([
      {
        name: 'git',
        status: git.available ? DependencyStatus.OK : DependencyStatus.UNAVAILABLE,
        required: true,
        detail: git.available
          ? `git ${git.version ?? 'installed'}`
          : 'The git executable was not found on PATH',
        ...(git.available
          ? {}
          : { remediation: 'Install Git and ensure it is on PATH, then run `ferret doctor`.' }),
      },
    ]);
  }

  /**
   * Finds repositories under the requested roots.
   *
   * Paging deserves a note, because it is a real trade-off rather than an
   * oversight. The cursor holds the last repository returned, and resuming
   * re-walks the tree to that position. The alternative — carrying the walk's
   * frontier in the cursor — is unbounded in size and stale the moment a
   * directory is created, and a cursor travels out to an AI client and comes
   * back minutes later.
   *
   * The consequence, stated in the declared limits rather than hidden: a page is
   * not a snapshot. A repository created between two pages may appear, and one
   * deleted may vanish. For discovery that is the honest behaviour; a caller
   * that needs a snapshot should take one walk with no limit.
   */
  async discoverRepositories(
    request: RepositoryDiscoveryRequest,
    context: ProviderOperationContext,
  ): Promise<RepositoryDiscoveryResult> {
    const roots = request.roots.map((root) => {
      if (!isAbsolute(root)) {
        throw new FerretError(ErrorCode.USAGE, 'A discovery root must be an absolute path', {
          details: { root },
          remediation: 'Resolve the path before requesting discovery.',
        });
      }
      return resolve(root);
    });
    if (roots.length === 0) {
      throw new FerretError(ErrorCode.USAGE, 'Discovery needs at least one root', {
        details: {},
        remediation: 'Pass the directories to search.',
      });
    }

    const resumeAfter =
      request.cursor === undefined ? undefined : this.#decodeDiscoveryCursor(request.cursor, roots);

    const walk = await walkForRepositories({
      roots,
      exclusions: this.#exclusions,
      signal: context.signal,
      ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.followSymlinks === undefined ? {} : { followSymlinks: request.followSymlinks }),
      ...(request.includeNested === undefined ? {} : { includeNested: request.includeNested }),
      ...(resumeAfter === undefined ? {} : { resumeAfter }),
    });

    const items: DiscoveredRepository[] = [];
    const skipped: SkippedPath[] = [...walk.skipped];

    for (const candidate of walk.candidates) {
      try {
        items.push(await this.#describe(candidate, context));
      } catch (error) {
        // A directory that looked like a repository and is not — or one Git
        // refuses to touch because it is owned by someone else — is a skip with
        // a reason, not the end of the walk. Governance §13.
        skipped.push({
          path: candidate.path,
          reason: SkipReason.NOT_A_REPOSITORY,
          detail: error instanceof FerretError ? error.message : 'Git could not read it',
        });
      }
    }

    const last = walk.lastPath;
    return {
      items,
      cursor:
        walk.truncated && last !== undefined
          ? encodeCursor(this.id, Capability.SOURCE_REPOSITORY, { after: last, roots })
          : undefined,
      skipped,
      directoriesVisited: walk.directoriesVisited,
    };
  }

  /** Describes one repository Ferret is pointed at directly. */
  async describeRepository(
    root: string,
    context: ProviderOperationContext,
  ): Promise<DiscoveredRepository> {
    if (!isAbsolute(root)) {
      throw new FerretError(ErrorCode.USAGE, 'A repository path must be absolute', {
        details: { root },
        remediation: 'Resolve the path before asking about it.',
      });
    }
    return this.#describe({ path: resolve(root), gitLink: false, bareCandidate: false }, context);
  }

  /**
   * Every checkout of a repository, primary first.
   *
   * Asked of the **common** Git directory, not of whichever worktree happened to
   * be discovered: a linked worktree and its primary share one repository, and
   * asking either of them must give the same answer or the graph disagrees with
   * itself depending on which directory a walk reached first.
   */
  async listWorktrees(
    repository: DiscoveredRepository,
    context: ProviderOperationContext,
  ): Promise<readonly DiscoveredWorktree[]> {
    return listWorktrees(this.#gitOptions(repository, context));
  }

  /**
   * Local branches, sorted by ref name so paging is stable.
   *
   * Offset paging rather than a ref-name cursor. Refs are read in one bounded
   * call and sorted by Git itself, so an offset is exactly the position in that
   * ordering — and unlike a name it stays meaningful when the branch it pointed
   * at is deleted between pages.
   */
  async listBranches(
    repository: DiscoveredRepository,
    request: PageRequest,
    context: ProviderOperationContext,
  ): Promise<BranchPage> {
    const offset =
      request.cursor === undefined
        ? 0
        : decodeCursor(this.id, Capability.SOURCE_REPOSITORY, request.cursor, (state) => {
            const value = (state as { offset?: unknown } | null)?.offset;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
              throw new Error('not a branch cursor');
            }
            return value;
          });

    const listing = await listBranches({
      ...this.#gitOptions(repository, context),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      offset,
    });

    return {
      items: listing.branches,
      cursor: listing.truncated
        ? encodeCursor(this.id, Capability.SOURCE_REPOSITORY, { offset: offset + listing.branches.length })
        : undefined,
      defaultRef: listing.defaultRef,
    };
  }

  /**
   * Emits a repository together with its checkouts and its branches.
   *
   * One method rather than three, because the *relationships* are the point.
   * A worktree entity that nobody connected to its repository, and a branch
   * entity that nobody connected to the worktree that has it checked out, are
   * three disconnected facts where Governance §9 asked for a graph.
   *
   * `worktree_checks_out_branch` is declared exclusive from the worktree
   * (EPIC-007): a checkout is on one branch at a time, and the reconciliation
   * that enforces it is the reason switching branches produces history rather
   * than a contradiction.
   */
  emitGraph(
    repository: DiscoveredRepository,
    parts: {
      worktrees?: readonly DiscoveredWorktree[];
      branches?: readonly DiscoveredBranch[];
      /**
       * When this observation was made.
       *
       * Explicit, and threaded through every relationship in the graph, because
       * `validFrom` is part of a relationship's identity (EPIC-007). Letting it
       * default per call would mint a different id for every edge in a single
       * emission, so a graph read in one pass would not even be internally
       * consistent — let alone idempotent.
       *
       * Git cannot say when a branch came to be contained by its repository, so
       * this is Ferret's observation time rather than a valid time it knows.
       * Governance §6: that distinction is recorded rather than smoothed over.
       */
      observedAt?: Date;
    } = {},
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
  } {
    const emitter = this.#requireEmitter();
    const observedAt = parts.observedAt ?? new Date();
    const { entity: repositoryEntity, evidence: repositoryEvidence } = this.emit(repository);

    const entities: CanonicalEntity[] = [repositoryEntity];
    const relationships: CanonicalRelationship[] = [];
    const evidence: CanonicalEvidence[] = [...repositoryEvidence];

    const branchByRef = new Map<string, CanonicalEntity>();

    for (const branch of parts.branches ?? []) {
      const entity = emitter.entity({
        kind: 'branch',
        // Scoped to the repository: `main` means nothing on its own, and two
        // repositories' `main` branches are different objects.
        source: { id: branch.ref, scope: repositoryEntity.id },
        attributes: {
          ref: branch.ref,
          shortName: branch.shortName,
          headCommit: branch.headCommit,
          isDefault: branch.isDefault,
        },
        unknownFields: branch.upstream === undefined ? {} : { upstream: branch.upstream },
      });
      entities.push(entity);
      branchByRef.set(branch.ref, entity);
      relationships.push(
        emitter.relationship(
          {
            fromId: repositoryEntity.id,
            type: RelationshipType.REPOSITORY_CONTAINS_BRANCH,
            toId: entity.id,
            fromKind: 'repository',
            toKind: 'branch',
          },
          observedAt,
        ),
      );
      evidence.push(emitter.about(entity, 'attributes.headCommit', branch.headCommit));
    }

    for (const worktree of parts.worktrees ?? []) {
      const entity = emitter.entity({
        kind: 'worktree',
        source: { id: normalizeSeparators(worktree.path), scope: repositoryEntity.id },
        attributes: {
          path: worktree.path,
          isDetached: worktree.detached,
          isPrimary: worktree.primary,
          isLocked: worktree.locked,
          ...(worktree.ref === undefined ? {} : { ref: worktree.ref }),
        },
        unknownFields: {
          ...(worktree.headCommit === undefined ? {} : { headCommit: worktree.headCommit }),
          ...(worktree.lockReason === undefined ? {} : { lockReason: worktree.lockReason }),
          ...(worktree.prunable ? { prunable: true } : {}),
          ...(worktree.prunableReason === undefined ? {} : { prunableReason: worktree.prunableReason }),
          bare: worktree.bare,
        },
      });
      entities.push(entity);
      relationships.push(
        emitter.relationship(
          {
            fromId: repositoryEntity.id,
            type: RelationshipType.REPOSITORY_CONTAINS_WORKTREE,
            toId: entity.id,
            fromKind: 'repository',
            toKind: 'worktree',
          },
          observedAt,
        ),
      );
      evidence.push(
        emitter.about(entity, 'attributes.path', worktree.path, {
          locator: { kind: 'path', detail: worktree.path },
        }),
      );

      // Only when the branch is one Ferret also emitted. A detached HEAD has no
      // branch, and a worktree on a ref outside `refs/heads/` is not on a branch
      // in the sense this relationship means — inventing an endpoint for either
      // would be manufacturing certainty (Governance §6).
      const branchEntity = worktree.ref === undefined ? undefined : branchByRef.get(worktree.ref);
      if (branchEntity !== undefined) {
        relationships.push(
          emitter.relationship(
            {
              fromId: entity.id,
              type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
              toId: branchEntity.id,
              fromKind: 'worktree',
              toKind: 'branch',
            },
            observedAt,
          ),
        );
      }
    }

    return { entities, relationships, evidence };
  }

  #gitOptions(
    repository: DiscoveredRepository,
    context: ProviderOperationContext,
  ): { cwd: string; signal: AbortSignal; logger: ProviderOperationContext['logger']; timeoutMs?: number } {
    return {
      cwd: repository.commonGitDir,
      signal: context.signal,
      logger: context.logger,
      ...(this.#options.gitTimeoutMs === undefined ? {} : { timeoutMs: this.#options.gitTimeoutMs }),
    };
  }

  /**
   * Turns a discovered repository into a canonical entity and its evidence.
   *
   * Everything here goes through the SDK's emitter, so the source system,
   * producer and producer version cannot be forgotten, and any credential
   * encountered on the way is redacted by EPIC-008 before it is stored.
   */
  emit(repository: DiscoveredRepository): { entity: CanonicalEntity; evidence: readonly CanonicalEvidence[] } {
    const emitter = this.#requireEmitter();
    const entity = emitter.entity({
      kind: 'repository',
      source: {
        id: repository.identityKey,
        ...(repository.originUrl === undefined ? {} : { url: repository.originUrl }),
      },
      attributes: {
        name: repositoryName(repository),
        isBare: repository.bare,
        ...(repository.originUrl === undefined ? {} : { remoteUrl: repository.originUrl }),
      },
      unknownFields: {
        // Where this checkout happens to live is a fact about *this machine*,
        // not about the repository, so it is deliberately not a canonical
        // attribute — two machines sharing one Ferret database would otherwise
        // overwrite each other's copy of the same row for ever.
        //
        // EPIC-006 does model `attributes.path`, and the reason not to use it
        // here is Governance §9: a checkout is a **worktree**, which is its own
        // entity, and EPIC-018 is the Epic that creates it. Carrying the paths
        // verbatim keeps them available for that without pretending they belong
        // to the repository.
        localRoot: repository.root,
        gitDir: repository.gitDir,
        commonGitDir: repository.commonGitDir,
        linkedWorktree: repository.linkedWorktree,
        identityKind: repository.identityKind,
      },
    });

    const evidence: CanonicalEvidence[] = [
      emitter.about(entity, 'attributes.name', repositoryName(repository), {
        locator: { kind: 'path', detail: repository.root },
      }),
    ];
    if (repository.originUrl !== undefined) {
      evidence.push(
        emitter.about(entity, 'attributes.remoteUrl', repository.originUrl, {
          locator: { kind: 'path', detail: `${repository.commonGitDir}/config` },
        }),
      );
    }

    return { entity, evidence };
  }

  async #describe(
    candidate: RepositoryCandidate,
    context: ProviderOperationContext,
  ): Promise<DiscoveredRepository> {
    // One invocation for the four facts that define a checkout. `rev-parse` is
    // plumbing: its output is stable across Git versions and locales, which
    // matters because Ferret parses it.
    //
    // `--show-toplevel` is last, and deliberately so. A **bare** repository has
    // no work tree, so Git answers the first three, prints
    // "this operation must be run in a work tree", and exits 128. Asking
    // separately would cost a third process for every ordinary repository to
    // accommodate the rare one; accepting the partial answer costs nothing and
    // is unambiguous, because `--is-bare-repository` has already said `true` by
    // the time the failure happens.
    //
    // The first version of this had no `allowFailure`, and so found no bare
    // repository at all — which is every mirror on a Git server. Caught by the
    // integration test, which is why the bare fixture exists.
    const revParse = await runGit(
      [
        'rev-parse',
        '--absolute-git-dir',
        '--path-format=absolute',
        '--git-common-dir',
        '--is-bare-repository',
        '--show-toplevel',
      ],
      {
        cwd: candidate.path,
        signal: context.signal,
        logger: context.logger,
        allowFailure: true,
        ...(this.#options.gitTimeoutMs === undefined ? {} : { timeoutMs: this.#options.gitTimeoutMs }),
      },
    );

    const lines = revParse.stdout.trim().split('\n').map((line) => line.trim());
    const gitDir = lines[0];
    const commonGitDir = lines[1];
    const bare = lines[2] === 'true';
    const topLevel = lines[3];

    const answered = gitDir !== undefined && gitDir.length > 0 && commonGitDir !== undefined;
    // A non-zero exit is only acceptable for the one reason above: a bare
    // repository that answered everything it could. Anything else is a
    // directory that is not a repository, and saying so is the honest result.
    if (!answered || (revParse.exitCode !== 0 && !bare)) {
      throw new FerretError(ErrorCode.PROVIDER_INVALID, 'Git did not report a repository directory', {
        details: { path: candidate.path, exitCode: revParse.exitCode },
        remediation: 'The directory is not a Git repository, or Git refused to read it.',
      });
    }

    const root = bare || topLevel === undefined || topLevel.length === 0 ? candidate.path : topLevel;

    const remotes = await this.#readRemotes(candidate.path, context);
    const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    const identity = repositoryIdentity(origin?.url, commonGitDir);

    return {
      identityKey: identity.key,
      identityKind:
        identity.source === RepositoryIdentitySource.REMOTE
          ? RepositoryIdentityKind.REMOTE
          : RepositoryIdentityKind.PATH,
      root,
      gitDir,
      commonGitDir,
      bare,
      // A linked worktree keeps its own `.git` directory and shares the common
      // one. Governance §9 needs the two kept apart: a branch is not a worktree.
      linkedWorktree: normalizeSeparators(gitDir) !== normalizeSeparators(commonGitDir),
      remotes,
      originUrl: origin?.url,
    };
  }

  /**
   * Reads the configured remotes.
   *
   * `config --get-regexp` rather than `remote -v`, because the former is
   * plumbing-stable and the latter's output has changed shape between Git
   * versions. Reading configuration cannot execute anything by itself; the keys
   * that *can* are overridden on every invocation by the runner.
   */
  async #readRemotes(
    cwd: string,
    context: ProviderOperationContext,
  ): Promise<readonly RepositoryRemote[]> {
    const result = await runGit(['config', '--get-regexp', '^remote\\..*\\.url$'], {
      cwd,
      signal: context.signal,
      logger: context.logger,
      // Exit 1 means "no matching key", which is a repository with no remote —
      // a fact, not a failure.
      allowFailure: true,
      ...(this.#options.gitTimeoutMs === undefined ? {} : { timeoutMs: this.#options.gitTimeoutMs }),
    });
    if (result.exitCode !== 0) return [];

    const remotes: RepositoryRemote[] = [];
    for (const line of result.stdout.split('\n')) {
      const separator = line.indexOf(' ');
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      const rawUrl = line.slice(separator + 1).trim();
      const name = /^remote\.(.+)\.url$/.exec(key)?.[1];
      if (name === undefined || rawUrl.length === 0) continue;

      const normalized = normalizeRemote(rawUrl);
      remotes.push({
        name,
        // Masked, always. A URL read from a repository's configuration carries
        // a personal access token far more often than anyone expects, and this
        // value is stored, logged and shown.
        url: normalized?.display ?? maskRemote(rawUrl),
        canonical: normalized?.canonical,
      });
    }
    // `origin` first, then by name, so identity does not depend on config order.
    remotes.sort((a, b) => {
      if (a.name === 'origin') return -1;
      if (b.name === 'origin') return 1;
      return a.name.localeCompare(b.name);
    });
    return remotes;
  }

  #decodeDiscoveryCursor(cursor: string, roots: readonly string[]): string {
    return decodeCursor(this.id, Capability.SOURCE_REPOSITORY, cursor, (state) => {
      if (typeof state !== 'object' || state === null) throw new Error('not a discovery cursor');
      const { after, roots: cursorRoots } = state as { after?: unknown; roots?: unknown };
      if (typeof after !== 'string' || !Array.isArray(cursorRoots)) {
        throw new Error('not a discovery cursor');
      }
      // A cursor from a different set of roots would resume a walk that never
      // happened, and would silently return the wrong repositories.
      if (cursorRoots.length !== roots.length || cursorRoots.some((root, index) => root !== roots[index])) {
        throw new FerretError(ErrorCode.CURSOR_INVALID, 'Cursor was issued for a different set of roots', {
          details: { providerId: this.id },
          remediation: 'Restart the discovery without a cursor, or request the original roots.',
        });
      }
      return after;
    });
  }

  #requireEmitter(): Emitter {
    if (this.#emitter === undefined) {
      throw new FerretError(ErrorCode.LIFECYCLE_INVALID_STATE, 'The Git provider was used before initialization', {
        details: { providerId: this.id },
        remediation: 'Await runtime.initialize() first.',
      });
    }
    return this.#emitter;
  }
}

/**
 * A repository's human name.
 *
 * From the remote when there is one, so two clones agree; from the directory
 * otherwise. Only ever a display name — identity is `identityKey`, and nothing
 * downstream should join on this.
 */
function repositoryName(repository: DiscoveredRepository): string {
  const fromKey = repository.identityKey.split('/').filter((part) => part.length > 0).pop();
  return fromKey ?? repository.root;
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Convenience constructor matching the style of the other subsystems. */
export function createGitSourceProvider(options: GitProviderOptions = {}): GitSourceProvider {
  return new GitSourceProvider(options);
}
