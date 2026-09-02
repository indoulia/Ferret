import { effectiveAuthority, SourceAuthority, type CanonicalEntity } from '../domain/index.js';

import { LIVE_STANDING, describeStanding, recencyKey, standing } from './freshness.js';
import { MAX_LIMIT, type RankBreakdown, type RankSignals, type SearchHit } from './query.js';

/**
 * Ranking retrieval results — EPIC-056.
 *
 * Three P0 Epics disclaim ranking and name this module: EPIC-034 §4 ("this Epic
 * returns matches in a defined order; EPIC-056 ranks"), EPIC-052/053 §4
 * ("ranking that is comparable across queries"), and `query.ts` on
 * `SearchHit.score`.
 *
 * Pure, and core: it takes candidate hits and returns candidate hits. It never
 * queries, so it can only ever reorder, fold and truncate what authorization
 * already allowed through — which is the property EPIC-056 AC-11 tests.
 *
 * **No table of per-kind weights.** That was the obvious implementation and it
 * would have needed a defence for every number in it. What is here instead is
 * two rules that follow from the data model: a part of a thing is credited to
 * the thing (§8.2), and independent matches combine (§8.3).
 */

/**
 * Candidates fetched per result returned.
 *
 * Reranking can only change an answer if the pool is bigger than the answer;
 * with `limit` candidates the best possible rerank is a reordering of a page
 * somebody else chose. Five is the smallest factor that lets a whole page turn
 * over, and the pool is bounded by `MAX_LIMIT` regardless — EPIC-056 §8.7.
 */
export const OVERFETCH = 5;

/** How many candidates to fetch to answer with `limit` of them. */
export function overfetchLimit(limit: number): number {
  return Math.min(limit * OVERFETCH, MAX_LIMIT);
}

/**
 * Kinds that are a part of something a person names, and how the part says
 * which whole it belongs to — EPIC-056 §8.2.
 *
 * `file_version.source_scope` is the file's entity id. A `code_symbol`'s is
 * `` `${repositoryScope}:${path}` `` — `symbolScope` in `src/code/identity.ts`,
 * because EPIC-034 identifies a symbol within its file by path rather than by a
 * foreign key. Both are already on the row, so resolving a container is a
 * string comparison over the pool and not a second query.
 */
const CONSTITUENT_KINDS: ReadonlySet<string> = new Set(['code_symbol', 'file_version']);

/** The container keys an entity answers to, for a constituent to find it by. */
function containerKeys(entity: CanonicalEntity): readonly string[] {
  if (CONSTITUENT_KINDS.has(entity.kind)) return [];
  const keys = [entity.id];
  // The composite key only a whole publishes. A `file_version` has a path too,
  // and letting it publish this would fold a symbol into a version of its file
  // rather than into the file — the part into another part.
  const path = attribute(entity, 'path');
  if (entity.source.scope !== undefined && path !== undefined) keys.push(`${entity.source.scope}:${path}`);
  return keys;
}

/** The container this hit belongs to, or `undefined` if it is not a part. */
function containerKeyOf(entity: CanonicalEntity): string | undefined {
  if (!CONSTITUENT_KINDS.has(entity.kind)) return undefined;
  // A malformed or absent scope makes the hit its own answer rather than an
  // error: a constituent nobody can place still matched the query.
  return entity.source.scope === undefined || entity.source.scope === '' ? undefined : entity.source.scope;
}

