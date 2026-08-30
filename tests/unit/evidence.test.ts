import { describe, expect, it } from 'vitest';

import {
  Completeness,
  EVIDENCE_METHODS,
  EvidenceMethod,
  EvidenceState,
  createEvidence,
  detectConflicts,
  evidenceKey,
  integrityHashOf,
  isCanonicalId,
  isDirectObservation,
  preferredEvidence,
  redactStatement,
  type EvidenceInput,
} from '../../src/index.js';

const SUBJECT = '11111111-1111-8111-8111-111111111111';

function observed(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    subjectId: SUBJECT,
    field: 'attributes.title',
    statement: 'Fix the parser',
    method: EvidenceMethod.OBSERVED,
    producer: 'ferret.provider.jira',
    producerVersion: '1.0.0',
    sourceSystem: 'jira',
    sourceId: 'FER-1',
    ...overrides,
  };
}

describe('evidence identity', () => {
  it('deduplicates an identical observation', () => {
    // Re-indexing an unchanged file must not multiply its evidence.
    const a = createEvidence(observed());
    const b = createEvidence(observed());
    expect(b.id).toBe(a.id);
    expect(b.integrityHash).toBe(a.integrityHash);
  });

  it('treats a different producer version as a different observation', () => {
    // Governance §21: a parser upgrade can change what was extracted, and
    // conflating the two would make "re-extract what the old parser touched"
    // unanswerable.
    const v1 = createEvidence(observed({ producerVersion: '1.0.0' }));
    const v2 = createEvidence(observed({ producerVersion: '2.0.0' }));
    expect(v2.id).not.toBe(v1.id);
  });

  it('distinguishes evidence about different fields of the same subject', () => {
    const title = createEvidence(observed({ field: 'attributes.title' }));
    const state = createEvidence(observed({ field: 'attributes.state', statement: 'open' }));
    expect(state.id).not.toBe(title.id);
  });

  it('distinguishes evidence found at different locations in one source', () => {
    const first = createEvidence(observed({ locator: { kind: 'line', start: 10, end: 12 } }));
    const second = createEvidence(observed({ locator: { kind: 'line', start: 40, end: 42 } }));
    expect(second.id).not.toBe(first.id);
  });

  it('produces a well-formed canonical id', () => {
    expect(isCanonicalId(createEvidence(observed()).id)).toBe(true);
    expect(
      evidenceKey({
        subjectId: SUBJECT,
        field: undefined,
        statement: 1,
        method: 'observed',
        producer: 'p',
        producerVersion: '1',
        sourceSystem: 's',
        sourceId: undefined,
        locator: undefined,
      }),
    ).toContain('evidence');
  });
});

