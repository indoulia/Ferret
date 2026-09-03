import { Command, Option } from 'commander';

import { ConfigStore, describeConfig, isDatabaseConfigured } from '../../config/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  MigrationPolicy,
  createStorageProvider,
  type ExtensionProvisionResult,
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
 * `--save` (EPIC-003) writes the connection details into the user configuration
 * file, so the database has to be described once rather than on every
 * invocation. That includes the password: Governance §3 has an AI client spawn
 * Ferret per session with an environment Ferret does not control, so a password
 * reachable only through the environment would make normal operation
 * impossible. The file is written with `0600`. Moving credentials to an OS
 * keychain is EPIC-081; a user who prefers indirection today can store a secret
 * reference instead:
 *
 * ```bash
 * ferret config set database.password '{"$secret":{"env":"FERRET_PG_PASSWORD"}}'
 * ```
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
    .addOption(
      new Option('--save', 'Store the database connection in the user configuration file').default(false),
    )
    .addOption(new Option('--lock-timeout <ms>', 'How long to wait for another migrating process').argParser(Number))
    .action(async (options: { check: boolean; extensions: boolean; save: boolean; lockTimeout?: number }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      const storage = createStorageProvider({
        // `--check` must not mutate: the same guarantee EPIC-004 requires of
        // health checks. `off` still validates the schema it finds.
        policy: options.check ? MigrationPolicy.OFF : MigrationPolicy.AUTO,
        // Provisioning moved *into* initialization, ahead of the migrations,
        // because `0008` is conditional on pgvector being present. Installing
        // the extension after migrating left that migration recorded as applied
        // with its table never created, on every fresh install. `--check` and
        // `--no-extensions` still mean exactly what they meant: neither
        // provisions anything.
        provisionExtensions: !options.check && options.extensions,
        ...(options.lockTimeout === undefined || Number.isNaN(options.lockTimeout)
          ? {}
          : { lockTimeoutMs: options.lockTimeout }),
      });

      const runtime = createRuntime({
        providers: [storage],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      const result = await runtime.run((context) => {
        const report: StorageReport = storage.report;
        // The provider already provisioned, before migrating, and its report
        // carries what that did. Re-provisioning here would report `created:
        // false` for an extension this very run created.
        const extensions: readonly ExtensionProvisionResult[] =
          report.provisioned ??
          report.extensions.map((entry) => ({ ...entry, created: false, reason: undefined }));

        // Persisted only after the connection has been proven to work, so a
        // typo is never written down as if it were correct.
        let saved: string | undefined;
        if (options.save && !options.check && isDatabaseConfigured(context.config)) {
          const store = new ConfigStore();
          // EPIC-081 AC-3. `context.config` is *resolved*, so passing the
          // password through unconditionally replaced a stored `$secret`
          // reference with the literal it resolved to — the command that
          // documents the mitigation removing it. Preserving the reference is
          // the whole of the fix; a literal password is still written as a
          // literal (AC-4), because D-011's reason has not changed.
          //
          // A password supplied only through `FERRET_DATABASE_PASSWORD` is
          // still written as a literal, deliberately. Writing an env reference
          // instead would look tidier and would break Governance §3: an AI
          // client spawns Ferret with an environment Ferret does not control,
          // so a saved configuration that only works inside today's shell is a
          // configuration that does not work.
          store.setMany(
            {
              'database.host': context.config.database.host,
              'database.port': context.config.database.port,
              'database.database': context.config.database.database,
              'database.user': context.config.database.user,
              'database.password': context.config.database.password,
            },
            { preserveSecretRefs: true },
          );
          saved = store.path;
        }

        return {
          mode: options.check ? ('check' as const) : ('apply' as const),
          saved: saved ?? null,
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
        if (result.saved !== null) lines.push(`saved             ${result.saved}`);
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
