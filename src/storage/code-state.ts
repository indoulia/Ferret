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
 * Everything read here already existed: a `file` entity's `source_id` is its
 * repo-relative path within its repository, the open `FILE_HAS_VERSION`
 * interval names the version that path holds now, and `withholds` is the same
 * boundary retrieval uses — so an exclusion stays an exclusion instead of
 * becoming a permission denial, which is the mistake EPIC-135 fixed.
 */

/** Reads the live working tree. `git/worktree-state.ts` satisfies this. */
export interface WorktreeReader {
  read(cwd: string): Promise<{
    readonly headCommit: string | undefined;
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
  /** One worktree read per scope per instance; the instance is per request. */
  readonly #corresponds = new Map<string, Promise<Correspondence>>();

  constructor(
    db: FerretDatabase,
    options: { readonly access: AccessContext; readonly worktree?: WorktreeReader | undefined },
  ) {
    this.#db = db;
    this.#entities = new EntityStore(db);
    this.#relationships = new RelationshipStore(db);
    this.#access = options.access;
    this.#worktree = options.worktree;
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
    const path = repository.attributes['path'];
    if (this.#worktree === undefined || typeof path !== 'string' || path.length === 0) {
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

    const indexedHead = await this.#indexedHead(scope);
    if (indexedHead === undefined || live.headCommit === undefined) {
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
   * The commit Ferret's index says this repository is at.
   *
   * The default branch, or the only branch. Two branches with no default is not
   * a head Ferret may choose between, so it returns nothing and the verdict is
   * `unknown` — the direction §8 requires.
   */
  async #indexedHead(scope: string): Promise<string | undefined> {
    const rows = await this.#db
      .select({ attributes: entity.attributes })
      .from(entity)
      .where(and(eq(entity.kind, EntityKind.BRANCH), eq(entity.sourceScope, scope)));

    const branches = rows.map((row) => (row.attributes as Record<string, unknown> | null) ?? {});
    const heads = (branches.filter((one) => one['isDefault'] === true).length > 0
      ? branches.filter((one) => one['isDefault'] === true)
      : branches
    )
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

  /** The content hash each file holds now, by the open `FILE_HAS_VERSION` edge. */
  async #currentVersions(fileIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    for (const fileId of new Set(fileIds)) {
      const edges = await this.#relationships.outgoing(fileId, { type: RelationshipType.FILE_HAS_VERSION });
      // Exactly one open version, or nothing. Several would mean Ferret cannot
      // say which content the path holds, which is not a match.
      if (edges.length !== 1 || edges[0] === undefined) continue;
      const version = await this.#entities.get(edges[0].toId);
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
