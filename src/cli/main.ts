#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CommanderError } from 'commander';

import { ErrorCode, FerretError, serializeError, toFerretError } from '../errors/index.js';
import { createLogger, isLogLevel, type LogLevel } from '../logging/index.js';
import { installSignalHandlers } from '../runtime/index.js';

import { ExitCode, exitCodeFor } from './exit-codes.js';
import { emitError } from './output.js';
import { buildProgram, type ProgramOptions } from './program.js';

/**
 * Commander signals help and `--version` by throwing. Those are successful
 * outcomes; every other Commander error is a usage error.
 */
const COMMANDER_SUCCESS: ReadonlySet<string> = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);

function commanderExitCode(error: CommanderError): ExitCode {
  return COMMANDER_SUCCESS.has(error.code) ? ExitCode.OK : ExitCode.USAGE;
}

/**
 * Reads `--log-level` before Commander parses, so a failure during parsing is
 * still logged at the level the user asked for.
 */
function earlyLogLevel(argv: readonly string[]): LogLevel | undefined {
  const index = argv.indexOf('--log-level');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (isLogLevel(value)) return value;
  const inline = argv.find((argument) => argument.startsWith('--log-level='))?.split('=')[1];
  return isLogLevel(inline) ? inline : undefined;
}

export interface RunOptions extends ProgramOptions {
  /** Full argv, including the node and script entries. */
  readonly argv?: readonly string[];
}

/**
 * Runs the CLI and returns the process exit code.
 *
 * Returns rather than exits so the whole surface is testable in-process and so
 * a single place owns the exit-code contract. Nothing here throws: every
 * outcome, including an unexpected one, becomes a redacted structured error and
 * a documented exit code. An error is never converted into success.
 */
export async function run(options: RunOptions = {}): Promise<number> {
  const argv = [...(options.argv ?? process.argv)];
  const programOptions: ProgramOptions = {};
  if (options.stdout !== undefined) Object.assign(programOptions, { stdout: options.stdout });
  if (options.stderr !== undefined) Object.assign(programOptions, { stderr: options.stderr });

  const program = buildProgram(programOptions);
  const json = argv.includes('--json');
  const output = {
    json,
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
  };

  // A bare invocation is not an error; show the user what exists.
  if (argv.length <= 2) {
    program.outputHelp();
    return ExitCode.OK;
  }

  try {
    await program.parseAsync([...argv]);
    return ExitCode.OK;
  } catch (error) {
    if (error instanceof CommanderError) {
      const code = commanderExitCode(error);
      // Commander has already written its own message; in JSON mode the caller
      // still needs a parseable envelope on stdout.
      if (code !== ExitCode.OK && json) {
        emitError(
          output,
          new FerretError(ErrorCode.USAGE, error.message, {
            details: { commanderCode: error.code },
            remediation: 'Run `ferret --help` for the supported commands and options.',
          }),
        );
      }
      return code;
    }

    const ferretError = toFerretError(error);
    emitError(output, ferretError);
    return exitCodeFor(ferretError.code);
  }
}

/**
 * Process entry point.
 *
 * Owns the things that only make sense for a real process: signal handling and
 * last-resort handlers for faults that escape the command. The exported
 * {@link run} stays free of them so tests and embedders are unaffected.
 */
async function main(): Promise<void> {
  const level = earlyLogLevel(process.argv) ?? 'warn';
  const logger = createLogger({ level, base: { component: 'cli' } });

  let settled = false;
  const exit = (code: number): void => {
    if (settled) return;
    settled = true;
    process.exitCode = code;
    process.exit(code);
  };

  // No EPIC-001 command runs long enough to be interrupted mid-flight, but the
  // contract has to exist before EPIC-064's MCP server relies on it.
  const removeSignalHandlers = installSignalHandlers({
    shutdown: () => Promise.resolve(),
    logger,
    onExit: exit,
  });

  process.on('uncaughtException', (error: unknown) => {
    logger.fatal({ operation: 'cli.uncaughtException', err: serializeError(error) }, 'Unhandled exception');
    exit(ExitCode.ERROR);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ operation: 'cli.unhandledRejection', err: serializeError(reason) }, 'Unhandled rejection');
    exit(ExitCode.ERROR);
  });

  try {
    process.exitCode = await run();
  } finally {
    removeSignalHandlers();
  }
}

/**
 * True when this module is the process entry point.
 *
 * Compares real paths so the check survives the symlink npm creates for a
 * global `bin`, on which `process.argv[1]` is the link and `import.meta.url`
 * the target.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Only take over the process when executed as the `ferret` binary; importing
// this module from a test or an embedder must have no side effects.
if (isEntryPoint()) {
  await main();
}
