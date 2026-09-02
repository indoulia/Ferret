import { describe, expect, it } from 'vitest';

import {
  BatchEmitter,
  CONFIDENCE_BANDS,
  Completeness,
  Confidence,
  EvidenceMethod,
  LinkRule,
  MemoryOrigin,
  ORIGIN_CONFIDENCE,
  RULE_CONFIDENCE,
  SourceAuthority,
  completenessOf,
  createEvidence,
  derivedConfidence,
  isUnassessedConfidence,
  preferredEvidence,
  type CanonicalEvidence,
} from '../../src/index.js';

/**
 * EPIC-046.
 *
 * The Epic's central claim is a *negative* one — that confidence must not be
 * derived from `method`, because authority already is — so the tests that matter
 * most are the ones asserting the scale is the one already in use and that
 * nothing invents a number where no rule determined one.
 */

const OMISSION_REASONS = ['binary', 'over-size-bound', 'undecodable', 'secret-scan-failed'];

function evidence(overrides: Partial<Parameters<typeof createEvidence>[0]> = {}): CanonicalEvidence {
  return createEvidence({
    subjectId: '01J00000000000000000000000',
    field: 'attributes.name',
    statement: 'a value',
    method: EvidenceMethod.OBSERVED,
    producer: 'test',
    producerVersion: '1.0.0',
    sourceSystem: 'git',
    ...overrides,
  });
}

describe('the scale is the one already in use — AC-1, AC-2', () => {
  it('gives every band the value the producer that already used it chose', () => {
    // Changing one of these would be re-deciding EPIC-009 or EPIC-042 from
    // outside, which is why they are asserted against the tables rather than
    // against literals in two places.
    expect(RULE_CONFIDENCE[LinkRule.MAILMAP]).toBe(Confidence.CERTAIN);
    expect(RULE_CONFIDENCE[LinkRule.SAME_ADDRESS]).toBe(Confidence.STRONG);
    expect(RULE_CONFIDENCE[LinkRule.GITHUB_NOREPLY_LOGIN]).toBe(Confidence.PROBABLE);
    expect(RULE_CONFIDENCE[LinkRule.SAME_NAME_AND_LOCAL_PART]).toBe(Confidence.EVEN);
    expect(ORIGIN_CONFIDENCE[MemoryOrigin.EXPLICIT]).toBe(Confidence.STRONG);
    expect(ORIGIN_CONFIDENCE[MemoryOrigin.EXTRACTED]).toBe(Confidence.PLAUSIBLE);
  });

  it('leaves the numbers where the two validated Epics put them', () => {
    expect(RULE_CONFIDENCE).toStrictEqual({
      [LinkRule.MAILMAP]: 1,
      [LinkRule.SAME_ADDRESS]: 0.95,
      [LinkRule.GITHUB_NOREPLY_LOGIN]: 0.8,
      [LinkRule.SAME_NAME_AND_LOCAL_PART]: 0.5,
    });
    expect(ORIGIN_CONFIDENCE).toStrictEqual({
      [MemoryOrigin.EXPLICIT]: 0.95,
      [MemoryOrigin.EXTRACTED]: 0.6,
    });
  });

  it('keeps every band inside the field the schema allows, and orders them', () => {
    for (const band of CONFIDENCE_BANDS) {
      expect(band).toBeGreaterThanOrEqual(0);
      expect(band).toBeLessThanOrEqual(1);
    }
    // `EVEN` is the floor and is named for what it is: as likely wrong as right.
    // Nothing below is offered, because a producer that believes a statement is
    // probably false should not be emitting it as evidence.
    expect(Math.min(...CONFIDENCE_BANDS)).toBe(Confidence.EVEN);
    expect(Math.max(...CONFIDENCE_BANDS)).toBe(Confidence.CERTAIN);
  });

  it('exposes no mapping from a method to a confidence — AC-2', () => {
    // The negative claim, asserted rather than trusted. Authority is keyed on
    // method; a confidence keyed on the same input would say the same thing
    // twice on a different scale.
    const exported = Object.keys(Confidence);
    for (const method of Object.values(EvidenceMethod)) {
      expect(exported).not.toContain(method);
      expect(exported).not.toContain(method.toUpperCase());
    }
    // And the two remain independently varying: both `SAME_ADDRESS` and
    // `SAME_NAME_AND_LOCAL_PART` are `inferred`, and they are 0.45 apart.
    expect(RULE_CONFIDENCE[LinkRule.SAME_ADDRESS]).not.toBe(
      RULE_CONFIDENCE[LinkRule.SAME_NAME_AND_LOCAL_PART],
    );
  });
});

