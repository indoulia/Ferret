import { describe, expect, it } from 'vitest';

import type { CanonicalEntity } from '../../src/domain/index.js';
import {
  MAX_LIMIT,
  OVERFETCH,
  overfetchLimit,
  rank,
  type SearchHit,
} from '../../src/retrieval/index.js';

/**
 * EPIC-056, without a database.
 *
 * Ranking is a pure function of a candidate pool, so every rule in §8 can be
 * provoked from a hand-built pool where the answer is known on paper. The
 * figures the Epic is actually judged on — precision, MRR, nDCG — need a real
 * index and live in the golden-dataset suite.
 */

interface Candidate {
  readonly kind: string;
  readonly id: string;
  readonly scope?: string;
  readonly path?: string;
  readonly source?: SearchHit['source'];
  readonly score: number;
}

function entity(candidate: Candidate): CanonicalEntity {
  return Object.freeze({
    id: candidate.id,
    kind: candidate.kind,
    canonicalKey: `key-${candidate.id}`,
    schemaVersion: 1,
    source: Object.freeze({
      system: 'git',
      id: candidate.path ?? candidate.id,
      ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
    }),
    lifecycle: 'active',
    attributes: Object.freeze(candidate.path === undefined ? {} : { path: candidate.path }),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: undefined,
    contentHash: `hash-${candidate.id}`,
  });
}

function hit(candidate: Candidate): SearchHit {
  return {
    source: candidate.source ?? 'entity',
    entity: entity(candidate),
    evidence: undefined,
    score: candidate.score,
    highlight: `<b>${candidate.id}</b>`,
  };
}

const REPO = 'repo-1';
const FILE_ID = 'file-refund';
const FILE = { kind: 'file', id: FILE_ID, scope: REPO, path: 'src/billing/refund.ts' } as const;

/** A symbol says which file declares it by `symbolScope` — `${scope}:${path}`. */
const SYMBOL = {
  kind: 'code_symbol',
  id: 'symbol-refund-invoice',
  scope: `${REPO}:src/billing/refund.ts`,
} as const;

/** A file version says so by the file's entity id. */
const VERSION = { kind: 'file_version', id: 'version-refund', scope: FILE_ID } as const;

describe('a score that means the same thing in every query — AC-1, AC-2', () => {
  it('keeps every ranked score inside [0, 1]', () => {
    const ranked = rank(
      [hit({ ...FILE, score: 0.6 }), hit({ kind: 'commit', id: 'commit-1', score: 0.9 })],
      10,
    );

    for (const one of ranked) {
      expect(one.score).toBeGreaterThanOrEqual(0);
      expect(one.score).toBeLessThanOrEqual(1);
    }
  });

  it('leaves an exact identifier match at 1.0, above every ranked hit', () => {
    // The object-id branch scores 1.0 on purpose: "an exact identifier prefix
    // is not a guess about relevance, it is the thing that was asked for."
    // Probabilistic or must not erode that, and must not push anything past it.
    const ranked = rank(
      [hit({ kind: 'commit', id: 'commit-exact', score: 1 }), hit({ ...FILE, score: 0.99 })],
      10,
    );

    expect(ranked[0]?.entity.id).toBe('commit-exact');
    expect(ranked[0]?.score).toBe(1);
  });

  it('ranks a pool identically however it arrives, including ties', () => {
    const pool = [
      hit({ kind: 'commit', id: 'commit-b', score: 0.5 }),
      hit({ kind: 'commit', id: 'commit-a', score: 0.5 }),
      hit({ ...FILE, score: 0.5 }),
    ];

    const forwards = rank(pool, 10).map((one) => one.entity.id);
    const backwards = rank([...pool].reverse(), 10).map((one) => one.entity.id);

    expect(forwards).toStrictEqual(backwards);
    // kind, then source id: `commit` before `file`, and `commit-a` before
    // `commit-b` because a tie must break on something stable across processes.
    expect(forwards).toStrictEqual(['commit-a', 'commit-b', FILE_ID]);
  });
});

