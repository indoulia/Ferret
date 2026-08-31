import type {
  CanonicalEntity,
  CanonicalEvidence,
  CanonicalRelationship,
  EntityInput,
  EvidenceInput,
  RelationshipInput,
} from '../domain/index.js';
import type {
  DiscoveredRepository,
  FileContent,
  FileContentRequest,
  ProviderOperationContext,
} from '../providers/index.js';

/**
 * What the indexer needs from storage, expressed as ports rather than as
 * imports.
 *
 * The indexer is **core logic**: deciding what to read, in what order, and what
 * has already been seen has nothing to do with PostgreSQL. If it imported the
 * storage module directly, the core would gain a database dependency and
 * Governance §4's central claim — that replacing a provider requires no
 * unrelated core change — would be false at the first place it mattered.
 *
 * So the indexer names the four narrow interfaces it actually uses, and the
 * EPIC-002 stores satisfy them structurally without knowing this file exists.
 * The architecture test proves the core still reaches no `storage/` module.
 *
 * The shapes are deliberately the *stores'* shapes rather than idealised ones.
 * An adapter layer here would be a second place for an outcome enum to drift.
 */

export interface EntityWriteResult {
  readonly entity: CanonicalEntity;
  /** `created`, `updated` or `unchanged` — see EPIC-006's `UpsertOutcome`. */
  readonly outcome: string;
}

export interface EntityWriter {
  upsert(input: EntityInput, now?: Date): Promise<EntityWriteResult>;
}

export interface RelationshipWriteResult {
  readonly relationship: CanonicalRelationship;
  /** `opened`, `updated`, `unchanged` or `stale` — see EPIC-007's `AssertOutcome`. */
  readonly outcome: string;
}

export interface RelationshipWriter {
  assert(input: RelationshipInput, now?: Date): Promise<RelationshipWriteResult>;
}

export interface EvidenceWriteResult {
  readonly evidence: CanonicalEvidence;
  /** True when this exact observation was already on record. */
  readonly deduplicated: boolean;
}

export interface EvidenceWriter {
  record(input: EvidenceInput, now?: Date): Promise<EvidenceWriteResult>;
}

/**
 * Where the indexer remembers how far it got.
 *
 * EPIC-010's derived-artifact store, reached through the narrowest interface
 * that fits. A watermark *is* a derived artefact — something Ferret built,
 * attributed to a producer and a version, that becomes stale when either
 * changes — so this reuses that rather than adding a table with the same
 * columns and a different name.
 */
export interface WatermarkRecord {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly producerVersion: string;
}

/**
 * One entity whose recorded lifecycle disagrees with what was observed.
 *
 * The shape EPIC-032's store returns, named here so the indexer can reason
 * about lifecycle without knowing a database exists.
 */
export interface PendingLifecycleChange {
  readonly entityId: string;
  readonly path: string;
  readonly action: 'retire' | 'reinstate';
  readonly at: Date;
}

/**
 * Where the indexer reconciles what Ferret believes with what it observed.
 *
 * Deliberately a *reconciliation* rather than a delta. An incremental run reads
 * no commit that mentions a file deleted years ago, so a port that only accepted
 * this run's changes would leave every already-wrong entity wrong for ever —
 * which is precisely the state EPIC-032 found Ferret's own index in.
 */
export interface LifecycleStore {
  pendingChanges(repositoryId: string, limit?: number): Promise<readonly PendingLifecycleChange[]>;
  retire(entityId: string, repositoryId: string, at: Date, now?: Date): Promise<boolean>;
  reinstate(entityId: string, now?: Date): Promise<boolean>;
}

export interface WatermarkStore {
  getArtifact(kind: string, scopeId?: string): Promise<WatermarkRecord | undefined>;
  recordArtifact(
    input: {
      kind: string;
      scopeId?: string | undefined;
      producer: string;
      producerVersion: string;
      sourceContentHash?: string | undefined;
      metadata?: Record<string, unknown>;
    },
    now?: Date,
  ): Promise<unknown>;
}

