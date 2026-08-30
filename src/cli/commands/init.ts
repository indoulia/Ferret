import { Command, Option } from 'commander';

import { describeConfig } from '../../config/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  MigrationPolicy,
  createStorageProvider,
  provisionExtensions,
  type StorageReport,
} from '../../storage/index.js';
import type { LogLevel } from '../../logging/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret init` — provision the database.
 *
 * The one command a user has to run before Ferret is usable, and Governance §2
 * caps what it may ask for: database host, port, name, user, password. It
 * creates the schema, applies every pending migration and enables the optional
 * extensions it is permitted to enable.
 *
 * Idempotent by construction: it delegates to the migrator, which applies only
 * what is pending, so running it repeatedly is a supported and cheap way to
 * confirm the database is current.
 *
 * `--check` inspects without changing anything, which is what a CI job or an AI
 * client should call before assuming Ferret can store what it indexes.
 *
 * It applies migrations regardless of the configured `database.migrate` policy:
 * Governance §16 ranks an explicit operation above stored configuration, and
 * `ferret init` *is* the request to provision. A `verify` or `off` policy exists
 * to stop an ordinary start from migrating, not to stop the operator who asked.
 *
 * EPIC-003 extends this command with configuration persistence; EPIC-002 owns
 * only the database half.
 */
export function initCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('init')
    .description('Provision the Ferret database: create the schema and apply pending migrations')
    .addOption(
      new Option('--check', 'Report what would change without modifying the database').default(false),
    )
    .addOption(
      new Option('--no-extensions', 'Skip enabling optional PostgreSQL extensions such as pgvector'),
    )
    .addOption(new Option('--lock-timeout <ms>', 'How long to wait for another migrating process').argParser(Number))
    .action(async (options: { check: boolean; extensions: boolean; lockTimeout?: number }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      const storage = createStorageProvider({
        // `--check` must not mutate: the same guarantee EPIC-004 requires of
        // health checks. `off` still validates the schema it finds.
        policy: options.check ? MigrationPolicy.OFF : MigrationPolicy.AUTO,
        ...(options.lockTimeout === undefined || Number.isNaN(options.lockTimeout)
          ? {}
          : { lockTimeoutMs: options.lockTimeout }),
      });

      const runtime = createRuntime({
        providers: [storage],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      const result = await runtime.run(async (context) => {
        const report: StorageReport = storage.report;
        const extensions =
          options.check || !options.extensions
            ? report.extensions.map((entry) => ({ ...entry, created: false, reason: undefined }))
            : await provisionExtensions(storage.pool, context.logger);

        return {
          mode: options.check ? ('check' as const) : ('apply' as const),
          connection: report.connection,
          server: { version: report.server.version, supported: report.server.supported },
          instanceId: report.schema.instanceId,
          schemaVersion: report.migration.schemaVersion,
          targetSchemaVersion: report.migration.targetVersion,
          applied: report.migration.applied,
          pending: report.migration.pending,
          extensions,
          config: describeConfig(context.config),
          durationMs: report.migration.durationMs,
        };
      });

      emitResult(output(json), result, () => {
        const lines = [
          `database          ${result.connection.user}@${result.connection.host}:${String(result.connection.port)}/${result.connection.database}`,
          `server            PostgreSQL ${result.server.version}`,
          `instance          ${result.instanceId ?? '(not created yet)'}`,
          `schema version    ${String(result.schemaVersion)} of ${String(result.targetSchemaVersion)}`,
        ];
        if (result.applied.length > 0) {
          lines.push(
            `applied           ${result.applied.map((entry) => `${String(entry.version)}:${entry.name}`).join(', ')}`,
          );
        }
        if (result.pending.length > 0) {
          lines.push(
            `pending           ${result.pending.map((entry) => `${String(entry.version)}:${entry.name}`).join(', ')}`,
          );
        }
        for (const extension of result.extensions) {
          lines.push(
            `extension ${extension.name.padEnd(8)}${extension.state}${extension.reason === undefined ? '' : ` — ${extension.reason}`}`,
          );
        }
        lines.push(
          result.mode === 'check'
            ? result.pending.length === 0
              ? 'Database is up to date. Nothing to apply.'
              : 'Run `ferret init` to apply the pending migrations.'
            : 'Database is ready.',
        );
        return lines.join('\n');
      });
    });
}
