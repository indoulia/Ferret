import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  RepositoryOperation,
  type BranchPage,
  type DiscoveredBranch,
  type DiscoveredRepository,
  type DiscoveredWorktree,
} from '../providers/contracts/source-repository.js';
import {
  SOURCE_CONNECTOR_CONTRACT_VERSION,
  sourceIdentityKey,
  type AcquiredRecord,
  type AcquisitionPage,
  type AcquisitionRequest,
  type NormalizationContext,
  type SkippedSourceRecord,
  type SourceConnector,
  type SourceContribution,
  type SourceIdentity,
} from '../providers/contracts/source-connector.js';
import type { Emitter } from '../providers/sdk/emit.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

/**
 * A repository as a source, on the universal boundary — EPIC-120.
 *
 * EPIC-119 cut the seam and proved it with a tracker. A tracker is the *easy*
 * case: `ProjectSource` already returns one flat collection, so the adapter was
 * a projection. A repository is the case that decides whether the seam was cut
 * in the right place, because a repository is not one collection — it is a
 * description, its checkouts, its refs, its tree and its history, four of which
 * page independently and none of which is shaped like an issue.
 *
 * It goes through unchanged. `acquire` walks those collections as **stages of
 * one cursor**, so the ingestor's paging, bounding, cancellation and
 * cursor-advance rules apply to a repository exactly as they apply to a board;
 * `normalize` calls the Git provider's own `emitGraph`/`emitFiles`/`emitHistory`,
 * which is the same modelling `RepositoryIndexer` has always called. There is
 * no second model of a commit in Ferret, and this file does not add one.
 *
 * **This is not a Git client.** Nothing here clones, fetches, checks out,
 * commits, or resolves a merge. It reads what is already on disk through the
 * provider Ferret already ships, and stops — the boundary the Epic states, and
 * the reason `acquire` is the only method that touches a repository at all.
 */

/** The record kinds this connector acquires. */
export const REPOSITORY_RECORD = 'repository';
export const WORKTREE_RECORD = 'worktree';
export const BRANCH_RECORD = 'branch';
export const FILE_RECORD = 'file';
export const COMMIT_RECORD = 'commit';

/**
 * A tree entry, in the only terms core needs of one.
 *
 * Structural, and deliberately *not* Git's `TreeEntry`. `src/connectors` is
 * core, and core must not know Git exists — EPIC-017's central rule, which
 * `boundaries.test.ts` enforces and which this file broke on its first draft by
 * importing the provider's types for convenience. `RepositoryIndexer`'s port
 * solves the same problem the same way.
 *
 * Only `path` is required, because only `path` is load-bearing: it is the
 * record id, and therefore what the file entity's identity derives from. The
 * rest is metadata carried through when a provider has it.
 */
export interface AcquiredTreeEntry {
  readonly path: string;
  readonly oid?: string;
  readonly kind?: string;
  readonly mode?: string;
  readonly sizeBytes?: number;
}

/**
 * A commit, in the only terms core needs of one.
 *
 * `sha` alone is required, for the same reason: it is the record id, and a
 * commit acquired twice must be one entity. Everything else is what the source
 * happened to say.
 */
export interface AcquiredCommit {
  readonly sha: string;
  readonly subject?: string;
  readonly authoredAt?: string | undefined;
  readonly committedAt?: string | undefined;
  readonly parents?: readonly string[];
  readonly changes?: readonly unknown[];
}

/** An emitter supplied by the caller, so modelling carries this pass's provenance. */
interface EmitterOverride {
  readonly emitter?: Emitter;
}

/**
 * What the connector needs of a repository source.
 *
 * A structural type rather than a provider class, for the reason
 * `indexing/ports.ts` gives: the connector depends on the operations it calls,
 * not on whatever holds them, so a second repository provider can be ingested
 * through this connector without either of them knowing about the other.
 *
 * `listFiles` and `readHistory` are not on the `RepositorySource` contract —
 * they are declared operations whose signatures the contract leaves to the
 * provider — so they are named here in the same shape `RepositoryIndexer`
 * already depends on rather than being invented afresh.
 */
