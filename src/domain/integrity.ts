import { createEntity, type CanonicalEntity } from './entity.js';
import { integrityHashOf, type CanonicalEvidence } from './evidence.js';
import { canonicalId, canonicalKey } from './identity.js';
import { createRelationship, type CanonicalRelationship } from './relationship.js';

/**
 * Checking that what Ferret stored is still what Ferret derived — EPIC-094 §3.1.
 *
 * Both tables have carried `content_hash` since EPIC-006 and EPIC-007, computed
 * over everything a change could alter. It was used for exactly one thing:
 * comparing two *in-memory* values during ingestion to skip an unchanged write.
 * **Nothing recomputed it from a stored row.** An entity whose `attributes`
 * were edited outside Ferret verified against nothing and was served as fact.
 *
 * **Re-derived through the production function, never reimplemented.**
 * `createEntity` and `createRelationship` are pure and deterministic, so the
 * check is: rebuild the input from the row, run it through the same function
 * that wrote the row, and compare. A second implementation of the hash would be
 * a second thing to keep in step, and the failure mode of getting it wrong is a
 * checker that reports corruption where there is none — which is worse than no
 * checker, because it will be believed once and then ignored.
 *
 * Pure and dependency-free on purpose: the storage layer streams rows, this
 * decides, and neither needs the other to be tested.
 */

export const IntegrityFindingKind = {
  /** The stored content no longer hashes to the stored `content_hash`. */
  CONTENT_HASH_MISMATCH: 'content-hash-mismatch',
  /** The row's `id` is not what its canonical key derives to. */
  IDENTITY_MISMATCH: 'identity-mismatch',
  /** The row no longer satisfies the schema for its kind. */
  SCHEMA_INVALID: 'schema-invalid',
  /** An evidence observation was altered after it was written. */
  EVIDENCE_TAMPERED: 'evidence-tampered',
  /** A derived artefact built by a producer, version or schema no longer current. */
  STALE_ARTIFACT: 'stale-artifact',
  /** An index run that started and never recorded finishing. */
  UNFINISHED_RUN: 'unfinished-run',
} as const;

export type IntegrityFindingKind = (typeof IntegrityFindingKind)[keyof typeof IntegrityFindingKind];

/** Which table a finding is about. */
export const IntegritySubject = {
  ENTITY: 'entity',
  RELATIONSHIP: 'relationship',
  EVIDENCE: 'evidence',
  ARTIFACT: 'derived_artifact',
  RUN: 'index_run',
} as const;

export type IntegritySubject = (typeof IntegritySubject)[keyof typeof IntegritySubject];

/**
 * One thing that is wrong, said in a sentence an operator can act on.
 *
 * **Names, never values.** §11: a finding carries ids, kinds and counts and
 * never echoes a statement, an attribute value or anything that could carry a
 * secret. `canonicalKey` is the one identifier that can contain a repository
 * path, and it is included because AC-1 requires it: it is the entity's
 * identity, EPIC-082 already excluded secret-bearing paths at ingestion, and a
 * finding an operator cannot locate is not actionable.
 */
export interface IntegrityFinding {
  readonly kind: IntegrityFindingKind;
  readonly subject: IntegritySubject;
  readonly id: string;
  readonly entityKind: string | undefined;
  readonly canonicalKey: string | undefined;
  /** The repository or parent scope, when the row has one. */
  readonly scope: string | undefined;
  /** What is wrong. No stored value ever appears here. */
  readonly detail: string;
  /** AC-10 — a Ferret command, never SQL and never a table name. */
  readonly remediation: string;
}

/** The remediation every re-derivable finding gets. Governance §13: not a DBA's job. */
function reindexRemediation(scope: string | undefined): string {
  return scope === undefined
    ? 'Run `ferret verify --repair` to re-read the affected scope from source. Ferret supersedes the row; it never edits one to match its hash.'
    : `Run \`ferret verify --repair --scope ${scope}\` to re-read that repository from source. Ferret supersedes the row; it never edits one to match its hash.`;
}

/**
 * Verifies one stored entity against what Ferret would derive for it today.
 *
 * Returns every finding rather than the first: a row can be both re-pointed and
 * altered, and reporting one would send an operator to fix half of it.
 */
