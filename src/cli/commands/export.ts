import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';

import { Command, Option } from 'commander';

import { AuditCategory, AuditOutcome, AuditWriter, auditEventsPath } from '../../audit/index.js';
import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import { userConfigPath } from '../../config/index.js';
import { processInvocationId, type LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  ExportService,
  MigrationPolicy,
  backupCommandFor,
  createStorageProvider,
  type ExportManifest,
  type ExportTrailer,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret export` — EPIC-089.
 *
 * **This is not a backup, and the difference is the Epic.** A backup is a
 * point-in-time copy restorable into the *same* schema version, which `pg_dump`
 * already does correctly; an export is a document a *different* version can
 * read, which a dump cannot be. `COMPATIBILITY.md` §7 points here for the
 * downgrade path precisely because a migration runs forward and there is no
 * `down`.
 *
 * So Ferret builds the export and never wraps `pg_dump` — EPIC-088 §4's
 * precedent, and Governance §5 at its sharpest: the right amount of backup code
 * to write is none. `--backup-command` prints the command instead.
 */
export function exportCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('export')
    .description('Write the index as a portable NDJSON document a different version can read')
    .addOption(new Option('--out <path>', 'Write to a file rather than stdout'))
    .addOption(new Option('--scope <repositoryId>', 'Export one repository and what it contains'))
    .addOption(
      new Option('--backup-command', 'Print the pg_dump command for a real backup and exit').default(
        false,
      ),
    )
    .action(
      async (
        options: { out?: string; scope?: string; backupCommand: boolean },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
        const json = globals.json === true;

        // AC-14, before the runtime starts: an operator asking what the backup
        // command is should not need a reachable database to be told.
        if (options.backupCommand) {
          const backup = backupCommandFor(process.env['FERRET_DATABASE_URL']);
          const configurationFile = userConfigPath();
          emitResult(
            output(json),
            { backupCommand: backup, configurationFile },
            () =>
              [
                'A backup is not an export. For a point-in-time copy restorable into this',
                'same schema version, use PostgreSQL own tool — Ferret does not wrap it:',
                '',
                `  ${backup}`,
                '',
                'And copy the configuration file. It already holds secret *references*',
                'rather than secrets, so it needs no exporter of its own:',
                '',
                `  ${configurationFile}`,
                '',
                'For a document a different Ferret version can read, use ferret export.',
              ].join('\n'),
          );
          return;
        }

        const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
        const runtime = createRuntime({
          providers: [storage],
          ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
        });

        const result = await runtime.run(async (context) => {
          // An export is the largest read Ferret performs — every row it holds,
          // in one file. So it is a read, checked as one, and §8.3 keeps
          // `permission_scope` on the rows rather than stripping it.
          assertPermitted(localOperatorFrom(context.config), Permission.READ, 'export');
          assertSupported(runtime.providers.supports(Capability.STORAGE));

          const service = new ExportService(storage.db);
          const sink = await openSink(options.out);

          try {
            const written = await service.exportDocument(sink.write, {
              ...(options.scope === undefined ? {} : { scope: options.scope }),
            });
            await sink.close();

            // §8.7 — EPIC-085 recorded that reads are otherwise *not* audited,
            // so this is the deliberate exception rather than a drift from it:
            // a bulk read of everything Ferret knows is the read most worth
            // recording.
            new AuditWriter({
              path: auditEventsPath(dirname(userConfigPath())),
              invocation: processInvocationId(),
              agent: 'ferret-cli',
            }).record({
              category: AuditCategory.AUTHORIZATION,
              action: 'export',
              outcome: AuditOutcome.PERMITTED,
              actor: localOperatorFrom(context.config).id,
              ...(options.scope === undefined ? {} : { subject: options.scope }),
              reason: `${String(written.rows)} row(s)`,
            });

            return {
              manifest: written.manifest,
              trailer: written.trailer,
              destination: options.out ?? 'stdout',
            };
          } catch (error) {
            await sink.close();
            throw error;
          }
        });

        // In JSON mode the document has already gone to the file, so the
        // envelope carries the manifest and trailer rather than the rows. To
        // stdout there is nothing more to print: the document *is* the output.
        if (options.out === undefined) return;
        emitResult(output(json), result, () => render(result.manifest, result.trailer, result.destination));
      },
    );
}

interface Sink {
  readonly write: (line: string) => void | Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Where the document goes.
 *
 * Backpressure is honoured rather than ignored: `write` returning false means
 * the buffer is full, and awaiting `drain` is what keeps memory bounded for an
 * index larger than it — which is the whole point of streaming.
 */
async function openSink(path: string | undefined): Promise<Sink> {
  if (path === undefined) {
    return {
      write: (line: string) => {
        process.stdout.write(`${line}\n`);
      },
      close: async () => {},
    };
  }

  const stream = createWriteStream(path, { encoding: 'utf8' });
  await once(stream, 'open');

  return {
    write: async (line: string) => {
      if (!stream.write(`${line}\n`)) await once(stream, 'drain');
    },
    close: async () => {
      stream.end();
      await once(stream, 'finish');
    },
  };
}

function render(manifest: ExportManifest, trailer: ExportTrailer, destination: string): string {
  const rows = Object.entries(trailer.counts)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `  ${table}: ${String(count)}`);

  return [
    `Exported ${String(trailer.rows)} row(s) to ${destination}`,
    ...(rows.length === 0 ? ['  (the index is empty)'] : rows),
    '',
    `Ferret ${manifest.ferretVersion}, entity schema ${String(manifest.entitySchemaVersion)}`,
    `Digest ${trailer.digest}`,
    '',
    'This is an export, not a backup. `ferret export --backup-command` prints the',
    'pg_dump command for a point-in-time copy of this same schema version.',
  ].join('\n');
}
