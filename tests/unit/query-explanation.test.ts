import { describe, expect, it } from 'vitest';

import type { CanonicalEntity } from '../../src/domain/index.js';
import {
  NOTHING_WITHHELD,
  QueryShape,
  WithheldTally,
  WithholdReason,
  explainQuery,
  renderExplanation,
  type QueryPlan,
  type RankBreakdown,
  type SearchHit,
} from '../../src/retrieval/index.js';

/**
 * EPIC-063, without a database.
 *
 * Every sentence an explanation contains is derived from a field, so every claim
 * it makes can be provoked by setting that field. The one thing that needs a
 * real query is AC-13 — that no indexed value reaches an explanation — because
 * proving it needs values a repository actually produced.
 */

interface Candidate {
  readonly id: string;
  readonly score: number;
  readonly kind?: string;
  readonly lifecycle?: string;
  readonly authority?: number;
  readonly observedAt?: string;
  readonly ranking?: Partial<RankBreakdown>;
  readonly source?: SearchHit['source'];
}

function entity(candidate: Candidate): CanonicalEntity {
  return Object.freeze({
    id: candidate.id,
    kind: candidate.kind ?? 'file',
    canonicalKey: `key-${candidate.id}`,
    schemaVersion: 1,
    source: Object.freeze({ system: 'git', id: candidate.id }),
    lifecycle: candidate.lifecycle ?? 'active',
    attributes: Object.freeze({ path: `src/${candidate.id}.ts` }),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: candidate.observedAt,
    contentHash: `hash-${candidate.id}`,
  }) as CanonicalEntity;
}

function hit(candidate: Candidate): SearchHit & { readonly authority?: number } {
  return {
    source: candidate.source ?? 'entity',
    entity: entity(candidate),
    evidence: undefined,
    score: candidate.score,
    highlight: `<b>${candidate.id}</b>`,
    ...(candidate.authority === undefined ? {} : { authority: candidate.authority }),
    ...(candidate.ranking === undefined
      ? {}
      : {
          ranking: {
            relevance: candidate.score,
            contributors: ['entity'],
            subsumed: [],
            standing: 0,
            ...candidate.ranking,
          },
        }),
  };
}

function plan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    shape: QueryShape.PROSE,
    reason: 'The question is prose, which is what ranked retrieval is for.',
    exact: false,
    partial: false,
    strategies: [{ strategy: 'text', ran: true, returned: 2, skipped: undefined }],
    ...overrides,
  };
}

describe('the plan is narrated, including what did not happen — AC-1 to AC-4', () => {
  it('names the question, the shape and the recorded reason', () => {
    const explanation = explainQuery('how are files tombstoned', plan(), [], NOTHING_WITHHELD);

    expect(explanation.question).toBe('how are files tombstoned');
    expect(explanation.readAs).toBe(QueryShape.PROSE);
    expect(explanation.reason).toBe('The question is prose, which is what ranked retrieval is for.');
  });

  it('reports every strategy with what it returned — AC-2', () => {
    const explanation = explainQuery(
      'q',
      plan({
        strategies: [
          { strategy: 'text', ran: true, returned: 7, skipped: undefined },
          { strategy: 'semantic', ran: false, returned: 0, skipped: 'No embedding provider is registered.' },
        ],
      }),
      [],
      NOTHING_WITHHELD,
    );

    expect(explanation.strategies.map((one) => one.strategy)).toStrictEqual(['text', 'semantic']);
    expect(explanation.strategies[0]?.returned).toBe(7);
  });

  it('repeats a skipped reason verbatim rather than paraphrasing it — AC-3', () => {
    // The recorded wording is the wording that was reviewed. A paraphrase is a
    // second place for the sentence to live and drift from.
    const recorded =
      'No embedding provider is registered. Ferret ships none by design — semantic retrieval is optional augmentation.';
    const explanation = explainQuery(
      'q',
      plan({ strategies: [{ strategy: 'semantic', ran: false, returned: 0, skipped: recorded }] }),
      [],
      NOTHING_WITHHELD,
    );

    expect(explanation.strategies[0]?.skipped).toBe(recorded);
    expect(renderExplanation(explanation)).toContain(recorded);
  });

  it('says the answer may be short when a strategy was skipped — AC-4', () => {
    const explanation = explainQuery('q', plan({ partial: true }), [], NOTHING_WITHHELD);

    expect(explanation.partial).toBe(true);
    expect(explanation.limits.some((limit) => limit.includes('may be missing'))).toBe(true);
  });
});