function attribute(entity: CanonicalEntity, name: string): string | undefined {
  const value = entity.attributes[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Probabilistic or over independent relevances — EPIC-056 §8.3.
 *
 * `1 - Π(1 - rᵢ)`. Monotone in every input, stays inside `[0, 1]` for inputs in
 * `[0, 1]`, and has no constant to tune. An entity matched by its name and by
 * its body scores above the same entity matched either way alone, which is what
 * AC-7 asserts, without a weight saying by how much.
 */
function noisyOr(relevances: Iterable<number>): number {
  let complement = 1;
  for (const relevance of relevances) complement *= 1 - clamp(relevance);
  return 1 - complement;
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 1 ? 1 : value;
}

/**
 * One contributor's best relevance.
 *
 * Keyed so that repetition cannot masquerade as corroboration — the reason
 * `fuse` gives for keeping evidence rows apart: "an entity with twenty evidence
 * records would otherwise dominate by corroborating itself." Twenty evidence
 * hits share the key `evidence` and contribute the best one, once. Two symbols
 * in one file are two keys, because two different parts of the file matching is
 * what the file being about the term looks like.
 */
function contributorKey(hit: SearchHit): string {
  return hit.source;
}

interface Group<T extends SearchHit> {
  /** The row whose highlight and evidence the answer shows. */
  best: T;
  /** Contributor key to its best relevance. */
  readonly contributions: Map<string, number>;
  readonly subsumed: Set<string>;
}

/**
 * Ranks a candidate pool and returns at most `limit` of it.
 *
 * Generic over the hit so a caller may carry its own fields through — the
 * storage layer threads an evidence id it only wants to resolve for the rows
 * that survive.
 */
export function rank<T extends SearchHit & RankSignals>(
  hits: readonly T[],
  limit: number,
): readonly (T & { readonly ranking: RankBreakdown })[] {
  const groups = new Map<string, Group<T>>();

  // One group per entity — EPIC-056 §8.5. A ranked answer is an ordering of
  // things, not of observations about them.
  for (const hit of hits) {
    const existing = groups.get(hit.entity.id);
    const group = existing ?? { best: hit, contributions: new Map<string, number>(), subsumed: new Set<string>() };
    if (existing === undefined) groups.set(hit.entity.id, group);
    else if (hit.score > group.best.score) group.best = hit;

    const key = contributorKey(hit);
    group.contributions.set(key, Math.max(group.contributions.get(key) ?? 0, clamp(hit.score)));
  }

  // Where a part can find its whole. Built from the groups so a container is
  // only claimable if it is in the pool at all — a constituent whose file was
  // not retrieved stands as its own hit (AC-5).
  const containers = new Map<string, Group<T>>();
  for (const group of groups.values()) {
    for (const key of containerKeys(group.best.entity)) containers.set(key, group);
  }

  const survivors: Group<T>[] = [];
  for (const group of groups.values()) {
    const containerKey = containerKeyOf(group.best.entity);
    const container = containerKey === undefined ? undefined : containers.get(containerKey);
    if (container === undefined || container === group) {
      survivors.push(group);
      continue;
    }
    // The part is credited to the whole and folded. Its *relevance* moves; its
    // text does not — the answer shows the surviving hit's own highlight, which
    // is what keeps this a ranking decision rather than a disclosure.
    container.contributions.set(
      `subsumed:${group.best.entity.id}`,
      noisyOr(group.contributions.values()),
    );
    container.subsumed.add(group.best.entity.id);
  }

  return survivors
    .map((group) => {
      const score = noisyOr(group.contributions.values());
      const where = standing(group.best.entity);
      const ranking: RankBreakdown = Object.freeze({
        relevance: clamp(group.best.score),
        contributors: Object.freeze([...group.contributions.keys()].sort()),
        subsumed: Object.freeze([...group.subsumed].sort()),
        standing: where,
        // Only when standing actually moved the hit. A sentence on every result
        // saying "this is live" is noise a reader learns to skip, and then does
        // not read the one that matters.
        ...(where === LIVE_STANDING ? {} : { why: describeStanding(group.best.entity) }),
      });
      return { ...group.best, score, ranking };
    })
    .sort(compareRanked)
    .slice(0, limit);
}

/**
 * The full ordering — EPIC-057 §8.3.
 *
 * ```
 * standing asc → relevance desc → authority desc → recency desc
 *              → kind asc → sourceId asc → id asc
 * ```
 *
 * **Standing outranks relevance, and it is the only thing that does.** A
 * tombstoned file that matches perfectly is still the wrong answer while a live
 * one matches at all, and no tiebreak can fix that. Everything below relevance
 * acts where relevance has already tied — which after probabilistic or is
 * common; the golden run has three files at 0.0797.
 *
 * `kind → sourceId → id` is EPIC-056's determinism tail, unchanged, so the order
 * stays total and AC-2 still holds.
 */
function compareRanked<T extends SearchHit & RankSignals & { readonly ranking: RankBreakdown }>(
  a: T,
  b: T,
): number {
  return (
    a.ranking.standing - b.ranking.standing ||
    b.score - a.score ||
    authorityOf(b) - authorityOf(a) ||
    // Descending, and a missing timestamp is the empty string — so it never
    // precedes a hit that has one, and is not called old either.
    recencyKey(b.entity).localeCompare(recencyKey(a.entity)) ||
    a.entity.kind.localeCompare(b.entity.kind) ||
    a.entity.source.id.localeCompare(b.entity.source.id) ||
    a.entity.id.localeCompare(b.entity.id)
  );
}

/**
 * The authority to order this hit by.
 *
 * Absent on every branch but evidence, where the candidate row carries it so
 * ranking does not have to read a record it may then fold away. Absent means
 * unassessed, which is what `effectiveAuthority` is for — not the weakest rank.
 */
function authorityOf(hit: SearchHit & RankSignals): number {
  return effectiveAuthority(hit.authority ?? SourceAuthority.UNKNOWN);
}
