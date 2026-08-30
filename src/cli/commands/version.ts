import { Command } from 'commander';

import { versionInfo } from '../../version.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * Reports the version of Ferret and the runtime it is executing on.
 *
 * Deliberately does not start the runtime: version reporting must work even
 * when configuration or a dependency is broken, because it is the first thing
 * anyone asks for in a bug report.
 */
export function versionCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('version')
    .description('Print Ferret and runtime version information')
    .action((_options: unknown, command: Command) => {
      const { json } = command.optsWithGlobals<{ json?: boolean }>();
      const info = versionInfo();
      emitResult(output(json === true), info, () =>
        [
          `${info.name} ${info.version}`,
          `runtime contract  ${String(info.runtimeContractVersion)}`,
          `node              ${info.node}`,
          `platform          ${info.platform}/${info.arch}`,
        ].join('\n'),
      );
    });
}
