import { PUBLIC_ACCESS, type AccessContext, type SearchHit, type SearchResult } from '../retrieval/index.js';

import { QueryShape, resolveIdentity, type GoldenDataset, type GoldenQuery } from './dataset.js';
import { meanOf, ndcgAtK, precisionAtK, recallOf, reciprocalRank, type Grades } from './metrics.js';

/**
 * Measuring Ferret's retrieval against the golden dataset — EPIC-098.
 *
 * EPIC-096 supplied labels and deliberately measured nothing; two earlier Epics
 * recorded a measurement they could not make
 * (`validation/EPIC-042-VALIDATION.md:96`, `validation/EPIC-044-045-VALIDATION.md:100`).
 * This is the number.
 *
 * **It reads and queries; it never writes.** It cannot edit a label — if a label
 * is wrong that is a change to EPIC-096 with a recomputed checksum — and it
 * cannot index. A harness that could adjust its own expectations measures
 * nothing.
 */

/**
 * The two reads a golden query needs.
 *
 * A port of its own rather than `RetrievalPort`, which has no `byIdentifier`
 * (`src/retrieval/query.ts:186`): the exact-lookup path an `exact` label
 * describes lives on `ExactStrategy` and on `RetrievalStore`. Widening
 * `RetrievalPort` to suit a harness would be the harness dictating the product's
 * shape, and importing `storage/` here would put a database dependency in a module
 * whose whole job is to be runnable anywhere. `RetrievalStore` satisfies this
 * structurally, the same way it satisfies `EvidenceReader`.
 */
export interface MeasurableRetrieval {
  search(query: { readonly text: string; readonly limit?: number }, access: AccessContext): Promise<SearchResult>;
  byIdentifier(term: string, access: AccessContext, limit?: number): Promise<readonly SearchHit[]>;
}

/** How deep into a ranking the metrics look. */
export const DEFAULT_K = 10;

export interface QueryMeasurement {
  readonly id: string;
  readonly shape: QueryShape;
  readonly query: string;
  /** How many results came back, before any window is applied. */
  readonly returned: number;
  readonly expected: number;
  readonly precisionAtK: number | undefined;
  readonly recall: number | undefined;
  readonly reciprocalRank: number | undefined;
  readonly ndcg: number | undefined;
  /**
   * Results returned for a label that expected none.
   *
   * Only set for an absence label. Counted rather than scored, because precision
   * over an empty expectation is undefined and folding a made-up zero into a mean
   * would hide exactly the failure the label exists to catch.
   */
  readonly falsePositives: number | undefined;
}

export interface RetrievalQualityReport {
  /** What was measured against. A figure without this cannot be compared to another. */
  readonly dataset: { readonly version: string; readonly checksum: string };
  readonly k: number;
  readonly queries: readonly QueryMeasurement[];
  readonly aggregate: {
    readonly measured: number;
    readonly meanPrecisionAtK: number | undefined;
    readonly meanRecall: number | undefined;
    readonly meanReciprocalRank: number | undefined;
    readonly meanNdcg: number | undefined;
    /** Across every absence label. Zero is the only passing value. */
    readonly falsePositives: number;
  };
}

/** Ranked entity ids for one label, in the order retrieval returned them. */
async function rankingFor(
  query: GoldenQuery,
  retrieval: MeasurableRetrieval,
  access: AccessContext,
  k: number,
): Promise<readonly string[]> {
  if (query.shape === QueryShape.EXACT) {
    const hits = await retrieval.byIdentifier(query.query, access, k);
    return hits.map((hit) => hit.entity.id);
  }
  const result = await retrieval.search({ text: query.query, limit: k }, access);
  return result.hits.map((hit) => hit.entity.id);
}

/**
 * Runs every golden query and reports what retrieval did.
 *
 * Reports; it does not assert. The first run's job is to produce a number, not to
 * pass — EPIC-096 §4 deferred the threshold decision to this Epic precisely so it
 * could be argued from data rather than guessed in advance.
 */
export async function measureRetrievalQuality(
  dataset: GoldenDataset,
  retrieval: MeasurableRetrieval,
  bindings: Readonly<Record<string, string>>,
  options: { readonly k?: number; readonly access?: AccessContext } = {},
): Promise<RetrievalQualityReport> {
  const k = options.k ?? DEFAULT_K;
  const access = options.access ?? PUBLIC_ACCESS;

  const queries: QueryMeasurement[] = [];
  for (const query of dataset.queries) {
    const grades: Grades = new Map(
      query.expected.map((one) => [resolveIdentity(one, bindings), one.relevance]),
    );
    const ranked = await rankingFor(query, retrieval, access, k);
    const isAbsence = query.expected.length === 0;

    queries.push({
      id: query.id,
      shape: query.shape,
      query: query.query,
      returned: ranked.length,
      expected: query.expected.length,
      // An absence label contributes nothing to the scored means — EPIC-098 §8.
      precisionAtK: isAbsence ? undefined : precisionAtK(ranked, grades, k),
      recall: isAbsence ? undefined : recallOf(ranked, grades),
      reciprocalRank: isAbsence ? undefined : reciprocalRank(ranked, grades),
      ndcg: isAbsence ? undefined : ndcgAtK(ranked, grades, k),
      falsePositives: isAbsence ? ranked.length : undefined,
    });
  }

  return Object.freeze({
    dataset: { version: dataset.version, checksum: dataset.checksum },
    k,
    queries: Object.freeze(queries),
    aggregate: Object.freeze({
      measured: queries.filter((one) => one.expected > 0).length,
      meanPrecisionAtK: meanOf(queries.map((one) => one.precisionAtK)),
      meanRecall: meanOf(queries.map((one) => one.recall)),
      meanReciprocalRank: meanOf(queries.map((one) => one.reciprocalRank)),
      meanNdcg: meanOf(queries.map((one) => one.ndcg)),
      falsePositives: queries.reduce((total, one) => total + (one.falsePositives ?? 0), 0),
    }),
  });
}
