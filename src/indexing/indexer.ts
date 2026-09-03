import { Metric, Tracer, defaultMetrics, type MetricsRegistry } from '../observability/index.js';
import { processInvocationId } from '../logging/index.js';
import {
  EntityKind,
  canonicalId,
  encodeKeyParts,
  type CanonicalEntity,
  type CanonicalEvidence,
  type CanonicalRelationship,
  type RelationshipInput,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import type {
  DiscoveredRepository,
  ProviderOperationContext,
} from '../providers/index.js';
import { throwIfAborted } from '../providers/index.js';
import { VERSION } from '../version.js';

import type { SymbolIndexPort } from '../code/index.js';
import type { FileStructure } from '../files/index.js';
import type { ParserFramework } from '../parsing/index.js';

import { runContentStage, type ContentCounts } from './content.js';
import { ContentStageSkip } from './ports.js';
import type {
  ContentArtifactStore,
  ContentBlobWriter,
  ContentReader,
  EntityWriter,
  EvidenceWriter,
  LifecycleStore,
  RelationshipWriter,
  RunJournal,
  SyncCursors,
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
  /**
   * Rewrite what is read even when the stored hash says it is unchanged.
   *
   * A **repair** option, off by default and deliberately separate from `full`.
   * `full` says which commits to read; this says whether to trust the stored
   * hash of what is read back — and issue #101 is what happens when Ferret
   * always trusts it: an entity altered outside Ferret keeps its `content_hash`,
   * so the recomputed hash matches, `upsert` reports `unchanged`, and no number
   * of re-reads ever corrects the row.
   *
   * Kept off `full` so `ferret index --full` writes exactly what it always
   * wrote. Widening an existing option's effect would change EPIC-031's measured
   * behaviour to close EPIC-094's criterion.
   */
  readonly rederive?: boolean;
  /**
   * Read file content, and derive structure and symbols from it. Default false.
   *
   * **Off unless asked for**, and it is the one option here whose default is a
   * decision rather than a convenience. Content indexing reads and parses every
   * file in the repository, which is a materially different cost model from a
   * tree listing (EPIC-108 §13), and it is the first path on which
   * attacker-controlled bytes reach a parser in production (§11). Both are
   * reasons for an operator to opt in deliberately rather than to discover the
   * change in a bill or an incident.
   */
  readonly withContent?: boolean;
  /** Instant recorded as the observation time for the whole run. */
  readonly observedAt?: Date;
}

export interface WriteCounts {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface LifecycleCounts {
  /** Entities marked deleted, with their containment closed at the source instant. */
  readonly retired: number;
  /** Entities observed to exist again. */
  readonly reinstated: number;
  /**
   * Why the reconciliation did not run, when it did not.
   *
   * Never silence. An operator wondering why deleted files persist should find
   * the answer here and in the log, rather than having to read this file.
   */
  readonly skippedReason: string | undefined;
  /**
   * Refs retired by absence from a complete enumeration — EPIC-032 AC-7.
   *
   * Counted separately rather than added into `retired`. That number is
   * asserted by AC-11's tests as the count of *files* whose containment was
   * closed at a deleting commit's instant; folding a ref retirement into it
   * would quietly change what an existing measurement means.
   */
  readonly branches: {
    readonly retired: number;
    readonly skippedReason: string | undefined;
  };
}

export interface IndexReport {
  readonly repositoryId: string;
  readonly repositoryKey: string;
  /** True when a watermark limited what was read. */
  readonly incremental: boolean;
  readonly entities: WriteCounts;
  readonly relationships: WriteCounts;
  readonly evidence: { readonly recorded: number; readonly deduplicated: number };
  /**
   * Conflict reconciliation over the subjects this run wrote about — EPIC-047.
   *
   * `undefined` when the evidence writer cannot reconcile, which is not the same
   * as having found nothing.
   */
  readonly conflicts:
    | { readonly subjects: number; readonly groups: number }
    | undefined;
  readonly commitsRead: number;
  readonly filesRead: number;
  readonly branchesRead: number;
  readonly worktreesRead: number;
  /** Entries the provider reported but Ferret did not model, with reasons. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  /**
   * What stopped existing, and what came back.
   *
   * Reported rather than done silently: a run that quietly tombstoned four per
   * cent of a repository is indistinguishable from one that did nothing, and
   * Governance §6 asks for the difference to be visible.
   */
  readonly lifecycle: LifecycleCounts;
  /**
   * What the content stage read, parsed and stored — EPIC-108 §8.8.
   *
   * `undefined` when the stage did not run, and never a block of zeroes: zeroes
   * would claim the stage ran and found nothing, and "no result" and "nothing
   * there" must not look the same (Governance §6). The log says why it did not
   * run.
   */
  readonly content: ContentCounts | undefined;
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
  ): Promise<{
    items: readonly unknown[];
    /**
     * Present when the enumeration was cut short — EPIC-032 AC-7.
     *
     * The provider has always returned this and the indexer always discarded
     * it. That is precisely why ref retirement could not be built: absence from
     * a *bounded* enumeration proves nothing, and without this signal there is
     * no way to tell a repository with two branches from the first page of a
     * repository with two thousand.
     */
    cursor?: string | undefined;
  }>;
  readHistory(
    repository: DiscoveredRepository,
    request: {
      revision?: string;
      limit?: number;
      cursor?: string;
      since?: string;
      exclude?: readonly string[];
      withChanges?: boolean;
    },
    context: ProviderOperationContext,
  ): Promise<{
    commits: readonly { committedAt: string; sha?: string }[];
    /**
     * Present when the page was cut short — the same signal `listBranches` and
     * `listFiles` carry, and for the same reason.
     *
     * It was declared on both of those and not on this one, and the omission
     * was not visible: the provider returned it, the port did not name it, and
     * the run then advanced its position past commits it had never read. A
     * bounded read whose bound the caller cannot see is a silent truncation.
     */
    cursor?: string | undefined;
    /**
     * The commit `revision` names now, when the provider can say.
     *
     * What the next run excludes. A position, rather than a date that happens
     * to belong to a commit.
     */
    tip?: string | undefined;
  }>;
  listFiles(
    repository: DiscoveredRepository,
    request: { revision?: string; limit?: number },
    context: ProviderOperationContext,
  ): Promise<{
    entries: readonly unknown[];
    /**
     * Present when the listing was cut short.
     *
     * The completeness signal the lifecycle reconciliation is gated on. A
     * partial view of a tree cannot be allowed to condemn the files it did not
     * reach, and the failure mode if it were is silent: a sweep on a truncated
     * listing tombstones most of a large repository and looks exactly like a
     * successful run.
     */
    cursor?: string | undefined;
  }>;
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
    options?: {
      revision?: string;
      observedAt?: Date;
      /**
       * EPIC-030 structure by path, for a caller that has read the content.
       *
       * Named here by EPIC-108 so the option `GitProvider.emitFiles` has
       * accepted since EPIC-030 can finally be filled. It widens what the
       * indexer may *pass*, not what a source must implement: the field is
       * optional on both sides, so a source that ignores it is unaffected and
       * every existing implementation still satisfies this interface.
       */
      structure?: ReadonlyMap<string, FileStructure>;
    },
  ): Graph & { skipped: readonly { path: string; reason: string }[] };
}

