import { createWriteStream, rmSync } from 'node:fs';
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
    // EPIC-116, D-116.1. A session travels when it is *named*, never when a
    // scope happens to look like its `repository_id` — which is free text and
    // relates to nothing an entity scope can be compared against. Repeatable,
    // because moving one piece of work usually means moving its lineage.
    //
    // **It narrows the session dimension and nothing else**, which the help text
    // now says because dogfooding showed it needed to: `--session <id>` alone
    // produced a 38 865-row document — the whole index, plus that one session —
    // and the README's example was named `one-session.ndjson`, which promised the
    // opposite. The behaviour is right; the wording was not. The two dimensions
    // are independent by construction, and that independence is exactly what
    // stops an entity scope being read as a claim about which sessions belong
    // to it.
    .addOption(
      new Option(
        '--session <id...>',
        'Export these sessions, their transcripts, checkpoints and memories. Narrows the ' +
          'session dimension only — pass --scope as well to narrow entities. A full export ' +
          'carries every session.',
      ),
    )
    .addOption(
      new Option('--backup-command', 'Print the pg_dump command for a real backup and exit').default(
        false,
      ),
    )
    // D1. The default export is faithful and reports what it carried; strict
    // is for the operator who would rather have no document than one with a
    // credential-shaped value in it. Not the default, because refusing by
    // default would block the recovery path on a file path that merely looks
    // like a key — measured: `AKIA`-shaped filenames do exactly that.
    .addOption(
      new Option(
        '--strict',
        'Refuse rather than write a document carrying a credential-shaped value',
      ).default(false),
    )
    .action(
      async (
        options: {
          out?: string;
          scope?: string;
          session?: string[];
          backupCommand: boolean;
          strict: boolean;
        },
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
              ...(options.session === undefined ? {} : { sessions: options.session }),
              strict: options.strict,
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
              credentialShaped: written.credentialShaped,
              sessionScope: written.sessionScope,
              memoryEvidenceGaps: written.memoryEvidenceGaps,
            };
          } catch (error) {
            await sink.close();
            // A refused or failed export must not leave a file that looks like
            // a document. It would have no trailer, so `ferret import` refuses
            // it as truncated — but "refuses it" is a worse answer than "there
            // is nothing there", and a half-written strict export is precisely
            // the file whose contents the operator asked not to have on disk.
            if (options.out !== undefined) {
              try {
                rmSync(options.out, { force: true });
              } catch {
                // The original failure is the one worth reporting.
              }
            }
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

/**
 * What the document does not carry, and what the scanner found — D1 and D2.
 *
 * Printed for every export, not only when something is wrong. "Vectors are
 * excluded" is a property of the document rather than an incident, and an
 * operator who reads it only on the bad day learns it on the bad day.
 */
function disclosures(manifest: ExportManifest, trailer: ExportTrailer): readonly string[] {
  const lines: string[] = [];

  const excluded = manifest.excluded ?? [];
  if (excluded.length > 0) {
    lines.push('', 'Not carried by this document:');
    for (const table of excluded) lines.push(`  ${table.table} — ${table.reason}`);
    const embedding = excluded.find((table) => table.table === 'embedding');
    if (embedding !== undefined) lines.push('', `Vectors: ${embedding.recovery}`);
  }

  // EPIC-116, D-116.1. Which sessions travelled, and which were asked for and
  // are not here — the second is the statement the decision asked for, and it
  // is the one an operator moving work between installations acts on.
  const sessions = manifest.sessionScope;
  if (sessions !== undefined && sessions.requested.length > 0) {
    lines.push(
      '',
      `Sessions: ${String(sessions.resolved.length)} of ${String(sessions.requested.length)} named session(s) carried`,
    );
    if (sessions.unresolved.length > 0) {
      lines.push(
        `  ${String(sessions.unresolved.length)} not found here: ${sessions.unresolved.slice(0, 5).join(', ')}${sessions.unresolved.length > 5 ? ' …' : ''}`,
      );
    }
  }

  // D-116.3. Never repaired, always reported: dropping the memory would lose
  // what a session decided and inventing a capture would fabricate evidence.
  const gaps = trailer.memoryEvidenceGaps ?? [];
  if (gaps.length > 0) {
    lines.push(
      '',
      `${String(gaps.length)} extracted memory(s) cite captures this document does not carry:`,
    );
    for (const gap of gaps.slice(0, 10)) {
      lines.push(`  ${gap.memoryId} (session ${gap.sessionId}) — ${String(gap.missing)} missing`);
    }
    if (gaps.length > 10) lines.push(`  … and ${String(gaps.length - 10)} more`);
    lines.push(
      '',
      'They are carried as they are. An extracted memory whose evidence did not arrive is',
      'still a memory EPIC-042 built from something, and neither dropping it nor inventing',
      'the capture it names is an honest repair.',
    );
  }

  const findings = trailer.credentialShaped ?? [];
  if (findings.length > 0) {
    lines.push(
      '',
      `${String(findings.length)} value(s) match a credential shape and were exported as they are:`,
    );
    for (const finding of findings.slice(0, 10)) {
      lines.push(`  ${finding.table}.${finding.column} (row ${finding.key}) — ${finding.kinds.join(', ')}`);
    }
    if (findings.length > 10) lines.push(`  … and ${String(findings.length - 10)} more`);
    lines.push(
      '',
      'They are carried faithfully on purpose: rewriting them would leave a content hash',
      'that no longer describes its row, so a restore would report itself tampered with.',
      'Treat this document as containing those values. `--strict` refuses instead.',
    );
  }

  return lines;
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
    ...disclosures(manifest, trailer),
    '',
    'This is an export, not a backup. `ferret export --backup-command` prints the',
    'pg_dump command for a point-in-time copy of this same schema version.',
  ].join('\n');
}
