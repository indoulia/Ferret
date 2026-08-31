import type { SearchHit } from './query.js';

// RRF: ts_rank and cosine distance share no scale, so only rank can be
// combined. score = sum of 1 / (k + rank).

/** TREC default; untuned on purpose. */
export const RRF_K = 60;

export interface RankedList {
  readonly strategy: string;
  readonly hits: readonly SearchHit[];
}

export interface FusedHit extends SearchHit {
  readonly foundBy: readonly string[];
  /** Comparable within this result set only. */
  readonly fusedScore: number;
}

// Order-independent: strategies run concurrently, so completion order must not
// affect the ranking. Ties break on identity, not arrival.
export function fuse(lists: readonly RankedList[], limit: number): readonly FusedHit[] {
  const accumulated = new Map<
    string,
    { hit: SearchHit; score: number; foundBy: string[] }
  >();

  for (const list of lists) {
    for (const [index, hit] of list.hits.entries()) {
      const key = identify(hit);
      const existing = accumulated.get(key);
      const contribution = 1 / (RRF_K + index + 1);

      if (existing === undefined) {
        accumulated.set(key, { hit, score: contribution, foundBy: [list.strategy] });
        continue;
      }
      existing.score += contribution;
      // Once per strategy: a duplicate within one list must not look like
      // corroboration from two.
      if (!existing.foundBy.includes(list.strategy)) existing.foundBy.push(list.strategy);
    }
  }

  return [...accumulated.entries()]
    .map(([key, entry]) => ({
      ...entry.hit,
      foundBy: entry.foundBy,
      fusedScore: entry.score,
      key,
    }))
    .sort((a, b) => (b.fusedScore - a.fusedScore) || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map(({ key: _key, ...hit }) => hit);
}

// Not merged: an entity with twenty evidence records would otherwise dominate
// by corroborating itself.
function identify(hit: SearchHit): string {
  return hit.evidence === undefined ? `entity:${hit.entity.id}` : `evidence:${hit.evidence.id}`;
}
