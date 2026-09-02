import { Command, Option } from 'commander';
import type { Pool } from 'pg';

import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import type { Logger, LogLevel } from '../../logging/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  MigrationPolicy,
  backupCommandFor,
  createPool,
  migrate,
  readSchemaStatus,
  type SchemaStatus,
} from '../../storage/index.js';
import { ExitCode } from '../exit-codes.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret upgrade` — EPIC-106.
 *
 * `validation/EPIC-010-VALIDATION.md` states the gap this closes: *"No
 * user-facing upgrade experience. `ferret init` applies migrations and `ferret
 * doctor` reports state; nothing guides an upgrade."*
 *
 * Both halves were true and neither was an upgrade. `init` migrates as a side
 * effect of provisioning, so an operator upgrading a production database ran a
 * command named *init* and hoped; `doctor` reported the state afterwards.
 * Nothing between them said *this is what is about to change*.
 *
 * **Not a second migration path.** The plan comes from `readSchemaStatus` and
 * the apply calls the same `migrate` that `init` calls, so the advisory lock,
 * the ordering, the checksum verification and the failure journal are all
 * EPIC-002's — §8.2.
 */
export function upgradeCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('upgrade')
    .description('Report what upgrading the database schema would change, and apply it when asked')
    .addOption(new Option('--yes', 'Apply the pending migrations the plan names').default(false))
    .action(async (options: { yes: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      // **No storage provider, and that is the finding this command is built
      // around.** `migrate` calls `assertUsable` even under
      // `MigrationPolicy.OFF`, so the provider refuses to initialize against a
      // database that has drifted or was migrated by a newer Ferret — correct
      // for every other command, and fatal for this one. Those are precisely
      // the two situations an upgrade exists to explain, so a command that
      // could not start against them could never report them.
      //
      // The runtime is therefore composed with no providers: it supplies the
      // configuration, the logger and the authorization context, and this
      // command opens its own pool. `migrate` is still the only writer (§8.2);
      // what changes is that nothing asserts usability before the plan exists.
      const runtime = createRuntime({
        providers: [],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      const result = await runtime.run(async (context) => {
        // An upgrade changes the schema, so applying takes the grant `index`
        // and `reconcile` need. Named at the call site rather than hoisted —
        // the shape `authorization-enforcement.test.ts` asserts across every
        // command.
        assertPermitted(localOperatorFrom(context.config), Permission.READ, 'upgrade');
        if (options.yes) {
          assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'upgrade.apply');
        }

        const pool = createPool(context.config, context.logger);
        try {
          return await planUpgrade(pool, context.logger, options.yes);
        } finally {
          await pool.end();
        }
      });

      // `STORAGE` — "the database is reachable but its schema is not usable",
      // which is precisely what both of these are. The same code `ferret
      // status` reports, so a script branching on the exit code sees one answer
      // rather than two.
      if (result.outcome === 'newer-database' || result.outcome === 'drifted') {
        reportExitCode(ExitCode.STORAGE);
      }

      emitResult(output(json), result, () => render(result));
    });
}

/**
 * The plan, and the apply when it was asked for.
 *
 * Takes a pool rather than a provider — see the composition above for why this
 * command cannot have one.
 */
async function planUpgrade(pool: Pool, logger: Logger, apply: boolean): Promise<UpgradeResult> {
  const status = await readSchemaStatus(pool);
  const reported = reportStatus(status);

  // §8.4 — refused *before* anything is applied, and the way out is named. The
  // migrator already refused a newer schema; what was missing was the sentence
  // after the refusal.
  if (status.unknown.length > 0) {
    return {
      outcome: 'newer-database',
      status: reported,
      applied: [],
      remediation: newerDatabaseRemediation(status),
    };
  }

  // §8.5 — drift means the database and this build disagree about what already
  // ran, so applying more migrations on top is the wrong move. Reported here
  // rather than left to the provider's refusal, which no other command can get
  // past to tell anyone.
  if (status.drift.length > 0) {
    return {
      outcome: 'drifted',
      status: reported,
      applied: [],
      remediation: driftRemediation(status),
    };
  }

  if (!status.initialized) {
    // AC-14 — an empty database is not an upgrade. Saying "0 pending" would be
    // true and useless.
    return {
      outcome: 'not-initialized',
      status: reported,
      applied: [],
      remediation:
        'This database has never been provisioned. Run `ferret init` to create the schema; there is nothing to upgrade.',
    };
  }

  if (status.pending.length === 0) {
    // §8.7 — already current is a success, so an upgrade is safe to run from a
    // script, which is where an upgrade belongs.
    return { outcome: 'current', status: reported, applied: [] };
  }

  if (!apply) return { outcome: 'planned', status: reported, applied: [] };

  // §8.2 — EPIC-002's migrator, with its lock and its journal. A second writer
  // would be a second set of durability bugs.
  const report = await migrate(pool, { policy: MigrationPolicy.AUTO, logger });

  return {
    outcome: 'applied',
    // The status *after* the apply, so `schemaVersion` is what the database now
    // holds rather than what it held when the plan was made.
    status: reportStatus(await readSchemaStatus(pool)),
    applied: report.applied,
  };
}

/**
 * What a caller is told, which is **not** `SchemaStatus` verbatim.
 *
 * Found by test: returning the status directly put `failures[].errorMessage` —
 * the driver's own message — into the `--json` envelope. The human rendering had
 * always printed only the code, for EPIC-093's reason: *a message can carry a
 * path or a value.* The JSON path quietly did not, which is the worse of the two
 * to get wrong, because a machine caller is the one most likely to log it.
 *
 * So the response is shaped rather than forwarded, and a future field on
 * `SchemaStatus` cannot leak by default.
 */
interface ReportedStatus {
  readonly initialized: boolean;
  readonly schemaVersion: number;
  readonly targetVersion: number;
  readonly pending: readonly { readonly version: number; readonly name: string }[];
  readonly drift: readonly { readonly version: number; readonly name: string }[];
  /** The code and when, never the message. */
  readonly failures: readonly {
    readonly version: number;
    readonly name: string;
    readonly errorCode: string | undefined;
    readonly failedAt: string;
  }[];
  readonly unknown: readonly number[];
}

function reportStatus(status: SchemaStatus): ReportedStatus {
  return {
    initialized: status.initialized,
    schemaVersion: status.schemaVersion,
    targetVersion: status.targetVersion,
    pending: status.pending.map((one) => ({ version: one.version, name: one.name })),
    drift: status.drift.map((one) => ({ version: one.version, name: one.name })),
    failures: status.failures.map((one) => ({
      version: one.version,
      name: one.name,
      errorCode: one.errorCode,
      failedAt: one.failedAt.toISOString(),
    })),
    unknown: [...status.unknown],
  };
}

interface UpgradeResult {
  readonly outcome:
    | 'newer-database'
    | 'drifted'
    | 'not-initialized'
    | 'current'
    | 'planned'
    | 'applied';
  readonly status: ReportedStatus;
  readonly applied: readonly { readonly version: number; readonly name: string; readonly durationMs: number }[];
  readonly remediation?: string;
}

/**
 * What to do about a database a newer Ferret migrated.
 *
 * `ferret export` exists (EPIC-089) and an import refuses a document whose
 * schema version it cannot read (EPIC-090 §8.2). This is the first place those
 * two are joined into an instruction rather than left as two Epics an operator
 * would have to find.
 */
function newerDatabaseRemediation(status: SchemaStatus): string {
  const newest = Math.max(...status.unknown);
  return [
    `This database has schema version ${String(newest)} applied and this Ferret ships up to ${String(status.targetVersion)},`,
    'so it was migrated by a newer Ferret. Reading it under the old meaning would apply an',
    'interpretation the writer never intended, so it is refused.',
    '',
    'Three ways forward:',
    '  1. Install the newer Ferret again — `npm install -g @indoulia/ferret@latest`.',
    '  2. Export from the newer Ferret (`ferret export --out index.ndjson`), then',
    '     `ferret import` that document into a database this build can read.',
    '  3. Restore the backup taken before the upgrade.',
    '',
    'There is no downgrade migration. A migration runs forward and there is no `down`.',
  ].join('\n');
}

function driftRemediation(status: SchemaStatus): string {
  return [
    `Migration ${String(status.drift[0]?.version)} ("${status.drift[0]?.name ?? 'unknown'}") was applied from`,
    'different SQL than this build ships. The database and this build disagree about what',
    'already ran, so applying more migrations on top of it is the wrong move.',
    '',
    'Two ways forward:',
    '  1. Restore the original migration file — an applied migration is never edited.',
    '  2. Restore the database from a backup, or `ferret export` and `ferret import`',
    '     into a fresh one.',
    '',
    `Drifted: ${status.drift.map((one) => `${String(one.version)} (${one.name})`).join(', ')}`,
  ].join('\n');
}

function render(result: UpgradeResult): string {
  const { status } = result;

  if (
    result.outcome === 'newer-database' ||
    result.outcome === 'drifted' ||
    result.outcome === 'not-initialized'
  ) {
    return result.remediation ?? '';
  }

  const lines = [
    `Schema version ${String(status.schemaVersion)}, target ${String(status.targetVersion)}`,
  ];

  if (result.outcome === 'current') {
    lines.push('', 'Already current. Nothing to upgrade.');
    // A prior failure still matters on a current database: it says an earlier
    // attempt died, even though the schema caught up afterwards.
    lines.push(...failureLines(status));
    return lines.join('\n');
  }

  lines.push(
    '',
    result.outcome === 'applied' ? 'Applied:' : `Pending (${String(status.pending.length)}):`,
  );
  lines.push(
    ...(result.outcome === 'applied'
      ? result.applied.map(
          (one) =>
            `  ${String(one.version).padStart(4, '0')} ${one.name} (${String(Math.round(one.durationMs))} ms)`,
        )
      : status.pending.map((one) => `  ${String(one.version).padStart(4, '0')} ${one.name}`)),
  );

  lines.push(...failureLines(status));

  if (result.outcome === 'planned') {
    lines.push(
      '',
      // §8.6 — the operator reading an upgrade plan is the one who still has
      // time to take a backup, so the line belongs here and not after.
      'Take a backup first. Ferret does not wrap pg_dump:',
      `  ${backupCommandFor(process.env['FERRET_DATABASE_URL'])}`,
      '',
      'Nothing has been changed. Re-run with --yes to apply.',
    );
  } else {
    lines.push('', `Schema is now version ${String(status.targetVersion)}.`);
  }

  return lines.join('\n');
}

/**
 * A previous failure, reported wherever the plan is.
 *
 * §8.5 — a plan that omitted this would say "N migrations pending" while
 * withholding "and the last attempt failed", which changes what an operator
 * does next.
 */
function failureLines(status: ReportedStatus): readonly string[] {
  if (status.failures.length === 0) return [];
  return [
    '',
    `Previous failures (${String(status.failures.length)}):`,
    // The code, not the message: a message can carry a connection detail.
    ...status.failures.map(
      (one) =>
        `  ${String(one.version).padStart(4, '0')} ${one.name} — ${one.errorCode ?? 'unknown'} at ${one.failedAt}`,
    ),
  ];
}
