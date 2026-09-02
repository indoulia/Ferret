import { existsSync } from 'node:fs';

import { Command, Option } from 'commander';

import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import { ErrorCode, FerretError, toFerretError } from '../../errors/index.js';
import { createGitSourceProvider } from '../../git/index.js';
import {
  ReconcileOutcome,
  RepositoryIndexer,
  byStaleness,
  isFresh,
  parseDuration,
  passFailed,
  summarizePass,
  type ReconcileCandidate,
  type ReconcileEntry,
  type ReconcileReport,
} from '../../indexing/index.js';
import type { LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  IndexRunStore,
  MigrationPolicy,
  RelationshipStore,
  SyncCursorStore,
  createStorageProvider,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';
import { ExitCode } from '../exit-codes.js';

/**
 * `ferret reconcile` — EPIC-078.
 *
 * **Ferret does not schedule itself.** The scheduler is `cron`, a `systemd`
 * timer, or Task Scheduler — each of which already survives a reboot, avoids
 * overlapping with itself, logs when it ran, and is visible to an operator who
 * did not write it. What this command owes them is being *safe to run
 * unattended*: no prompt, an exit code that means something, and a pass that is
 * harmless when it overlaps with another.
 *
 * **It reads and re-derives. It never deletes, exports, or recovers a
 * provider** — §8.5, and each of those three was deferred here as a decision
 * rather than a mechanism. The answer to each is no: an unattended run is the
 * one nobody is watching.
 */
export function reconcileCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('reconcile')
    .description('Bring every repository Ferret already knows up to date — the pass a scheduler runs')
    .addOption(
      new Option(
        '--stale-after <duration>',
        'Skip a repository indexed more recently than this — 30m, 6h, 7d, or bare seconds',
      ),
    )
    .addOption(new Option('--dry-run', 'Report the plan and index nothing').default(false))
    .addOption(
      new Option(
        '--unfinished-after <duration>',
        'Treat a run open longer than this as abandoned rather than in flight',
      ).default('1h'),
    )
    .action(
      async (
        options: { staleAfter?: string; dryRun: boolean; unfinishedAfter: string },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
        const json = globals.json === true;

        const staleAfterMs = options.staleAfter === undefined ? undefined : parseDuration(options.staleAfter);
        if (options.staleAfter !== undefined && staleAfterMs === undefined) {
          throw new FerretError(ErrorCode.USAGE, `"${options.staleAfter}" is not a duration`, {
            details: { staleAfter: options.staleAfter },
            remediation: 'Use a number with an optional unit: 30m, 6h, 7d. A bare number is seconds.',
          });
        }
        const unfinishedAfterMs = parseDuration(options.unfinishedAfter) ?? 3_600_000;

        const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
        const source = createGitSourceProvider();
        const runtime = createRuntime({
          providers: [storage, source],
          ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
        });

        const report = await runtime.run(async (context) => {
          // A pass indexes, so it is checked as an index — the same grant
          // `ferret index` needs. Spelled out at the call site rather than
          // hoisted, which is the shape `authorization-enforcement.test.ts`
          // asserts across every command.
          assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'reconcile');
          assertSupported(runtime.providers.supports(Capability.STORAGE));
          assertSupported(runtime.providers.supports(Capability.SOURCE_REPOSITORY));

          const now = new Date();
          const candidates = byStaleness(await knownRepositories(storage.pool));

          // §8.4 — reusing the run journal rather than adding a lock. Ferret
          // has no per-repository index lock because EPIC-080 proved the write
          // paths idempotent, so an overlapping pass is harmless and merely
          // wasteful; skipping makes it not wasteful either. The evidence is
          // *age*, and `unfinished` says so: runs open longer than any
          // plausible run, not runs known to be dead.
          const runs = new IndexRunStore(storage.db);
          const inFlight = new Set(
            (await runs.unfinished(new Date(now.getTime() + 1)))
              .filter((run) => now.getTime() - run.startedAt.getTime() < unfinishedAfterMs)
              .map((run) => run.repositoryId)
              .filter((id): id is string => id !== undefined),
          );

          const compatibility = new CompatibilityService(storage.db, storage.pool);
          const indexer = new RepositoryIndexer({
            source,
            entities: new EntityStore(storage.db),
            relationships: new RelationshipStore(storage.db),
            evidence: new EvidenceStore(storage.db),
            watermarks: compatibility,
            lifecycle: new IndexLifecycleStore(storage.db),
            runs,
            cursors: new SyncCursorStore(storage.db, storage.pool),
            logger: context.logger,
          });

          const entries: ReconcileEntry[] = [];
          for (const candidate of candidates) {
            const ageMs = now.getTime() - candidate.lastIndexedAt.getTime();
            const overdue = staleAfterMs !== undefined && ageMs >= staleAfterMs;
            const base = { repositoryId: candidate.repositoryId, path: candidate.path, ageMs, overdue };

            if (inFlight.has(candidate.repositoryId)) {
              entries.push({
                ...base,
                outcome: ReconcileOutcome.IN_FLIGHT,
                detail: 'A run for this repository is still open; skipped rather than queued.',
              });
              continue;
            }
            // §8.3 — "nothing needed doing" and "it was done" are different
            // facts, and a report that conflated them would make a broken pass
            // indistinguishable from a quiet one.
            if (isFresh(candidate, staleAfterMs, now)) {
              entries.push({ ...base, outcome: ReconcileOutcome.FRESH });
              continue;
            }
            if (options.dryRun) {
              entries.push({ ...base, outcome: ReconcileOutcome.PLANNED });
              continue;
            }

            // A path recorded by a different machine is not a failure — see
            // `ReconcileOutcome.ELSEWHERE`. Checked before the attempt so the
            // report says which fact it is.
            if (!existsSync(candidate.path)) {
              entries.push({
                ...base,
                outcome: ReconcileOutcome.ELSEWHERE,
                detail: 'The path this repository was indexed from is not on this machine.',
              });
              continue;
            }

            try {
              const described = await source.describeRepository(candidate.path, {
                logger: context.logger,
                signal: context.signal,
              });
              await indexer.index(described, {}, { logger: context.logger, signal: context.signal });
              entries.push({ ...base, outcome: ReconcileOutcome.INDEXED });
            } catch (error) {
              // §8.6 — EPIC-093's isolation grain applied to a loop: a
              // repository whose remote is gone must not stop the other five.
              // The code, never the message.
              const classified = toFerretError(error);
              context.logger.warn(
                {
                  operation: 'reconcile.repository.failed',
                  repositoryId: candidate.repositoryId,
                  code: classified.code,
                },
                `Reconciling "${candidate.path}" failed; the pass continues`,
              );
              entries.push({
                ...base,
                outcome: ReconcileOutcome.FAILED,
                failureCode: classified.code,
              });
            }
          }

          return summarizePass(entries, !options.dryRun);
        });

        // §8.7 — a pass that skipped everything as fresh is the pass working,
        // and a scheduler that mailed about it hourly would train an operator
        // to ignore the mail. Only a repository that failed is a failure.
        if (passFailed(report)) reportExitCode(ExitCode.ERROR);

        emitResult(output(json), report, () => render(report, options.staleAfter));
      },
    );
}

