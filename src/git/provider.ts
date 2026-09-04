import { isAbsolute, resolve } from 'node:path';

import { effectiveExclusions, type ExclusionRule } from '../config/index.js';
import {
  RelationshipType,
  type CanonicalEntity,
  type CanonicalEvidence,
  type CanonicalRelationship,
} from '../domain/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import { ActorClass } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  LinkRule,
  RULE_CONFIDENCE,
  applyMailmap,
  classifyIdentity,
  normalizeGitIdentity,
  type Mailmap,
} from '../identity/index.js';
import { fileAttributesFrom, fileVersionAttributesFrom, type FileStructure } from '../files/index.js';
import type { FileReferenceResolution } from '../code/index.js';
import { isSecretPath, redactSecrets } from '../security/index.js';
import { VERSION } from '../version.js';
import {
  ContentUnavailable,
  RepositoryIdentityKind,
  RepositoryOperation,
  SkipReason,
  type BranchPage,
  type DiscoveredBranch,
  type DiscoveredRepository,
  type DiscoveredWorktree,
  type FileContent,
  type FileContentRequest,
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
import {
  BlobUnavailable,
  TreeEntryKind,
  extensionOf,
  gitContentHash,
  listFiles,
  readBlob,
  type TreeEntry,
} from './files.js';
import { ChangeKind, knownCommits, readHistory, resolveCommit, type CommitRecord } from './history.js';
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

/**
 * Git's reasons for not producing a blob, in the contract's vocabulary.
 *
 * Exhaustive by type: adding a `BlobUnavailable` value without deciding what a
 * caller should be told about it is a compile error rather than a silent
 * `undefined` in a report.
 */
const CONTENT_REASON: Readonly<Record<BlobUnavailable, ContentUnavailable>> = Object.freeze({
  [BlobUnavailable.TOO_LARGE]: ContentUnavailable.TOO_LARGE,
  [BlobUnavailable.NOT_FOUND]: ContentUnavailable.NOT_FOUND,
  [BlobUnavailable.UNREADABLE]: ContentUnavailable.UNREADABLE,
});

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
        RepositoryOperation.READ_HISTORY,
        RepositoryOperation.LIST_FILES,
        // EPIC-108. Named explicitly, like the six before it: this provider
        // declares what it implements rather than claiming the capability
        // wholesale, so the next operation added does not arrive already
        // claimed.
        RepositoryOperation.READ_CONTENT,
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
          // A ref name can carry a token — `fix/ghp_...` is a legal branch name.
          ref: redactSecrets(branch.ref).text,
          shortName: redactSecrets(branch.shortName).text,
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

  /**
   * Reads a page of commit history.
   *
   * Paged by offset. `git log --skip` walks the history to reach the offset, so
   * this is O(offset) on a deep repository — acceptable for the first pages and
   * wrong for the ten-thousandth. A caller reading a whole history follows
   * `cursor` until it is absent; a caller resuming passes `exclude`, which
   * makes the walk proportional to what is new rather than to what exists.
   *
   * `tip` is the commit `revision` names *now*. It is the position a later
   * incremental read excludes, and it is reported whether or not this page was
   * the first: a caller that read nothing new still needs to know where the
   * ref stands.
   */
  async readHistory(
    repository: DiscoveredRepository,
    request: {
      revision?: string;
      limit?: number;
      skip?: number;
      cursor?: string;
      since?: string;
      exclude?: readonly string[];
      withChanges?: boolean;
    },
    context: ProviderOperationContext,
  ): Promise<{
    commits: readonly CommitRecord[];
    cursor: string | undefined;
    tip: string | undefined;
    incomplete: { readonly reason: string } | undefined;
  }> {
    const options = this.#gitOptions(repository, context);
    const skip = request.cursor === undefined ? (request.skip ?? 0) : this.#decodeHistoryCursor(request.cursor);
    // Dropped rather than passed through: an id this repository no longer holds
    // makes `git log` fail, and a failed read here is indistinguishable from an
    // empty one. Reading more than necessary is the safe direction.
    const exclude =
      request.exclude === undefined || request.exclude.length === 0
        ? []
        : await knownCommits(options, request.exclude);

    const page = await readHistory({
      ...options,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(exclude.length === 0 ? {} : { exclude }),
      ...(request.withChanges === undefined ? {} : { withChanges: request.withChanges }),
      skip,
    });

    const tip = await resolveCommit({
      ...options,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    });

    return {
      commits: page.commits,
      cursor: page.truncated
        ? encodeCursor(this.id, Capability.SOURCE_REPOSITORY, { skip: skip + page.commits.length })
        : undefined,
      // Not reported when the read was cut short by a failure. A tip is the
      // position a later run excludes, and recording one for history that was
      // never read would turn a recoverable gap into a permanent one.
      ...(page.incomplete === undefined ? { tip } : { tip: undefined }),
      incomplete: page.incomplete,
    };
  }

  #decodeHistoryCursor(cursor: string): number {
    return decodeCursor(this.id, Capability.SOURCE_REPOSITORY, cursor, (state) => {
      if (typeof state !== 'object' || state === null) throw new Error('not a history cursor');
      const { skip } = state as { skip?: unknown };
      if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0) {
        throw new Error('not a history cursor');
      }
      return skip;
    });
  }

  /**
   * Turns commits into the graph they imply.
   *
   * **Commit identity is the object id, and nothing else.** A Git commit hash is
   * a content hash of the commit object: the same commit in a fork and in its
   * upstream is the same commit, byte for byte. Scoping it to a repository would
   * make "which release contains the fix for FER-12" unanswerable across a fork,
   * which is one of the questions Ferret exists to answer.
   *
   * Which repositories *hold* a commit is recorded as
   * `repository_contains_commit`, which is exactly what that relationship type
   * is for.
   *
   * **Developer identity is the email address, lowercased** — for now. One
   * person commits as several addresses, and EPIC-036 resolves them; EPIC-006
   * models `emails` as a list precisely so that resolution has somewhere to put
   * the answer. Collapsing to one address here would destroy the evidence that
   * resolution depends on.
   *
   * **File identity is the repository and the path.** A rename therefore
   * produces a *different* file entity, and the continuity between them is the
   * rename relationship rather than a shared id — Ferret records what Git
   * recorded, and Git records a rename as a similarity score rather than an
   * identity claim.
   */
  emitHistory(
    repository: DiscoveredRepository,
    commits: readonly CommitRecord[],
    options: {
      observedAt?: Date;
      /**
       * The repository's `.mailmap`, when the caller has read one.
       *
       * Optional because nothing here opens a file — the provider is handed
       * commit records, not a working tree. A caller that has the checkout
       * passes it and gets the project's own identity mapping applied
       * (EPIC-036); one that does not gets the raw identities, as before.
       */
      mailmap?: Mailmap;
    } = {},
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
    /**
     * Entities emitted only so an edge has an endpoint — see `add` below.
     *
     * Reported rather than kept private because the invariant the placeholder
     * set enforces ("never displaces a record read from the source") is only
     * enforceable inside one batch. Across runs the store holds the richer
     * record and the emitter cannot see it, so the emitter states which of its
     * entities are placeholders and the writer declines to regress them.
     */
    placeholderEntityIds: readonly string[];
    /**
     * Commits this page could not represent, and why.
     *
     * Never silently empty: a history read that returns fewer commits than it
     * was given is indistinguishable from a smaller repository.
     */
    skippedRecords: readonly { readonly id: string; readonly reason: string }[];
  } {
    const emitter = this.#requireEmitter();
    const observedAt = options.observedAt ?? new Date();
    const repositoryEntity = this.emit(repository).entity;

    const entities = new Map<string, CanonicalEntity>();
    const placeholders = new Set<string>();
    const relationships = new Map<string, CanonicalRelationship>();
    const evidence: CanonicalEvidence[] = [];
    /** Records an observation, and how to take it back. */
    const observe = (...rows: readonly CanonicalEvidence[]): void => {
      const mark = evidence.length;
      undo.push(() => evidence.splice(mark));
      evidence.push(...rows);
    };

    // `placeholder` marks a record emitted only so that an edge has an
    // endpoint — a parent commit Ferret has not read yet. It fills a gap and
    // never displaces a record read from the source, and it is displaced by one
    // the moment the loop reaches it.
    //
    // Without the distinction, `git log`'s newest-first order guarantees that
    // every commit which is a parent of a newer one is stored as its stub: the
    // right shape, and empty.
    // Every mutation records how to undo itself, so one commit that cannot be
    // represented costs that commit and not the page — EPIC-019 AC-9. Without
    // it a single invalid field threw out of the middle of the loop and the
    // whole read produced nothing, which is the failure §13 describes as
    // "breaking what it knows" rather than reducing it.
    let undo: (() => void)[] = [];

    const add = (entity: CanonicalEntity, placeholder = false): CanonicalEntity => {
      const existing = entities.get(entity.id);
      if (existing !== undefined && (placeholder || !placeholders.has(entity.id))) return existing;
      const wasPlaceholder = placeholders.has(entity.id);
      undo.push(() => {
        if (existing === undefined) entities.delete(entity.id);
        else entities.set(entity.id, existing);
        if (wasPlaceholder) placeholders.add(entity.id);
        else placeholders.delete(entity.id);
      });
      entities.set(entity.id, entity);
      if (placeholder) placeholders.add(entity.id);
      else placeholders.delete(entity.id);
      return entity;
    };
    const link = (relationship: CanonicalRelationship): void => {
      const existing = relationships.get(relationship.id);
      undo.push(() => {
        if (existing === undefined) relationships.delete(relationship.id);
        else relationships.set(relationship.id, existing);
      });
      relationships.set(relationship.id, relationship);
    };

    add(repositoryEntity);

    /**
     * The actor behind a commit — a person, or a machine.
     *
     * EPIC-036: bots are not developers. `dependabot[bot]` recorded as a human
     * contributor makes "who has worked on this file" answer with a machine,
     * and EPIC-009 made the two identity classes distinct so that would not
     * happen. `.mailmap` is applied first where the caller supplied one,
     * because it is the project's own maintained answer.
     */
    /** Actors already given identity evidence on this page — one row each. */
    const actorEvidence = new Set<string>();

    /**
     * What Git said about an author Ferret will not identify — F-11.
     *
     * Refusing to mint an identity is not licence to lose the observation. The
     * commit keeps what the repository claimed, marked as unattributed, so "who
     * wrote this" answers *"Git said `Alice Ainsworth <unknown>`, which is not
     * an address"* rather than answering nothing — and a later `.mailmap` can
     * still repair it, because the raw strings are still there.
     *
     * A separate pure predicate rather than a second return channel from
     * `actorFor`, so that the commit entity — built before the author is
     * resolved — can carry the attribute without reordering the emission.
     */
    const unattributedAuthorFor = (
      name: string,
      email: string,
    ): { name: string; email: string; reason: string } | undefined => {
      const raw = normalizeGitIdentity(name, email);
      const identity =
        raw === undefined || options.mailmap === undefined ? raw : applyMailmap(options.mailmap, raw);
      if (identity !== undefined && identity.addressed) return undefined;
      return {
        name: name.trim(),
        email: email.trim(),
        reason: raw === undefined ? 'the commit records no author address' : 'the author address is not an address',
      };
    };

    const actorFor = (
      name: string,
      email: string,
    ): { entity: CanonicalEntity; actorClass: ActorClass } | undefined => {
      const raw = normalizeGitIdentity(name, email);
      // No address means no identity. Inventing one from a display name would
      // merge every "unknown" author in the repository into one person.
      if (raw === undefined) return undefined;
      const identity = options.mailmap === undefined ? raw : applyMailmap(options.mailmap, raw);

      // F-11. The comment above stated this guarantee and the code delivered it
      // for the empty string alone: `unknown`, `(no author)`, `root` and every
      // other non-address were kept as opaque identities whose `comparable` is
      // the raw string, so the entity id derived from it and two people became
      // one. Measured on a three-commit fixture: Alice and Bob, both authored
      // `unknown`, emitted **one** developer — and which display name survived
      // depended on the order Git returned the commits.
      //
      // After the mailmap, not before: a `.mailmap` exists to give imported
      // history real addresses, and refusing first would disable it on exactly
      // the repositories that need it. The caller records what Git said.
      if (!identity.addressed) return undefined;

      const { actorClass, reason } = classifyIdentity(identity);

      const display = identity.name.length === 0 ? identity.comparable : identity.name;
      const entity =
        actorClass === ActorClass.AGENT
          ? emitter.entity({
              kind: 'agent',
              source: { id: identity.comparable },
              attributes: {
                name: display,
                agentType: 'bot',
                // Why this is a machine, so the classification is answerable
                // without re-deriving it.
                description: reason,
              },
            })
          : emitter.entity({
              kind: 'developer',
              source: { id: identity.comparable },
              attributes: {
                // `emails` is a *list* because one person commits as several
                // addresses; collapsing it would destroy the evidence
                // resolution depends on. The address as written is kept
                // alongside the comparable form when they differ.
                name: display,
                emails: [...new Set([identity.comparable, identity.email.toLowerCase()])],
                ...(identity.login === undefined ? {} : { usernames: [identity.login] }),
              },
            });
      const actor = add(entity);

      // DEFECT (#71), the third kind. A `developer` entity carried no evidence
      // either: 0 of 1 on a full index of Ferret's own repository. The identity
      // that answers "who has worked on this file" rested on nothing, and
      // EPIC-036 resolution is built on exactly these addresses.
      //
      // Emitted once per actor rather than once per commit, guarded by the id —
      // a repository with a thousand commits by one person needs one row, and
      // the `observedAt` of any single commit would be arbitrary.
      //
      // `observed` only when Git's own answer is what was recorded. When a
      // `.mailmap` rewrote the address, the stored value is the project's
      // maintained answer applied to a different one Ferret read, so the method
      // is `parsed` — claiming otherwise would say Ferret saw an address it did
      // not.
      if (!actorEvidence.has(actor.id)) {
        actorEvidence.add(actor.id);
        const rewritten = identity.comparable !== raw.comparable;
        const emails = actor.attributes['emails'] ?? [identity.comparable];
        observe(
          rewritten
            ? emitter.parsed({
                subjectId: actor.id,
                field: 'attributes.emails',
                statement: emails,
                sourceId: raw.comparable,
                // EPIC-046. The first real confidence Ferret emits, and it comes
                // from the *rule* rather than from the method — which is §8.1's
                // whole point, since `parsed` already sets the authority rank.
                // The rule is `.mailmap`: the project's own maintained answer
                // about who an address belongs to, which `RULE_CONFIDENCE` has
                // rated `CERTAIN` since EPIC-009 and which is the one rule that
                // is almost never wrong.
                confidence: RULE_CONFIDENCE[LinkRule.MAILMAP],
              })
            : emitter.about(actor, 'attributes.emails', emails),
        );
      }

      return { entity: actor, actorClass };
    };

    const fileFor = (path: string): CanonicalEntity =>
      add(
        emitter.entity({
          kind: 'file',
          source: { id: path, scope: repositoryEntity.id },
          attributes: { path, ...(extensionOf(path) === undefined ? {} : { extension: extensionOf(path) }) },
        }),
      );

    /** The earliest instant each file was observed to exist, across this page. */
    const firstSeen = new Map<string, { at: Date; file: CanonicalEntity }>();

    const skippedRecords: { id: string; reason: string }[] = [];

    for (const commit of commits) {
      undo = [];
      try {
      const unattributed = unattributedAuthorFor(commit.authorName, commit.authorEmail);
      const commitEntity = add(
        emitter.entity({
          kind: 'commit',
          source: { id: commit.sha },
          attributes: {
            sha: commit.sha,
            message: redactSecrets(commit.body.length === 0 ? commit.subject : commit.subject + '\n\n' + commit.body).text,
            authoredAt: commit.authoredAt,
            committedAt: commit.committedAt,
            parents: [...commit.parents],
            ...(commit.tree === undefined ? {} : { tree: commit.tree }),
            // F-11. Present only when Ferret declined to identify the author,
            // so an ordinary commit's attributes are unchanged and a query for
            // unattributed history is a single predicate.
            ...(unattributed === undefined ? {} : { unattributedAuthor: unattributed }),
          },
          sourceObservedAt: commit.committedAt,
        }),
      );

      link(
        emitter.relationship(
          {
            fromId: repositoryEntity.id,
            type: RelationshipType.REPOSITORY_CONTAINS_COMMIT,
            toId: commitEntity.id,
            fromKind: 'repository',
            toKind: 'commit',
          },
          observedAt,
        ),
      );

      // A commit's valid time is a fact Git *does* know, unlike a branch's
      // containment: the commit came into being when it was committed.
      const committedAt = commit.committedAt === undefined ? undefined : new Date(commit.committedAt);
      const commitTime =
        committedAt === undefined || Number.isNaN(committedAt.getTime()) ? observedAt : committedAt;

      for (const parent of commit.parents) {
        const parentEntity = add(
          emitter.entity({ kind: 'commit', source: { id: parent }, attributes: { sha: parent } }),
          // A placeholder: this parent may be read properly later in the same
          // page, and when it is, the full record must win.
          true,
        );
        link(
          emitter.relationship(
            {
              fromId: commitEntity.id,
              type: RelationshipType.COMMIT_PARENT_OF_COMMIT,
              toId: parentEntity.id,
              fromKind: 'commit',
              toKind: 'commit',
            },
            commitTime,
          ),
        );
      }

      const author = actorFor(commit.authorName, commit.authorEmail);
      if (author !== undefined) {
        const human = author.actorClass === ActorClass.DEVELOPER;
        link(
          emitter.relationship(
            {
              fromId: author.entity.id,
              type: human
                ? RelationshipType.DEVELOPER_AUTHORED_COMMIT
                : RelationshipType.AGENT_AUTHORED_COMMIT,
              toId: commitEntity.id,
              fromKind: human ? 'developer' : 'agent',
              toKind: 'commit',
            },
            commitTime,
          ),
        );
        observe(
          emitter.about(commitEntity, 'attributes.authoredAt', commit.authoredAt, {
            observedAt: commit.authoredAt,
          }),
        );
      }

      for (const change of commit.changes) {
        // EPIC-082: history reaches files the tree listing never returns, so
        // the gate has to be here too. Without it a commit that touched `.env`
        // created the entity that `emitFiles` had just refused to.
        if (isSecretPath(change.path)) {
          continue;
        }

        const file = fileFor(change.path);

        // Containment starts when the file first appeared, not at whichever
        // commit happens to be processed first.
        //
        // `git log` returns newest-first, so emitting the edge here opened the
        // interval at the *newest* commit that touched the file and every older
        // assertion then found an open equivalent and did nothing. Measured on
        // Ferret's own repository: it claimed to have started containing
        // `README.md` at 14:28, the instant of its most recent edit, when the
        // file had been there since 09:33. Asking what a repository contained at
        // a past instant therefore returned nothing modified since — which is
        // the one question the temporal model exists to answer.
        //
        // A deletion establishes nothing, so it is not a candidate: a file seen
        // only as deleted opens no interval at all, and EPIC-032's tombstone
        // carries that case.
        if (change.kind !== ChangeKind.DELETED) {
          const earliest = firstSeen.get(file.id);
          if (earliest === undefined || commitTime < earliest.at) {
            const previousFirst = firstSeen.get(file.id);
            undo.push(() => {
              if (previousFirst === undefined) firstSeen.delete(file.id);
              else firstSeen.set(file.id, previousFirst);
            });
            firstSeen.set(file.id, { at: commitTime, file });
          }
        }

        link(
          emitter.relationship(
            {
              fromId: commitEntity.id,
              type: RelationshipType.COMMIT_MODIFIES_FILE,
              toId: file.id,
              fromKind: 'commit',
              toKind: 'file',
              metadata: {
                change: change.kind,
                ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
                ...(change.similarity === undefined ? {} : { similarity: change.similarity }),
              },
            },
            commitTime,
          ),
        );

        // A rename touches two paths, and the old one is a file Ferret may never
        // otherwise hear about — a file deleted in the same commit that created
        // its successor. Recording it keeps the history traversable backwards.
        if (change.previousPath !== undefined && change.kind === ChangeKind.RENAMED) {
          const previous = fileFor(change.previousPath);
          link(
            emitter.relationship(
              {
                fromId: commitEntity.id,
                type: RelationshipType.COMMIT_MODIFIES_FILE,
                toId: previous.id,
                fromKind: 'commit',
                toKind: 'file',
                metadata: { change: ChangeKind.DELETED, renamedTo: change.path },
              },
              commitTime,
            ),
          );
        }
      }
      } catch (error) {
        // This commit, and only this commit. Everything it had already emitted
        // is taken back, so the page never carries half of a record Ferret
        // could not finish — and the run is told which commit was lost and why,
        // because a silently shorter history is the failure EPIC-019 §12 exists
        // to prevent.
        for (const step of undo.reverse()) step();
        skippedRecords.push({
          id: commit.sha,
          reason: error instanceof Error ? error.message : 'the commit could not be represented',
        });
      }
    }

    // Emitted after the whole page, so each interval opens at the earliest
    // instant the page saw rather than the first one it happened to read.
    for (const { at, file } of firstSeen.values()) {
      // DEFECT (#71), the other half. A file reached only through history — one
      // that was deleted, or that lives outside the current tree — never passes
      // through the tree listing, so without this it would still have no
      // evidence. Those are precisely the files EPIC-032 tombstones, and a
      // tombstone nothing supports cannot be explained.
      //
      // Emitted from `firstSeen` rather than per change, which is what makes it
      // one row per file and gives it the *earliest* instant the path was
      // observed rather than whichever commit happened to be last.
      const path = file.attributes['path'];
      if (typeof path === 'string') {
        evidence.push(
          emitter.about(file, 'attributes.path', path, {
            observedAt: at.toISOString(),
            locator: { kind: 'path', detail: path },
          }),
        );
      }

      link(
        emitter.relationship(
          {
            fromId: repositoryEntity.id,
            type: RelationshipType.REPOSITORY_CONTAINS_FILE,
            toId: file.id,
            fromKind: 'repository',
            toKind: 'file',
          },
          at,
        ),
      );
    }

    return {
      entities: [...entities.values()],
      relationships: [...relationships.values()],
      evidence,
      // Whatever is still marked at the end of the loop was never reached as a
      // real commit, so it is a genuine gap-filler rather than one this batch
      // went on to describe properly.
      placeholderEntityIds: [...placeholders],
      skippedRecords,
    };
  }

  /**
   * Lists the files a repository holds at a revision.
   *
   * Answers for a *revision* rather than for a working directory, so it works on
   * a bare repository and on a commit nobody has checked out — which is most of
   * them.
   */
  async listFiles(
    repository: DiscoveredRepository,
    request: { revision?: string; limit?: number; offset?: number },
    context: ProviderOperationContext,
  ): Promise<{ entries: readonly TreeEntry[]; cursor: string | undefined }> {
    const offset = request.offset ?? 0;
    const listing = await listFiles({
      ...this.#gitOptions(repository, context),
      ...(request.revision === undefined ? {} : { revision: request.revision }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      offset,
    });

    return {
      entries: listing.entries,
      cursor: listing.truncated
        ? encodeCursor(this.id, Capability.SOURCE_REPOSITORY, { offset: offset + listing.entries.length })
        : undefined,
    };
  }

  /**
   * Reads one file's bytes at a revision — EPIC-108 §8.3.
   *
   * Against the object store, addressed by the object id `listFiles` returned.
   * That is what makes the read answer for the *revision* rather than for
   * whatever happens to be on disk: a bare repository has no working tree at
   * all, and a checkout with uncommitted edits would otherwise silently index
   * content no commit contains.
   *
   * `revision` is accepted and deliberately unused for the lookup. An object id
   * is already absolute — a blob is the same blob at every revision that
   * references it — so re-resolving `revision:path` would ask a question
   * `listFiles` already answered, and would answer it against the tree as it
   * stands now. It is kept on the request because a provider that *cannot*
   * address by object id needs it, and because dropping it from the contract
   * would make this provider's shortcut everyone's requirement.
   */
  async readFileContent(
    repository: DiscoveredRepository,
    request: FileContentRequest,
    context: ProviderOperationContext,
  ): Promise<FileContent> {
    const blob = await readBlob({
      ...this.#gitOptions(repository, context),
      oid: request.oid,
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    });

    if (blob.read) return { read: true, bytes: blob.bytes, sizeBytes: blob.sizeBytes };
    return { read: false, reason: CONTENT_REASON[blob.reason], detail: blob.detail };
  }

  /**
   * Emits files and the versions of them a revision holds.
   *
   * **File identity is the repository and the path** — the same scheme
   * EPIC-020 chose for files seen in commit history, deliberately, so that a
   * file found by listing a tree and the same file found in a commit are one
   * entity rather than two.
   *
   * **File-version identity is the content hash**, which for a tracked file is
   * Git's own object id. Ferret does not recompute it: an object id is
   * `sha1("blob <length>" + NUL + bytes)` over exactly the bytes Git stored,
   * whereas hashing the working copy would produce a different number for the
   * same content on a machine with different line-ending settings — and two
   * developers' identical files would look like two versions.
   *
   * A **symlink is not a file**. Its blob holds a target path, not content, and
   * indexing it as source would record the string `../../etc/passwd` as though
   * it were something someone wrote. A **submodule is not a file** either: its
   * "oid" is a commit id in a repository Ferret may not even have. Both are
   * reported by `listFiles` and neither becomes a `file` entity here.
   */
  emitFiles(
    repository: DiscoveredRepository,
    entries: readonly TreeEntry[],
    options: {
      revision?: string;
      observedAt?: Date;
      /**
       * EPIC-030 structure, by path, for callers that have read the content.
       *
       * Optional because nothing here opens a file: `listFiles` answers from the
       * tree, and reading content is a decision the caller makes. A path absent
       * from the map is emitted exactly as it was before EPIC-030.
       */
      structure?: ReadonlyMap<string, FileStructure>;
      /**
       * How much of each file's code the caller could resolve — F-27.
       *
       * Optional, and by path, exactly like `structure`: nothing here parses,
       * and a caller that did not run the content stage supplies none. A path
       * absent from the map is emitted as it was before.
       */
      referenceResolution?: ReadonlyMap<string, FileReferenceResolution>;
    } = {},
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
    skipped: readonly { path: string; reason: string }[];
  } {
    const emitter = this.#requireEmitter();
    const observedAt = options.observedAt ?? new Date();
    const repositoryEntity = this.emit(repository).entity;

    const entities: CanonicalEntity[] = [repositoryEntity];
    const relationships: CanonicalRelationship[] = [];
    const evidence: CanonicalEvidence[] = [];
    const skipped: { path: string; reason: string }[] = [];

    for (const entry of entries) {
      if (entry.kind === TreeEntryKind.SUBMODULE) {
        skipped.push({ path: entry.path, reason: 'submodule' });
        continue;
      }
      if (entry.kind === TreeEntryKind.SYMLINK) {
        skipped.push({ path: entry.path, reason: 'symlink' });
        continue;
      }
      if (entry.kind === TreeEntryKind.UNKNOWN) {
        skipped.push({ path: entry.path, reason: 'unrecognised-mode' });
        continue;
      }

      // EPIC-082: skipped on what the path is, not what it holds — content is
      // never read, so the path is the only signal available.
      if (isSecretPath(entry.path)) {
        skipped.push({ path: entry.path, reason: 'secret-bearing path' });
        continue;
      }

      const extension = extensionOf(entry.path);
      const structure = options.structure?.get(entry.path);
      const resolution = options.referenceResolution?.get(entry.path);
      const file = emitter.entity({
        kind: 'file',
        source: { id: entry.path, scope: repositoryEntity.id },
        attributes: {
          path: entry.path,
          ...(extension === undefined ? {} : { extension }),
          ...(structure === undefined ? {} : fileAttributesFrom(structure)),
          // F-27. Present only for a file this run actually resolved
          // references in, so "not measured" and "measured, none unresolved"
          // stay apart — the distinction the counters lost by being logged.
          ...(resolution === undefined ? {} : { referenceResolution: { ...resolution } }),
        },
      });
      entities.push(file);

      const version = emitter.entity({
        kind: 'file_version',
        // Scoped to the file, not the repository: the same bytes at two paths
        // are two versions of two files, and the same bytes at one path in two
        // clones are one version of one file.
        source: { id: gitContentHash(entry.oid), scope: file.id },
        attributes: {
          contentHash: gitContentHash(entry.oid),
          path: entry.path,
          ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
          ...(structure === undefined
            ? {}
            : fileVersionAttributesFrom(structure, gitContentHash(entry.oid))),
        },
      });
      entities.push(version);

      relationships.push(
        emitter.relationship(
          {
            fromId: repositoryEntity.id,
            type: RelationshipType.REPOSITORY_CONTAINS_FILE,
            toId: file.id,
            fromKind: 'repository',
            toKind: 'file',
          },
          observedAt,
        ),
      );
      relationships.push(
        emitter.relationship(
          {
            fromId: file.id,
            type: RelationshipType.FILE_HAS_VERSION,
            toId: version.id,
            fromKind: 'file',
            toKind: 'file_version',
            metadata: options.revision === undefined ? {} : { revision: options.revision },
          },
          observedAt,
        ),
      );

      // DEFECT (#71): a `file` entity carried no evidence at all.
      //
      // Measured on a full index of Ferret's own repository: 0 of 465 `file`
      // entities had any evidence, while all 463 `file_version` entities did.
      // So the one entity kind a developer names by hand — a path — was the one
      // kind Ferret could not justify holding, and `ferret_why` on a file
      // answered `held: false`. Governance §8 makes files first-class and §18
      // requires an important answer to be traceable to evidence.
      //
      // The observation is the *path*, which is what the tree listing read and
      // what the file's identity is. Not the extension: that is computed from
      // the path, so a row for it would record Ferret's own arithmetic as though
      // it were an observation. One row per file, deduplicated by content in the
      // store, so re-indexing does not grow it.
      evidence.push(
        emitter.about(file, 'attributes.path', entry.path, {
          locator: { kind: 'path', detail: entry.path },
        }),
      );
      evidence.push(
        emitter.observed({
          subjectId: version.id,
          field: 'attributes.contentHash',
          statement: gitContentHash(entry.oid),
          sourceId: entry.oid,
          sourceContentHash: gitContentHash(entry.oid),
          locator: { kind: 'path', detail: entry.path },
        }),
      );
    }

    return { entities, relationships, evidence, skipped };
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
