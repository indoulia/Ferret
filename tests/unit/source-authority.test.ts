import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_BY_METHOD,
  Emitter,
  SOURCE_AUTHORITIES,
  EvidenceMethod,
  SourceAuthority,
  UNASSESSED_AUTHORITY,
  authorityFor,
  effectiveAuthority,
  createEvidence,
  isUnknownAuthority,
  preferredEvidence,
  type CanonicalEvidence,
  type EvidenceInput,
} from '../../src/index.js';

function evidence(overrides: Partial<EvidenceInput> = {}): CanonicalEvidence {
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

describe('the scale', () => {
  it.each([
    [EvidenceMethod.OBSERVED, SourceAuthority.OBSERVED],
    [EvidenceMethod.PARSED, SourceAuthority.PARSED],
    [EvidenceMethod.INFERRED, SourceAuthority.DERIVED],
    [EvidenceMethod.AGGREGATED, SourceAuthority.DERIVED],
    [EvidenceMethod.GENERATED, SourceAuthority.ASSERTED],
    [EvidenceMethod.ASSERTED, SourceAuthority.ASSERTED],
  ])('ranks %s as %d — AC-9', (method, expected) => {
    expect(authorityFor(method)).toBe(expected);
  });

  it('covers every method the model defines — AC-9', () => {
    // A method added without a rank would silently fall to UNKNOWN, which reads
    // as "unassessed" and would be wrong: it was assessed, by omission.
    for (const method of Object.values(EvidenceMethod)) {
      expect(AUTHORITY_BY_METHOD[method]).toBeDefined();
    }
  });

  it('orders read above parsed above derived above asserted — AC-9', () => {
    expect(SourceAuthority.OBSERVED).toBeGreaterThan(SourceAuthority.PARSED);
    expect(SourceAuthority.PARSED).toBeGreaterThan(SourceAuthority.DERIVED);
    expect(SourceAuthority.DERIVED).toBeGreaterThan(SourceAuthority.ASSERTED);
    expect(SourceAuthority.SYSTEM_OF_RECORD).toBeGreaterThan(SourceAuthority.OBSERVED);
  });

  it('leaves room to insert a rank without renumbering', () => {
    const ranks = [...SOURCE_AUTHORITIES].sort((a, b) => a - b);
    for (let index = 1; index < ranks.length; index += 1) {
      expect((ranks[index] ?? 0) - (ranks[index - 1] ?? 0)).toBeGreaterThan(1);
    }
  });
});

describe('the system-of-record override', () => {
  it('promotes what the provider actually read — AC-10', () => {
    expect(authorityFor(EvidenceMethod.OBSERVED, { systemOfRecord: true })).toBe(
      SourceAuthority.SYSTEM_OF_RECORD,
    );
    expect(authorityFor(EvidenceMethod.PARSED, { systemOfRecord: true })).toBe(
      SourceAuthority.SYSTEM_OF_RECORD,
    );
  });

  it.each([EvidenceMethod.INFERRED, EvidenceMethod.GENERATED, EvidenceMethod.ASSERTED, EvidenceMethod.AGGREGATED])(
    'refuses to promote %s — AC-10',
    (method) => {
      // Authority is a property of how a fact was obtained, not of who is
      // claiming it. A provider cannot promote a guess by declaring itself
      // important.
      expect(authorityFor(method, { systemOfRecord: true })).toBe(AUTHORITY_BY_METHOD[method]);
    },
  );
});

describe('unknown', () => {
  it('is distinct from the lowest known rank — AC-11', () => {
    // "Nobody has decided" is not the same claim as "assessed, and weak".
    expect(SourceAuthority.UNKNOWN).not.toBe(SourceAuthority.ASSERTED);
    expect(isUnknownAuthority(SourceAuthority.UNKNOWN)).toBe(true);
    expect(isUnknownAuthority(SourceAuthority.ASSERTED)).toBe(false);
  });

  it('is what an unrecognised method gets — AC-11', () => {
    expect(authorityFor('divined-from-tea-leaves')).toBe(SourceAuthority.UNKNOWN);
  });
});

describe('preferring evidence', () => {
  it('prefers the higher authority — AC-12', () => {
    const read = evidence({ method: EvidenceMethod.OBSERVED, statement: 'from the code' });
    const guessed = evidence({
      method: EvidenceMethod.INFERRED,
      statement: 'from a heuristic',
      // EPIC-008 requires a conclusion to name what it was worked out from.
      derivedFrom: [read.id],
    });

    // With real ranks this discriminates; with the old default of 0 for
    // everything it fell through to confidence, which neither of these has.
    const preferred = preferredEvidence([
      { ...guessed, authority: authorityFor(EvidenceMethod.INFERRED) },
      { ...read, authority: authorityFor(EvidenceMethod.OBSERVED) },
    ]);

    expect(preferred?.statement).toBe('from the code');
  });

  it('still returns nothing for a genuine tie — AC-12', () => {
    // Introducing real ranks must not turn "cannot say" into an arbitrary pick.
    const one = evidence({ statement: 'one' });
    const two = evidence({ statement: 'two' });
    const rank = authorityFor(EvidenceMethod.OBSERVED);

    expect(
      preferredEvidence([
        { ...one, authority: rank },
        { ...two, authority: rank },
      ]),
    ).toBeUndefined();
  });
});

describe('emission applies the policy — AC-12', () => {
  it('stamps a real rank instead of leaving it at zero', () => {
    const emitter = new Emitter({
      sourceSystem: 'git',
      producer: 'ferret.source.git',
      producerVersion: '1.0.0',
    });

    const observed = emitter.observed({
      subjectId: '01J00000000000000000000000',
      statement: 'a value',
    });
    // `inferred` requires the evidence it was worked out from — EPIC-008's
    // rule that a conclusion names its inputs.
    const inferred = emitter.inferred({
      subjectId: '01J00000000000000000000000',
      statement: 'a guess',
      derivedFrom: [observed.id],
    });

    expect(observed.authority).toBe(SourceAuthority.OBSERVED);
    expect(inferred.authority).toBe(SourceAuthority.DERIVED);
    expect(observed.authority).toBeGreaterThan(inferred.authority);
  });

  it('promotes a provider that declares itself the system of record', () => {
    const emitter = new Emitter({
      sourceSystem: 'git',
      producer: 'ferret.source.git',
      producerVersion: '1.0.0',
      systemOfRecord: true,
    });

    const observed = emitter.observed({ subjectId: '01J00000000000000000000000', statement: 'x' });
    expect(observed.authority).toBe(SourceAuthority.SYSTEM_OF_RECORD);
    // And still cannot promote a guess.
    expect(
      emitter.inferred({
        subjectId: '01J00000000000000000000000',
        statement: 'x',
        derivedFrom: [observed.id],
      }).authority,
    ).toBe(SourceAuthority.DERIVED);
  });

  it('keeps an authority the caller decided', () => {
    const emitter = new Emitter({
      sourceSystem: 'git',
      producer: 'ferret.source.git',
      producerVersion: '1.0.0',
    });

    expect(
      emitter.observed({ subjectId: '01J00000000000000000000000', statement: 'x', authority: 42 })
        .authority,
    ).toBe(42);
  });
});

/**
 * Freshness in the authority ordering — EPIC-057 §8.4.
 *
 * EPIC-045's validation recorded this as the limitation it was leaving behind:
 * "`preferredEvidence` breaks an authority tie with confidence and then recency,
 * and a highly authoritative stale record still beats a fresh weak one. That is
 * EPIC-057."
 */
describe('one source speaking twice is not two sources disagreeing — EPIC-057', () => {
  it('prefers the later of two records from the same system and field — AC-11', () => {
    // The sharp case: one system's own January observation outranking its own
    // September observation of the same field, because authority was consulted
    // first and both carry the same rank.
    const january = {
      ...evidence({ statement: 'in January' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const september = {
      ...evidence({ statement: 'in September' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(preferredEvidence([january, september])?.statement).toBe('in September');
  });

  it('prefers the later one even when the earlier is more authoritative — AC-11', () => {
    // Supersession is decided before authority, which is the whole change. The
    // same source having said something more carefully in January does not make
    // January its current position.
    const january = {
      ...evidence({ statement: 'in January' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const september = {
      ...evidence({ statement: 'in September' }),
      authority: SourceAuthority.ASSERTED,
      observedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(preferredEvidence([january, september])?.statement).toBe('in September');
  });

  it('leaves two different systems to authority — AC-12', () => {
    // Narrow on purpose. This is not conflict resolution (EPIC-047): two
    // systems disagreeing still tie on authority and still surface as a
    // conflict.
    const jira = {
      ...evidence({ statement: 'from jira', sourceSystem: 'jira' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const git = {
      ...evidence({ statement: 'from git', sourceSystem: 'git' }),
      authority: SourceAuthority.PARSED,
      observedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(preferredEvidence([jira, git])?.statement).toBe('from jira');
  });

  it('leaves two different fields alone — AC-12', () => {
    const name = {
      ...evidence({ statement: 'a name', field: 'attributes.name' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const path = {
      ...evidence({ statement: 'a path', field: 'attributes.path' }),
      authority: SourceAuthority.ASSERTED,
      observedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(preferredEvidence([name, path])?.statement).toBe('a name');
  });

  it('supersedes nothing when a record has no observation time — AC-12', () => {
    // An absent timestamp is unknown, not old. Governance §6 forbids inventing
    // the difference, so the rule does not fire and authority decides.
    const undated = {
      ...evidence({ statement: 'undated' }),
      authority: SourceAuthority.SYSTEM_OF_RECORD,
      observedAt: undefined,
    };
    const dated = {
      ...evidence({ statement: 'dated' }),
      authority: SourceAuthority.ASSERTED,
      observedAt: '2026-09-01T00:00:00.000Z',
    };

    expect(preferredEvidence([undated, dated])?.statement).toBe('undated');
  });

  it('still returns nothing when two records are genuinely indistinguishable — AC-12', () => {
    // Supersession must not turn "cannot say" into an arbitrary pick. Same
    // system, same field, same instant: neither supersedes the other.
    const at = '2026-09-01T00:00:00.000Z';
    const one = { ...evidence({ statement: 'one' }), authority: SourceAuthority.OBSERVED, observedAt: at };
    const two = { ...evidence({ statement: 'two' }), authority: SourceAuthority.OBSERVED, observedAt: at };

    expect(preferredEvidence([one, two])).toBeUndefined();
  });

  it('orders unassessed authority above asserted and below derived — AC-13', () => {
    // `UNKNOWN` is the lowest number and not the lowest meaning, which this
    // file has documented since EPIC-045 while `preferredEvidence` sorted on
    // the raw number. EPIC-057 §8.4 records it as a defect found.
    const unassessed = { ...evidence({ statement: 'unassessed' }), authority: SourceAuthority.UNKNOWN };
    const asserted = { ...evidence({ statement: 'asserted' }), authority: SourceAuthority.ASSERTED };
    const derived = { ...evidence({ statement: 'derived' }), authority: SourceAuthority.DERIVED };

    expect(preferredEvidence([asserted, unassessed])?.statement).toBe('unassessed');
    expect(preferredEvidence([unassessed, derived])?.statement).toBe('derived');
  });

  it('places the unassessed rank between the two it must sit between', () => {
    expect(UNASSESSED_AUTHORITY).toBeGreaterThan(SourceAuthority.ASSERTED);
    expect(UNASSESSED_AUTHORITY).toBeLessThan(SourceAuthority.DERIVED);
    expect(effectiveAuthority(SourceAuthority.UNKNOWN)).toBe(UNASSESSED_AUTHORITY);
    for (const rank of SOURCE_AUTHORITIES.filter((one) => one !== SourceAuthority.UNKNOWN)) {
      expect(effectiveAuthority(rank)).toBe(rank);
    }
  });
});
