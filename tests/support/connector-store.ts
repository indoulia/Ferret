import { createEntity, evidenceKey, relationshipKey } from '../../src/domain/index.js';
import type { CanonicalEntity, EntityInput, EvidenceInput, RelationshipInput } from '../../src/domain/index.js';
import type {
  EntityWriter,
  EvidenceWriter,
  RelationshipWriter,
  SyncCursors,
} from '../../src/indexing/index.js';
import type { IngestDependencies } from '../../src/index.js';
import { createNullLogger } from '../../src/logging/index.js';

/**
 * A store that stores, for the connector suites — EPIC-119, EPIC-120.
 *
 * Lifted out of the EPIC-119 suite unchanged when EPIC-120 needed the same
 * measurements against a repository. A second copy would have been a second
 * definition of what "idempotent" means, and the two would have disagreed the
 * first time either was corrected.
 *
 * It behaves like the real store in the two ways the assertions depend on: it
 * derives the canonical id and content hash through `createEntity`, the same
 * function the real store uses, and it deduplicates evidence on the same key.
 * So "wrote the same row twice" is observed rather than assumed.
 */
export interface ConnectorStore {
  readonly entities: Map<string, { entity: CanonicalEntity; writes: number }>;
  readonly relationships: Map<string, RelationshipInput>;
  readonly evidence: Map<string, EvidenceInput>;
  readonly order: string[];
  readonly cursorPositions: Map<string, Record<string, unknown>>;
  readonly cursorProducers: Map<string, string>;
}

export function connectorStore(): { deps: IngestDependencies; state: ConnectorStore } {
  const state: ConnectorStore = {
    entities: new Map(),
    relationships: new Map(),
    evidence: new Map(),
    order: [],
    cursorPositions: new Map(),
    cursorProducers: new Map(),
  };

  const entities: EntityWriter = {
    upsert: (input: EntityInput, _now, options) => {
      state.order.push('entity');
      const derived = createEntity(input);
      const existing = state.entities.get(derived.id);
      if (existing === undefined) {
        state.entities.set(derived.id, { entity: derived, writes: 1 });
        return Promise.resolve({ entity: derived, outcome: 'created' });
      }
      // `ifAbsent` is the placeholder rule: a stub emitted so an edge has an
      // endpoint must leave a record an earlier pass read in full exactly as
      // it is (issue #48).
      if (options?.ifAbsent === true) {
        return Promise.resolve({ entity: existing.entity, outcome: 'unchanged' });
      }
      if (existing.entity.contentHash === derived.contentHash) {
        return Promise.resolve({ entity: existing.entity, outcome: 'unchanged' });
      }
      state.entities.set(derived.id, { entity: derived, writes: existing.writes + 1 });
      return Promise.resolve({ entity: derived, outcome: 'updated' });
    },
  };

  const relationships: RelationshipWriter = {
    assert: (input: RelationshipInput) => {
      state.order.push('relationship');
      state.relationships.set(
        relationshipKey(input.fromId, input.type, input.toId, input.validFrom ?? ''),
        input,
      );
      return Promise.resolve({ relationship: {} as never, outcome: 'opened' });
    },
  };

  const evidence: EvidenceWriter = {
    record: (input: EvidenceInput) => {
      state.order.push('evidence');
      const key = evidenceKey({
        subjectId: input.subjectId,
        field: input.field,
        statement: input.statement,
        method: input.method,
        producer: input.producer,
        producerVersion: input.producerVersion,
        sourceSystem: input.sourceSystem,
        sourceId: input.sourceId,
        locator: input.locator,
      });
      const deduplicated = state.evidence.has(key);
      if (!deduplicated) state.evidence.set(key, input);
      return Promise.resolve({ evidence: {} as never, deduplicated });
    },
  };

  const cursors: SyncCursors = {
    read: (scopeId) => {
      const position = state.cursorPositions.get(scopeId);
      return Promise.resolve(position === undefined ? undefined : { position });
    },
    advance: (producer, scopeId, position) => {
      state.cursorProducers.set(scopeId, producer);
      state.cursorPositions.set(scopeId, { ...position });
      return Promise.resolve();
    },
  };

  return { deps: { entities, relationships, evidence, cursors, logger: createNullLogger() }, state };
}

/** A cancellable operation context that logs nowhere. */
export function connectorContext(): {
  logger: ReturnType<typeof createNullLogger>;
  signal: AbortSignal;
} {
  return { logger: createNullLogger(), signal: new AbortController().signal };
}
