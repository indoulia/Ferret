import { Command, Option } from 'commander';

import { LOG_LEVELS } from '../logging/index.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

import { configCommand } from './commands/config.js';
import { envCommand } from './commands/env.js';
import { initCommand } from './commands/init.js';
import { PLANNED_COMMANDS, plannedCommand } from './commands/planned.js';
import { versionCommand } from './commands/version.js';
import type { OutputOptions } from './output.js';

export interface ProgramOptions {
  /** Writes command results. Defaults to process stdout. */
  readonly stdout?: (text: string) => void;
  /** Writes diagnostics. Defaults to process stderr. */
  readonly stderr?: (text: string) => void;
}

/**
 * Builds the `ferret` command tree.
 *
 * Argument parsing, help generation and usage errors are Commander's job
 * (Governance §5 — do not reimplement mature capabilities). What EPIC-001 adds
 * is the surrounding contract: a stable command surface, honest `(planned)`
 * markers for capabilities later Epics own, and deterministic exit codes.
 *
 * `exitOverride` turns Commander's `process.exit` calls into throws so the
 * whole CLI is testable in-process and the caller decides how to exit.
 */
export function buildProgram(options: ProgramOptions = {}): Command {
  const write = options.stdout ?? ((text: string) => process.stdout.write(text));
  const writeError = options.stderr ?? ((text: string) => process.stderr.write(text));

  const output = (json: boolean): OutputOptions => ({ json, stdout: write, stderr: writeError });

  const program = new Command()
    .name('ferret')
    .description(
      'Ferret — persistent engineering context and knowledge layer for AI-assisted development.',
    )
    .version(`${PACKAGE_NAME} ${VERSION}`, '-v, --version', 'Print the Ferret version')
    .helpOption('-h, --help', 'Show help')
    .addOption(
      new Option('--json', 'Emit machine-readable JSON on stdout instead of human text').default(
        false,
      ),
    )
    .addOption(
      new Option('--log-level <level>', 'Structured log verbosity on stderr').choices([
        ...LOG_LEVELS,
      ]),
    )
    .showHelpAfterError('(run `ferret --help` for usage)')
    .exitOverride()
    .configureOutput({
      writeOut: write,
      writeErr: writeError,
    });

  program.addCommand(versionCommand(output));
  program.addCommand(configCommand(output));
  program.addCommand(envCommand(output));
  program.addCommand(initCommand(output));
  for (const spec of PLANNED_COMMANDS) program.addCommand(plannedCommand(spec));

  // Commander's `addCommand` does not propagate `exitOverride` or the output
  // configuration to subcommands, so a subcommand usage error would call
  // `process.exit` itself and bypass Ferret's exit-code contract. Applying both
  // to the whole tree keeps every outcome in the caller's hands.
  applyToTree(program, write, writeError);

  return program;
}

function applyToTree(
  command: Command,
  write: (text: string) => void,
  writeError: (text: string) => void,
): void {
  for (const child of command.commands) {
    child.exitOverride().configureOutput({ writeOut: write, writeErr: writeError });
    applyToTree(child, write, writeError);
  }
}
