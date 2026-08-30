import { Command } from 'commander';

import { describeConfig } from '../../config/index.js';
import { createRuntime } from '../../runtime/index.js';
import type { LogLevel } from '../../logging/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * Reports the facts Ferret detected about its host and its resolved
 * configuration.
 *
 * This is the CLI surface of EPIC-001's environment detection, and it reports
 * facts only — no health verdict. Interpreting those facts as healthy,
 * degraded or unavailable is `ferret status` and `ferret doctor` (EPIC-004).
 *
 * Configuration is rendered through {@link describeConfig}, so a password can
 * never reach the terminal even when the user asks for full output.
 *
 * Runs a complete runtime cycle — initialize, read, shut down — which makes it
 * the smallest real exercise of the lifecycle available from the CLI.
 */
export function envCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('env')
    .description('Report detected environment and resolved configuration')
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      const runtime = createRuntime(
        globals.logLevel === undefined ? {} : { logLevel: globals.logLevel },
      );

      // `report` is what the caller receives; `summary` carries the few typed
      // values the human rendering needs, so it never has to reach back into
      // the redacted structure and cast.
      const { report, summary } = await runtime.run((context) => ({
        report: {
          ferret: context.version,
          node: context.environment.node,
          platform: context.environment.platform,
          arch: context.environment.arch,
          cwd: context.environment.cwd,
          interactive: context.environment.interactive,
          git: context.environment.git,
          config: describeConfig(context.config),
          providers: context.providers.describe(),
        },
        summary: {
          logLevel: context.config.logLevel,
          databaseHost: context.config.database.host,
        },
      }));

      emitResult(output(json), report, () =>
        [
          `ferret            ${report.ferret.version}`,
          `node              ${report.node.version} (supported range ${report.node.supportedRange}: ${report.node.supported ? 'yes' : 'no'})`,
          `platform          ${report.platform}/${report.arch}`,
          `cwd               ${report.cwd}`,
          `git               ${report.git.available ? (report.git.version ?? 'found') : 'not found on PATH'}`,
          `log level         ${summary.logLevel}`,
          `database host     ${summary.databaseHost ?? '(not configured)'}`,
          `providers         ${report.providers.length === 0 ? '(none registered)' : report.providers.map((p) => p.id).join(', ')}`,
        ].join('\n'),
      );
    });
}
