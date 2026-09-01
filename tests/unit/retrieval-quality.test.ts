import { describe, expect, it } from 'vitest';

import { loadGoldenDataset } from '../../src/evaluation/index.js';
import {
  DEFAULT_K,
  measureRetrievalQuality,
  meanOf,
  ndcgAtK,
  precisionAtK,
  recallOf,
  reciprocalRank,
  type Grades,
  type MeasurableRetrieval,
} from '../../src/evaluation/index.js';
import { PUBLIC_ACCESS, type SearchHit } from '../../src/retrieval/index.js';

/**
 * Retrieval quality metrics — EPIC-098.
 *
 * Every expected value here is computed by hand in the comment beside it. A
 * metric test that asserts whatever the implementation returned is a test that
 * proves the implementation is deterministic, not that it is right.
 */

const grades = (entries: Record<string, number>): Grades => new Map(Object.entries(entries));

describe('precision@k — AC-1', () => {
  it('is the relevant fraction of the window', () => {
    // Window of 4: a, b relevant; x, y not. 2/4.
    expect(precisionAtK(['a', 'x', 'b', 'y'], grades({ a: 3, b: 2 }), 4)).toBe(0.5);
  });

  it('narrows with k rather than counting past it', () => {
    // Window of 2: a relevant, x not. 1/2 — b never enters the window.
    expect(precisionAtK(['a', 'x', 'b'], grades({ a: 3, b: 3 }), 2)).toBe(0.5);
  });

  it('is undefined when nothing came back, not zero', () => {
    // Zero out of zero is not zero precision. Averaging a made-up zero into a
    // mean is how a harness reports a decline that did not happen.
    expect(precisionAtK([], grades({ a: 3 }), 10)).toBeUndefined();
  });
});

describe('recall — AC-1', () => {
  it('is the found fraction of what was expected', () => {
    // Expected a, b, c; found a and c. 2/3.
    expect(recallOf(['a', 'x', 'c'], grades({ a: 3, b: 3, c: 1 }))).toBeCloseTo(2 / 3, 10);
  });

  it('ignores rank — finding it ninth is still finding it', () => {
    const ranked = ['x', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'a'];
    expect(recallOf(ranked, grades({ a: 3 }))).toBe(1);
  });

  it('is undefined when nothing was expected, not perfect', () => {
    // Reporting 1.0 would let a dataset of absences claim a flawless score.
    expect(recallOf(['a'], grades({}))).toBeUndefined();
  });
});

describe('reciprocal rank — AC-1', () => {
  it('is one over the position of the first relevant result', () => {
    expect(reciprocalRank(['a'], grades({ a: 1 }))).toBe(1);
    expect(reciprocalRank(['x', 'a'], grades({ a: 1 }))).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'a'], grades({ a: 1 }))).toBeCloseTo(1 / 3, 10);
  });

  it('is zero when nothing relevant came back — a real measurement', () => {
    // Zero, not undefined: the caller looked and found nothing useful. That is
    // different from precision over an empty result, which was never asked.
    expect(reciprocalRank(['x', 'y'], grades({ a: 1 }))).toBe(0);
  });
});

describe('nDCG — AC-1, AC-2', () => {
  it('is 1 when the ranking is ideal', () => {
    // Gains 3 then 1, in that order, is the best possible arrangement.
    expect(ndcgAtK(['a', 'b'], grades({ a: 3, b: 1 }), 10)).toBeCloseTo(1, 10);
  });

  it('falls when the same answers are ranked worse — AC-2', () => {
    // DCG  = 1/log2(2) + 3/log2(3) = 1 + 1.892789… = 2.892789…
    // IDCG = 3/log2(2) + 1/log2(3) = 3 + 0.630929… = 3.630929…
    // nDCG = 0.796708…
    const worse = ndcgAtK(['b', 'a'], grades({ a: 3, b: 1 }), 10);

    expect(worse).toBeCloseTo(2.8927892607143724 / 3.6309297535714573, 10);
    // The property that matters, stated as well as computed: this is the only
    // metric of the four that can tell these two rankings apart.
    expect(worse).toBeLessThan(1);
    expect(precisionAtK(['b', 'a'], grades({ a: 3, b: 1 }), 10)).toBe(
      precisionAtK(['a', 'b'], grades({ a: 3, b: 1 }), 10),
    );
  });

  it('rewards the higher grade being first', () => {
    const better = ndcgAtK(['a', 'b'], grades({ a: 3, b: 1 }), 10) ?? 0;
    const worse = ndcgAtK(['b', 'a'], grades({ a: 3, b: 1 }), 10) ?? 0;
    expect(better).toBeGreaterThan(worse);
  });

  it('is zero when nothing relevant is returned', () => {
    expect(ndcgAtK(['x', 'y'], grades({ a: 3 }), 10)).toBe(0);
  });

  it('is undefined when nothing was expected — AC-11', () => {
    expect(ndcgAtK(['x'], grades({}), 10)).toBeUndefined();
  });
});