describe('why this is below that is the first key that differs — AC-5, AC-6', () => {
  it('names standing when the pair differ there, even against a better match', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [
        hit({ id: 'live', score: 0.1, ranking: {} }),
        hit({ id: 'gone', score: 0.9, lifecycle: 'deleted', ranking: { standing: 40 } }),
      ],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[0]?.below).toBeUndefined();
    expect(explanation.hits[1]?.below).toContain('standing');
    // And not the key below it, which is the one a naive explanation would
    // reach for — the deleted hit matched *better*.
    expect(explanation.hits[1]?.below).not.toContain('weaker text match');
  });

  it('names relevance when standing ties', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'a', score: 0.8, ranking: {} }), hit({ id: 'b', score: 0.2, ranking: {} })],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[1]?.below).toContain('weaker text match');
    expect(explanation.hits[1]?.below).toContain('0.2000');
    expect(explanation.hits[1]?.below).toContain('0.8000');
  });

  it('names authority when standing and relevance tie', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [
        hit({ id: 'a', score: 0.5, authority: 80, ranking: {} }),
        hit({ id: 'b', score: 0.5, authority: 60, ranking: {} }),
      ],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[1]?.below).toContain('less authoritative');
  });

  it('names recency when standing, relevance and authority tie', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [
        hit({ id: 'a', score: 0.5, authority: 80, observedAt: '2026-01-01T00:00:00.000Z', ranking: {} }),
        hit({ id: 'b', score: 0.5, authority: 80, observedAt: '2024-01-01T00:00:00.000Z', ranking: {} }),
      ],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[1]?.below).toContain('older observation');
    expect(explanation.hits[1]?.below).toContain('2024-01-01');
  });

  it('reports the determinism tail as identity, never as a judgement — AC-6', () => {
    // The tail is EPIC-056's determinism device. Reporting it as a reason would
    // be the explanation inventing something the comparator did not have.
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'a', score: 0.5, ranking: {} }), hit({ id: 'b', score: 0.5, ranking: {} })],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[1]?.below).toContain('determinism tail');
  });

  it('describes a missing observation time as missing rather than as old', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [
        hit({ id: 'a', score: 0.5, authority: 80, observedAt: '2026-01-01T00:00:00.000Z', ranking: {} }),
        hit({ id: 'b', score: 0.5, authority: 80, ranking: {} }),
      ],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[1]?.below).toContain('no recorded observation time');
  });
});

describe('what each hit rests on — AC-7, AC-8, AC-9', () => {
  it('says which contributors built a relevance — AC-7', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'a', score: 0.75, ranking: { contributors: ['content', 'entity'] } })],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[0]?.builtFrom).toStrictEqual(['content', 'entity']);
    expect(renderExplanation(explanation)).toContain('built from: content, entity');
  });

  it('says how many parts were folded into a hit — AC-8', () => {
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'a', score: 0.8, ranking: { subsumed: ['sym-1', 'ver-1'] } })],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[0]?.folded).toStrictEqual(['2 folded into this result']);
  });

  it('carries a standing sentence verbatim — AC-9', () => {
    const recorded = 'ranked below live results: the source reports this as removed';
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'gone', score: 0.5, lifecycle: 'deleted', ranking: { standing: 40, why: recorded } })],
      NOTHING_WITHHELD,
    );

    expect(explanation.hits[0]?.standing).toBe(recorded);
    expect(renderExplanation(explanation)).toContain(recorded);
  });
});

