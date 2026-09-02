import {
  TraversalBound,
  boundedDepth,
  boundedLimit,
  type Neighbour,
  type TraversalPath,
  type TraversalResult,
  type TraversalStep,
} from './query.js';
import { NOTHING_WITHHELD, type WithheldReport } from './access.js';

/**
 * Walking more than one hop — EPIC-050.
 *
 * EPIC-007's validation recorded five limitations and every one is here:
 * traversal was one hop, so "which release contains the fix for FER-12" had to
 * be walked by the caller, with its own visited set, its own depth bound, and no
 * way to be told that a path existed but was truncated.
 *
 * **Pure, and it takes the one-hop read as a function.** That is not a testing
 * convenience; it is the security property. A recursive CTE is the obvious
 * implementation and cannot be used: `neighbours` filters twice — in SQL through
 * `scopePredicate`, and in TypeScript through `visibleEntities` for the
 * dimensions SQL cannot express (worktree, session, glob path exclusion) — and a
 * CTE can carry the first and not the second. A walk built that way would expand
 * *through* a node the caller may not see and return what lies beyond it, which
 * is a caller learning a relationship exists by receiving its far end.
 *
 * Taking the filtered read as a parameter means every hop is filtered by
 * construction rather than by being reimplemented here, and it makes the bounds
 * and the cycle behaviour testable without a database.
 */

/** One hop from a node, already filtered for the caller's access. */
export type HopReader = (from: string, limit: number) => Promise<readonly Neighbour[]>;

export interface TraverseOptions {
  readonly from: string;
  readonly depth?: number;
  readonly limit?: number;
  /** The withheld report the hop reader accumulated, when the caller keeps one. */
  readonly withheld?: WithheldReport;
}

/**
 * Breadth-first, bounded twice, terminating.
 *
 * Breadth-first so `depth` means what a reader expects and the first path found
 * is a shortest one. **Cycle protection is a visited set, not a path check**: the
 * graph is walked, not the set of walks, so `A → B → A` yields `B` once and
 * stops. Ferret's edges are genuinely cyclic — merge commits through
 * `commit_parent_of_commit`, a rename undone through `entity_supersedes_entity` —
 * and EPIC-007 made cycle protection a precondition of this Epic existing.
 */
export async function traverseFrom(
  hop: HopReader,
  options: TraverseOptions,
): Promise<TraversalResult> {
  const limit = boundedLimit(options.limit);
  const depth = boundedDepth(options.depth);

  const paths: TraversalPath[] = [];
  // The origin counts as visited, so a cycle back to it is not reported as
  // something it reached: a caller asking what this reaches does not mean itself.
  const visited = new Set<string>([options.from]);
  let frontier: readonly { readonly id: string; readonly steps: readonly TraversalStep[] }[] = [
    { id: options.from, steps: [] },
  ];
  let truncated: TraversalBound | undefined;
  let depthReached = 0;

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: { id: string; steps: readonly TraversalStep[] }[] = [];

    for (const node of frontier) {
      const reached = await hop(node.id, limit);

      for (const neighbour of reached) {
        if (visited.has(neighbour.entity.id)) continue;
        if (paths.length >= limit) {
          truncated = TraversalBound.LIMIT;
          break;
        }
        visited.add(neighbour.entity.id);

        const steps: readonly TraversalStep[] = [
          ...node.steps,
          {
            relationshipType: neighbour.relationshipType,
            direction: neighbour.direction,
            entityId: neighbour.entity.id,
          },
        ];
        paths.push({
          entity: neighbour.entity,
          depth: level,
          steps,
          metadata: neighbour.metadata,
        });
        next.push({ id: neighbour.entity.id, steps });
      }
      if (truncated !== undefined) break;
    }

    depthReached = level;
    if (truncated !== undefined) break;
    // Reached the bound with somewhere left to go: the graph continues and
    // Ferret stopped looking, which §8.4 requires it to say. Without this a
    // caller cannot tell "nothing further exists" from "I stopped".
    if (level === depth && next.length > 0) truncated = TraversalBound.DEPTH;
    frontier = next;
  }

  return Object.freeze({
    // Depth first, then identity, so two runs over one graph compare equal.
    // Ordering is never a judgement here — EPIC-056/057 own that.
    paths: Object.freeze(
      [...paths].sort((a, b) => a.depth - b.depth || a.entity.id.localeCompare(b.entity.id)),
    ),
    truncated,
    depthReached,
    withheld: options.withheld ?? NOTHING_WITHHELD,
  });
}
