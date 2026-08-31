import type {
  CanonicalEntity,
  CanonicalEvidence,
  CanonicalRelationship,
  EntityInput,
  EvidenceInput,
  RelationshipInput,
} from '../domain/index.js';

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