interface Graph {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
  /**
   * Entities present only so an edge has an endpoint, by id.
   *
   * Optional, so a source that never emits a placeholder is unaffected and
   * every existing implementation still satisfies this interface. When a source
   * does report them, the writer inserts them if they are absent and leaves
   * them alone if they are not — a gap-filler must never overwrite a record
   * some earlier run read in full.
   */
  readonly placeholderEntityIds?: readonly string[];
}

export interface IndexerDependencies {
  readonly source: IndexableSource;
  readonly entities: EntityWriter;
  readonly relationships: RelationshipWriter;
  readonly evidence: EvidenceWriter;
  readonly watermarks: WatermarkStore;
  /**
   * Where this run's measurements go — EPIC-092.
   *
   * Optional, so every existing caller keeps working and gets the process
   * registry. A test supplies its own to assert on totals in isolation.
   */
  readonly metrics?: MetricsRegistry;
  /**
   * Optional so that every existing caller keeps working, and so a source that
   * cannot observe deletion is not forced to pretend it can. When absent the
   * report says why the reconciliation did not run.
   */
  readonly lifecycle?: LifecycleStore;
  /**
   * Where file content comes from — EPIC-108.
   *
   * Optional, and its absence is the metadata-only fallback: a source that
   * cannot read content must not be made to pretend it can, so the composition
   * root asks `supports(capability, operation)` and omits this rather than
   * supplying something that will throw at the call. Same shape as
   * `lifecycle`, and for the same reason.
   */
  readonly content?: ContentReader;
  /**
   * Where the symbols a parse produced are stored — EPIC-108.
   *
   * The second of this Epic's two ports. Optional alongside `content` because
   * neither is useful without the other: reading content with nowhere to put
   * what it yields would be cost without a result.
   */
  readonly symbols?: SymbolIndexPort;
  /**
   * The parser framework a content run parses through — EPIC-108.
   *
   * A collaborator rather than a port: it abstracts nothing external, it is core
   * code, and the indexer could construct one if it had the parsers. It does not
   * have them — they are *composed* into the registry (§8.5) — so the
   * composition root builds the framework and hands it over, which is what keeps
   * the indexer from knowing a registry exists.
   */
  readonly parser?: ParserFramework;
  /**
   * Where the re-parse gate records what it derived — EPIC-108 §8.7.
   *
   * EPIC-010's derived-artefact store, reached through the narrowest interface
   * that fits, exactly as `watermarks` is. The same service satisfies both.
   */
  readonly artifacts?: ContentArtifactStore;
  /**
   * Where content is kept once it has been read — EPIC-087.
   *
   * Optional, and its absence is not a skip reason: a run without it derives
   * everything it derived before and keeps no bodies, which is exactly the
   * behaviour EPIC-108 shipped. Making it required would turn a VALIDATED Epic's
   * composition into a broken one.
   */
  readonly blobs?: ContentBlobWriter;
  /**
   * Where a run records that it started — EPIC-094.
   *
   * Optional. Without it the indexer behaves exactly as it did before, and a
   * run that dies halfway leaves no trace of having started — the state this
   * port exists to end.
   */
  readonly runs?: RunJournal;
  /**
   * Where this run records how far it got — EPIC-075.
   *
   * Optional, and its absence falls back to the artefact store directly, so a
   * caller that has not been updated behaves exactly as it did. Resuming is an
   * optimisation: losing it costs time, not correctness.
   */
  readonly cursors?: SyncCursors;
  readonly logger?: Logger;
}