describe('an explanation may say it cannot explain — AC-10, AC-11', () => {
  it('reports a hit with no breakdown as unexplained rather than reconstructing one — AC-10', () => {
    const explanation = explainQuery('q', plan(), [hit({ id: 'a', score: 0.5 })], NOTHING_WITHHELD);

    expect(explanation.hits[0]?.unexplained).toBe('no ranking breakdown was recorded for this hit');
    expect(explanation.hits[0]?.score).toBeUndefined();
    expect(explanation.limits.some((limit) => limit.includes('unexplained'))).toBe(true);
  });

  it('explains an exact answer as exact, claiming no ranking — AC-11', () => {
    const explanation = explainQuery(
      'b9559ab',
      plan({ shape: QueryShape.OBJECT_ID, exact: true, reason: 'An abbreviated object id.' }),
      [hit({ id: 'commit-1', score: 1, kind: 'commit' })],
      NOTHING_WITHHELD,
    );

    expect(explanation.exact).toBe(true);
    expect(explanation.hits[0]?.unexplained).toBe('answered exactly; no ranking was applied');
    expect(renderExplanation(explanation)).toContain('one right answer, so nothing was ranked');
  });
});

describe('withholding is counted, never described — AC-12', () => {
  it('reports counts by reason and no value', () => {
    const tally = new WithheldTally();
    tally.add(WithholdReason.PERMISSION, 3);
    const explanation = explainQuery('q', plan(), [hit({ id: 'a', score: 0.5, ranking: {} })], tally.report);

    expect(explanation.withheld.total).toBe(3);
    expect(explanation.withheld.byReason).toStrictEqual([`${WithholdReason.PERMISSION}: 3`]);
    expect(explanation.limits.some((limit) => limit.includes('never their content'))).toBe(true);
  });

  it('says plainly when nothing was withheld', () => {
    const explanation = explainQuery('q', plan(), [], NOTHING_WITHHELD);

    expect(explanation.withheld.total).toBe(0);
    expect(renderExplanation(explanation)).toContain('nothing was withheld');
  });
});

describe('no indexed value reaches an explanation — AC-13', () => {
  it('names fields and kinds, never attribute values or highlights', () => {
    // The hand-built hits carry a `path` attribute and a `<b>`-marked highlight.
    // Neither may appear: an explanation that quoted content would need EPIC-084
    // containment and could carry an injected instruction.
    const explanation = explainQuery(
      'q',
      plan(),
      [hit({ id: 'a', score: 0.5, ranking: {} }), hit({ id: 'b', score: 0.2, ranking: {} })],
      NOTHING_WITHHELD,
    );
    const rendered = `${JSON.stringify(explanation)}\n${renderExplanation(explanation)}`;

    expect(rendered).not.toContain('src/a.ts');
    expect(rendered).not.toContain('<b>');
    // The id and the kind *are* emitted — they are Ferret's own structural
    // fields and are how a caller correlates an explanation with a result.
    expect(rendered).toContain('"a"');
    expect(rendered).toContain('file');
  });
});

describe('purity and stability — AC-14, AC-17', () => {
  it('returns the same explanation for the same inputs', () => {
    const hits = [hit({ id: 'a', score: 0.5, ranking: {} }), hit({ id: 'b', score: 0.2, ranking: {} })];
    const first = explainQuery('q', plan(), hits, NOTHING_WITHHELD);
    const second = explainQuery('q', plan(), hits, NOTHING_WITHHELD);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(renderExplanation(first)).toBe(renderExplanation(second));
  });

  it('freezes what it returns, so a caller cannot edit an explanation', () => {
    const explanation = explainQuery('q', plan(), [hit({ id: 'a', score: 0.5, ranking: {} })], NOTHING_WITHHELD);

    expect(Object.isFrozen(explanation)).toBe(true);
    expect(Object.isFrozen(explanation.hits)).toBe(true);
  });
});

describe('a degenerate query still explains', () => {
  it('explains an empty result', () => {
    const explanation = explainQuery('kubernetes', plan({ strategies: [] }), [], NOTHING_WITHHELD);

    expect(explanation.hits).toStrictEqual([]);
    expect(renderExplanation(explanation)).toContain('nothing matched');
  });

  it('always states the boundary of the feature', () => {
    // Stated on every explanation rather than discovered by a caller who
    // assumed otherwise: nothing records what a query did not find.
    const explanation = explainQuery('q', plan(), [], NOTHING_WITHHELD);

    expect(explanation.limits.some((limit) => limit.includes('why something is missing'))).toBe(true);
  });
});
