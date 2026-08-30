import { Command, Option } from 'commander';

import {
  DiagnosisSeverity,
  buildDoctorReport,
  countBySeverity,
  describeConfig,
  type Diagnosis,
} from '../../index.js';
import { createLogger, type LogLevel } from '../../logging/index.js';
import { exitCodeForHealth, probeHealth } from '../health.js';
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
      const logger =
        globals.logLevel === undefined
          ? undefined
          : createLogger({ level: globals.logLevel, base: { component: 'doctor' } });

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

      const payload = {
        ...report,
        ...(options.showConfig ? { configuration: configuration ?? null } : {}),
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
        lines.push('', report.summary);
        return lines.join('\n');
      });

      reportExitCode(exitCodeForHealth(health, options.strict));
    });
}