export class RepositoryIndexer {
  readonly #source: IndexableSource;
  readonly #entities: EntityWriter;
  readonly #relationships: RelationshipWriter;
  readonly #evidence: EvidenceWriter;
  readonly #watermarks: WatermarkStore;
  readonly #lifecycle: LifecycleStore | undefined;
  readonly #content: ContentReader | undefined;
  readonly #symbols: SymbolIndexPort | undefined;
  readonly #parser: ParserFramework | undefined;
  readonly #artifacts: ContentArtifactStore | undefined;
  readonly #blobs: ContentBlobWriter | undefined;
  readonly #runs: RunJournal | undefined;
  readonly #cursors: SyncCursors | undefined;
  readonly #logger: Logger | undefined;
  /**
   * Metrics for this run — EPIC-092.
   *
   * The process registry unless a caller supplies one, which is what lets a
   * test hold its own totals without two runtimes in one process sharing them.
   */
  readonly #metrics: MetricsRegistry;
  readonly #tracer: Tracer;

  constructor(dependencies: IndexerDependencies) {
    this.#source = dependencies.source;
    this.#entities = dependencies.entities;
    this.#relationships = dependencies.relationships;
    this.#evidence = dependencies.evidence;
    this.#watermarks = dependencies.watermarks;
    this.#lifecycle = dependencies.lifecycle;
    this.#content = dependencies.content;
    this.#symbols = dependencies.symbols;
    this.#parser = dependencies.parser;
    this.#artifacts = dependencies.artifacts;
    this.#blobs = dependencies.blobs;
    this.#runs = dependencies.runs;
    this.#cursors = dependencies.cursors;
    this.#logger = dependencies.logger;
    // EPIC-092. The process registry unless a caller supplies one.
    this.#metrics = dependencies.metrics ?? defaultMetrics();
    this.#tracer = new Tracer({
      invocation: processInvocationId(),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
      metrics: this.#metrics,
    });
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
    // EPIC-094 §3.3 — intent before effect. The row is opened before anything
    // is read or written and closed after everything succeeded, so an open row
    // whose process is gone is a partially applied run rather than an inference
    // from which tables happen to be empty.
    //
    // A *killed* process runs neither branch below, and that is the mechanism:
    // the row stays open and the sweep finds it. A caught failure is closed as
    // `failed`, because Ferret knows how that one ended.
    const run = await this.#runs?.start({ repositoryKey: repository.identityKey });
    try {
      const report = await this.#indexOnce(repository, options, context);
      if (run !== undefined) {
        await this.#runs?.finish(
          run.id,
          'succeeded',
          {
            entities: report.entities,
            relationships: report.relationships,
            commitsRead: report.commitsRead,
            filesRead: report.filesRead,
            durationMs: Math.round(report.durationMs),
            // EPIC-092 §8.4. History comes from this journal rather than a new
            // table: migration 0012 made `summary` free-shaped on purpose, and
            // it already carries `started_at`, `ferret_version` and
            // `invocation` — which is what makes comparing two runs meaningful
            // rather than misleading.
            metrics: this.#metrics.snapshot(),
          },
          report.repositoryId,
        );
      }
      return report;
    } catch (error) {
      // The summary carries the error *code*, never its message: a message can
      // quote a path or a value, and the journal outlives the terminal it was
      // printed to.
      if (run !== undefined) {
        await this.#runs?.finish(run.id, 'failed', {
          code: error instanceof FerretError ? error.code : 'E_UNKNOWN',
          // A failed run still records what it measured before failing —
          // EPIC-092 §10. "Which stage was slow before it died" is exactly the
          // question a failure raises.
          metrics: this.#metrics.snapshot(),
        });
      }
      throw error;
    }
  }

  async #indexOnce(
    repository: DiscoveredRepository,
    options: IndexOptions,
    context: ProviderOperationContext,
  ): Promise<IndexReport> {
    const started = performance.now();
    const observedAt = options.observedAt ?? new Date();
    const repositoryEntity = this.#source.emit(repository).entity;

    // Issue #19: the watermark is scoped to the *revision* that was read, not
    // to the repository. One watermark per repository silently skips commits —
    // index `HEAD`, then a feature branch, then `HEAD` again, and every `HEAD`
    // commit older than the feature branch's tip is never read. Nothing fails;
    // the graph is simply missing history and no later run goes back for it.
    const watermarkScope = watermarkScopeId(repositoryEntity.id, options.revision);

    const previous = options.full === true ? undefined : await this.#readWatermark(watermarkScope);
    const previousTips = readTips(previous);
    const previousCommitAt = typeof previous?.lastCommitAt === 'string' ? previous.lastCommitAt : undefined;
    // Reachability when the last run left tips, the date otherwise. Never both:
    // a date filter applied on top of an exclusion would reintroduce exactly
    // the commits the exclusion exists to stop losing.
    //
    // `previousCommitAt` is still carried forward whichever is used. It is no
    // longer what a run resumes *from*, but it is still what the run reports and
    // what "how far behind" is measured from, and a resumed run that read
    // nothing new must not report that it has read nothing at all.
    const exclude = previousTips;
    const since = exclude.length > 0 ? undefined : previousCommitAt;

    const entities = counter();
    const relationships = counter();
    let recorded = 0;
    let deduplicated = 0;
    const conflictSubjects = new Set<string>();
    const skipped: { path: string; reason: string }[] = [];

    const write = async (graph: Graph): Promise<void> => {
      // Entities, then relationships, then evidence. The database has foreign
      // keys; the reverse order fails on a repository never indexed before.
      const placeholders = new Set(graph.placeholderEntityIds ?? []);
      for (const entity of graph.entities) {
        const result = await this.#entities.upsert(
          toInput(entity),
          observedAt,
          // `ifAbsent` still wins for a gap-filler — issue #48 — so a repair
          // cannot regress a full record to a stub. Everything a repair reads
          // in full is rewritten, which is what issue #101 needed.
          placeholders.has(entity.id)
            ? { ifAbsent: true }
            : options.rederive === true
              ? { rederive: true }
              : {},
        );
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
        // EPIC-047 §8.4. The subjects this run wrote about are exactly the ones
        // whose conflict state can have changed, so reconciliation is
        // maintained here rather than left to whoever remembers to ask —
        // which is why `conflicting` was unreachable for five Epics.
        if (!result.deduplicated) conflictSubjects.add(record.subjectId);
      }
    };

    // The content stage decision, taken before anything is read.
    //
    // Up here rather than beside the stage it gates, because a run that cannot
    // read content must say so whether or not it ever reaches the file tree.
    const contentStage = this.#contentStage(options);
    let content: ContentCounts | undefined;
    let contentStructure: ReadonlyMap<string, FileStructure> | undefined;
    let contentEdges: readonly RelationshipInput[] = [];
    if (!contentStage.run) {
      this.#logger?.info(
        {
          operation: 'index.content',
          repository: repository.identityKey,
          requested: options.withContent === true,
          skipped: contentStage.reason,
        },
        `Content indexing did not run: ${String(contentStage.reason)}`,
      );
    }

    throwIfAborted(context.signal, 'index');

    // Stage 1 — the repository, its checkouts and its branches.
    const worktrees = await this.#source.listWorktrees(repository, context);
    const branchPage = await this.#source.listBranches(repository, {}, context);
    const branches = branchPage.items;
    /**
     * Whether this run saw *every* ref — EPIC-032 AC-7.
     *
     * The one fact ref retirement is gated on, and the reason it is read here
     * rather than inferred later: a cursor means the enumeration stopped
     * early, and a sweep that treated a first page as complete would retire
     * every branch beyond it while looking like a successful run.
     */
    const branchesComplete = branchPage.cursor === undefined;
    const branchGraph = this.#source.emitGraph(repository, {
      worktrees: worktrees as readonly never[],
      branches: branches as readonly never[],
      observedAt,
    });
    /**
     * The branch entity ids this run observed.
     *
     * Taken from the emitted graph rather than recomputed from the provider's
     * ref strings, so the ids compared against the store are minted by exactly
     * the code that writes them. Deriving them a second way here is how a
     * sweep ends up retiring every branch because two id derivations disagreed.
     */
    const observedBranches = new Set(
      branchGraph.entities.filter((entity) => entity.kind === EntityKind.BRANCH).map((entity) => entity.id),
    );
    await write(branchGraph);

    // Stage 3 — the file tree at the revision, and the content it holds.
    let filesRead = 0;
    let treeComplete = false;
    /**
     * Files observed to exist at the indexed revision.
     *
     * Direct evidence of presence, and stronger than any older statement that
     * the file was deleted — a re-add on this branch, or a branch that still
     * has what another removed.
     */
    const present = new Set<string>();
    /**
     * `file` entities this run has already written from the tree.
     *
     * Only populated on a content run, and only so the history stage can be
     * told not to write them again — see `runFileStage` below.
     */
    const writtenFiles = new Set<string>();

    const runFileStage = async (): Promise<void> => {
      if (options.withFiles === false) return;
      throwIfAborted(context.signal, 'index.files');
      const listing = await this.#source.listFiles(
        repository,
        options.revision === undefined ? {} : { revision: options.revision },
        context,
      );
      filesRead = listing.entries.length;
      treeComplete = listing.cursor === undefined;
      const emitOptions = {
        ...(options.revision === undefined ? {} : { revision: options.revision }),
        observedAt,
      };
      const base = this.#source.emitFiles(repository, listing.entries as readonly never[], emitOptions);

      // Content, when it was asked for and the source can supply it.
      //
      // Between the listing and the write, deliberately. The structure EPIC-030
      // derives belongs on the same `file` and `file_version` entities the
      // listing produces, through the `structure` option `emitFiles` already
      // accepts and no caller has ever filled — so the content has to be read
      // before the graph is written, not after.
      if (
        contentStage.run &&
        this.#content !== undefined &&
        this.#symbols !== undefined &&
        this.#parser !== undefined &&
        this.#artifacts !== undefined
      ) {
        const stage = await runContentStage(
          {
            content: this.#content,
            symbols: this.#symbols,
            parser: this.#parser,
            artifacts: this.#artifacts,
            ...(this.#blobs === undefined ? {} : { blobs: this.#blobs }),
            // EPIC-035. Evidence only: a symbol exists by now, so evidence
            // about one has a subject. The *edges* come back from the stage and
            // are written below, once the entities they point from exist.
            evidence: this.#evidence,
            // EPIC-092. This run's registry, not the process default — or a
            // caller holding its own would see stage timings and not per-file
            // ones, which is how a snapshot ends up half true.
            metrics: this.#metrics,
            ...(this.#logger === undefined ? {} : { logger: this.#logger }),
          },
          {
            repository,
            repositoryId: repositoryEntity.id,
            entries: listing.entries,
            emitted: base,
            revision: options.revision,
            observedAt,
          },
          context,
        );
        content = stage.counts;
        contentStructure = stage.structure;
        contentEdges = stage.edges;
      }

      // Re-emitted with structure when there is any, and emitted once when
      // there is not. `emitFiles` is a pure function of its inputs, so the
      // second call costs a hash per entry and nothing else — and it is what
      // keeps identity derivation in the provider rather than duplicated here.
      const graph =
        contentStructure === undefined
          ? base
          : this.#source.emitFiles(repository, listing.entries as readonly never[], {
              ...emitOptions,
              structure: contentStructure,
            });

      skipped.push(...graph.skipped);
      for (const entity of graph.entities) {
        if (entity.kind !== 'file') continue;
        present.add(entity.id);
        if (contentStage.run) writtenFiles.add(entity.id);
      }
      await write(graph);

      // EPIC-035. After the write, and that is the whole reason the stage
      // returns these rather than asserting them: a `file_declares_symbol` edge
      // points from a `file` entity that did not exist a moment ago, and the
      // relationship table's foreign key is not a suggestion. Found by test on
      // the first end-to-end run.
      for (const edge of contentEdges) {
        await this.#relationships.assert(edge, observedAt);
      }
    };

    // On a content run the file tree is read and written **before** history.
    //
    // Not a preference — a correctness fix, and the reason is worth stating
    // because it is invisible until content indexing exists. EPIC-020 emits a
    // `file` entity for every path a commit touched, carrying `{ path,
    // extension }` and nothing else. The content stage puts EPIC-030's
    // structure on that same entity, and an entity upsert *replaces*
    // attributes rather than merging them. With history written second, every
    // run would strip the structure and then put it back: two writes per file
    // per run, for ever, and AC-6's "a second run writes no rows" would be
    // false. The watermark's boundary is inclusive, so the newest commit is
    // re-read on every run and the churn never settles.
    //
    // Writing the tree first makes those entities exist before history needs
    // them as relationship targets, which is what lets the history graph drop
    // its poorer copies below. A metadata-only run keeps the original order
    // exactly, so nothing about it changes (AC-1).
    if (contentStage.run) {
      await this.#tracer.span('index.files', runFileStage, { metric: Metric.INDEX_STAGE_MS });
    }

    // Stage 2 — history, resumed from what the last run read.
    //
    // **Every page, not the first one.** The provider bounds a read and says so
    // by returning a cursor; the run follows it until there is none. Reading one
    // page and then recording a position past its end is how a repository larger
    // than a page silently lost everything older than it (F-01), and no later
    // run went back: the position had already moved beyond the commits that were
    // never read.
    //
    // **Excluded by reachability, not filtered by date**, when a previous
    // position is available. `--since` asks "is this commit newer than a date",
    // which is a property of the commit rather than of what Ferret has seen: a
    // branch merged after it was written, a rebase, an imported history and a
    // clock an hour fast are all commits Ferret has never read whose dates say
    // they are old. `^<tip>` asks the only question that matters — is this
    // reachable from something already read — and Git answers it exactly.
    //
    // `since` remains the fallback for a position written before tips existed,
    // so an upgrade does not force a full re-read of every repository.
    let commitsRead = 0;
    let newestCommitAt = previousCommitAt;
    let tips: readonly string[] = previousTips;
    if (options.withHistory !== false) {
      throwIfAborted(context.signal, 'index.history');
      let cursor: string | undefined;
      let pages = 0;
      do {
        throwIfAborted(context.signal, 'index.history');
        const page = await this.#source.readHistory(
          repository,
          {
            ...(options.revision === undefined ? {} : { revision: options.revision }),
            ...(options.historyLimit === undefined ? {} : { limit: options.historyLimit }),
            ...(cursor === undefined ? {} : { cursor }),
            // Every page, not only the first. A cursor is an offset into *this*
            // walk; carrying the offset without the filter that defined the walk
            // would page into a different history and skip precisely the commits
            // the exclusion was meant to find.
            ...(exclude.length === 0 ? {} : { exclude }),
            ...(exclude.length > 0 || since === undefined ? {} : { since }),
            withChanges: options.withChanges !== false,
          },
          context,
        );
        commitsRead += page.commits.length;
        newestCommitAt = newest(page.commits, newestCommitAt);
        if (page.tip !== undefined) tips = rememberTip(tips, page.tip);
        const graph = this.#source.emitHistory(repository, page.commits as readonly never[], { observedAt });
        await write(withoutRewrittenFiles(graph, writtenFiles));
        cursor = page.cursor;
        pages += 1;
        // A provider that returned a cursor for ever would page for ever. The
        // bound is deliberately far above any real history at this page size,
        // and hitting it is a provider defect rather than a large repository.
        if (pages >= MAX_HISTORY_PAGES && cursor !== undefined) {
          this.#logger?.warn(
            { operation: 'index.history', repository: repositoryEntity.id, pages },
            'History paging stopped at its bound; the read is incomplete',
          );
          break;
        }
      } while (cursor !== undefined);
    }

    if (!contentStage.run) {
      await this.#tracer.span('index.files', runFileStage, { metric: Metric.INDEX_STAGE_MS });
    }

    // Stage 4 — reconcile what Ferret believes exists with what it observed.
    const lifecycle = await this.#reconcile(
      repositoryEntity.id,
      { complete: treeComplete, present },
      options,
      observedAt,
      context,
    );
    const branchLifecycle = await this.#reconcileBranches(
      repositoryEntity.id,
      { complete: branchesComplete, present: observedBranches },
      observedAt,
      context,
    );

    // EPIC-047 §8.4. After every write, before the watermark: the subjects this
    // run recorded new evidence about are the ones whose conflict state can have
    // changed, and reconciliation both marks and clears — a state that is only
    // ever set accumulates false positives until an operator stops reading it.
    //
    // A writer without the method leaves the count `undefined` rather than `0`,
    // so the report distinguishes "reconciled nothing" from "could not
    // reconcile" — the same distinction the lifecycle stage already makes.
    const conflicts = await this.#reconcileConflicts(conflictSubjects, observedAt);

    // The watermark moves only after everything above succeeded. A run that
    // failed halfway must be repeated, not resumed from a position it never
    // reached — Governance §6, never claim to know something you did not.
    await this.#writeWatermark(watermarkScope, newestCommitAt, tips, observedAt);

    const report: IndexReport = {
      repositoryId: repositoryEntity.id,
      repositoryKey: repository.identityKey,
      incremental: since !== undefined || exclude.length > 0,
      entities: entities.counts,
      relationships: relationships.counts,
      evidence: { recorded, deduplicated },
      conflicts,
      commitsRead,
      filesRead,
      branchesRead: branches.length,
      worktreesRead: worktrees.length,
      skipped,
      lifecycle: { ...lifecycle, branches: branchLifecycle },
      content,
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
        lifecycle: report.lifecycle,
        durationMs: Math.round(report.durationMs),
      },
      `Indexed ${repository.identityKey}`,
    );

    return report;
  }

  /**
   * Whether the content stage runs on this run, and why not when it does not.
   *
   * Asked once per run, before anything is read, and answered from what the
   * indexer was *given* rather than from what a provider turns out to have. That
   * is AC-16: a source that cannot read content is detected before it is called,
   * and the run proceeds as a metadata-only index — never a missing method
   * discovered halfway through a repository.
   *
   * The composition root does the capability check and simply does not supply a
   * content port when the answer is no, so this reads as "was I given one".
   * Keeping the check there and the consequence here is what lets the indexer
   * stay ignorant of the registry, which EPIC-031's port design requires.
   */
  #contentStage(options: IndexOptions): { run: boolean; reason: ContentStageSkip | undefined } {
    if (options.withContent !== true) {
      return { run: false, reason: ContentStageSkip.NOT_REQUESTED };
    }
    if (options.withFiles === false) return { run: false, reason: ContentStageSkip.NO_FILE_TREE };
    if (this.#content === undefined) return { run: false, reason: ContentStageSkip.NO_CONTENT_PORT };
    if (this.#symbols === undefined) return { run: false, reason: ContentStageSkip.NO_SYMBOL_PORT };
    if (this.#parser === undefined) return { run: false, reason: ContentStageSkip.NO_PARSER };
    if (this.#artifacts === undefined) return { run: false, reason: ContentStageSkip.NO_GATE_STORE };
    return { run: true, reason: undefined };
  }

  /**
   * Makes what Ferret believes exists agree with what it observed.
   *
   * Reads the graph rather than this run's changes, deliberately. An incremental
   * run reads no commit that mentions a file deleted years ago, so a delta-only
   * reconciliation would leave every already-wrong entity wrong for ever — the
   * exact state this found Ferret's own index in, thirteen files deep.
   *
   * **A partial observation retires nothing.** Every gate below fails closed and
   * says why. The failure mode it guards is silent and unrecoverable: a sweep
   * run against a truncated tree would tombstone most of a large repository, and
   * the run would look like every successful one.
   */
  async #reconcile(
    repositoryId: string,
    tree: { complete: boolean; present: ReadonlySet<string> },
    options: IndexOptions,
    now: Date,
    context: ProviderOperationContext,
  ): Promise<Omit<LifecycleCounts, 'branches'>> {
    const store = this.#lifecycle;
    const none = (reason: string): Omit<LifecycleCounts, 'branches'> => {
      this.#logger?.info(
        { operation: 'index.lifecycle', repository: repositoryId, skipped: reason },
        `Lifecycle reconciliation skipped: ${reason}`,
      );
      return { retired: 0, reinstated: 0, skippedReason: reason };
    };

    if (store === undefined) return none('no lifecycle store is configured');
    if (options.withFiles === false) {
      return none('the file tree was not read, so presence could not be corroborated');
    }
    if (!tree.complete) {
      return none('the file tree listing was truncated, so absence proves nothing');
    }
    if (context.signal?.aborted === true) return none('the run was cancelled');

    const pending = await store.pendingChanges(repositoryId);
    let retired = 0;
    let reinstated = 0;

    for (const change of pending) {
      // Checked per entity rather than per batch: a cancelled run must stop
      // where it is, and every write so far is independently correct.
      throwIfAborted(context.signal, 'index.lifecycle');

      // Seeing the file in the tree outranks any statement that it was
      // deleted. Both are positive observations, and this one is of the
      // revision being indexed rather than of some commit in its past.
      //
      // Git timestamps have one-second resolution, so a delete and a re-add
      // can share an instant and no ordering of the history can separate them.
      // The tree is what settles it, and this is why: without it the outcome
      // depended on which row the database happened to return first, which
      // passed on one platform and failed on another.
      if (change.action === 'retire' && tree.present.has(change.entityId)) {
        if (await store.reinstate(change.entityId, now)) reinstated += 1;
        continue;
      }

      if (change.action === 'retire') {
        if (await store.retire(change.entityId, repositoryId, change.at, now)) retired += 1;
      } else if (await store.reinstate(change.entityId, now)) {
        reinstated += 1;
      }
    }

    if (retired > 0 || reinstated > 0) {
      this.#logger?.info(
        { operation: 'index.lifecycle', repository: repositoryId, retired, reinstated },
        `Lifecycle reconciled: ${String(retired)} retired, ${String(reinstated)} reinstated`,
      );
    }

    return { retired, reinstated, skippedReason: undefined };
  }

  /**
   * Retires refs this repository no longer has — EPIC-032 AC-7.
   *
   * **The one place in Ferret where absence is evidence, and it is deliberate.**
   * Everywhere else, EPIC-032 refuses to infer deletion from a thing not being
   * there: a file missing from a listing might be missing from the *listing*.
   * Git makes refs different. It records no deletion event for one, so a
   * complete enumeration is the only observation there will ever be, and the
   * Epic's §3.4 says so. AC-7 is worded around completeness for that reason.
   *
   * Which puts the whole safety property on `complete`. A bounded enumeration
   * retires nothing, and the gate fails closed with a reason rather than
   * silently — the failure mode is a run that retires every branch past the
   * first page and looks exactly like a successful one.
   */
  async #reconcileBranches(
    repositoryId: string,
    enumeration: { complete: boolean; present: ReadonlySet<string> },
    now: Date,
    context: ProviderOperationContext,
  ): Promise<LifecycleCounts['branches']> {
    const store = this.#lifecycle;
    const none = (reason: string): LifecycleCounts['branches'] => {
      this.#logger?.info(
        { operation: 'index.lifecycle.branches', repository: repositoryId, skipped: reason },
        `Branch reconciliation skipped: ${reason}`,
      );
      return { retired: 0, skippedReason: reason };
    };

    if (store === undefined) return none('no lifecycle store is configured');
    if (!enumeration.complete) {
      return none('the branch enumeration was bounded, so absence proves nothing');
    }
    if (context.signal?.aborted === true) return none('the run was cancelled');

    const live = await store.liveBranches(repositoryId);
    let retired = 0;
    for (const branch of live) {
      // Per ref rather than per batch, so a cancelled run stops where it is and
      // every write so far is independently correct.
      throwIfAborted(context.signal, 'index.lifecycle.branches');
      if (enumeration.present.has(branch.entityId)) continue;
      // `now`, not a valid time: Git cannot say when the ref went, and
      // inventing an instant would be manufacturing certainty (Governance §6).
      if (await store.retireBranch(branch.entityId, repositoryId, now, now)) retired += 1;
    }

    if (retired > 0) {
      this.#logger?.info(
        { operation: 'index.lifecycle.branches', repository: repositoryId, retired },
        `Branches reconciled: ${String(retired)} retired`,
      );
    }

    return { retired, skippedReason: undefined };
  }

  /**
   * Where the last run got to — EPIC-075 AC-6.
   *
   * Through the cursor port when one is composed, and through the artefact
   * store otherwise. The version check that used to live here moved into
   * `SyncCursorStore`, so the rule — *a position written by a different build
   * is not trustworthy, because that build may read or model the source
   * differently and resuming would leave a gap nothing fills* — is applied in
   * one place rather than remembered per caller. The fallback below keeps it,
   * because a run without a cursor port must not become a run that trusts a
   * stale position.
   */
  async #readWatermark(repositoryId: string): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (this.#cursors !== undefined) {
      return (await this.#cursors.read(repositoryId))?.position;
    }
    const artifact = await this.#watermarks.getArtifact(INDEX_ARTIFACT_KIND, repositoryId);
    if (artifact === undefined) return undefined;
    if (artifact.producerVersion !== VERSION) return undefined;
    return artifact.metadata;
  }

  /**
   * Reconciles the conflict state of every subject this run wrote about.
   *
   * One subject at a time and each in its own transaction, so a failure on one
   * subject does not roll back the reconciliation of the others — the same
   * failure-isolation shape EPIC-093 asks for and EPIC-108 applies per file.
   * A reconciliation that throws is reported by the run rather than failing it:
   * conflict state is Ferret's interpretation, and losing an interpretation is
   * not worth losing an index run over.
   */
  async #reconcileConflicts(
    subjects: ReadonlySet<string>,
    now: Date,
  ): Promise<{ subjects: number; groups: number } | undefined> {
    const reconcile = this.#evidence.reconcileConflicts?.bind(this.#evidence);
    if (reconcile === undefined) return undefined;

    let groups = 0;
    for (const subjectId of subjects) {
      try {
        groups += (await reconcile(subjectId, now)).groups;
      } catch (error) {
        this.#logger?.warn(
          {
            operation: 'index.conflicts',
            subject: subjectId,
            reason: error instanceof Error ? error.message : 'the reconciliation failed',
          },
          'Could not reconcile conflict state for one subject; the run continues',
        );
      }
    }
    return { subjects: subjects.size, groups };
  }

  async #writeWatermark(
    repositoryId: string,
    lastCommitAt: string | undefined,
    tips: readonly string[],
    now: Date,
  ): Promise<void> {
    // `lastCommitAt` is no longer what the next run resumes from — `tips` is —
    // but it is still what "how far behind is this source" is measured from, so
    // it is clamped to now. A commit dated in the future is a repository's
    // mistake, and carrying it into the position made that mistake Ferret's:
    // the stored date outran every real commit and the source went quiet.
    const clamped = clampToNow(lastCommitAt, now);
    const position = {
      ...(clamped === undefined ? {} : { lastCommitAt: clamped }),
      ...(tips.length === 0 ? {} : { tips: [...tips] }),
      indexedAt: now.toISOString(),
    };
    if (this.#cursors !== undefined) {
      // Same kind, same scope, same metadata as the line below — EPIC-075 is a
      // generalisation of this write, not a replacement for it, so an
      // installation's existing watermarks keep working and no re-read is
      // triggered by the change.
      await this.#cursors.advance(INDEXER_PRODUCER, repositoryId, position, now);
      return;
    }
    await this.#watermarks.recordArtifact(
      {
        kind: INDEX_ARTIFACT_KIND,
        scopeId: repositoryId,
        producer: INDEXER_PRODUCER,
        producerVersion: VERSION,
        metadata: position,
      },
      now,
    );
  }
}

