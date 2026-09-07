import { and, eq, inArray } from 'drizzle-orm';

import {
  CORRESPONDENCE_UNAVAILABLE,
  UnknownReason,
  type AnchorResolution,
  type CodeStatePort,
  type ContextAnchorInput,
  type Correspondence,
  type CurrentContent,
  type ResolvedAnchor,
} from '../context/code-state.js';
import { EntityKind, RelationshipType, type CanonicalEntity } from '../domain/index.js';
import { WithholdReason, withholds, type AccessContext } from '../retrieval/access.js';

import { EntityStore, type FerretDatabase } from './entities.js';
import { RelationshipStore } from './relationships.js';
import { entity } from './schema/entities.js';

/**
 * Current code state for one repository scope — EPIC-137.
 *
 * A `file`'s `source_id` is its repo-relative path; `withholds` is the same
 * boundary retrieval uses, so an exclusion stays an exclusion rather than
 * becoming a permission denial — the mistake EPIC-135 fixed.
 */

/** Reads the live working tree. `git/worktree-state.ts` satisfies this. */
export interface WorktreeReader {
  read(cwd: string): Promise<{
    readonly headCommit: string | undefined;
    /** The checked-out branch. Absent when HEAD is detached. */
    readonly branch: string | undefined;
    readonly dirtyPaths: readonly string[];
    readonly dirtySampleTruncated: boolean;
  }>;
}

/** The three withholding mechanisms stay distinct — EPIC-135. */
function reasonFor(withheld: WithholdReason): UnknownReason {
  switch (withheld) {
    case WithholdReason.EXCLUSION:
      return UnknownReason.EXCLUDED;
    case WithholdReason.SCOPE:
    case WithholdReason.PERMISSION:
      return UnknownReason.NOT_PERMITTED;
    default:
      return UnknownReason.ANCHOR_UNRESOLVED;
  }
}

export class CodeStateStore implements CodeStatePort {
  readonly #db: FerretDatabase;
  readonly #entities: EntityStore;
  readonly #relationships: RelationshipStore;
  readonly #access: AccessContext;
  readonly #worktree: WorktreeReader | undefined;
  readonly #cwd: string | undefined;
  /** One worktree read per scope per instance; the instance is per request. */
  readonly #corresponds = new Map<string, Promise<Correspondence>>();

  constructor(
    db: FerretDatabase,
    options: {
      readonly access: AccessContext;
      readonly worktree?: WorktreeReader | undefined;
      /**
       * The checkout being asked about — normally the server's own directory.
       * Ferret's own repository has four live worktrees on four commits, so
       * this cannot be inferred from the index; without it, several worktrees
       * mean `unknown`.
       */
      readonly cwd?: string | undefined;
    },
  ) {
    this.#db = db;
    this.#entities = new EntityStore(db);
    this.#relationships = new RelationshipStore(db);
    this.#access = options.access;
    this.#worktree = options.worktree;
    this.#cwd = options.cwd;
  }

