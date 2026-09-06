/**
 * Types for the benchmark's scorer, so its guard test can import it.
 *
 * The harness is plain Node — it runs against `dist/` and independently of
 * `tsc`, like `scripts/` — but `tests/unit/benchmark-tasks.test.ts` imports
 * `score` and `summarize` to pin what `sourced` and `staleAboveCurrent` mean.
 * Without this the import is implicitly `any` and the guard would assert
 * against whatever it was handed.
 */

/** A graded expectation, as `benchmark/tasks.json` writes one. */
export interface BenchmarkExpectation {
  readonly artefact: string;
  readonly relevance: number;
  readonly basis: string;
}

/** A task, as far as scoring one needs it. */
export interface BenchmarkTask {
  readonly id: string;
  readonly question: string;
  readonly expected: readonly BenchmarkExpectation[];
  readonly superseded: readonly { readonly artefact: string; readonly basis: string }[];
}

/** What a condition spent reaching its answer. */
export interface BenchmarkCost {
  readonly retrievalTokens: number;
  readonly readTokensFull: number;
  readonly readTokensFrugal: number;
  readonly ms: number;
}

/** One condition's score on one task. */
export interface BenchmarkScore extends BenchmarkCost {
  readonly recall: number | undefined;
  readonly precision5: number | undefined;
  readonly precision10: number | undefined;
  readonly ndcg10: number | undefined;
  readonly sourced: boolean;
  readonly primaryFound: number;
  readonly primaryTotal: number;
  readonly reciprocalRankPrimary: number;
  /** `undefined` where the task labels nothing superseded. */
  readonly staleAboveCurrent: boolean | undefined;
  readonly supersededInWindow: number | undefined;
  readonly irrelevant5: number;
}

/** A rate over the tasks where the measurement was defined at all. */
export interface BenchmarkRate {
  readonly rate: number;
  readonly of: number;
}

/** A condition's scores, aggregated. */
export interface BenchmarkSummary {
  readonly tasks: number;
  readonly recall: number | undefined;
  readonly precision5: number | undefined;
  readonly precision10: number | undefined;
  readonly ndcg10: number | undefined;
  readonly mrrPrimary: number | undefined;
  readonly sourced: BenchmarkRate | undefined;
  readonly staleAboveCurrent: BenchmarkRate | undefined;
  readonly irrelevant5PerTask: number;
  readonly retrievalTokens: number;
  readonly readTokensFull: number;
  readonly readTokensFrugal: number;
  readonly totalTokensFull: number;
  readonly totalTokensFrugal: number;
  /** `undefined` when no task was sourced — an absent measurement, not zero. */
  readonly tokensPerSourcedTask: number | undefined;
  readonly medianMs: number | undefined;
}

export declare const K: number;
export declare const READS: number;
export declare function gradesOf(task: BenchmarkTask): ReadonlyMap<string, number>;
export declare function primaryOf(task: BenchmarkTask): readonly string[];
export declare function supersededOf(task: BenchmarkTask): readonly string[];
export declare function score(
  task: BenchmarkTask,
  ranked: readonly string[],
  cost: BenchmarkCost,
): BenchmarkScore;
export declare function summarize(scores: readonly BenchmarkScore[]): BenchmarkSummary;