describe('a part is credited to what contains it — AC-3, AC-4, AC-5', () => {
  it('folds a symbol into the file that declares it', () => {
    // Issue #98, as a unit: `refund` reached the file, a symbol inside it and a
    // version of it, and a ranking that treats those as three answers spends
    // three slots saying one thing and puts the part above the whole.
    const ranked = rank([hit({ ...SYMBOL, score: 0.9 }), hit({ ...FILE, score: 0.4 })], 10);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.entity.id).toBe(FILE_ID);
    expect(ranked[0]?.ranking.subsumed).toStrictEqual([SYMBOL.id]);
    // The whole now carries the part's relevance, so it outranks what it scored
    // on its own name alone.
    expect(ranked[0]?.score).toBeGreaterThan(0.9);
  });

  it('folds a file version into its file by entity id', () => {
    const ranked = rank([hit({ ...VERSION, score: 0.7 }), hit({ ...FILE, score: 0.3 })], 10);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.entity.id).toBe(FILE_ID);
    expect(ranked[0]?.ranking.subsumed).toStrictEqual([VERSION.id]);
  });

  it('shows the surviving hit its own highlight, never the folded one', () => {
    // The fold moves a *relevance*. Moving the text would make ranking a
    // disclosure mechanism — EPIC-056 §11.
    const ranked = rank([hit({ ...SYMBOL, score: 0.9 }), hit({ ...FILE, score: 0.4 })], 10);

    expect(ranked[0]?.highlight).toBe(`<b>${FILE_ID}</b>`);
  });

  it('returns a symbol whose file is not in the pool, on its own relevance', () => {
    // The invariant that makes this a ranking change and not a filter: no hit
    // is removed from a result set it would otherwise have been alone in.
    const ranked = rank([hit({ ...SYMBOL, score: 0.9 })], 10);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.entity.id).toBe(SYMBOL.id);
    expect(ranked[0]?.score).toBeCloseTo(0.9, 10);
    expect(ranked[0]?.ranking.subsumed).toStrictEqual([]);
  });

  it('does not fold a symbol into a version of its file — the part into another part', () => {
    // A `file_version` has a path too. If it published the composite key, a
    // symbol would fold into a version rather than into the file.
    const versionWithPath = {
      kind: 'file_version',
      id: 'version-with-path',
      scope: `${REPO}:src/billing/refund.ts`,
      path: 'src/billing/refund.ts',
    } as const;
    const ranked = rank([hit({ ...SYMBOL, score: 0.9 }), hit({ ...versionWithPath, score: 0.5 })], 10);

    expect(ranked.map((one) => one.entity.id).sort()).toStrictEqual([SYMBOL.id, versionWithPath.id]);
  });
});

describe('independent matches combine, and nothing corroborates itself — AC-7, AC-8', () => {
  it('scores an entity reached by name and by body above either alone', () => {
    const byName = rank([hit({ ...FILE, source: 'entity', score: 0.5 })], 10)[0]?.score ?? 0;
    const byBody = rank([hit({ ...FILE, source: 'content', score: 0.5 })], 10)[0]?.score ?? 0;
    const byBoth =
      rank(
        [hit({ ...FILE, source: 'entity', score: 0.5 }), hit({ ...FILE, source: 'content', score: 0.5 })],
        10,
      )[0]?.score ?? 0;

    expect(byBoth).toBeGreaterThan(byName);
    expect(byBoth).toBeGreaterThan(byBody);
    // 1 - (1 - 0.5)² on paper.
    expect(byBoth).toBeCloseTo(0.75, 10);
  });

  it('lets twenty evidence records contribute the best one, once', () => {
    // `fuse` states the reason for keeping evidence rows apart: "an entity with
    // twenty evidence records would otherwise dominate by corroborating
    // itself." Combining by contributor rather than by row is how that survives
    // a formula that rewards corroboration.
    const chatty = Array.from({ length: 20 }, (_unused, index) =>
      hit({ kind: 'commit', id: 'commit-chatty', source: 'evidence', score: 0.2 + index * 0.01 }),
    );
    const ranked = rank([...chatty, hit({ kind: 'commit', id: 'commit-better', score: 0.6 })], 10);

    expect(ranked[0]?.entity.id).toBe('commit-better');
    // The best of the twenty, not twenty combined.
    expect(ranked[1]?.score).toBeCloseTo(0.39, 10);
  });

  it('counts two symbols in one file as two contributors', () => {
    // Not self-corroboration: two different parts of the file matching is what
    // the file being about the term looks like.
    const second = { kind: 'code_symbol', id: 'symbol-refund-line', scope: SYMBOL.scope } as const;
    const one = rank([hit({ ...SYMBOL, score: 0.5 }), hit({ ...FILE, score: 0 })], 10)[0]?.score ?? 0;
    const two =
      rank(
        [hit({ ...SYMBOL, score: 0.5 }), hit({ ...second, score: 0.5 }), hit({ ...FILE, score: 0 })],
        10,
      )[0]?.score ?? 0;

    expect(two).toBeGreaterThan(one);
    expect(two).toBeCloseTo(0.75, 10);
  });
});