/**
 * The scope a watermark belongs to — issue #19.
 *
 * A watermark records how far a *read* got, and `--revision` means two reads of
 * one repository can be at different places. Sharing one watermark between them
 * makes each run skip whatever the other had already passed, which loses commits
 * with nothing failing and no later run going back for them.
 *
 * Derived through EPIC-009's identity function so that `derived_artifact`'s
 * unique `(kind, scope_id)` index keeps holding without a schema change. The
 * rejected alternative — recording the revision in metadata and forcing a full
 * read whenever it differs — is simpler, and would re-read all of history every
 * time someone alternated between two branches.
 *
 * The default revision keeps the bare repository id, so watermarks written
 * before this existed are still found and the upgrade costs no re-read.
 */
export function watermarkScopeId(repositoryId: string, revision: string | undefined): string {
  if (revision === undefined || revision === 'HEAD') return repositoryId;
  return canonicalId(encodeKeyParts([INDEX_ARTIFACT_KIND, repositoryId, revision]));
}

/**
 * A history graph without the `file` entities the tree stage already wrote.
 *
 * EPIC-020's history emitter produces a `file` entity per path a commit
 * touched, holding `{ path, extension }`. That is the right entity and the
 * poorer description of it, and an upsert replaces attributes rather than
 * merging them — so on a content run it would overwrite the structure the tree
 * stage just recorded on the same entity.
 *
 * Dropping it is safe precisely because the tree stage ran first: the entity
 * exists, so every relationship in this graph still has its target. Only ids
 * this run actually wrote are dropped, so a file that appears in history and
 * *not* in the tree — a deleted one — is still created here, which is what
 * EPIC-032 needs in order to have something to tombstone.
 */
