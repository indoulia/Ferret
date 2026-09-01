import {
  canonicalId,
  encodeKeyParts,
  type CanonicalEntity,
  type CanonicalEvidence,
  type CanonicalRelationship,
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
  readonly #logger: Logger | undefined;

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

    // Issue #19: the watermark is scoped to the *revision* that was read, not
    // to the repository. One watermark per repository silently skips commits —
    // index `HEAD`, then a feature branch, then `HEAD` again, and every `HEAD`
    // commit older than the feature branch's tip is never read. Nothing fails;
    // the graph is simply missing history and no later run goes back for it.
    const watermarkScope = watermarkScopeId(repositoryEntity.id, options.revision);

    const previous = options.full === true ? undefined : await this.#readWatermark(watermarkScope);
    const since = typeof previous?.lastCommitAt === 'string' ? previous.lastCommitAt : undefined;

    const entities = counter();
    const relationships = counter();
    let recorded = 0;
    let deduplicated = 0;
    const skipped: { path: string; reason: string }[] = [];

    const write = async (graph: Graph): Promise<void> => {
      // Entities, then relationships, then evidence. The database has foreign
      // keys; the reverse order fails on a repository never indexed before.
      const placeholders = new Set(graph.placeholderEntityIds ?? []);
      for (const entity of graph.entities) {
        const result = await this.#entities.upsert(
          toInput(entity),
          observedAt,
          placeholders.has(entity.id) ? { ifAbsent: true } : {},
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
      }
    };

    // The content stage decision, taken before anything is read.
    //
    // Up here rather than beside the stage it gates, because a run that cannot
    // read content must say so whether or not it ever reaches the file tree.
    const contentStage = this.#contentStage(options);
    let content: ContentCounts | undefined;
    let contentStructure: ReadonlyMap<string, FileStructure> | undefined;
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
    const branches = (await this.#source.listBranches(repository, {}, context)).items;
    await write(
      this.#source.emitGraph(repository, {
        worktrees: worktrees as readonly never[],
        branches: branches as readonly never[],
        observedAt,
      }),
    );

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
    if (contentStage.run) await runFileStage();

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
      const graph = this.#source.emitHistory(repository, page.commits as readonly never[], { observedAt });
      await write(withoutRewrittenFiles(graph, writtenFiles));
    }

    if (!contentStage.run) await runFileStage();

    // Stage 4 — reconcile what Ferret believes exists with what it observed.
    const lifecycle = await this.#reconcile(
      repositoryEntity.id,
      { complete: treeComplete, present },
      options,
      observedAt,
      context,
    );

    // The watermark moves only after everything above succeeded. A run that
    // failed halfway must be repeated, not resumed from a position it never
    // reached — Governance §6, never claim to know something you did not.
    await this.#writeWatermark(watermarkScope, newestCommitAt, observedAt);

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
      lifecycle,
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
  ): Promise<LifecycleCounts> {
    const store = this.#lifecycle;
    const none = (reason: string): LifecycleCounts => {
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
