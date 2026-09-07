/**
 * Types for the continuity benchmark's content measure, so its guard test can
 * import it.
 *
 * The same reason `benchmark/lib/score.d.mts` gives: the harness is plain Node
 * and runs independently of `tsc`, but `tests/unit/continuity-tasks.test.ts`
 * imports `factsIn` to pin what `answered` means. Without this the import is
 * implicitly `any` and the guard would assert against whatever it was handed —
 * which is precisely the failure a guard on a headline figure exists to prevent.
 */

/** A fact a complete answer has to contain, in any of its listed wordings. */
export interface RequiredFact {
  readonly id: string;
  readonly any: readonly string[];
  readonly basis?: string;
}

/** A task, as far as checking its facts needs it. */
export interface FactCheckedTask {
  readonly id: string;
  readonly requiredFacts: readonly RequiredFact[];
}

/** Which of a task's required facts were in front of the agent. */
export interface FactReport {
  /** Every required fact was present. `false` for a task that requires none. */
  readonly answered: boolean;
  readonly factsFound: number;
  readonly factsTotal: number;
  readonly missingFacts: readonly string[];
}

export declare function factsIn(task: FactCheckedTask, deliveredText: string): FactReport;