describe('observed versus derived', () => {
  it('knows which methods are direct observations', () => {
    expect(isDirectObservation(EvidenceMethod.OBSERVED)).toBe(true);
    expect(isDirectObservation(EvidenceMethod.PARSED)).toBe(true);
    expect(isDirectObservation(EvidenceMethod.INFERRED)).toBe(false);
    expect(isDirectObservation(EvidenceMethod.GENERATED)).toBe(false);
  });

  it('never conflates model output with observation', () => {
    // Governance §6 draws exactly this line. A generated statement is evidence
    // of what a model said, not of what is true.
    expect(EVIDENCE_METHODS).toContain(EvidenceMethod.GENERATED);
    expect(isDirectObservation(EvidenceMethod.GENERATED)).toBe(false);
  });

  it('requires a derived fact to name what it was derived from', () => {
    // A conclusion that cites nothing cannot be traced, which is the entire
    // point of recording derivation.
    let thrown: unknown;
    try {
      createEvidence(
        observed({ method: EvidenceMethod.INFERRED, producer: 'ferret.linker', derivedFrom: [] }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_EVIDENCE_INVALID' });
    expect((thrown as { remediation: string }).remediation).toContain('derivedFrom');
  });

  it('accepts a derived fact that does cite its sources', () => {
    const derived = createEvidence(
      observed({
        method: EvidenceMethod.INFERRED,
        producer: 'ferret.linker',
        derivedFrom: ['aaaaaaaa-1111-8111-8111-111111111111'],
      }),
    );
    expect(derived.derivedFrom).toHaveLength(1);
  });

  it('does not require a citation for something a person asserted', () => {
    // An operator saying "this issue is a duplicate" is the origin of that
    // fact, not a conclusion from other facts.
    expect(() =>
      createEvidence(observed({ method: EvidenceMethod.ASSERTED, producer: 'operator' })),
    ).not.toThrow();
  });

  it('records the producer and its version, so extraction is reproducible', () => {
    const record = createEvidence(observed({ producer: 'ferret.parser.pdf', producerVersion: '6.3.289' }));
    expect(record.producer).toBe('ferret.parser.pdf');
    expect(record.producerVersion).toBe('6.3.289');
  });
});

describe('not-knowing is representable', () => {
  it('distinguishes unknown confidence from zero confidence', () => {
    // Zero says "believed false". Omitted says "not assessed". Governance §6
    // forbids collapsing the two.
    expect(createEvidence(observed()).confidence).toBeUndefined();
    expect(createEvidence(observed({ confidence: 0 })).confidence).toBe(0);
  });

  it('defaults completeness to unknown rather than complete', () => {
    // A parser that extracted three of five sheets has evidence but not the
    // whole answer; assuming complete makes a retrieval confidently omit things.
    expect(createEvidence(observed()).completeness).toBe(Completeness.UNKNOWN);
  });

  it('can say a fact is only partly covered', () => {
    const partial = createEvidence(observed({ completeness: Completeness.PARTIAL }));
    expect(partial.completeness).toBe(Completeness.PARTIAL);
  });

  it('offers a state for every way knowledge can go wrong', () => {
    expect(Object.values(EvidenceState)).toStrictEqual([
      'current',
      'stale',
      'superseded',
      'conflicting',
      'unavailable',
    ]);
  });

  it('rejects a confidence outside 0..1', () => {
    expect(() => createEvidence(observed({ confidence: 1.5 }))).toThrow();
    expect(() => createEvidence(observed({ confidence: -0.1 }))).toThrow();
  });
});

describe('secrets are never stored as evidence content', () => {
  it('masks a credential encountered in source content', () => {
    // EPIC-008's security requirement. Ferret indexes configuration files and
    // logs, and will encounter these.
    const record = createEvidence(
      observed({ statement: 'export DATABASE_URL=postgres://user:hunter2@db/app' }),
    );
    expect(JSON.stringify(record.statement)).not.toContain('hunter2');
    expect(record.redacted).toBe(true);
  });

  it('masks a secret nested inside a structured statement', () => {
    const record = createEvidence(
      observed({ statement: { config: { database: { password: 'hunter2' }, host: 'db' } } }),
    );
    const rendered = JSON.stringify(record.statement);
    expect(rendered).not.toContain('hunter2');
    // The surrounding fact survives — recording that a password was configured,
    // masked, is more useful than recording nothing.
    expect(rendered).toContain('db');
  });

  it('reports that nothing was masked when the content is innocent', () => {
    expect(createEvidence(observed({ statement: 'Fix the parser' })).redacted).toBe(false);
  });

  it('exposes the redaction so a caller can check before storing', () => {
    expect(redactStatement('token=ghp_abcdefghijklmnopqrstuvwxyz012345').redacted).toBe(true);
    expect(redactStatement('nothing to see').redacted).toBe(false);
  });

  it('keeps the masked form in the identity, so the secret is never a key either', () => {
    const record = createEvidence(observed({ statement: { password: 'hunter2' } }));
    expect(record.id).toBe(createEvidence(observed({ statement: { password: 'different' } })).id);
  });
});

describe('integrity', () => {
  it('recomputes to the recorded hash for an untouched record', () => {
    const record = createEvidence(observed());
    expect(integrityHashOf(record)).toBe(record.integrityHash);
  });

  it('detects a changed statement', () => {
    const record = createEvidence(observed());
    const tampered = { ...record, statement: 'Something else entirely' };
    expect(integrityHashOf(tampered)).not.toBe(record.integrityHash);
  });

  it('detects a changed source location', () => {
    const record = createEvidence(observed({ locator: { kind: 'line', start: 1 } }));
    const tampered = { ...record, locator: { kind: 'line' as const, start: 99 } };
    expect(integrityHashOf(tampered)).not.toBe(record.integrityHash);
  });

  it('does not cover the state, so a superseded record still verifies', () => {
    // State is Ferret's interpretation, not the observation. If supersession
    // broke the hash, integrity checking would fail exactly where history
    // matters most.
    const record = createEvidence(observed());
    const superseded = { ...record };
    expect(integrityHashOf(superseded)).toBe(record.integrityHash);
  });
});

describe('conflicting evidence', () => {
  const jira = createEvidence(observed({ statement: 'Fix the parser', sourceSystem: 'jira', authority: 10 }));
  const github = createEvidence(
    observed({ statement: 'Fix parsing', sourceSystem: 'github', sourceId: 'gh-1', authority: 5 }),
  );

  it('reports two sources that disagree about the same fact', () => {
    const conflicts = detectConflicts([jira, github]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.field).toBe('attributes.title');
    expect(conflicts[0]?.statements).toHaveLength(2);
  });

  it('does not report agreement as conflict', () => {
    const same = createEvidence(observed({ sourceSystem: 'github', sourceId: 'gh-2' }));
    expect(detectConflicts([jira, same])).toStrictEqual([]);
  });

  it('does not treat evidence about different fields as conflict', () => {
    const other = createEvidence(observed({ field: 'attributes.state', statement: 'open' }));
    expect(detectConflicts([jira, other])).toStrictEqual([]);
  });

  it('prefers the more authoritative source without discarding the other', () => {
    // Detection is separate from resolution. Governance §15 forbids resolving a
    // conflict by throwing one side away.
    expect(preferredEvidence([github, jira])?.sourceSystem).toBe('jira');
    expect(detectConflicts([jira, github])[0]?.evidence).toHaveLength(2);
  });

  it('falls back to confidence, then to recency', () => {
    const low = createEvidence(observed({ statement: 'a', confidence: 0.2, sourceId: 'a' }));
    const high = createEvidence(observed({ statement: 'b', confidence: 0.9, sourceId: 'b' }));
    expect(preferredEvidence([low, high])?.statement).toBe('b');

    const older = createEvidence(
      observed({ statement: 'old', sourceId: 'o', observedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const newer = createEvidence(
      observed({ statement: 'new', sourceId: 'n', observedAt: '2026-06-01T00:00:00.000Z' }),
    );
    expect(preferredEvidence([older, newer])?.statement).toBe('new');
  });

  it('says it cannot choose rather than picking arbitrarily', () => {
    // An arbitrary pick is indistinguishable from a considered one by the time
    // it reaches an answer, which is the worse failure.
    const left = createEvidence(observed({ statement: 'left', sourceId: 'l' }));
    const right = createEvidence(observed({ statement: 'right', sourceId: 'r' }));
    expect(preferredEvidence([left, right])).toBeUndefined();
  });

  it('returns the only candidate when there is one, and nothing for none', () => {
    expect(preferredEvidence([jira])).toBe(jira);
    expect(preferredEvidence([])).toBeUndefined();
  });
});

describe('validation', () => {
  it('requires a producer and a version', () => {
    expect(() => createEvidence(observed({ producer: '' }))).toThrow();
    expect(() => createEvidence(observed({ producerVersion: '' }))).toThrow();
  });

  it('requires a source system, so no evidence is untraceable', () => {
    expect(() => createEvidence(observed({ sourceSystem: '' }))).toThrow();
  });

  it('rejects an unknown method', () => {
    expect(() => createEvidence(observed({ method: 'guessed' as never }))).toThrow();
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    expect(() => createEvidence({ ...observed(), weight: 1 } as unknown as EvidenceInput)).toThrow();
  });

  it('never echoes a rejected value, which may be the secret this module guards', () => {
    let thrown: unknown;
    try {
      createEvidence(observed({ confidence: 99, statement: 'password=super-secret-value' }));
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown)).not.toContain('super-secret-value');
  });
});
