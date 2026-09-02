/**
 * Periodic reconciliation — EPIC-078.
 *
 * **Ferret does not schedule itself.** No daemon, no timer, no background
 * thread: `cron`, a `systemd` timer and Task Scheduler each already solve the
 * problems a hand-rolled scheduler would solve badly — surviving a reboot, not
 * overlapping with itself, logging when it ran, and being visible to an
 * operator who did not write it. The same answer EPIC-089 §8.1 gave about
 * `pg_dump` and EPIC-088 §4 gave about `dropdb`.
 *
 * What this owes a scheduler is a command that is *safe to run unattended*: no
 * prompt, an exit code that means something, and a pass that is harmless when
 * it overlaps with another.
 */

/** What happened to one repository in a pass. */
export const ReconcileOutcome = {
  INDEXED: 'indexed',
  /** Indexed more recently than the staleness threshold — §8.3. */
  FRESH: 'fresh',
  /** A run is apparently still open — §8.4. Skipped, never queued. */
  IN_FLIGHT: 'in-flight',
  /**
   * Indexed from a path that is not on this machine.
   *
   * A repository's checkout path is deliberately *not* a canonical attribute —
   * `src/git/provider.ts` records why: "where this checkout happens to live is
   * a fact about **this machine**, not about the repository, so two machines
   * sharing one Ferret database would otherwise overwrite each other's copy of
   * the same row for ever." It lives in `unknownFields.localRoot`.
   *
   * So a pass run against a shared database legitimately meets repositories it
   * cannot reach. Reporting those as `failed` would make every such pass exit
   * non-zero for ever and train an operator to ignore the result; this is its
   * own outcome, counted as a skip.
   */
  ELSEWHERE: 'elsewhere',
  /** Reported by `--dry-run`, which indexes nothing. */
  PLANNED: 'planned',
  FAILED: 'failed',
} as const;

export type ReconcileOutcome = (typeof ReconcileOutcome)[keyof typeof ReconcileOutcome];

/** A repository as a pass sees it, before anything is attempted. */
export interface ReconcileCandidate {
  readonly repositoryId: string;
  /** The path the repository was indexed from. */
  readonly path: string;
  /** When Ferret last *looked*, which is not when the source last changed. */
  readonly lastIndexedAt: Date;
}

export interface ReconcileEntry {
  readonly repositoryId: string;
  readonly path: string;
  readonly outcome: ReconcileOutcome;
  /** Milliseconds since Ferret last looked at it. */
  readonly ageMs: number;
  /** Past the staleness threshold, when one was given — §8.8. */
  readonly overdue: boolean;
  /** The error code, never its message. EPIC-093's rule. */
  readonly failureCode?: string | undefined;
  readonly detail?: string | undefined;
}

export interface ReconcileReport {
  readonly entries: readonly ReconcileEntry[];
  readonly indexed: number;
  readonly skipped: number;
  readonly failed: number;
  /** False for a `--dry-run` pass. */
  readonly applied: boolean;
}

/**
 * Oldest first — §8.2.
 *
 * So a pass that is interrupted has done the most useful work rather than the
 * alphabetically earliest, and so nothing needs a cursor of its own: re-running
 * from the start reaches the same repositories in the same order.
 */
export function byStaleness(candidates: readonly ReconcileCandidate[]): readonly ReconcileCandidate[] {
  return [...candidates].sort((left, right) => {
    const byAge = left.lastIndexedAt.getTime() - right.lastIndexedAt.getTime();
    // A stable tiebreak, so two repositories indexed in the same millisecond
    // do not swap places between passes and make a report unreadable.
    return byAge !== 0 ? byAge : left.repositoryId.localeCompare(right.repositoryId);
  });
}

/**
 * Whether a repository is fresh enough to skip — §8.3.
 *
 * Cadence as a threshold rather than a timer: an hourly cron line pointed at a
 * `--stale-after 6h` pass is safe, because the schedule can be more frequent
 * than the work without doing the work more frequently.
 */
export function isFresh(candidate: ReconcileCandidate, staleAfterMs: number | undefined, now: Date): boolean {
  if (staleAfterMs === undefined) return false;
  return now.getTime() - candidate.lastIndexedAt.getTime() < staleAfterMs;
}

/**
 * A duration as milliseconds. `30m`, `6h`, `7d`, or bare seconds.
 *
 * Parsed rather than taken as a number of seconds, because a cron line reading
 * `--stale-after 21600` is a cron line nobody can check at a glance.
 */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const scale: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (scale[unit] ?? 1_000);
}

/**
 * Summarises a pass.
 *
 * `skipped` counts fresh, in-flight and planned together on purpose: from a
 * scheduler's point of view they are the same fact — the pass chose not to
 * index this one — and §8.7 makes all three exit `0`.
 */
export function summarizePass(
  entries: readonly ReconcileEntry[],
  applied: boolean,
): ReconcileReport {
  return {
    entries,
    indexed: entries.filter((one) => one.outcome === ReconcileOutcome.INDEXED).length,
    skipped: entries.filter(
      (one) =>
        one.outcome === ReconcileOutcome.FRESH ||
        one.outcome === ReconcileOutcome.IN_FLIGHT ||
        one.outcome === ReconcileOutcome.PLANNED ||
        one.outcome === ReconcileOutcome.ELSEWHERE,
    ).length,
    failed: entries.filter((one) => one.outcome === ReconcileOutcome.FAILED).length,
    applied,
  };
}

/**
 * Whether a pass should exit non-zero — §8.7.
 *
 * A pass that skipped everything as fresh is the pass **working**, and a
 * scheduler that mailed about it every hour would train an operator to ignore
 * the mail. Only a repository that failed is a failure.
 */
export function passFailed(report: ReconcileReport): boolean {
  return report.failed > 0;
}
