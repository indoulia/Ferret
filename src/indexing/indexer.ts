import type {
  CanonicalEntity,
  CanonicalEvidence,
  CanonicalRelationship,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import type {
  DiscoveredRepository,
  ProviderOperationContext,
} from '../providers/index.js';
import { throwIfAborted } from '../providers/index.js';
import { VERSION } from '../version.js';

import type {
  EntityWriter,
  EvidenceWriter,
  RelationshipWriter,
  WatermarkStore,
} from './ports.js';

/**
 * Turning what a provider observed into what Ferret knows.
 *
 * The whole product converges here. Everything before this Epic *reads* — a
 * repository, its checkouts, its history, its files — and everything after it
 * *answers*. This is the only place the two meet, and three properties decide
 * whether it is usable or merely functional.
 *
 * **Indexing twice must change nothing.** Governance §10 states it, and it is
 * not free: entity identity is content-derived so entities behave, but
 * relationship identity includes `validFrom`, which means an hourly index of an
 * unchanged repository would have written a new row per edge per run for ever.
 * That was recorded as a limitation by EPIC-018 and is fixed in EPIC-007's store
 * rather than here — every provider needs it, and one that forgot would grow the
 * database silently.
 *
 * **The second run must be cheaper than the first.** A watermark records the
 * newest commit Ferret has seen, and the next run asks the provider only for
 * what is newer. Without it, indexing a large repository hourly re-reads its
 * entire history hourly, and Ferret becomes something people turn off.
 *
 * **Writing must be ordered.** A relationship names two entities and evidence
 * names a subject, so entities are written first, relationships second and
 * evidence last. Not a preference: the database has foreign keys, and the
 * reverse order fails on a repository that has never been indexed.
 */

export const INDEX_ARTIFACT_KIND = 'index';
export const INDEXER_PRODUCER = 'ferret.indexer';

export interface IndexOptions {
  /** Revision to index. Default `HEAD`. */
  readonly revision?: string;
  /** Read commit history. Default true. */
  readonly withHistory?: boolean;
  /** Read the file tree. Default true. */
  readonly withFiles?: boolean;
  /** Read per-commit file changes. Costs Git a diff per commit. Default true. */
  readonly withChanges?: boolean;
  /** Commits to read in one run. */
  readonly historyLimit?: number;
  /**
   * Ignore the watermark and read everything.
   *
   * The escape hatch for "Ferret's model of this repository is wrong". It is
   * explicit because it is expensive, and because a run that silently decided to
   * be full would be indistinguishable from one that had lost its place.
   */
  readonly full?: boolean;
  /** Instant recorded as the observation time for the whole run. */
  readonly observedAt?: Date;
}

export interface WriteCounts {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface IndexReport {
  readonly repositoryId: string;
  readonly repositoryKey: string;
  /** True when a watermark limited what was read. */
  readonly incremental: boolean;
  readonly entities: WriteCounts;
  readonly relationships: WriteCounts;
  readonly evidence: { readonly recorded: number; readonly deduplicated: number };
  readonly commitsRead: number;
  readonly filesRead: number;
  readonly branchesRead: number;
  readonly worktreesRead: number;
  /** Entries the provider reported but Ferret did not model, with reasons. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /** The newest commit instant now on record, when there is one. */
  readonly watermark: string | undefined;
  readonly durationMs: number;
}

/** The subset of the Git provider the indexer uses. */
export interface IndexableSource {
  listWorktrees(
    repository: DiscoveredRepository,
    context: ProviderOperationContext,
  ): Promise<readonly unknown[]>;
  listBranches(
    repository: DiscoveredRepository,
    request: { limit?: number },
    context: ProviderOperationContext,
  ): Promise<{ items: readonly unknown[] }>;
  readHistory(
    repository: DiscoveredRepository,
    request: { revision?: string; limit?: number; since?: string; withChanges?: boolean },
    context: ProviderOperationContext,
  ): Promise<{ commits: readonly { committedAt: string }[] }>;
  listFiles(
    repository: DiscoveredRepository,
    request: { revision?: string; limit?: number },
    context: ProviderOperationContext,
  ): Promise<{ entries: readonly unknown[] }>;
  emit(repository: DiscoveredRepository): { entity: CanonicalEntity; evidence: readonly CanonicalEvidence[] };
  emitGraph(
    repository: DiscoveredRepository,
    parts: { worktrees?: readonly never[]; branches?: readonly never[]; observedAt?: Date },
  ): Graph;
  emitHistory(
    repository: DiscoveredRepository,
    commits: readonly never[],
    options?: { observedAt?: Date },
  ): Graph;
  emitFiles(
    repository: DiscoveredRepository,
    entries: readonly never[],
    options?: { revision?: string; observedAt?: Date },
  ): Graph & { skipped: readonly { path: string; reason: string }[] };
}

interface Graph {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
}

export interface IndexerDependencies {
  readonly source: IndexableSource;
  readonly entities: EntityWriter;
  readonly relationships: RelationshipWriter;
  readonly evidence: EvidenceWriter;
  readonly watermarks: WatermarkStore;
  readonly logger?: Logger;
}

export class RepositoryIndexer {
  readonly #source: IndexableSource;
  readonly #entities: EntityWriter;
  readonly #relationships: RelationshipWriter;
  readonly #evidence: EvidenceWriter;
  readonly #watermarks: WatermarkStore;
  readonly #logger: Logger | undefined;

  constructor(dependencies: IndexerDependencies) {
    this.#source = dependencies.source;
    this.#entities = dependencies.entities;
    this.#relationships = dependencies.relationships;
    this.#evidence = dependencies.evidence;
    this.#watermarks = dependencies.watermarks;
    this.#logger = dependencies.logger;
  }

  /**
   * Indexes one repository.
   *
   * Cancellation is checked between stages rather than between rows: a stage is
   * a bounded read followed by a bounded write, and abandoning one mid-write
   * would leave the graph half-connected. Governance §13 — an interrupted index
   * should leave Ferret knowing less, never knowing something wrong.
   */
  async index(
    repository: DiscoveredRepository,
    options: IndexOptions,
    context: ProviderOperationContext,
  ): Promise<IndexReport> {
    const started = performance.now();
    const observedAt = options.observedAt ?? new Date();
    const repositoryEntity = this.#source.emit(repository).entity;

    const previous = options.full === true ? undefined : await this.#readWatermark(repositoryEntity.id);
    const since = typeof previous?.lastCommitAt === 'string' ? previous.lastCommitAt : undefined;

    const entities = counter();
    const relationships = counter();
    let recorded = 0;
    let deduplicated = 0;
    const skipped: { path: string; reason: string }[] = [];

    const write = async (graph: Graph): Promise<void> => {
      // Entities, then relationships, then evidence. The database has foreign
      // keys; the reverse order fails on a repository never indexed before.
      for (const entity of graph.entities) {
        const result = await this.#entities.upsert(toInput(entity), observedAt);
        entities.record(result.outcome);
      }
      for (const edge of graph.relationships) {
        const result = await this.#relationships.assert(
          {
            fromId: edge.fromId,
            type: edge.type,
            toId: edge.toId,
            validFrom: edge.validFrom,
            ...(edge.validTo === null ? {} : { validTo: edge.validTo }),
            metadata: { ...edge.metadata },
            sourceSystem: edge.sourceSystem,
            ...(edge.sourceId === undefined ? {} : { sourceId: edge.sourceId }),
          },
          observedAt,
        );
        relationships.record(result.outcome);
      }
      for (const record of graph.evidence) {
        const result = await this.#evidence.record(toEvidenceInput(record), observedAt);
        if (result.deduplicated) deduplicated += 1;
        else recorded += 1;
      }
    };

    throwIfAborted(context.signal, 'index');

    // Stage 1 — the repository, its checkouts and its branches.
    const worktrees = await this.#source.listWorktrees(repository, context);
    const branches = (await this.#source.listBranches(repository, {}, context)).items;
    await write(
      this.#source.emitGraph(repository, {
        worktrees: worktrees as readonly never[],
        branches: branches as readonly never[],
        observedAt,
      }),
    );

    // Stage 2 — history, bounded by the watermark unless a full run was asked
    // for.
    //
    // `--since` has second granularity and an inclusive boundary, so the
    // watermark commit itself is re-read every run. That is deliberate: moving
    // the boundary forward by a second to avoid it would risk skipping a sibling
    // commit made in the same second, and silently losing history is far worse
    // than re-reading one commit whose write is already idempotent.
    let commitsRead = 0;
    let newestCommitAt = since;
    if (options.withHistory !== false) {
      throwIfAborted(context.signal, 'index.history');
      const page = await this.#source.readHistory(
        repository,
        {
          ...(options.revision === undefined ? {} : { revision: options.revision }),
          ...(options.historyLimit === undefined ? {} : { limit: options.historyLimit }),
          ...(since === undefined ? {} : { since }),
          withChanges: options.withChanges !== false,
        },
        context,
      );
      commitsRead = page.commits.length;
      newestCommitAt = newest(page.commits, since);
      await write(this.#source.emitHistory(repository, page.commits as readonly never[], { observedAt }));
    }

    // Stage 3 — the file tree at the revision.
    let filesRead = 0;
    if (options.withFiles !== false) {
      throwIfAborted(context.signal, 'index.files');
      const listing = await this.#source.listFiles(
        repository,
        options.revision === undefined ? {} : { revision: options.revision },
        context,
      );
      filesRead = listing.entries.length;
      const graph = this.#source.emitFiles(repository, listing.entries as readonly never[], {
        ...(options.revision === undefined ? {} : { revision: options.revision }),
        observedAt,
      });
      skipped.push(...graph.skipped);
      await write(graph);
    }

    // The watermark moves only after everything above succeeded. A run that
    // failed halfway must be repeated, not resumed from a position it never
    // reached — Governance §6, never claim to know something you did not.
    await this.#writeWatermark(repositoryEntity.id, newestCommitAt, observedAt);

    const report: IndexReport = {
      repositoryId: repositoryEntity.id,
      repositoryKey: repository.identityKey,
      incremental: since !== undefined,
      entities: entities.counts,
      relationships: relationships.counts,
      evidence: { recorded, deduplicated },
      commitsRead,
      filesRead,
      branchesRead: branches.length,
      worktreesRead: worktrees.length,
      skipped,
      watermark: newestCommitAt,
      durationMs: performance.now() - started,
    };

    this.#logger?.info(
      {
        operation: 'index.repository',
        repository: repository.identityKey,
        incremental: report.incremental,
        entities: report.entities,
        relationships: report.relationships,
        commitsRead,
        filesRead,
        durationMs: Math.round(report.durationMs),
      },
      `Indexed ${repository.identityKey}`,
    );

    return report;
  }

  async #readWatermark(repositoryId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    const artifact = await this.#watermarks.getArtifact(INDEX_ARTIFACT_KIND, repositoryId);
    if (artifact === undefined) return undefined;
    // A watermark written by a different build of Ferret is not trustworthy: the
    // producer may have changed what it reads or how it models it, and resuming
    // from it would leave a gap nothing would ever fill. Falling back to a full
    // read is the safe direction, and EPIC-010's artefact staleness exists for
    // exactly this.
    if (artifact.producerVersion !== VERSION) return undefined;
    return artifact.metadata;
  }

  async #writeWatermark(
    repositoryId: string,
    lastCommitAt: string | undefined,
    now: Date,
  ): Promise<void> {
    await this.#watermarks.recordArtifact(
      {
        kind: INDEX_ARTIFACT_KIND,
        scopeId: repositoryId,
        producer: INDEXER_PRODUCER,
        producerVersion: VERSION,
        metadata: {
          ...(lastCommitAt === undefined ? {} : { lastCommitAt }),
          indexedAt: now.toISOString(),
        },
      },
      now,
    );
  }
}

