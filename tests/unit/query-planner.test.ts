import { describe, expect, it } from 'vitest';

import {
  QueryPlanner,
  QueryShape,
  RRF_K,
  classify,
  fuse,
  type RankedList,
  type SearchHit,
} from '../../src/retrieval/index.js';
import type { CanonicalEntity } from '../../src/domain/index.js';

/**
 * EPIC-055, without a database.
 *
 * Classification and fusion are pure functions of their inputs, and the
 * planner's interesting behaviour is what it does when a strategy is missing or
 * fails — none of which needs PostgreSQL to provoke. The vector and full-text
 * paths are exercised against real infrastructure elsewhere.
 */

function entity(id: string, attributes: Record<string, unknown> = {}): CanonicalEntity {
  return Object.freeze({
    id,
    kind: 'commit',
    canonicalKey: `key-${id}`,
    schemaVersion: 1,
    source: Object.freeze({ system: 'git', id }),
    lifecycle: 'active',
    attributes: Object.freeze(attributes),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: undefined,
    contentHash: `hash-${id}`,
  });
}

function hit(id: string): SearchHit {
  return { source: 'entity', entity: entity(id), evidence: undefined, score: 1, highlight: undefined };
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('working out what kind of question was asked', () => {
  it('recognises an abbreviated object id, which full-text cannot match', () => {
    // The defect this exists for: `b9559ab` never matched the token
    // `b9559ab55755eee…`, because full-text matches whole lexemes. The commit
    // was indexed, findable by its full forty characters, and unreachable by
    // the seven anyone actually has.
    for (const term of ['b9559ab', 'B9559AB55755', 'b9559ab55755eb260c665c19647a6bd829af444b']) {
      const result = classify(term);
      expect(result.shape, term).toBe(QueryShape.OBJECT_ID);
      expect(result.exact).toBe(true);
      expect(result.term).toBe(term.toLowerCase());
    }
  });

  it('does not mistake six hex characters for an object id', () => {
    // Git's own abbreviation floor is seven. Below it, `abcdef` is far more
    // likely to be a word someone typed than a commit they meant.
    expect(classify('abcdef').shape).toBe(QueryShape.PROSE);
  });

  it('recognises a path, and normalises the separator a Windows user types', () => {
    expect(classify('src/storage/retrieval.ts').shape).toBe(QueryShape.PATH);

    const windows = classify('src\\storage\\retrieval.ts');
    expect(windows.shape).toBe(QueryShape.PATH);
    // Being told a path is prose because of the separator on your own keyboard
    // is the sort of thing that makes a tool feel broken.
    expect(windows.term).toBe('src/storage/retrieval.ts');
  });

  it('treats a sentence mentioning a path as a question, not a key', () => {
    // The distinction that stops an exact lookup returning nothing for a
    // perfectly good question.
    expect(classify('what changed in src/main.ts').shape).toBe(QueryShape.PROSE);
  });

  it('recognises a Ferret entity id', () => {
    expect(classify(uuid(1)).shape).toBe(QueryShape.ENTITY_ID);
  });

  it('explains itself, in words a person can check', () => {
    for (const term of ['b9559ab', 'src/main.ts', 'why is this slow', uuid(2)]) {
      expect(classify(term).reason.length, term).toBeGreaterThan(20);
    }
  });

  it('bounds what it will classify', () => {
    // A question arrives from an AI client, and every pattern is applied to it.
    const huge = 'a'.repeat(10_000);
    expect(classify(huge).term.length).toBeLessThanOrEqual(1024);
  });
});

describe('fusing rankings that do not share a scale', () => {
  it('ranks a result found by two strategies above one found by one', () => {
    // The entire reason to run more than one strategy.
    const lists: RankedList[] = [
      { strategy: 'text', hits: [hit('a'), hit('b')] },
      { strategy: 'semantic', hits: [hit('c'), hit('b')] },
    ];

    const fused = fuse(lists, 10);
    expect(fused[0]?.entity.id).toBe('b');
    expect(fused[0]?.foundBy).toStrictEqual(['text', 'semantic']);
  });

  it('gives the same ranking whichever strategy finishes first', () => {
    // Strategies run concurrently and their completion order is not something
    // Ferret controls, so a ranking that depended on it would be a ranking that
    // changed between identical queries.
    const text: RankedList = { strategy: 'text', hits: [hit('a'), hit('b'), hit('c')] };
    const semantic: RankedList = { strategy: 'semantic', hits: [hit('c'), hit('d')] };

    const forwards = fuse([text, semantic], 10).map((h) => h.entity.id);
    const backwards = fuse([semantic, text], 10).map((h) => h.entity.id);

    expect(forwards).toStrictEqual(backwards);
  });

  it('breaks ties on identity rather than on arrival', () => {
    const a = fuse([{ strategy: 'text', hits: [hit('zzz'), hit('aaa')] }], 10);
    const b = fuse([{ strategy: 'text', hits: [hit('zzz'), hit('aaa')] }], 10);
    expect(a.map((h) => h.entity.id)).toStrictEqual(b.map((h) => h.entity.id));
  });

  it('does not let one strategy corroborate itself with a duplicate', () => {
    const fused = fuse([{ strategy: 'text', hits: [hit('a'), hit('a')] }], 10);
    expect(fused[0]?.foundBy).toStrictEqual(['text']);
  });

  it('scores by reciprocal rank', () => {
    const fused = fuse([{ strategy: 'text', hits: [hit('a')] }], 10);
    expect(fused[0]?.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('honours the limit', () => {
    const hits = Array.from({ length: 20 }, (_, i) => hit(`e${String(i)}`));
    expect(fuse([{ strategy: 'text', hits }], 5)).toHaveLength(5);
  });
});

describe('planning a query', () => {
  const exactStore = (hits: readonly SearchHit[] = []) => ({
    byIdentifier: () => Promise.resolve(hits),
  });
  const textStore = (hits: readonly SearchHit[] = []) => ({
    search: () => Promise.resolve(hits),
  });

  it('answers an exact question exactly, without blending in ranked results', async () => {
    // Someone asking for `b9559ab` is not helped by the commit appearing above
    // three documents that happen to mention it.
    const planner = new QueryPlanner({
      exact: exactStore([hit('the-commit')]),
      text: textStore([hit('a'), hit('b')]),
    });

    const { plan, hits } = await planner.search({ question: 'b9559ab' });

    expect(plan.shape).toBe(QueryShape.OBJECT_ID);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity.id).toBe('the-commit');
    expect(plan.strategies.map((s) => s.strategy)).toStrictEqual(['exact']);
  });

  it('falls back to ranked retrieval when the key matches nothing, and says so', async () => {
    // A path that no longer exists is still discussed in commit messages, so
    // falling through is right — but a caller must not be left believing the
    // ranked results *are* the exact answer.
    const planner = new QueryPlanner({
      exact: exactStore([]),
      text: textStore([hit('a')]),
    });

    const { plan, hits } = await planner.search({ question: 'src/gone.ts' });

    expect(hits).toHaveLength(1);
    const exact = plan.strategies.find((s) => s.strategy === 'exact');
    expect(exact?.skipped).toContain('Nothing matched exactly');
  });

  it('records each strategy once, however many things happened to it', async () => {
    // Two rows for one strategy read as two attempts, and a reader counting
    // them would be counting something that never happened.
    const planner = new QueryPlanner({ exact: exactStore([]), text: textStore([]) });
    const { plan } = await planner.search({ question: 'src/gone.ts' });

    const names = plan.strategies.map((s) => s.strategy);
    expect(new Set(names).size).toBe(names.length);
  });

  it('reports semantic retrieval as unavailable rather than empty', async () => {
    // The distinction the whole design turns on: an empty result says "nothing
    // matched", which is a finding. Ferret ships no embedding provider, and
    // must not let that read as a finding.
    const planner = new QueryPlanner({ exact: exactStore(), text: textStore([hit('a')]) });
    const { plan } = await planner.search({ question: 'where did we discuss timeouts' });

    const semantic = plan.strategies.find((s) => s.strategy === 'semantic');
    expect(semantic?.ran).toBe(false);
    expect(semantic?.skipped).toContain('No embedding provider is registered');
    expect(plan.partial).toBe(true);
  });

  it('does not fail the query when a strategy fails', async () => {
    // Proved by making one fail. A search that returns text results with a note
    // that the vector store was unreachable is more useful than an error.
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: textStore([hit('a')]),
      semantic: {
        nearest: () => Promise.reject(new Error('the vector store is unreachable')),
        unavailableReason: () => Promise.resolve(undefined),
      },
    });

    const { plan, hits } = await planner.search({ question: 'why is this slow' });

    expect(hits).toHaveLength(1);
    const semantic = plan.strategies.find((s) => s.strategy === 'semantic');
    expect(semantic?.skipped).toContain('unreachable');
    expect(plan.partial).toBe(true);
  });

  it('treats a provider that declines as unavailable, not as finding nothing', async () => {
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: textStore([hit('a')]),
      semantic: {
        nearest: () => Promise.resolve(undefined),
        unavailableReason: () => Promise.resolve(undefined),
      },
    });

    const { plan } = await planner.search({ question: 'why is this slow' });
    expect(plan.strategies.find((s) => s.strategy === 'semantic')?.skipped).toBeDefined();
  });

  it('uses semantic results when they are there', async () => {
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: textStore([hit('a')]),
      semantic: {
        nearest: () => Promise.resolve([hit('a'), hit('b')]),
        unavailableReason: () => Promise.resolve(undefined),
      },
    });

    const { plan, hits } = await planner.search({ question: 'why is this slow' });

    expect(plan.partial).toBe(false);
    // `a` was found by both, so it leads.
    expect(hits[0]?.entity.id).toBe('a');
    expect(hits[0]?.foundBy).toStrictEqual(['text', 'semantic']);
  });

  it('skips semantic retrieval when a reproducible answer is asked for', async () => {
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: textStore([hit('a')]),
      semantic: {
        nearest: () => Promise.resolve([hit('b')]),
        unavailableReason: () => Promise.resolve(undefined),
      },
    });

    const { plan, hits } = await planner.search({
      question: 'why is this slow',
      deterministicOnly: true,
    });

    expect(hits.map((h) => h.entity.id)).toStrictEqual(['a']);
    expect(plan.strategies.find((s) => s.strategy === 'semantic')?.skipped).toContain(
      'deterministic',
    );
  });

  it('widens a prose question that matched nothing, and reports the widening', async () => {
    // Full-text joins terms with AND, so every extra word makes a match less
    // likely. Measured on Ferret's own index: `tombstone` found a result, and
    // "how are deleted files tombstoned" found nothing — the more context
    // someone gave, the worse the answer.
    let relaxedCall = false;
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: {
        search: (q: { relax?: boolean }) => {
          if (q.relax === true) {
            relaxedCall = true;
            return Promise.resolve([hit('found-loosely')]);
          }
          return Promise.resolve([]);
        },
      },
    });

    const { plan, hits } = await planner.search({ question: 'how are deleted files tombstoned' });

    expect(relaxedCall).toBe(true);
    expect(hits.map((h) => h.entity.id)).toStrictEqual(['found-loosely']);
    expect(plan.strategies.find((s) => s.strategy === 'text')?.skipped).toContain('widened');
  });

  it('does not widen when the strict answer exists', async () => {
    // When every term does match, that is the better answer, and starting loose
    // would bury it.
    let relaxedCall = false;
    const planner = new QueryPlanner({
      exact: exactStore(),
      text: {
        search: (q: { relax?: boolean }) => {
          if (q.relax === true) relaxedCall = true;
          return Promise.resolve([hit('strict')]);
        },
      },
    });

    await planner.search({ question: 'how are deleted files tombstoned' });
    expect(relaxedCall).toBe(false);
  });

  it('does not widen an exact question', async () => {
    let relaxedCall = false;
    const planner = new QueryPlanner({
      exact: exactStore([]),
      text: {
        search: (q: { relax?: boolean }) => {
          if (q.relax === true) relaxedCall = true;
          return Promise.resolve([]);
        },
      },
    });

    await planner.search({ question: 'b9559ab' });
    expect(relaxedCall).toBe(false);
  });
});