describe('a conclusion is no more certain than what it rests on — AC-4 to AC-6', () => {
  it('takes the minimum of the chain — AC-4', () => {
    expect(derivedConfidence([Confidence.CERTAIN, Confidence.EVEN, Confidence.STRONG])).toBe(
      Confidence.EVEN,
    );
    expect(derivedConfidence([Confidence.PROBABLE])).toBe(Confidence.PROBABLE);
  });

  it('is unassessed when any input is unassessed — AC-5', () => {
    // "No more certain than the weakest" cannot be evaluated when the weakest is
    // unknown, and the minimum of the known ones would state a bound Ferret
    // cannot support. Governance §6, and deliberately the conservative answer.
    expect(derivedConfidence([Confidence.CERTAIN, undefined])).toBeUndefined();
    expect(derivedConfidence([undefined])).toBeUndefined();
  });

  it('is unassessed for an empty chain — AC-6', () => {
    // Not certain. A conclusion resting on nothing recorded is not one Ferret
    // can vouch for.
    expect(derivedConfidence([])).toBeUndefined();
  });

  it('treats a zero input as a bound, not as absent', () => {
    // `0` says "believed false" and is a perfectly good minimum.
    expect(derivedConfidence([Confidence.CERTAIN, 0])).toBe(0);
  });
});

describe('unassessed is not zero — AC-12, AC-13', () => {
  it('distinguishes undefined from zero — AC-12', () => {
    expect(isUnassessedConfidence(undefined)).toBe(true);
    expect(isUnassessedConfidence(0)).toBe(false);
    expect(isUnassessedConfidence(Confidence.EVEN)).toBe(false);
  });

  it('round-trips a zero confidence without losing it — AC-13', () => {
    const record = evidence({ confidence: 0 });

    expect(record.confidence).toBe(0);
    expect(isUnassessedConfidence(record.confidence)).toBe(false);
  });

  it('leaves confidence unassessed when no rule determined one — AC-3', () => {
    // Most evidence will stay here, and that is the correct outcome of §8.1
    // rather than a shortfall: what a commit contains is not a probabilistic
    // claim.
    expect(evidence().confidence).toBeUndefined();
  });
});

describe('completeness comes from what the read did — AC-10, AC-11', () => {
  it.each(OMISSION_REASONS)('maps the omission reason %s to partial', (reason) => {
    expect(completenessOf({ omittedReason: reason })).toBe(Completeness.PARTIAL);
  });

  it('maps a bounded enumeration to partial and a full one to complete', () => {
    expect(completenessOf({ enumerated: false })).toBe(Completeness.PARTIAL);
    expect(completenessOf({ enumerated: true })).toBe(Completeness.COMPLETE);
  });

  it('maps a content read that kept its text to complete', () => {
    // Presence of the key, not truthiness of the value: a read that reported
    // `omittedReason: undefined` kept the text.
    expect(completenessOf({ omittedReason: undefined })).toBe(Completeness.COMPLETE);
  });

  it('leaves an absent signal unknown, never partial — AC-11', () => {
    // Reporting evidence partial because nobody said otherwise is the failure
    // EPIC-094 recorded, after which an operator stops reading the output.
    expect(completenessOf({})).toBe(Completeness.UNKNOWN);
    expect(completenessOf({ enumerated: undefined })).toBe(Completeness.UNKNOWN);
  });

  it('takes partial from either signal when the two disagree', () => {
    expect(completenessOf({ omittedReason: 'binary', enumerated: true })).toBe(Completeness.PARTIAL);
    expect(completenessOf({ omittedReason: undefined, enumerated: false })).toBe(Completeness.PARTIAL);
  });
});