describe('one row per entity, and never more than asked for — AC-9, AC-10, AC-11', () => {
  it('returns an entity once however many ways it was reached', () => {
    const ranked = rank(
      [
        hit({ kind: 'commit', id: 'commit-1', source: 'entity', score: 0.4 }),
        hit({ kind: 'commit', id: 'commit-1', source: 'evidence', score: 0.6 }),
        hit({ kind: 'commit', id: 'commit-1', source: 'content', score: 0.2 }),
      ],
      10,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.ranking.contributors).toStrictEqual(['content', 'entity', 'evidence']);
    // The best row's own relevance is what the breakdown reports; the combined
    // score is the one the order used.
    expect(ranked[0]?.ranking.relevance).toBe(0.6);
    expect(ranked[0]?.score).toBeGreaterThan(0.6);
  });

  it('returns no entity the pool did not contain', () => {
    const pool = [
      hit({ ...FILE, score: 0.5 }),
      hit({ ...SYMBOL, score: 0.5 }),
      hit({ kind: 'commit', id: 'commit-1', score: 0.5 }),
    ];
    const ids = new Set(pool.map((one) => one.entity.id));

    for (const one of rank(pool, 10)) expect(ids.has(one.entity.id)).toBe(true);
  });

  it('truncates to the limit after ranking, not before', () => {
    const pool = Array.from({ length: 20 }, (_unused, index) =>
      hit({ kind: 'commit', id: `commit-${String(index).padStart(2, '0')}`, score: index / 100 }),
    );
    const ranked = rank(pool, 3);

    expect(ranked.map((one) => one.entity.id)).toStrictEqual(['commit-19', 'commit-18', 'commit-17']);
  });

  it('fetches more candidates than it returns, bounded by MAX_LIMIT', () => {
    expect(overfetchLimit(1)).toBe(OVERFETCH);
    expect(overfetchLimit(10)).toBe(10 * OVERFETCH);
    expect(overfetchLimit(MAX_LIMIT)).toBe(MAX_LIMIT);
    expect(overfetchLimit(MAX_LIMIT)).toBeGreaterThanOrEqual(MAX_LIMIT);
  });
});

describe('a malformed pool ranks rather than throws', () => {
  it('treats a constituent with no scope as its own answer', () => {
    const orphan = { kind: 'code_symbol', id: 'symbol-orphan', score: 0.5 } as const;
    const ranked = rank([hit(orphan)], 10);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.entity.id).toBe(orphan.id);
  });

  it('treats a constituent pointing at nothing as its own answer', () => {
    const lost = { kind: 'file_version', id: 'version-lost', scope: 'file-that-was-not-fetched' } as const;
    const ranked = rank([hit({ ...lost, score: 0.5 }), hit({ kind: 'commit', id: 'commit-1', score: 0.4 })], 10);

    expect(ranked.map((one) => one.entity.id)).toStrictEqual([lost.id, 'commit-1']);
  });

  it('ranks a hit whose score is not a number as no relevance rather than NaN', () => {
    const broken = { ...hit({ kind: 'commit', id: 'commit-nan', score: 0.5 }), score: Number.NaN };
    const ranked = rank([broken, hit({ kind: 'commit', id: 'commit-ok', score: 0.5 })], 10);

    expect(ranked.map((one) => one.entity.id)).toStrictEqual(['commit-ok', 'commit-nan']);
    expect(ranked[1]?.score).toBe(0);
  });

  it('returns nothing for an empty pool', () => {
    expect(rank([], 10)).toStrictEqual([]);
  });
});