export interface RepositorySourcePort {
  describeRepository(
    root: string,
    context: ProviderOperationContext,
  ): Promise<DiscoveredRepository>;
  listWorktrees(
    repository: DiscoveredRepository,
    context: ProviderOperationContext,
  ): Promise<readonly DiscoveredWorktree[]>;
  listBranches(
    repository: DiscoveredRepository,
    request: { cursor?: string; limit?: number },
    context: ProviderOperationContext,
  ): Promise<BranchPage>;
  listFiles(
    repository: DiscoveredRepository,
    request: { revision?: string; limit?: number; cursor?: string },
    context: ProviderOperationContext,
  ): Promise<{ entries: readonly AcquiredTreeEntry[]; cursor: string | undefined }>;
  readHistory(
    repository: DiscoveredRepository,
    request: {
      revision?: string;
      limit?: number;
      cursor?: string;
      since?: string;
      withChanges?: boolean;
    },
    context: ProviderOperationContext,
  ): Promise<{
    commits: readonly AcquiredCommit[];
    cursor: string | undefined;
    tip: string | undefined;
    incomplete: { readonly reason: string } | undefined;
  }>;
  emitGraph(
    repository: DiscoveredRepository,
    parts: {
      worktrees?: readonly DiscoveredWorktree[];
      branches?: readonly DiscoveredBranch[];
      observedAt?: Date;
    } & EmitterOverride,
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
  };
  emitFiles(
    repository: DiscoveredRepository,
    entries: readonly AcquiredTreeEntry[],
    options: { revision?: string; observedAt?: Date } & EmitterOverride,
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
    skipped: readonly { path: string; reason: string }[];
  };
  emitHistory(
    repository: DiscoveredRepository,
    commits: readonly AcquiredCommit[],
    options: { observedAt?: Date } & EmitterOverride,
  ): {
    entities: readonly CanonicalEntity[];
    relationships: readonly CanonicalRelationship[];
    evidence: readonly CanonicalEvidence[];
    placeholderEntityIds: readonly string[];
    skippedRecords: readonly { readonly id: string; readonly reason: string }[];
  };
}

export interface RepositoryConnectorOptions {
  readonly source: RepositorySourcePort;
  /** The provider id, which is what the connector is attributed as. */
  readonly connectorId: string;
  /** The external system observed. `git`. */
  readonly system: string;
  /**
   * Which deployment of that system.
   *
   * For a checkout on this machine there is no deployment, and the honest
   * answer is the host it is on — see {@link LOCAL_INSTANCE}. It is required
   * rather than defaulted for the reason the project connector gives: a default
   * files two different machines' repositories under one identity, and they are
   * not the same source.
   */
  readonly instance: string;
  /** Operations the provider declared. An undeclared one is never called. */
  readonly operations: readonly string[];
  /** The revision the tree and history are read at. Default `HEAD`. */
  readonly revision?: string;
  /** Refs read in one page. A ceiling, not a target. */
  readonly branchPageSize?: number;
  /** Tree entries read in one page. */
  readonly filePageSize?: number;
  /** Commits read in one page. */
  readonly commitPageSize?: number;
  /**
   * When this observation was made.
   *
   * Threaded into every emitted relationship, because `validFrom` is part of a
   * relationship's identity (EPIC-007) and letting it default per call would
   * mint a different id for every edge in a single normalization. Injectable so
   * a test can assert that two runs of the same repository derive the same
   * graph rather than merely a similar one.
   */
  readonly observedAt?: () => Date;
}

/**
 * The `instance` for a repository that is a directory on this machine.
 *
 * A checkout has no deployment to name. What distinguishes two of them is the
 * host they sit on, and a caller that knows the hostname passes it; this is the
 * value for a caller that does not, and it is deliberately *not* the empty
 * string — "unspecified" and "the local one" become the same source the moment
 * anybody adds a second machine to one database.
 */
export const LOCAL_INSTANCE = 'local';