/**
 * Where the indexer obtains a file's bytes — EPIC-108 §8.3.
 *
 * A port for the same reason the four above are ports, and for one more that is
 * specific to this Epic. EPIC-031 §11 states that "the indexer adds no
 * subprocess, no filesystem access and no network"; content therefore cannot be
 * something the indexer *fetches*, only something it is *handed*. Naming the one
 * method it calls, rather than importing a provider, is what keeps that true —
 * and the architecture test proves the core reaches no concrete provider.
 *
 * Satisfied structurally by the `source.repository` capability's
 * `readFileContent`, so the Git provider fits it without knowing this file
 * exists.
 */
export interface ContentReader {
  readFileContent(
    repository: DiscoveredRepository,
    request: FileContentRequest,
    context: ProviderOperationContext,
  ): Promise<FileContent>;
}

/**
 * One derived-artefact record, as the gate needs to read it.
 *
 * The store's own shape rather than an idealised one, for the reason the header
 * of this file gives: an adapter here would be a second place for the staleness
 * rules to live and drift. EPIC-010's `CompatibilityService` satisfies this
 * structurally and knows nothing about it.
 */
export interface DerivedArtifactRecord {
  readonly producer: string;
  readonly producerVersion: string;
  readonly schemaVersion: number;
  readonly sourceContentHash: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Where the re-parse gate remembers what it already derived — EPIC-108 §8.7.
 *
 * Deliberately EPIC-010's derived-artefact store rather than a new table.
 * `validateArtifact` already answers the exact question the gate asks *and*
 * already distinguishes the reasons: "built by a different producer version" and
 * "the source content has changed" call for the same action and are different
 * facts, and an operator asking why everything is reparsing deserves the real
 * one.
 *
 * `validateArtifact` is on the port rather than reimplemented beside it. The
 * staleness rules are EPIC-010's, and a second copy of them here would be a
 * second thing to keep in step — which is the failure this whole file exists to
 * avoid.
 */
export interface ContentArtifactStore {
  getArtifact(kind: string, scopeId?: string): Promise<DerivedArtifactRecord | undefined>;
  validateArtifact(
    artifact: DerivedArtifactRecord,
    current: { producer: string; producerVersion: string; sourceContentHash?: string },
  ): { valid: boolean; reason: string | undefined };
  recordArtifact(
    input: {
      kind: string;
      scopeId?: string | undefined;
      producer: string;
      producerVersion: string;
      sourceContentHash?: string | undefined;
      metadata?: Record<string, unknown>;
    },
    now?: Date,
  ): Promise<unknown>;
}

/**
 * Why the content stage did not run, when it did not.
 *
 * Never silence, and never a block of zeroes: EPIC-108 §8.8 and Governance §6
 * both want "no result" and "nothing there" to look different. A run that was
 * not asked for content, and a run whose source could not provide it, are
 * different facts and an operator chasing either deserves the real one.
 */
export const ContentStageSkip = {
  /** Content indexing was not requested. The default. */
  NOT_REQUESTED: 'content indexing was not requested',
  /** Requested, but no content port was supplied to the indexer. */
  NO_CONTENT_PORT: 'no content reader is configured',
  /** Requested, but the source provider does not implement the operation. */
  UNSUPPORTED: 'the source provider does not support reading file content',
  /** Requested, but nowhere to put what the parse produced. */
  NO_SYMBOL_PORT: 'no symbol index is configured',
  /** Requested, but no parser framework was composed. */
  NO_PARSER: 'no parser was composed for this run',
  /** Requested, but no derived-artefact store, so the re-parse gate cannot work. */
  NO_GATE_STORE: 'no derived-artefact store is configured for the re-parse gate',
  /** Requested, and the file tree was not read, so there is nothing to read. */
  NO_FILE_TREE: 'the file tree was not read, so there were no files to read content for',
} as const;

export type ContentStageSkip = (typeof ContentStageSkip)[keyof typeof ContentStageSkip];
