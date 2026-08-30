import { Command, Option } from 'commander';

import { DependencyStatus, type HealthComponent } from '../../index.js';
import { createLogger, type LogLevel } from '../../logging/index.js';
import { exitCodeForHealth, probeHealth } from '../health.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret status` — is Ferret working?
 *
 * The fast, dependable answer. It never throws: a database that is down, a
 * configuration file that does not parse and credentials that are wrong are all
 * *results*, because a diagnostic that fails when the thing it diagnoses is
 * broken is useless (Governance §20).
 *
 * It is strictly read-only — the migration policy is forced to `off`, so
 * checking health can never migrate a schema.
 *
 * `ferret doctor` is the same data plus remediation. Use `status` to find out
 * whether something is wrong, `doctor` to find out what to do.
 */

/** Marker glyphs, chosen to stay legible in a terminal without colour. */
const GLYPH: Readonly<Record<DependencyStatus, string>> = {
  [DependencyStatus.OK]: '+',
  [DependencyStatus.DEGRADED]: '~',
  [DependencyStatus.UNAVAILABLE]: 'x',
  [DependencyStatus.UNKNOWN]: '?',
};

function renderComponent(component: HealthComponent): string {
  const glyph = GLYPH[component.status] ?? '?';
  const optional = component.required ? '' : ' (optional)';
  return `  ${glyph} ${component.name.padEnd(28)}${component.status.padEnd(13)}${component.detail ?? ''}${optional}`;
}

export function statusCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('status')
    .description('Report the health of Ferret, its database, its schema and its providers')
    .addOption(new Option('--strict', 'Exit non-zero when anything is degraded, not just unavailable').default(false))
    .action(async (options: { strict: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;
      const logger =
        globals.logLevel === undefined
          ? undefined
          : createLogger({ level: globals.logLevel, base: { component: 'status' } });

      const report = await probeHealth(logger === undefined ? {} : { logger });

      emitResult(output(json), report, () =>
        [
          `ferret ${report.ferret.version} on node ${report.ferret.node} (${report.ferret.platform})`,
          '',
          ...report.components.map(renderComponent),
          '',
          report.summary,
        ].join('\n'),
      );

      // Reported rather than thrown: the command *succeeded* at reporting. The
      // health verdict travels as the exit code so a script can branch on it.
      reportExitCode(exitCodeForHealth(report, options.strict));
    });
}