/** Pages are bounded so one repository cannot spend a whole pass. */
const DEFAULT_BRANCH_PAGE = 200;
const DEFAULT_FILE_PAGE = 500;
const DEFAULT_COMMIT_PAGE = 200;

/**
 * Where a staged acquisition got to.
 *
 * A repository is four enumerations behind one cursor, so the cursor names
 * which one is running and carries that enumeration's own opaque position. The
 * stages run in a fixed order — description, then refs, then tree, then
 * history — and the order is the one `RepositoryIndexer` established: the tree
 * is written before history so that a commit's `MODIFIED` edge has a file to
 * point at rather than creating a placeholder that then has to be repaired.
 */
const Stage = {
  DESCRIBE: 'describe',
  BRANCHES: 'branches',
  FILES: 'files',
  COMMITS: 'commits',
} as const;

type Stage = (typeof Stage)[keyof typeof Stage];

interface StagedCursor {
  readonly stage: Stage;
  /** The running stage's own cursor, as that operation defined it. */
  readonly inner?: string;
}

export function repositorySourceConnector(
  options: RepositoryConnectorOptions,
): SourceConnector {
  const operations = new Set(options.operations);
  const now = options.observedAt ?? ((): Date => new Date());

  /**
   * The repository each stage after the first is asked about.
   *
   * `listBranches`, `listFiles` and `readHistory` all take a
   * `DiscoveredRepository` rather than a path, so the description read on the
   * first page has to survive to the later ones. It is cached per identity
   * rather than re-read per page because re-describing costs several Git
   * invocations and answers a question that cannot have changed mid-pass —
   * and a pass that *did* straddle a change re-reads next time anyway, since a
   * truncated pass never advances its cursor.
   */
  const described = new Map<string, DiscoveredRepository>();

  async function repositoryFor(
    identity: SourceIdentity,
    context: ProviderOperationContext,
  ): Promise<DiscoveredRepository> {
    const key = sourceIdentityKey(identity);
    const cached = described.get(key);
    if (cached !== undefined) return cached;
    const repository = await options.source.describeRepository(identity.resource, context);
    described.set(key, repository);
    return repository;
  }

  return {
    connectorId: options.connectorId,
    contractVersion: SOURCE_CONNECTOR_CONTRACT_VERSION,
    system: options.system,
    /**
     * Deliberately unset, and it is not an oversight.
     *
     * Git *is* the system of record for its own commits, but the Git provider's
     * own emitter does not claim it, and `RepositoryIndexer` emits through that
     * emitter. Claiming it here would give the same observation of the same
     * commit a different authority depending on which path read it, and two
     * rows that should have deduplicated would not. Raising it is EPIC-045's
     * decision to make for the provider, not this connector's to make for one
     * caller.
     */

    identify(resource: string): SourceIdentity {
      // Pure and total, so the separators are unified here rather than by
      // asking Git: `identify` is called before anything is acquired — the
      // cursor is keyed by its answer — so a version of this that read
      // `.git/config` for the remote would make an unreadable repository
      // indistinguishable from an unknown one. The remote is not lost: the
      // description carries it onto the entity as `remoteUrl`, where the
      // resolution layer can still collapse two clones.
      const trimmed = resource.trim().replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
      return { system: options.system, instance: options.instance, resource: trimmed };
    },

    async acquire(
      request: AcquisitionRequest,
      context: ProviderOperationContext,
    ): Promise<AcquisitionPage> {
      const cursor = decodeStage(request.cursor);

      if (cursor.stage === Stage.DESCRIBE) {
        return acquireDescription(request, context);
      }
      if (cursor.stage === Stage.BRANCHES) {
        return acquireBranches(request, cursor, context);
      }
      if (cursor.stage === Stage.FILES) {
        return acquireFiles(request, cursor, context);
      }
      return acquireCommits(request, cursor, context);
    },

    normalize(
      records: readonly AcquiredRecord[],
      context: NormalizationContext,
    ): SourceContribution {
      // The description is what every other stage is modelled against, and a
      // page set without one cannot be normalized at all. That is not a failure
      // — an `unchanged` pass legitimately carries no records — so it returns
      // an empty contribution rather than throwing, and the ingestor still
      // writes the source entity and advances the cursor.
      const description = records.find((record) => record.kind === REPOSITORY_RECORD);
      if (description === undefined) return EMPTY_CONTRIBUTION;

      const emitter = context.emitter;
      const observedAt = now();

      /**
       * The description, re-rooted onto the identity this source is filed under.
       *
       * The one substantive decision in this file. `emit()` derives the
       * repository entity from `identityKey`, and the ingestor has *already*
       * derived a source entity from `sourceIdentityKey(identity)` — so left
       * alone, one ingested repository would be two `repository` rows, one of
       * them holding the whole graph and the other holding nothing but a name.
       *
       * Overriding the key makes the provider's modelling root at the entity
       * the ingestor scoped this pass to, which is what
       * `NormalizationContext.sourceEntityId` exists to say. Everything the
       * real identity carried is still on the entity — `remoteUrl`,
       * `identityKind`, `localRoot` — so nothing about the repository is lost;
       * only the derivation of its id changes, and it changes to the one value
       * that keeps a source to a single root.
       */
      const repository: DiscoveredRepository = {
        ...(description.payload as DiscoveredRepository),
        identityKey: sourceIdentityKey(context.identity),
      };

      const entities: CanonicalEntity[] = [];
      const relationships: CanonicalRelationship[] = [];
      const evidence: CanonicalEvidence[] = [];
      const placeholderEntityIds: string[] = [];
      const skipped: SkippedSourceRecord[] = [];

      const add = (part: {
        entities: readonly CanonicalEntity[];
        relationships: readonly CanonicalRelationship[];
        evidence: readonly CanonicalEvidence[];
      }): void => {
        entities.push(...part.entities);
        relationships.push(...part.relationships);
        evidence.push(...part.evidence);
      };

      // The repository, its checkouts and its refs — one emission, because
      // `emitGraph` models the containment between them and splitting it would
      // mean re-deriving the same edges twice.
      add(
        options.source.emitGraph(repository, {
          worktrees: payloads<DiscoveredWorktree>(records, WORKTREE_RECORD),
          branches: payloads<DiscoveredBranch>(records, BRANCH_RECORD),
          observedAt,
          emitter,
        }),
      );

      // The tree before the history, exactly as `RepositoryIndexer` orders it:
      // a commit's change edges point at file entities, and writing the tree
      // first means those entities exist as records read from the source rather
      // than as placeholders a later pass has to repair.
      const entries = payloads<AcquiredTreeEntry>(records, FILE_RECORD);
      if (entries.length > 0) {
        const files = options.source.emitFiles(repository, entries, {
          ...(options.revision === undefined ? {} : { revision: options.revision }),
          observedAt,
          emitter,
        });
        add(files);
        for (const record of files.skipped) {
          skipped.push({ id: record.path, kind: FILE_RECORD, reason: record.reason });
        }
      }

      const commits = payloads<AcquiredCommit>(records, COMMIT_RECORD);
      if (commits.length > 0) {
        const history = options.source.emitHistory(repository, commits, { observedAt, emitter });
        add(history);
        placeholderEntityIds.push(...history.placeholderEntityIds);
        for (const record of history.skippedRecords) {
          skipped.push({ id: record.id, kind: COMMIT_RECORD, reason: record.reason });
        }
      }

      return { entities, relationships, evidence, placeholderEntityIds, skipped };
    },
  };

  // -------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------

  async function acquireDescription(
    request: AcquisitionRequest,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage> {
    if (!operations.has(RepositoryOperation.DESCRIBE)) {
      // Without a description there is no repository to ask the later stages
      // about, so a provider that cannot describe cannot be ingested through
      // this connector at all. Said plainly, rather than discovered as a
      // `TypeError` four stages later.
      throw new FerretError(
        ErrorCode.CAPABILITY_UNAVAILABLE,
        'The repository source cannot describe a repository',
        {
          details: { connector: options.connectorId, operation: RepositoryOperation.DESCRIBE },
          remediation:
            'Ingest through a provider that declares `describeRepository`; every later stage is asked about what it returns.',
        },
      );
    }

    const repository = await repositoryFor(request.identity, context);
    const records: AcquiredRecord[] = [
      {
        id: repository.identityKey,
        kind: REPOSITORY_RECORD,
        payload: repository,
        metadata: {
          title: repository.identityKey,
          // The masked remote, which is what `DiscoveredRepository.originUrl`
          // already is — `RepositoryRemote.url` states the rule and the
          // provider applies it. Never the raw configured value.
          ...(repository.originUrl === undefined ? {} : { url: repository.originUrl }),
          attributes: {
            identityKind: repository.identityKind,
            bare: repository.bare,
            linkedWorktree: repository.linkedWorktree,
          },
        },
      },
    ];

    if (operations.has(RepositoryOperation.LIST_WORKTREES)) {
      for (const worktree of await options.source.listWorktrees(repository, context)) {
        records.push({
          id: worktree.path,
          kind: WORKTREE_RECORD,
          payload: worktree,
          metadata: {
            title: worktree.path,
            attributes: {
              primary: worktree.primary,
              detached: worktree.detached,
              ...(worktree.ref === undefined ? {} : { ref: worktree.ref }),
            },
          },
        });
      }
    }

    return { records, cursor: encodeStage({ stage: Stage.BRANCHES }) };
  }

  async function acquireBranches(
    request: AcquisitionRequest,
    cursor: StagedCursor,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage> {
    if (!operations.has(RepositoryOperation.LIST_BRANCHES)) {
      return { records: [], cursor: encodeStage({ stage: Stage.FILES }) };
    }

    const repository = await repositoryFor(request.identity, context);
    const page = await options.source.listBranches(
      repository,
      {
        limit: pageSize(request, options.branchPageSize ?? DEFAULT_BRANCH_PAGE),
        ...(cursor.inner === undefined ? {} : { cursor: cursor.inner }),
      },
      context,
    );

    const records = page.items.map((branch) => ({
      id: branch.ref,
      kind: BRANCH_RECORD,
      payload: branch,
      metadata: {
        title: branch.shortName,
        version: branch.headCommit,
        attributes: {
          isDefault: branch.isDefault,
          isHead: branch.isHead,
          ...(branch.upstream === undefined ? {} : { upstream: branch.upstream }),
        },
      },
    }));

    return { records, cursor: advance(Stage.BRANCHES, Stage.FILES, page.cursor) };
  }

  async function acquireFiles(
    request: AcquisitionRequest,
    cursor: StagedCursor,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage> {
    if (!operations.has(RepositoryOperation.LIST_FILES)) {
      return { records: [], cursor: encodeStage({ stage: Stage.COMMITS }) };
    }

    const repository = await repositoryFor(request.identity, context);
    const page = await options.source.listFiles(
      repository,
      {
        ...(options.revision === undefined ? {} : { revision: options.revision }),
        limit: pageSize(request, options.filePageSize ?? DEFAULT_FILE_PAGE),
        ...(cursor.inner === undefined ? {} : { cursor: cursor.inner }),
      },
      context,
    );

    const records = page.entries.map((entry) => ({
      id: entry.path,
      kind: FILE_RECORD,
      payload: entry,
      metadata: {
        title: entry.path,
        // Git's object id: a content hash, so this is the source's own version
        // marker for the file and not something Ferret derived.
        version: entry.oid,
        attributes: {
          kind: entry.kind,
          mode: entry.mode,
          ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
        },
      },
    }));

    return { records, cursor: advance(Stage.FILES, Stage.COMMITS, page.cursor) };
  }

  async function acquireCommits(
    request: AcquisitionRequest,
    cursor: StagedCursor,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage> {
    if (!operations.has(RepositoryOperation.READ_HISTORY)) return { records: [] };

    const repository = await repositoryFor(request.identity, context);
    const page = await options.source.readHistory(
      repository,
      {
        ...(options.revision === undefined ? {} : { revision: options.revision }),
        limit: pageSize(request, options.commitPageSize ?? DEFAULT_COMMIT_PAGE),
        ...(cursor.inner === undefined ? {} : { cursor: cursor.inner }),
        ...(request.since === undefined ? {} : { since: request.since }),
        // Asked for, because the change edges are the point: without them a
        // commit is a message with an author, and "which commit last touched
        // this file" — the question the history is ingested to answer — has no
        // edge to walk.
        withChanges: true,
      },
      context,
    );

    const records = page.commits.map((commit) => ({
      id: commit.sha,
      kind: COMMIT_RECORD,
      payload: commit,
      metadata: {
        title: commit.subject,
        version: commit.sha,
        ...(commit.authoredAt === undefined ? {} : { createdAt: commit.authoredAt }),
        ...(commit.committedAt === undefined ? {} : { updatedAt: commit.committedAt }),
        attributes: { parents: commit.parents?.length ?? 0, changes: commit.changes?.length ?? 0 },
      },
    }));

    // A history read that could not finish must not look like one that did.
    // Leaving the inner cursor in place keeps the pass unfinished, so the
    // ingestor reports it truncated and declines to advance — the commits Git
    // could not reach are still unread, and a resume past them would make the
    // gap permanent.
    const inner = page.incomplete !== undefined ? (page.cursor ?? cursor.inner) : page.cursor;

    return {
      records,
      ...(inner === undefined ? {} : { cursor: encodeStage({ stage: Stage.COMMITS, inner }) }),
      // The tip is what a later exclusion-based read would start from. Kept
      // because the ingestor persists it untouched and a change-feed Epic then
      // has somewhere to have left its place.
      ...(page.tip === undefined ? {} : { checkpoint: { tip: page.tip } }),
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor and page helpers
// ---------------------------------------------------------------------------

const EMPTY_CONTRIBUTION: SourceContribution = Object.freeze({
  entities: [],
  relationships: [],
  evidence: [],
});

/** Move to the next stage when this one is done, or stay and carry its place. */
function advance(current: Stage, next: Stage, inner: string | undefined): string {
  return inner === undefined
    ? encodeStage({ stage: next })
    : encodeStage({ stage: current, inner });
}

/**
 * A ceiling the connector may lower and must not raise.
 *
 * The contract's words, applied: `pageSize` is the caller's bound, the
 * connector's own default is its bound, and what goes to the provider is
 * whichever is smaller.
 */
function pageSize(request: AcquisitionRequest, fallback: number): number {
  return request.pageSize === undefined ? fallback : Math.min(request.pageSize, fallback);
}

function encodeStage(cursor: StagedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Read a staged cursor, treating anything unreadable as the beginning.
 *
 * A cursor is opaque to the ingestor, which stores and returns it verbatim, so
 * a truncated or hand-edited one arrives here as a string that means nothing.
 * Starting over re-reads a repository, which is free — every write is an
 * idempotent upsert. Throwing would fail a source over a value the source did
 * not produce.
 */
function decodeStage(cursor: string | undefined): StagedCursor {
  if (cursor === undefined) return { stage: Stage.DESCRIBE };
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return { stage: Stage.DESCRIBE };
    const { stage, inner } = decoded as { stage?: unknown; inner?: unknown };
    if (!isStage(stage)) return { stage: Stage.DESCRIBE };
    return { stage, ...(typeof inner === 'string' ? { inner } : {}) };
  } catch {
    return { stage: Stage.DESCRIBE };
  }
}

function isStage(value: unknown): value is Stage {
  return (
    value === Stage.DESCRIBE ||
    value === Stage.BRANCHES ||
    value === Stage.FILES ||
    value === Stage.COMMITS
  );
}

/** The payloads of one record kind, in the order they were acquired. */
function payloads<T>(records: readonly AcquiredRecord[], kind: string): readonly T[] {
  const selected: T[] = [];
  for (const record of records) {
    if (record.kind === kind) selected.push(record.payload as T);
  }
  return selected;
}