describe('propagation at the emission seam — AC-7, AC-8, AC-9', () => {
  const emitter = (): BatchEmitter =>
    new BatchEmitter({ sourceSystem: 'git', producer: 'test', producerVersion: '1.0.0' });

  it('gives a conclusion the confidence of its chain — AC-7', () => {
    const batch = emitter();
    const weak = batch.parsed({
      subjectId: '01J00000000000000000000000',
      statement: 'a shaky reading',
      confidence: Confidence.EVEN,
    });
    const strong = batch.parsed({
      subjectId: '01J00000000000000000000000',
      field: 'other',
      statement: 'a solid reading',
      confidence: Confidence.CERTAIN,
    });

    const conclusion = batch.inferred({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'worked out from both',
      derivedFrom: [weak.id, strong.id],
    });

    expect(conclusion.confidence).toBe(Confidence.EVEN);
  });

  it('keeps a confidence the producer supplied — AC-8', () => {
    const batch = emitter();
    const weak = batch.parsed({
      subjectId: '01J00000000000000000000000',
      statement: 'a shaky reading',
      confidence: Confidence.EVEN,
    });

    const conclusion = batch.inferred({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'assessed by its own producer',
      derivedFrom: [weak.id],
      confidence: Confidence.PROBABLE,
    });

    // Propagation fills a gap; it does not overrule a producer that assessed its
    // own output.
    expect(conclusion.confidence).toBe(Confidence.PROBABLE);
  });

  it('leaves a conclusion unassessed when the chain cannot be followed — AC-9', () => {
    const batch = emitter();

    const conclusion = batch.inferred({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'rests on something this batch never saw',
      derivedFrom: ['01JZZZZZZZZZZZZZZZZZZZZZZZ'],
    });

    expect(conclusion.confidence).toBeUndefined();
  });

  it('leaves a conclusion unassessed when any link is unassessed — AC-5, AC-7', () => {
    const batch = emitter();
    const assessed = batch.parsed({
      subjectId: '01J00000000000000000000000',
      statement: 'assessed',
      confidence: Confidence.CERTAIN,
    });
    const unassessed = batch.parsed({
      subjectId: '01J00000000000000000000000',
      field: 'other',
      statement: 'nobody assessed this',
    });

    const conclusion = batch.inferred({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'worked out from both',
      derivedFrom: [assessed.id, unassessed.id],
    });

    expect(conclusion.confidence).toBeUndefined();
  });

  it('keeps the record id consistent with its content', () => {
    // The one mistake this seam cannot make: a record's id is derived from its
    // fields, so setting confidence after `createEvidence` would produce a
    // record whose id no longer matches its content.
    const batch = emitter();
    const input = batch.parsed({
      subjectId: '01J00000000000000000000000',
      statement: 'a reading',
      confidence: Confidence.STRONG,
    });
    const conclusion = batch.inferred({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'derived',
      derivedFrom: [input.id],
    });

    const rebuilt = createEvidence({
      subjectId: '01J00000000000000000000000',
      field: 'conclusion',
      statement: 'derived',
      method: EvidenceMethod.INFERRED,
      producer: 'test',
      producerVersion: '1.0.0',
      sourceSystem: 'git',
      derivedFrom: [input.id],
      confidence: Confidence.STRONG,
      authority: conclusion.authority,
    });

    expect(conclusion.id).toBe(rebuilt.id);
    expect(conclusion.integrityHash).toBe(rebuilt.integrityHash);
  });
});

describe('the tiebreak that used to fall through — AC-14', () => {
  it('discriminates on confidence where authority ties', () => {
    // Both orderings consult confidence *under* authority, and until this Epic
    // nothing set it — so both fell straight through to recency.
    const at = '2026-01-01T00:00:00.000Z';
    const sure = {
      ...evidence({ statement: 'sure' }),
      authority: SourceAuthority.PARSED,
      confidence: Confidence.CERTAIN,
      observedAt: at,
    };
    const unsure = {
      ...evidence({ statement: 'unsure' }),
      authority: SourceAuthority.PARSED,
      confidence: Confidence.EVEN,
      observedAt: at,
    };

    expect(preferredEvidence([unsure, sure])?.statement).toBe('sure');
  });

  it('still prefers authority over confidence', () => {
    // Confidence is the tiebreak *under* authority, and making it discriminate
    // must not promote it above the thing EPIC-045 decided.
    const at = '2026-01-01T00:00:00.000Z';
    const authoritative = {
      ...evidence({ statement: 'authoritative' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      confidence: Confidence.EVEN,
      observedAt: at,
    };
    const confident = {
      ...evidence({ statement: 'confident' }),
      authority: SourceAuthority.ASSERTED,
      confidence: Confidence.CERTAIN,
      observedAt: at,
    };

    expect(preferredEvidence([confident, authoritative])?.statement).toBe('authoritative');
  });
});
