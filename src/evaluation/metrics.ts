/**
 * Retrieval quality metrics — EPIC-098.
 *
 * Pure, and computed from **rank order only**. `src/retrieval/query.ts:150`
 * records why that constraint is not stylistic: a `SearchHit.score` is
 * PostgreSQL's `ts_rank`, "comparable within one result set and nowhere else …
 * treating it as one across queries is how a threshold gets hard-coded that means
 * nothing". A metric built on it would be a number without a meaning.
 *
 * Nothing here knows what a golden dataset is, what a retrieval port is, or where
 * a ranking came from. They take a ranked list of ids and a map of graded
 * relevance, which is what makes them checkable against a worked example on
 * paper.
 */

/** Relevance grade per expected id. Anything absent is irrelevant. */
export type Grades = ReadonlyMap<string, number>;

/**
 * How much of what was returned was relevant, over the first `k`.
 *
 * `undefined` when nothing was returned: zero out of zero is not zero precision,
 * and averaging a made-up zero into a mean is how a harness reports a decline
 * that did not happen. An absence label is counted separately for the same
 * reason (EPIC-098 §8).
 */
export function precisionAtK(ranked: readonly string[], grades: Grades, k: number): number | undefined {
  const window = ranked.slice(0, Math.max(0, k));
  if (window.length === 0) return undefined;
  const relevant = window.filter((id) => (grades.get(id) ?? 0) > 0).length;
  return relevant / window.length;
}

/**
 * How much of what should have been found was found.
 *
 * `undefined` when nothing was expected — recall over an empty expectation is
 * undefined, not perfect, and reporting 1.0 there would let a dataset of
 * absences claim a flawless score.
 */
export function recallOf(ranked: readonly string[], grades: Grades): number | undefined {
  const expected = [...grades.keys()].filter((id) => (grades.get(id) ?? 0) > 0);
  if (expected.length === 0) return undefined;
  const found = new Set(ranked);
  return expected.filter((id) => found.has(id)).length / expected.length;
}

/**
 * 1 / the rank of the first relevant result, or 0 if none is relevant.
 *
 * Zero rather than `undefined` when nothing relevant came back: that is a real
 * measurement — the caller looked and found nothing useful — unlike precision
 * over an empty result, which is a question that was never asked.
 */
export function reciprocalRank(ranked: readonly string[], grades: Grades): number {
  const position = ranked.findIndex((id) => (grades.get(id) ?? 0) > 0);
  return position === -1 ? 0 : 1 / (position + 1);
}

/** Discounted cumulative gain over the first `k`, log base 2. */
function dcg(ranked: readonly string[], grades: Grades, k: number): number {
  return ranked.slice(0, Math.max(0, k)).reduce((total, id, index) => {
    const gain = grades.get(id) ?? 0;
    return total + gain / Math.log2(index + 2);
  }, 0);
}

/**
 * Normalised discounted cumulative gain — the ranking metric.
 *
 * The only one of the four that distinguishes a right answer in position one from
 * the same answer in position nine, which is why EPIC-096 graded its labels
 * rather than marking them present or absent. Ranking is one of the five things
 * Governance §19 names.
 *
 * `undefined` when nothing was expected, so an absence label cannot contribute a
 * ranking score to a mean.
 */
export function ndcgAtK(ranked: readonly string[], grades: Grades, k: number): number | undefined {
  const ideal = [...grades.values()].filter((grade) => grade > 0).sort((a, b) => b - a);
  if (ideal.length === 0) return undefined;

  const best = ideal.slice(0, Math.max(0, k)).reduce((total, gain, index) => {
    return total + gain / Math.log2(index + 2);
  }, 0);
  // Cannot be zero: `ideal` is non-empty and every gain in it is positive.
  return dcg(ranked, grades, k) / best;
}

/** The mean of the values that are defined, or `undefined` when none is. */
export function meanOf(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  return present.reduce((total, value) => total + value, 0) / present.length;
}
