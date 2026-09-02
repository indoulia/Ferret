import { describe, expect, it } from 'vitest';

import type { CanonicalEntity } from '../../src/domain/index.js';
import {
  MAX_TRAVERSAL_DEPTH,
  TraversalBound,
  boundedDepth,
  traverseFrom,
  type Neighbour,
} from '../../src/retrieval/index.js';

/**
 * EPIC-050's walk, without a database.
 *
 * The walk takes the one-hop read as a function, which is what lets a graph be
 * written down here and every bound provoked exactly. EPIC-007's validation made
 * depth and cycle protection a precondition of this Epic existing, so those are
 * the tests that matter most.
 */

function entity(id: string): CanonicalEntity {
  return Object.freeze({
    id,
    kind: 'commit',
    canonicalKey: `key-${id}`,
    schemaVersion: 1,
    source: Object.freeze({ system: 'git', id }),
    lifecycle: 'active',
    attributes: Object.freeze({}),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: undefined,
    contentHash: `hash-${id}`,
  });
}

function neighbour(id: string, type = 'commit_parent_of_commit'): Neighbour {
  return {
    entity: entity(id),
    relationshipType: type,
    direction: 'out',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
    metadata: {},
  };
}

/** A graph as an adjacency list, read one hop at a time. */
function graph(edges: Readonly<Record<string, readonly string[]>>): {
  hop: (from: string, limit: number) => Promise<readonly Neighbour[]>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    hop: (from) => {
      calls.push(from);
      return Promise.resolve((edges[from] ?? []).map((id) => neighbour(id)));
    },
  };
}

describe('the depth bound — AC-3', () => {
  it('defaults to one hop, which is what neighbours always did', () => {
    expect(boundedDepth(undefined)).toBe(1);
  });

  it('clamps beyond the maximum rather than rejecting', () => {
    // A caller asking for more than Ferret will walk is asking for everything;
    // the honest answer is as much as it walks plus a truncation flag.
    expect(boundedDepth(999)).toBe(MAX_TRAVERSAL_DEPTH);
    expect(boundedDepth(0)).toBe(1);
    expect(boundedDepth(-3)).toBe(1);
    expect(boundedDepth(2.5)).toBe(1);
  });
});

describe('walking a chain — AC-1, AC-6, AC-12', () => {
  it('returns each node with the path that reached it', async () => {
    const { hop } = graph({ a: ['b'], b: ['c'], c: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 3 });

    expect(walk.paths.map((one) => `${one.entity.id}@${String(one.depth)}`)).toStrictEqual([
      'b@1',
      'c@2',
    ]);
    // The path is the answer to "how": the ordered edges and the nodes between.
    expect(walk.paths[1]?.steps.map((step) => step.entityId)).toStrictEqual(['b', 'c']);
    expect(walk.paths[1]?.steps[0]?.relationshipType).toBe('commit_parent_of_commit');
  });

  it('orders by depth, then by identity', async () => {
    const { hop } = graph({ a: ['z', 'b'], b: ['y'], z: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 2 });

    expect(walk.paths.map((one) => one.entity.id)).toStrictEqual(['b', 'z', 'y']);
  });

  it('says depth stopped it when the graph continues — AC-12', async () => {
    const { hop } = graph({ a: ['b'], b: ['c'], c: ['d'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 2 });

    expect(walk.paths.map((one) => one.entity.id)).toStrictEqual(['b', 'c']);
    expect(walk.truncated).toBe(TraversalBound.DEPTH);
    expect(walk.depthReached).toBe(2);
  });

  it('reports no truncation when the graph is exhausted', async () => {
    const { hop } = graph({ a: ['b'], b: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 4 });

    expect(walk.truncated).toBeUndefined();
  });

  it('stops calling once the depth is reached', async () => {
    const { hop, calls } = graph({ a: ['b'], b: ['c'], c: ['d'], d: [] });

    await traverseFrom(hop, { from: 'a', depth: 2 });

    // One query per level, and no query for the level it did not walk.
    expect(calls).toStrictEqual(['a', 'b']);
  });
});

describe('cycles terminate — AC-4', () => {
  it('walks a two-node cycle once', async () => {
    // `commit_parent_of_commit` is genuinely cyclic in a repository with merges.
    const { hop } = graph({ a: ['b'], b: ['a'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: MAX_TRAVERSAL_DEPTH });

    expect(walk.paths.map((one) => one.entity.id)).toStrictEqual(['b']);
    expect(walk.truncated).toBeUndefined();
  });

  it('never reports the origin as something it reached', async () => {
    const { hop } = graph({ a: ['b', 'a'], b: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 3 });

    expect(walk.paths.map((one) => one.entity.id)).not.toContain('a');
  });

  it('walks a longer cycle once and terminates', async () => {
    const { hop } = graph({ a: ['b'], b: ['c'], c: ['d'], d: ['b'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: MAX_TRAVERSAL_DEPTH });

    expect(walk.paths.map((one) => one.entity.id).sort()).toStrictEqual(['b', 'c', 'd']);
  });

  it('reports a node reached two ways once, by a shortest path — AC-5', async () => {
    // A diamond: `d` is reachable at depth 2 and at depth 3.
    const { hop } = graph({ a: ['b', 'c'], b: ['d'], c: ['x'], x: ['d'], d: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 4 });
    const d = walk.paths.filter((one) => one.entity.id === 'd');

    expect(d).toHaveLength(1);
    expect(d[0]?.depth).toBe(2);
    expect(d[0]?.steps.map((step) => step.entityId)).toStrictEqual(['b', 'd']);
  });
});

describe('the result bound — AC-13', () => {
  it('stops at the limit and says so', async () => {
    const { hop } = graph({ a: ['b', 'c', 'd', 'e'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 2, limit: 2 });

    expect(walk.paths).toHaveLength(2);
    expect(walk.truncated).toBe(TraversalBound.LIMIT);
  });

  it('prefers the limit reason when both bounds would apply', async () => {
    // The limit stopped it first, and that is the more specific answer: raising
    // the depth would not help.
    const { hop } = graph({ a: ['b', 'c'], b: ['d'], c: ['e'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 1, limit: 1 });

    expect(walk.truncated).toBe(TraversalBound.LIMIT);
  });
});

describe('a degenerate walk', () => {
  it('reaches nothing from a node with no edges', async () => {
    const { hop } = graph({ a: [] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 3 });

    expect(walk.paths).toStrictEqual([]);
    expect(walk.truncated).toBeUndefined();
    expect(walk.depthReached).toBe(1);
  });

  it('reaches nothing from a node the graph does not contain', async () => {
    const { hop } = graph({ a: ['b'] });

    const walk = await traverseFrom(hop, { from: 'missing', depth: 3 });

    expect(walk.paths).toStrictEqual([]);
  });

  it('freezes what it returns', async () => {
    const { hop } = graph({ a: ['b'] });

    const walk = await traverseFrom(hop, { from: 'a', depth: 1 });

    expect(Object.isFrozen(walk)).toBe(true);
    expect(Object.isFrozen(walk.paths)).toBe(true);
  });
});