  async resolveAnchors(
    scope: string | undefined,
    anchors: readonly ContextAnchorInput[],
  ): Promise<readonly AnchorResolution[]> {
    if (scope === undefined) {
      return anchors.map((one) =>
        failed(one.path, UnknownReason.NOT_INDEXED, 'no repository scope was established for this anchor'),
      );
    }
    const files = await this.#filesByPath(scope, anchors.map((one) => one.path));
    const versions = await this.#currentVersions([...files.values()].map((one) => one.id));

    return anchors.map((anchor) => {
      const file = files.get(anchor.path);
      if (file === undefined) {
        return failed(
          anchor.path,
          UnknownReason.ANCHOR_UNRESOLVED,
          'no indexed file in this repository has that path — index the repository, or check the path',
        );
      }
      const withheld = withholds(this.#access, file);
      if (withheld !== undefined) {
        return failed(anchor.path, reasonFor(withheld), 'the caller policy in force does not permit reading this path');
      }
      const hash = versions.get(file.id);
      if (hash === undefined) {
        return failed(anchor.path, UnknownReason.ANCHOR_UNRESOLVED, 'the file is indexed but holds no single current version');
      }
      const resolved: ResolvedAnchor = {
        path: anchor.path,
        symbol: anchor.symbol,
        lineRange: anchor.lineRange,
        fileId: file.id,
        contentHash: hash,
      };
      return Object.freeze({ path: anchor.path, resolved, failure: undefined, detail: undefined });
    });
  }

  async currentContent(
    scope: string | undefined,
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, CurrentContent>> {
    const out = new Map<string, CurrentContent>();
    if (scope === undefined || paths.length === 0) return out;

    const correspondence = await this.correspondence(scope);
    const files = await this.#filesByPath(scope, paths);
    const versions = await this.#currentVersions([...files.values()].map((one) => one.id));

    for (const path of paths) {
      const file = files.get(path);
      if (file === undefined) {
        out.set(path, { contentHash: undefined, withheld: UnknownReason.ANCHOR_UNRESOLVED });
        continue;
      }
      const withheld = withholds(this.#access, file);
      if (withheld !== undefined) {
        out.set(path, { contentHash: undefined, withheld: reasonFor(withheld) });
        continue;
      }
      // A locally modified path means the indexed hash is not what the reader
      // has, so it cannot verify — §8 condition 6.
      if (correspondence.dirtyPaths.has(path)) {
        out.set(path, { contentHash: undefined, withheld: UnknownReason.PATH_DIRTY });
        continue;
      }
      // Truncated sample: the anchor cannot be shown to be clean.
      if (correspondence.dirtySampleTruncated) {
        out.set(path, { contentHash: undefined, withheld: UnknownReason.DIRT_UNKNOWN });
        continue;
      }
      out.set(path, { contentHash: versions.get(file.id), withheld: undefined });
    }
    return out;
  }

  async correspondence(scope: string | undefined): Promise<Correspondence> {
    if (scope === undefined) return CORRESPONDENCE_UNAVAILABLE;
    const cached = this.#corresponds.get(scope);
    if (cached !== undefined) return cached;
    const pending = this.#establish(scope);
    this.#corresponds.set(scope, pending);
    return pending;
  }

  async #establish(scope: string): Promise<Correspondence> {
    const repository = await this.#entities.get(scope);
    if (repository === undefined || repository.kind !== EntityKind.REPOSITORY) {
      return unestablished(UnknownReason.NOT_INDEXED);
    }
    const path = await this.#localPath(scope, repository);
    if (this.#worktree === undefined || path === undefined) {
      return CORRESPONDENCE_UNAVAILABLE;
    }

    let live: Awaited<ReturnType<WorktreeReader['read']>>;
    try {
      live = await this.#worktree.read(path);
    } catch {
      // Not establishable rather than a failure to explain: a repository Ferret
      // cannot read says nothing about whether the anchor still holds.
      return CORRESPONDENCE_UNAVAILABLE;
    }

    // The branch that is *checked out*, not the default one. An agent works on
    // a feature branch, and comparing against `main` would make every verdict
    // `unknown` exactly where the capability is used.
    if (live.branch === undefined || live.headCommit === undefined) {
      // Detached HEAD: no branch to compare, so correspondence is not
      // establishable rather than failed.
      return unestablished(UnknownReason.NOT_INDEXED);
    }
    const indexedHead = await this.#indexedHead(scope, live.branch);
    if (indexedHead === undefined) {
      return unestablished(UnknownReason.NOT_INDEXED);
    }
    if (indexedHead !== live.headCommit) {
      return unestablished(UnknownReason.NO_CORRESPONDENCE);
    }
    return Object.freeze({
      established: true,
      reason: undefined,
      dirtyPaths: new Set(live.dirtyPaths),
      dirtySampleTruncated: live.dirtySampleTruncated,
    });
  }

  /**
   * The checkout to evaluate against.
   *
   * Dogfooding found the `repository` entity carries no `path` at all, and that
   * four worktrees sat on four commits. Ambiguous is `unknown`, not a guess.
   */
  async #localPath(scope: string, repository: CanonicalEntity): Promise<string | undefined> {
    const rows = await this.#db
      .select({ attributes: entity.attributes })
      .from(entity)
      .where(and(eq(entity.kind, EntityKind.WORKTREE), eq(entity.sourceScope, scope)));
    const worktrees = rows
      .map((row) => ((row.attributes as Record<string, unknown> | null) ?? {})['path'])
      .filter((one): one is string => typeof one === 'string' && one.length > 0);

    const normalize = (value: string): string =>
      value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();
    if (this.#cwd !== undefined) {
      const asked = normalize(this.#cwd);
      const match = worktrees.find((one) => normalize(one) === asked);
      if (match !== undefined) return match;
    }
    if (worktrees.length === 1) return worktrees[0];

    const declared = repository.attributes['path'];
    if (worktrees.length === 0 && typeof declared === 'string' && declared.length > 0) return declared;
    return undefined;
  }

  /**
   * The commit Ferret's index says one named branch points at.
   *
   * Exactly one match, or nothing. Two rows disagreeing about a branch's head
   * is not a head Ferret may choose between, so the verdict becomes `unknown` —
   * the direction §8 requires.
   */
  async #indexedHead(scope: string, branch: string): Promise<string | undefined> {
    const rows = await this.#db
      .select({ attributes: entity.attributes })
      .from(entity)
      .where(and(eq(entity.kind, EntityKind.BRANCH), eq(entity.sourceScope, scope)));

    const heads = rows
      .map((row) => (row.attributes as Record<string, unknown> | null) ?? {})
      .filter((one) => one['shortName'] === branch || one['ref'] === `refs/heads/${branch}`)
      .map((one) => one['headCommit'])
      .filter((head): head is string => typeof head === 'string' && head.length > 0);

    return new Set(heads).size === 1 ? heads[0] : undefined;
  }

  async #filesByPath(scope: string, paths: readonly string[]): Promise<ReadonlyMap<string, CanonicalEntity>> {
    const wanted = [...new Set(paths)].filter((one) => one.length > 0);
    const out = new Map<string, CanonicalEntity>();
    if (wanted.length === 0) return out;

    // `source_id` is the repo-relative path for a `file`, and
    // `entity_scope_idx` covers (source_scope, kind). Parameterized: these
    // paths come from tool input.
    const rows = await this.#db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.kind, EntityKind.FILE), eq(entity.sourceScope, scope), inArray(entity.sourceId, wanted)));

    for (const row of rows) {
      const found = await this.#entities.get(row.id);
      const path = found?.attributes['path'];
      if (found !== undefined && typeof path === 'string') out.set(path, found);
    }
    return out;
  }

  /**
   * The newest open `FILE_HAS_VERSION`, not the only one.
   *
   * Observed on the real index: a changed file gains a second open edge and the
   * first is never retired. Requiring exactly one put `stale` out of reach;
   * matching *any* open edge would verify against superseded bytes. The
   * retirement gap belongs to indexing, not to EPIC-137.
   */
  async #currentVersions(fileIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const fileId of new Set(fileIds)) {
      const edges = await this.#relationships.outgoing(fileId, { type: RelationshipType.FILE_HAS_VERSION });
      const newest = [...edges].sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
      if (newest === undefined) continue;
      const version = await this.#entities.get(newest.toId);
      const hash = version?.attributes['contentHash'];
      if (typeof hash === 'string' && hash.length > 0) out.set(fileId, hash);
    }
    return out;
  }
}

function failed(path: string, failure: UnknownReason, detail: string): AnchorResolution {
  return Object.freeze({ path, resolved: undefined, failure, detail });
}

function unestablished(reason: UnknownReason): Correspondence {
  return Object.freeze({ established: false, reason, dirtyPaths: new Set<string>(), dirtySampleTruncated: false });
}
