import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../domain/index.js';
import type { EntityWriter, EvidenceWriter, RelationshipWriter } from '../indexing/ports.js';
import { toEntityInput, toEvidenceInput, toRelationshipInput } from '../indexing/ports.js';
import { throwIfAborted } from '../providers/sdk/cancellation.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

/**
 * The one way canonical knowledge reaches storage — EPIC-119 §8.2.
 *
 * This function is not new behaviour. It is `ProjectSynchronizer.#write`,
 * lifted out unchanged so that `SourceIngestor` can *be* that path rather than
 * resemble it. A second implementation of "entities, then relationships, then
 * evidence, then reconcile" would have been the parallel ingestion model
 * EPIC-119 exists to prevent, and it would have drifted at the first change:
 * the `reconcileConflicts` sweep below was added to the sync path five Epics
 * after the indexer's, because it had to be remembered twice.
 *
 * Three rules are load-bearing, and each of them cost an Epic to learn:
 *
 * - **The order is fixed.** The database has foreign keys, so evidence about an
 *   entity nothing has written yet fails on a source ingested for the first
 *   time. It is not a preference.
 * - **Placeholders are written `ifAbsent`.** An entity emitted only so an edge
 *   has an endpoint must not overwrite a record an earlier pass read in full —
 *   issue #48.
 * - **Conflicts are reconciled for the subjects this pass wrote about**, and
 *   only those: they are exactly the ones whose conflict state can have
 *   changed. `EvidenceState.CONFLICTING` was unreachable for five Epics because
 *   it depended on a caller remembering to ask (EPIC-047 §8.4).
 */
export interface ContributionGraph {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
  readonly placeholderEntityIds?: readonly string[];
}

export interface ContributionWriters {
  readonly entities: EntityWriter;
  readonly relationships: RelationshipWriter;
  readonly evidence: EvidenceWriter;
}

/** What one write pass did. The counts a report quotes. */
export interface ContributionWrites {
  readonly entitiesCreated: number;
  readonly entitiesUpdated: number;
  readonly entitiesUnchanged: number;
  readonly relationships: number;
  readonly evidenceRecorded: number;
  readonly evidenceDeduplicated: number;
}

export const NO_WRITES: ContributionWrites = Object.freeze({
  entitiesCreated: 0,
  entitiesUpdated: 0,
  entitiesUnchanged: 0,
  relationships: 0,
  evidenceRecorded: 0,
  evidenceDeduplicated: 0,
});

/** Adds two write tallies. For a pass that writes page by page. */
export function addWrites(left: ContributionWrites, right: ContributionWrites): ContributionWrites {
  return {
    entitiesCreated: left.entitiesCreated + right.entitiesCreated,
    entitiesUpdated: left.entitiesUpdated + right.entitiesUpdated,
    entitiesUnchanged: left.entitiesUnchanged + right.entitiesUnchanged,
    relationships: left.relationships + right.relationships,
    evidenceRecorded: left.evidenceRecorded + right.evidenceRecorded,
    evidenceDeduplicated: left.evidenceDeduplicated + right.evidenceDeduplicated,
  };
}

export async function writeContribution(
  graph: ContributionGraph,
  writers: ContributionWriters,
  now: Date,
  context: ProviderOperationContext,
  operation = 'ingest',
): Promise<ContributionWrites> {
  const placeholders = new Set(graph.placeholderEntityIds ?? []);
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const entity of graph.entities) {
    throwIfAborted(context.signal, operation);
    const result = await writers.entities.upsert(
      toEntityInput(entity),
      now,
      placeholders.has(entity.id) ? { ifAbsent: true } : {},
    );
    if (result.outcome === 'created') created += 1;
    else if (result.outcome === 'updated') updated += 1;
    else unchanged += 1;
  }

  let relationships = 0;
  for (const edge of graph.relationships) {
    throwIfAborted(context.signal, operation);
    await writers.relationships.assert(toRelationshipInput(edge), now);
    relationships += 1;
  }

  let recorded = 0;
  let deduplicated = 0;
  const subjects = new Set<string>();
  for (const record of graph.evidence) {
    throwIfAborted(context.signal, operation);
    const result = await writers.evidence.record(toEvidenceInput(record), now);
    if (result.deduplicated) deduplicated += 1;
    else {
      recorded += 1;
      subjects.add(record.subjectId);
    }
  }

  for (const subjectId of subjects) {
    await writers.evidence.reconcileConflicts?.(subjectId, now);
  }

  return {
    entitiesCreated: created,
    entitiesUpdated: updated,
    entitiesUnchanged: unchanged,
    relationships,
    evidenceRecorded: recorded,
    evidenceDeduplicated: deduplicated,
  };
}
