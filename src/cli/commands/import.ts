import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Command, Option } from 'commander';

import { AuditCategory, AuditOutcome, AuditWriter, auditEventsPath } from '../../audit/index.js';
import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import { userConfigPath } from '../../config/index.js';
import { processInvocationId, type LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  ImportService,
  MigrationPolicy,
  createStorageProvider,
  readDocument,
  type ImportReport,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret import` — EPIC-090.
 *
 * Reads a document [EPIC-089] wrote, into a different version, a different
 * database, or a fresh one — and refuses it clearly when it cannot be read.
 *
 * **Nothing is written until the whole document has been read.** The digest is
 * in the trailer, so integrity is only knowable at the end. A partial import is
 * worse than a slow one: it leaves an index that looks complete.
 *
 * A document with no trailer is truncated and is refused — EPIC-089 §8.2 put
 * the digest at the end precisely so that case is detectable.
 */
export function importCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('import')
    .description('Read an exported document into this index')
    .argument('<document>', 'Path to an NDJSON document written by `ferret export`')
    .addOption(new Option('--yes', 'Write the rows the plan names').default(false))
    .action(async (document: string, options: { yes: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      // Parsed and verified before a database connection is opened, so an
      // unreadable document costs nothing and reports precisely.
      const checked = readDocument(readFileSync(document, 'utf8'), (lines) => {
        const hash = createHash('sha256');
        for (const line of lines) {
          hash.update(line);
          hash.update('\n');
        }
        return hash.digest('hex');
      });

      const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
      const runtime = createRuntime({
        providers: [storage],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      const result = await runtime.run(async (context) => {
        // An import writes rows, so it is checked as an index. The plan is a
        // read. Spelled out at the call site rather than hoisted — the shape
        // `authorization-enforcement.test.ts` asserts across every command.
        assertPermitted(localOperatorFrom(context.config), Permission.READ, 'import');
        if (options.yes) {
          assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'import.apply');
        }
        assertSupported(runtime.providers.supports(Capability.STORAGE));

        const report = await new ImportService(storage.db).importDocument(checked, {
          apply: options.yes,
        });

        // §8.8 — the write that most changes what Ferret believes, and the only
        // one whose source is a file rather than an observation.
        if (options.yes) {
          new AuditWriter({
            path: auditEventsPath(dirname(userConfigPath())),
            invocation: processInvocationId(),
            agent: 'ferret-cli',
          }).record({
            category: AuditCategory.CONFIGURATION,
            action: 'import',
            outcome: AuditOutcome.PERMITTED,
            actor: localOperatorFrom(context.config).id,
            subject: document,
            reason: `${String(totalOf(report, 'written'))} row(s) written`,
          });
        }

        return report;
      });

      emitResult(output(json), result, () => render(result, document));
    });
}

function totalOf(report: ImportReport, field: 'written' | 'unchanged' | 'conflicting' | 'orphaned'): number {
  return report.tables.reduce((sum, table) => sum + table[field], 0);
}

function render(report: ImportReport, document: string): string {
  const lines = [
    report.applied ? `Imported ${document}` : `Would import ${document}`,
    `  Ferret ${report.manifest.ferretVersion}, entity schema ${String(report.manifest.entitySchemaVersion)}`,
    `  ${String(report.trailer.rows)} row(s) in the document`,
    '',
  ];

  for (const table of report.tables) {
    if (table.written + table.unchanged + table.conflicting + table.orphaned === 0) continue;
    const parts = [
      `${String(table.written)} ${report.applied ? 'written' : 'to write'}`,
      `${String(table.unchanged)} unchanged`,
    ];
    if (table.conflicting > 0) parts.push(`${String(table.conflicting)} conflicting`);
    if (table.orphaned > 0) parts.push(`${String(table.orphaned)} orphaned`);
    lines.push(`  ${table.table}: ${parts.join(', ')}`);
    if (table.failure !== undefined) lines.push(`    FAILED: ${table.failure}`);
    // §8.6 — the orphan's key, not a constraint name. A scoped export can
    // legitimately reference an entity outside its scope, and naming which row
    // is the difference between a diagnosis and a stack trace.
    for (const orphan of table.orphans) lines.push(`    orphan: ${orphan}`);
  }

  const conflicting = totalOf(report, 'conflicting');
  if (conflicting > 0) {
    lines.push(
      '',
      `${String(conflicting)} row(s) are present with different content. Ferret does not choose`,
      'between two installations that disagree — import into an empty database instead.',
    );
  }

  // D2 — what the restore did *not* recover, stated on the restore rather than
  // only on the export. An operator restoring a backup is rarely the one who
  // took it, and this is the moment the gap matters.
  if (report.excluded === undefined) {
    lines.push(
      '',
      'This document predates the exclusion declaration, so it does not say what it',
      'omits. Vectors and instance identity were not carried by that format either.',
    );
  } else if (report.excluded.length > 0) {
    lines.push('', 'Not carried by this document, so not restored:');
    for (const table of report.excluded) lines.push(`  ${table.table} — ${table.reason}`);
    const embedding = report.excluded.find((table) => table.table === 'embedding');
    if (embedding !== undefined) {
      lines.push('', `Vectors: ${embedding.recovery}`);
    }
  }

  // EPIC-116 — what came back of the session domain, on the restore rather
  // than only on the export. `undefined` is a third answer and is said as one.
  if (report.sessions === undefined) {
    const carried = report.tables.find((table) => table.table === 'session');
    if (carried === undefined) {
      lines.push(
        '',
        'This document predates session export, so it carries no session, transcript,',
        'checkpoint or engineering memory. `pg_dump` is the full-fidelity copy.',
      );
    }
  } else if (report.sessions.resolved.length > 0) {
    lines.push('', `Sessions restored: ${String(report.sessions.resolved.length)}`);
  }

  // D-116.3, at the moment somebody is deciding whether to trust the restore.
  const gaps = report.memoryEvidenceGaps ?? [];
  if (gaps.length > 0) {
    lines.push(
      '',
      `${String(gaps.length)} restored memory(s) cite captures this document does not carry.`,
      'Their statements are intact; the transcript they were drawn from is not here, so',
      '`ferret session recall` can quote the memory and not the turn behind it.',
    );
  }

  // D2 — both identities, always, because the contract is that they differ.
  const { instanceId, sourceInstanceId, recorded, note } = report.provenance;
  lines.push(
    '',
    'Instance identity:',
    `  this installation  ${instanceId ?? '(none — run `ferret init`)'}`,
    `  document written by ${sourceInstanceId ?? '(not declared by this document)'}`,
  );
  if (instanceId !== undefined && sourceInstanceId !== undefined && instanceId !== sourceInstanceId) {
    lines.push(
      '  This index keeps its own identity. The source is recorded as provenance, not adopted:',
      '  two installations restored from one document must not answer to one identity.',
    );
  }
  if (recorded) lines.push('  Recorded in ferret.instance_restore.');
  if (note !== undefined) lines.push(`  ${note}`);

  if (!report.applied) {
    lines.push('', 'Nothing has been written. Re-run with --yes to proceed.');
  }
  return lines.join('\n');
}