export function verifyEntity(stored: CanonicalEntity): readonly IntegrityFinding[] {
  // Two different scopes, and conflating them broke the identity check.
  //
  // `keyScope` is the entity's *identity* scope — what `canonicalKey` was
  // derived from — and must be passed back exactly as stored. `repairScope` is
  // where a re-read would start: for a repository entity that is the entity
  // itself, because a repository has no parent and a finding with nowhere to
  // repair from is the one row whose re-derivation is most obviously possible.
  const keyScope = stored.source.scope;
  const repairScope = stored.kind === 'repository' ? stored.id : keyScope;
  const base = {
    subject: IntegritySubject.ENTITY,
    id: stored.id,
    entityKind: stored.kind,
    canonicalKey: stored.canonicalKey,
    scope: repairScope,
    remediation: reindexRemediation(repairScope),
  } as const;

  // The identity check needs no re-derivation of content and must therefore
  // survive a row whose attributes no longer parse — so it runs first and
  // separately.
  const findings: IntegrityFinding[] = [];
  const expectedKey = canonicalKey({
    kind: stored.kind,
    sourceSystem: stored.source.system,
    sourceId: stored.source.id,
    ...(keyScope === undefined ? {} : { scope: keyScope }),
  });
  if (expectedKey !== stored.canonicalKey) {
    findings.push({
      ...base,
      kind: IntegrityFindingKind.IDENTITY_MISMATCH,
      detail: 'The stored canonical key is not the one this row\'s kind, source system and source id derive to.',
    });
  } else if (canonicalId(expectedKey) !== stored.id) {
    findings.push({
      ...base,
      kind: IntegrityFindingKind.IDENTITY_MISMATCH,
      detail: 'The row id is not the id its canonical key derives to; the row has been re-pointed.',
    });
  }

  let rederived: CanonicalEntity;
  try {
    rederived = createEntity({
      kind: stored.kind,
      source: { ...stored.source },
      lifecycle: stored.lifecycle,
      attributes: { ...stored.attributes },
      unknownFields: { ...stored.unknownFields },
      externalIds: [...stored.externalIds],
      ...(stored.sourceObservedAt === undefined ? {} : { sourceObservedAt: stored.sourceObservedAt }),
    });
  } catch {
    // A row that no longer satisfies its kind's schema is a finding, not an
    // exception to propagate: the sweep's job is to report every bad row, and
    // one that throws would stop it at the first.
    findings.push({
      ...base,
      kind: IntegrityFindingKind.SCHEMA_INVALID,
      detail: 'The stored row no longer satisfies the schema registered for its kind.',
    });
    return findings;
  }

  if (rederived.contentHash !== stored.contentHash) {
    // **Two causes, and the finding must not assert the wrong one.** A row the
    // source no longer contains cannot be re-derived, so it keeps whatever hash
    // it was written with — including one written before this Epic
    // canonicalised instants. Measured on Ferret's own index: all 14 mismatched
    // `file` rows were `deleted`. Calling those "altered outside Ferret" is a
    // false statement about the only rows a re-index can never fix.
    const retired = stored.lifecycle !== 'active';
    findings.push({
      ...base,
      kind: IntegrityFindingKind.CONTENT_HASH_MISMATCH,
      detail: retired
        ? 'The stored content does not hash to the recorded content hash. This row is retired, so re-reading the source cannot re-derive it: either it was altered outside Ferret, or it was written before the content hash treated timestamps canonically.'
        : 'The stored content does not hash to the recorded content hash: either it was altered outside Ferret, or it was written before the content hash treated timestamps canonically.',
      ...(retired
        ? {
            remediation:
              'A retired row has nothing left in the source to re-derive it from. Re-index if the path has returned; otherwise this is a historical record and cannot be re-verified.',
          }
        : {}),
    });
  }
  return findings;
}

/** Verifies one stored relationship. Same rule, same reason. */
export function verifyRelationship(stored: CanonicalRelationship): readonly IntegrityFinding[] {
  const base = {
    subject: IntegritySubject.RELATIONSHIP,
    id: stored.id,
    entityKind: stored.type,
    canonicalKey: undefined,
    scope: undefined,
    remediation: reindexRemediation(undefined),
  } as const;

  let rederived: CanonicalRelationship;
  try {
    rederived = createRelationship({
      fromId: stored.fromId,
      type: stored.type,
      toId: stored.toId,
      validFrom: stored.validFrom,
      ...(stored.validTo === null ? {} : { validTo: stored.validTo }),
      metadata: { ...stored.metadata },
      sourceSystem: stored.sourceSystem,
      ...(stored.sourceId === undefined ? {} : { sourceId: stored.sourceId }),
    });
  } catch {
    return [
      {
        ...base,
        kind: IntegrityFindingKind.SCHEMA_INVALID,
        detail: 'The stored row is no longer a valid relationship.',
      },
    ];
  }

  const findings: IntegrityFinding[] = [];
  if (rederived.id !== stored.id) {
    findings.push({
      ...base,
      kind: IntegrityFindingKind.IDENTITY_MISMATCH,
      detail: 'The row id is not the id its endpoints, type and validity derive to; the row has been re-pointed.',
    });
  }
  if (rederived.contentHash !== stored.contentHash) {
    findings.push({
      ...base,
      kind: IntegrityFindingKind.CONTENT_HASH_MISMATCH,
      detail: 'The stored content does not hash to the recorded content hash; it was altered outside Ferret.',
    });
  }
  return findings;
}

/**
 * Verifies one stored evidence record.
 *
 * EPIC-008 already had this check and already had the right remedy in its error
 * text; what it did not have was a caller. This is the same recomputation,
 * returned as a finding rather than thrown, so a sweep sees the whole picture
 * instead of stopping at the first bad row.
 */
export function verifyEvidence(stored: CanonicalEvidence): readonly IntegrityFinding[] {
  if (integrityHashOf(stored) === stored.integrityHash) return [];
  return [
    {
      kind: IntegrityFindingKind.EVIDENCE_TAMPERED,
      subject: IntegritySubject.EVIDENCE,
      id: stored.id,
      entityKind: undefined,
      canonicalKey: undefined,
      scope: stored.subjectId,
      // Evidence is append-only, so a record written before this Epic
      // canonicalised instants keeps its original hash for ever and can never
      // be re-verified. Indistinguishable here from tampering, so the wording
      // says both rather than asserting the one that sounds worse. Measured on
      // Ferret's own index: 135 such records, all predating the fix, none
      // altered.
      detail:
        'This observation does not match its recorded integrity hash. Either it was modified outside Ferret, or it was written before the integrity hash treated timestamps canonically — evidence is append-only, so an older record keeps its original hash and cannot be re-verified.',
      // EPIC-008's own words, kept: the only correct fix for an altered
      // observation is a fresh one, and editing evidence in place launders a
      // corruption into a fact.
      remediation:
        'Re-index the source with `ferret verify --repair` to record a fresh observation superseding this one; do not edit evidence in place.',
    },
  ];
}