function withoutRewrittenFiles(graph: Graph, written: ReadonlySet<string>): Graph {
  if (written.size === 0) return graph;
  const entities = graph.entities.filter((entity) => !(entity.kind === 'file' && written.has(entity.id)));
  if (entities.length === graph.entities.length) return graph;
  return { ...graph, entities };
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
 * How many pages one history read will follow.
 *
 * At the provider's page size this is far more history than any repository has,
 * and it exists only so a provider that returned a cursor for ever could not
 * make a run unbounded. Hitting it is a provider defect, and the run says so
 * rather than reporting a complete read.
 */
const MAX_HISTORY_PAGES = 10_000;

/** How many tips a position carries. Well above one per branch anyone indexes. */
const MAX_TIPS = 64;

/**
 * The commits a stored position says were already read.
 *
 * Absent on a position written before tips existed, and on one written by a run
 * that read no history. Both mean the same thing to the caller — there is no
 * exclusion to apply — and neither is an error.
 */
function readTips(position: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const tips = position?.['tips'];
  if (!Array.isArray(tips)) return [];
  return tips.filter((tip): tip is string => typeof tip === 'string' && /^[0-9a-f]{7,64}$/.test(tip));
}

/**
 * The tip set, with this run's tip in it.
 *
 * Newest first and bounded, so indexing many branches in turn cannot grow a
 * position without limit. Dropping the oldest tip costs a re-read of commits
 * that are already written — idempotent — rather than a gap.
 */
function rememberTip(tips: readonly string[], tip: string): readonly string[] {
  return [tip, ...tips.filter((existing) => existing !== tip)].slice(0, MAX_TIPS);
}

/**
 * A commit instant, never later than the instant it was observed.
 *
 * The stored date is a fact about how far Ferret has read, and a commit dated
 * in 2035 is not evidence that Ferret has read 2035. Clamping keeps "how far
 * behind is this source" answerable; it is no longer load-bearing for
 * *resuming*, which is why the clamp is safe to apply at all.
 */
function clampToNow(instant: string | undefined, now: Date): string | undefined {
  if (instant === undefined) return undefined;
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) return undefined;
  return parsed > now.getTime() ? now.toISOString() : instant;
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
