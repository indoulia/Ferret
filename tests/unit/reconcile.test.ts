import { describe, expect, it } from 'vitest';

import {
  ReconcileOutcome,
  byStaleness,
  isFresh,
  parseDuration,
  passFailed,
  summarizePass,
  type ReconcileCandidate,
  type ReconcileEntry,
} from '../../src/indexing/index.js';

/**
 * EPIC-078's decisions, without a database.
 *
 * The staleness threshold, the ordering and the exit-code mapping are the parts
 * a scheduler depends on, and all three are pure. The pass itself is
 * `tests/integration/indexing/reconcile.test.ts`.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

function candidate(id: string, agoMs: number): ReconcileCandidate {
  return { repositoryId: id, path: `/repos/${id}`, lastIndexedAt: new Date(NOW.getTime() - agoMs) };
}

function entry(outcome: ReconcileOutcome, id = 'r1'): ReconcileEntry {
  return { repositoryId: id, path: `/repos/${id}`, outcome, ageMs: 0, overdue: false };
}

describe('a pass goes oldest first — AC-2', () => {
  it('orders by staleness', () => {
    // So a pass that is interrupted has done the most useful work rather than
    // the alphabetically earliest.
    const ordered = byStaleness([candidate('fresh', 60_000), candidate('ancient', 86_400_000), candidate('mid', 3_600_000)]);

    expect(ordered.map((one) => one.repositoryId)).toStrictEqual(['ancient', 'mid', 'fresh']);
  });

  it('breaks a tie stably, so two passes read the same', () => {
    // Two repositories indexed in the same millisecond must not swap places
    // between passes and make the report unreadable.
    const same = [candidate('b', 1_000), candidate('a', 1_000), candidate('c', 1_000)];

    expect(byStaleness(same).map((one) => one.repositoryId)).toStrictEqual(['a', 'b', 'c']);
    expect(byStaleness([...same].reverse()).map((one) => one.repositoryId)).toStrictEqual(['a', 'b', 'c']);
  });

  it('does not mutate what it was given', () => {
    const input = [candidate('b', 1_000), candidate('a', 5_000)];
    byStaleness(input);

    expect(input.map((one) => one.repositoryId)).toStrictEqual(['b', 'a']);
  });
});

describe('cadence is a threshold, not a timer — AC-3, AC-5', () => {
  it('treats a repository indexed within the threshold as fresh — AC-3', () => {
    expect(isFresh(candidate('r', 60_000), 3_600_000, NOW)).toBe(true);
  });

  it('treats one indexed longer ago as stale', () => {
    expect(isFresh(candidate('r', 7_200_000), 3_600_000, NOW)).toBe(false);
  });

  it('attempts everything when no threshold is given — AC-5', () => {
    // A pass with no `--stale-after` reconciles the lot, which is what an
    // operator running it by hand means.
    expect(isFresh(candidate('r', 1), undefined, NOW)).toBe(false);
    expect(isFresh(candidate('r', 86_400_000), undefined, NOW)).toBe(false);
  });

  it('treats the boundary as stale, not fresh', () => {
    // Exactly at the threshold is due: a 6h cadence that skipped at 6h would
    // drift a little later every pass.
    expect(isFresh(candidate('r', 3_600_000), 3_600_000, NOW)).toBe(false);
  });
});

describe('a duration is readable in a cron line', () => {
  it('parses each unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('6h')).toBe(21_600_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('90')).toBe(90_000);
  });

  it('tolerates surrounding space', () => {
    expect(parseDuration('  6h ')).toBe(21_600_000);
  });

  it('refuses what it cannot read rather than guessing', () => {
    // A silently-misparsed threshold is a pass that quietly does nothing, or
    // everything — both worse than a usage error.
    for (const bad of ['', 'soon', '6 hours', '-1h', '1.5h', 'h', '6H']) {
      expect(parseDuration(bad), bad).toBeUndefined();
    }
  });
});

describe('the exit code distinguishes nothing-to-do from something-failed — AC-9 to AC-11', () => {
  it('is a success when everything attempted succeeded — AC-9', () => {
    const report = summarizePass([entry(ReconcileOutcome.INDEXED, 'a'), entry(ReconcileOutcome.INDEXED, 'b')], true);

    expect(report.indexed).toBe(2);
    expect(passFailed(report)).toBe(false);
  });

  it('is a success when everything was skipped as fresh — AC-10', () => {
    // The one that matters: a scheduler mailing about this hourly would train
    // an operator to ignore the mail.
    const report = summarizePass([entry(ReconcileOutcome.FRESH, 'a'), entry(ReconcileOutcome.FRESH, 'b')], true);

    expect(report.skipped).toBe(2);
    expect(report.indexed).toBe(0);
    expect(passFailed(report)).toBe(false);
  });

  it('is a success when a run was in flight', () => {
    expect(passFailed(summarizePass([entry(ReconcileOutcome.IN_FLIGHT)], true))).toBe(false);
  });

  it('is a success when a checkout is on another machine — AC-18', () => {
    // A pass against a shared database legitimately meets repositories it
    // cannot reach. Calling those failures would make every such pass exit
    // non-zero for ever, which is what §8.7 exists to prevent.
    const report = summarizePass([entry(ReconcileOutcome.ELSEWHERE)], true);

    expect(report.skipped).toBe(1);
    expect(report.failed).toBe(0);
    expect(passFailed(report)).toBe(false);
  });

  it('is a failure when a repository failed — AC-11', () => {
    const report = summarizePass(
      [entry(ReconcileOutcome.INDEXED, 'a'), entry(ReconcileOutcome.FAILED, 'b')],
      true,
    );

    expect(report.failed).toBe(1);
    // And the one that worked is still counted, so the report is not all-or-nothing.
    expect(report.indexed).toBe(1);
    expect(passFailed(report)).toBe(true);
  });

  it('is a success on an empty index — AC-16', () => {
    const report = summarizePass([], true);

    expect(report).toMatchObject({ indexed: 0, skipped: 0, failed: 0 });
    expect(passFailed(report)).toBe(false);
  });

  it('counts a dry run as skipped and not applied — AC-17', () => {
    const report = summarizePass([entry(ReconcileOutcome.PLANNED)], false);

    expect(report.applied).toBe(false);
    expect(report.skipped).toBe(1);
    expect(report.indexed).toBe(0);
    expect(passFailed(report)).toBe(false);
  });
});

describe('skipped and done stay distinct — AC-4', () => {
  it('never counts a fresh repository as indexed', () => {
    // §8.3 — a report that conflated them would make a broken pass
    // indistinguishable from a quiet one.
    const report = summarizePass([entry(ReconcileOutcome.FRESH)], true);

    expect(report.indexed).toBe(0);
    expect(report.entries[0]?.outcome).toBe(ReconcileOutcome.FRESH);
  });

  it('gives every outcome its own name', () => {
    expect(Object.values(ReconcileOutcome).sort()).toStrictEqual([
      'elsewhere',
      'failed',
      'fresh',
      'in-flight',
      'indexed',
      'planned',
    ]);
  });
});

describe('Ferret schedules nothing — AC-14, AC-15', () => {
  it('names no timer, and no destructive operation, in the pass module', async () => {
    // §8.1 and §8.5. The three operations deferred here as *decisions* — a
    // scheduled prune, a scheduled export, an unattended provider recovery —
    // are all declined, and the module that a pass runs through must not reach
    // them even by accident.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/indexing/reconcile.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('RetentionService');
    expect(source).not.toContain('ExportService');
    expect(source).not.toContain('recover');
  });

  it('does not reach a destructive service from the command either — AC-14', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/cli/commands/reconcile.ts', import.meta.url), 'utf8'),
    );

    // Named imports, so a future author who adds one has to remove this test
    // and say why.
    expect(source).not.toContain('RetentionService');
    expect(source).not.toContain('ExportService');
    expect(source).not.toContain('ImportService');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('setTimeout');
  });

  it('reads no stdin — AC-13', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/cli/commands/reconcile.ts', import.meta.url), 'utf8'),
    );

    // An unattended run has no terminal, so a prompt is a hang. Matched on the
    // APIs rather than on the word, which appears in the prose above saying
    // there is no prompt.
    expect(source).not.toContain('process.stdin');
    expect(source).not.toContain('readline');
    expect(source).not.toContain('createInterface');
    expect(source).not.toContain('question(');
  });
});