function counter(): { record(outcome: string): void; readonly counts: WriteCounts } {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  return {
    record(outcome: string): void {
      // `opened` is the relationship store's word for what the entity store
      // calls `created`; `stale` is an observation that arrived too late to
      // change anything, which is a form of unchanged.
      if (outcome === 'created' || outcome === 'opened') created += 1;
      else if (outcome === 'updated') updated += 1;
      else unchanged += 1;
    },
    get counts(): WriteCounts {
      return { created, updated, unchanged };
    },
  };
}

/**
 * The newest commit instant seen, never moving backwards.
 *
 * A repository can contain a commit dated before one Ferret has already seen —
 * a rebase, an imported branch, a wrong clock — and letting the watermark move
 * back would make the next run re-read everything between. Taking the maximum
 * costs nothing and removes the whole class.
 */
function newest(commits: readonly { committedAt: string }[], previous: string | undefined): string | undefined {
  let best = previous;
  for (const commit of commits) {
    const at = Date.parse(commit.committedAt);
    if (Number.isNaN(at)) continue;
    if (best === undefined || at > Date.parse(best)) best = commit.committedAt;
  }
  return best;
}

function toInput(entity: CanonicalEntity): Parameters<EntityWriter['upsert']>[0] {
  return {
    kind: entity.kind,
    source: { ...entity.source },
    lifecycle: entity.lifecycle,
    attributes: { ...entity.attributes },
    unknownFields: { ...entity.unknownFields },
    externalIds: entity.externalIds.map((id) => ({ ...id })),
    ...(entity.sourceObservedAt === undefined ? {} : { sourceObservedAt: entity.sourceObservedAt }),
  };
}

function toEvidenceInput(record: CanonicalEvidence): Parameters<EvidenceWriter['record']>[0] {
  return {
    subjectId: record.subjectId,
    ...(record.field === undefined ? {} : { field: record.field }),
    statement: record.statement,
    method: record.method,
    producer: record.producer,
    producerVersion: record.producerVersion,
    sourceSystem: record.sourceSystem,
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
    ...(record.locator === undefined ? {} : { locator: { ...record.locator } }),
    ...(record.sourceContentHash === undefined ? {} : { sourceContentHash: record.sourceContentHash }),
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    completeness: record.completeness,
    authority: record.authority,
    ...(record.observedAt === undefined ? {} : { observedAt: record.observedAt }),
    derivedFrom: [...record.derivedFrom],
    ...(record.permissionScope === undefined ? {} : { permissionScope: record.permissionScope }),
  };
}

/** Guard used by callers that must not proceed without a usable index. */
export function assertIndexed(report: IndexReport): void {
  if (report.entities.created + report.entities.updated + report.entities.unchanged === 0) {
    throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, 'Indexing produced no entities', {
      details: { repository: report.repositoryKey },
      remediation: 'Check that the path is a readable Git repository with at least one commit.',
    });
  }
}