/**
 * The repositories Ferret has indexed.
 *
 * A pass reconciles what is *indexed*; adding a repository is
 * `ferret index <path>`, deliberately — §4. Reading `entity` directly rather
 * than through a store because a repository's own path lives in its attributes
 * and no store method asks that question.
 */
async function knownRepositories(pool: {
  query: (text: string) => Promise<{ rows: { id: string; path: string; last_indexed_at: Date }[] }>;
}): Promise<readonly ReconcileCandidate[]> {
  // `unknown_fields->>'localRoot'`, not `attributes->>'path'`, and the reason
  // is `src/git/provider.ts`'s: a repository's canonical attributes carry no
  // path, because "where this checkout happens to live is a fact about *this
  // machine*, not about the repository, so two machines sharing one Ferret
  // database would otherwise overwrite each other's copy of the same row for
  // ever." A local pass wants exactly the machine-specific fact.
  const { rows } = await pool.query(
    `SELECT id, unknown_fields->>'localRoot' AS path, last_indexed_at
       FROM ferret.entity
      WHERE kind = 'repository' AND unknown_fields->>'localRoot' IS NOT NULL`,
  );
  return rows.map((row) => ({
    repositoryId: row.id,
    path: row.path,
    lastIndexedAt: new Date(row.last_indexed_at),
  }));
}

function describeAge(ageMs: number): string {
  const hours = ageMs / 3_600_000;
  if (hours < 1) return `${String(Math.round(ageMs / 60_000))}m`;
  if (hours < 48) return `${String(Math.round(hours))}h`;
  return `${String(Math.round(hours / 24))}d`;
}

function render(report: ReconcileReport, staleAfter: string | undefined): string {
  if (report.entries.length === 0) {
    return [
      'No repositories are indexed, so there is nothing to reconcile.',
      '',
      'Index one with `ferret index <path>`. A pass reconciles what is already',
      'indexed; it does not go looking for repositories.',
    ].join('\n');
  }

  const lines = [
    report.applied ? 'Reconciled:' : 'Would reconcile:',
    ...report.entries.map((entry) => {
      const age = describeAge(entry.ageMs);
      const flag = entry.overdue ? ' overdue' : '';
      const reason = entry.failureCode === undefined ? '' : ` — ${entry.failureCode}`;
      return `  ${entry.outcome.padEnd(9)} ${age.padStart(4)}${flag.padEnd(8)} ${entry.path}${reason}`;
    }),
    '',
    `${String(report.indexed)} indexed, ${String(report.skipped)} skipped, ${String(report.failed)} failed`,
  ];

  if (staleAfter === undefined && report.entries.length > 1) {
    lines.push(
      '',
      'Every repository was attempted. Pass `--stale-after 6h` to skip what was',
      'indexed recently, which is how a frequent schedule stays cheap.',
    );
  }
  // §8.1, where an operator setting this up will read it.
  lines.push(
    '',
    'Ferret runs no timer. Schedule this with cron, a systemd timer, or Task',
    'Scheduler — each already survives a reboot and logs when it ran.',
  );
  return lines.join('\n');
}
