import { Command, Option } from 'commander';

import {
  DiagnosisSeverity,
  buildDoctorReport,
  countBySeverity,
  describeConfig,
  describeConfigProtection,
  type Diagnosis,
} from '../../index.js';
import { createLogger, type LogLevel } from '../../logging/index.js';
import { effectiveLogLevel } from '../log-level.js';
import { exitCodeForHealth, probeHealth, readCapabilityAvailability, readIndexInventory } from '../health.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret doctor` — what do I do about it?
 *
 * The same data `ferret status` reports, plus a remediation for every finding
 * and a stable `id` per finding so an AI client or a script can branch on the
 * *kind* of problem rather than pattern-matching English. EPIC-004's Definition
 * of Done requires exactly that: deterministic classification of failure modes.
 *
 * Like `status` it never throws and never mutates. Everything it reports about
 * the database is gathered with the migration policy forced to `off`.
 *
 * Only findings are listed. A doctor that also enumerates everything that is
 * fine buries the one thing that is not.
 */

const SEVERITY_LABEL: Readonly<Record<DiagnosisSeverity, string>> = {
  [DiagnosisSeverity.ERROR]: 'ERROR  ',
  [DiagnosisSeverity.WARNING]: 'WARNING',
  [DiagnosisSeverity.UNKNOWN]: 'UNKNOWN',
};

function renderDiagnosis(diagnosis: Diagnosis): string {
  return [
    `${SEVERITY_LABEL[diagnosis.severity]}  ${diagnosis.area}/${diagnosis.id}`,
    `         ${diagnosis.finding}`,
    `      -> ${diagnosis.remediation}`,
  ].join('\n');
}

export function doctorCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('doctor')
    .description('Diagnose setup, database, migration, permission and runtime problems')
    .addOption(new Option('--strict', 'Exit non-zero when anything is degraded, not just unavailable').default(false))
    .addOption(
      new Option('--show-config', 'Include the resolved configuration, with secrets redacted').default(false),
    )
    .action(async (options: { strict: boolean; showConfig: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;
      // EPIC-091 AC-7 — see the note in `status.ts`; both commands were mute
      // at every level unless the flag was present.
      const level = effectiveLogLevel(globals.logLevel);
      const logger =
        level === undefined || level === 'silent'
          ? undefined
          : createLogger({ level, base: { component: 'doctor' } });

      const health = await probeHealth(logger === undefined ? {} : { logger });
      const report = buildDoctorReport(health);
      const counts = countBySeverity(report.diagnoses);

      // Rendered through describeConfig, so a password can never reach the
      // terminal even when the user asks for everything.
      let configuration: Record<string, unknown> | undefined;
      if (options.showConfig) {
        const { probeCore } = await import('../../diagnostics/probe.js');
        const core = await probeCore();
        configuration = core.config === undefined ? undefined : describeConfig(core.config);
      }

      // EPIC-081 AC-10. Reported every run, not only when it is bad: "the file
      // is readable only by its owner" and "this platform does not enforce
      // that" are both facts an operator needs, and only one is a warning.
      const protection = describeConfigProtection();

      // EPIC-095 §3.2. "Is anything wrong" is answered above; this answers the
      // question every operator asks immediately after a clean bill of health —
      // what does Ferret actually know. Every number already existed and
      // nothing assembled them: `content_blob` since EPIC-087, the run journal
      // since EPIC-094, the entity counts since EPIC-006.
      //
      // Absent, never zero, when there is no database to ask (AC-7), and it
      // changes no verdict and no exit code (AC-8): a count is not a status,
      // and turning one into a status would invent a threshold nobody argued
      // for.
      const inventory = await readIndexInventory(logger);
      // EPIC-095 AC-6 — what Ferret can do here, and why it cannot do the rest.
      const capabilities = await readCapabilityAvailability(logger);

      const payload = {
        ...report,
        ...(options.showConfig ? { configuration: configuration ?? null } : {}),
        configFile: protection,
        inventory: inventory ?? null,
        capabilities,
        counts,
      };

      emitResult(output(json), payload, () => {
        const lines = [
          `ferret ${report.ferret.version} on node ${report.ferret.node} (${report.ferret.platform})`,
          `${String(report.checked)} checks in ${String(report.durationMs)} ms`,
          '',
        ];
        if (report.diagnoses.length === 0) {
          lines.push('No problems found.');
        } else {
          lines.push(...report.diagnoses.map(renderDiagnosis), '');
          lines.push(
            `${String(counts.error)} error(s), ${String(counts.warning)} warning(s), ${String(counts.unknown)} undetermined.`,
          );
        }
        if (inventory !== undefined) {
          lines.push('', 'index');
          for (const entry of inventory.entities.slice(0, 8)) {
            lines.push(`  ${entry.kind.padEnd(18)}${String(entry.count)}`);
          }
          lines.push(`  ${'relationships'.padEnd(18)}${String(inventory.relationships)}`);
          lines.push(`  ${'evidence'.padEnd(18)}${String(inventory.evidence)}`);
          lines.push(
            `  ${'content'.padEnd(18)}${String(inventory.contentBlobs)} blob(s), ${String(inventory.contentBytes)} byte(s) of text`,
          );
          lines.push(
            `  ${'last run'.padEnd(18)}${
              inventory.lastRun === undefined
                ? 'no completed run on record'
                : `${inventory.lastRun.outcome} for ${inventory.lastRun.repository}, ${String(inventory.lastRun.ageSeconds)}s ago`
            }`,
          );
        }
        if (capabilities.length > 0) {
          lines.push('', 'capabilities');
          for (const entry of capabilities) {
            lines.push(
              `  ${entry.capability.padEnd(20)}${entry.available ? 'available' : `unavailable (${entry.reason ?? 'unknown'})`}`,
            );
          }
        }
        lines.push('', `configuration at rest: ${protection.detail}`);
        lines.push('', report.summary);
        return lines.join('\n');
      });

      reportExitCode(exitCodeForHealth(health, options.strict));
    });
}