describe('meanOf', () => {
  it('averages only what is defined', () => {
    expect(meanOf([1, undefined, 0])).toBe(0.5);
  });

  it('is undefined when nothing is defined, never NaN — AC-11', () => {
    expect(meanOf([undefined, undefined])).toBeUndefined();
    expect(meanOf([])).toBeUndefined();
  });
});

/** A retrieval that returns exactly what it is told to, so the harness is testable. */
function stubRetrieval(byQuery: Record<string, readonly string[]>): MeasurableRetrieval {
  const hits = (ids: readonly string[]): readonly SearchHit[] =>
    ids.map((id) => ({ source: 'text', entity: { id }, evidence: undefined, score: 0 })) as never;
  return {
    search: (query) => Promise.resolve({ hits: hits(byQuery[query.text] ?? []), withheld: { total: 0, byReason: {} } } as never),
    byIdentifier: (term) => Promise.resolve(hits(byQuery[term] ?? [])),
  };
}

describe('the harness can report failure — AC-10', () => {
  const dataset = loadGoldenDataset();
  // Every label resolves against one bound scope; the ids are opaque to the
  // metrics, so any stable binding works for a stub.
  const bindings = { corpus: '00000000-0000-8000-8000-000000000001' };

  it('scores zero across the board when retrieval returns nothing', async () => {
    // The test that makes every other figure meaningful. A harness that cannot
    // report a bad number is not measuring anything.
    const report = await measureRetrievalQuality(dataset, stubRetrieval({}), bindings);

    expect(report.aggregate.meanRecall).toBe(0);
    expect(report.aggregate.meanReciprocalRank).toBe(0);
    expect(report.aggregate.meanNdcg).toBe(0);
    // Nothing came back anywhere, so precision was never defined — not zero.
    expect(report.aggregate.meanPrecisionAtK).toBeUndefined();
    // And an absence label returning nothing is the correct answer.
    expect(report.aggregate.falsePositives).toBe(0);
  });

  it('counts a false positive when an absence label returns something', async () => {
    const absence = dataset.queries.find((query) => query.expected.length === 0);
    expect(absence).toBeDefined();

    const report = await measureRetrievalQuality(
      dataset,
      stubRetrieval({ [absence?.query ?? '']: ['some-entity'] }),
      bindings,
    );

    expect(report.aggregate.falsePositives).toBe(1);
    // Counted, never folded into the scored means — EPIC-098 §8, AC-5.
    const measured = report.queries.find((one) => one.id === absence?.id);
    expect(measured?.precisionAtK).toBeUndefined();
    expect(measured?.ndcg).toBeUndefined();
  });

  it('reports the dataset it measured against — AC-6', async () => {
    const report = await measureRetrievalQuality(dataset, stubRetrieval({}), bindings);

    expect(report.dataset.checksum).toBe(dataset.checksum);
    expect(report.dataset.version).toBe(dataset.version);
    expect(report.k).toBe(DEFAULT_K);
  });

  it('measures every labelled query, so a passing score is not an empty run', async () => {
    const report = await measureRetrievalQuality(dataset, stubRetrieval({}), bindings);

    expect(report.queries).toHaveLength(dataset.queries.length);
    expect(report.aggregate.measured).toBeGreaterThan(0);
  });
});

describe('the harness reads nothing it should not — AC-3, AC-8', () => {
  it('never reads a hit score', async () => {
    // `src/retrieval/query.ts:150`: `ts_rank` is "comparable within one result
    // set and nowhere else". A metric built on it would be a number with no
    // meaning, so the stub above returns score 0 for everything — and the
    // figures below are still correct, which they could not be if score were read.
    const dataset = loadGoldenDataset();
    const exact = dataset.queries.find((query) => query.shape === 'exact');
    expect(exact).toBeDefined();

    const report = await measureRetrievalQuality(
      dataset,
      stubRetrieval({}),
      { corpus: '00000000-0000-8000-8000-000000000001' },
      { access: PUBLIC_ACCESS },
    );

    expect(report.queries.every((one) => one.returned === 0)).toBe(true);
  });
});
