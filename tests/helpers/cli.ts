import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the harness killed the process rather than it exiting. */
  readonly timedOut: boolean;
  /** The signal it was killed with, when it was killed. */
  readonly signal?: string;
}

/**
 * Runs the built CLI as a real child process.
 *
 * `execFile` passes the argument vector straight to the OS, so nothing here
 * depends on shell quoting and the test exercises the same entry point that
 * `npm install -g` produces.
 */
/**
 * How long a CLI invocation may take before the harness kills it.
 *
 * Named rather than inline so a timeout can be reported as one: a caller that
 * cannot distinguish "the command failed" from "the harness stopped waiting"
 * cannot diagnose either.
 */
export const CLI_TIMEOUT_MS = 30_000;

export async function runCli(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...options.env },
      cwd: options.cwd ?? ROOT,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    // A killed process is a **timeout**, not an exit code — and saying so is the
    // whole point. `execFile` reports one with `killed: true` and no numeric
    // `code`, which the previous shape flattened to `code: 1` with empty
    // stdout. A caller then saw `JSON.parse('')` throw a bare `SyntaxError`,
    // which is issue #61's finding one layer up: the run failed and the reason
    // was discarded.
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      timedOut: failure.killed === true && typeof failure.code !== 'number',
      ...(failure.signal === undefined ? {} : { signal: failure.signal }),
    };
  }
}

/**
 * Parses a `--json` envelope, and says what it got when it cannot.
 *
 * `JSON.parse(result.stdout)` throws a `SyntaxError` naming the first offending
 * character, which tells a reader nothing about a CLI that timed out, crashed,
 * or printed a diagnostic. Under full-suite contention that is the difference
 * between a diagnosable failure and a mystery — this repository has already
 * closed two such issues (#21, #61) and left a third (#130) uncaused.
 */
export function parseEnvelope<T>(result: CliResult, command: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const reason = result.timedOut
      ? `timed out after ${String(CLI_TIMEOUT_MS)}ms${result.signal === undefined ? '' : ` (${result.signal})`}`
      : `exited ${String(result.code)}`;
    throw new Error(
      `ferret ${command} ${reason} and did not print a JSON envelope.\n` +
        `stdout (${String(result.stdout.length)} bytes): ${JSON.stringify(result.stdout.slice(0, 400))}\n` +
        `stderr (last 400): ${JSON.stringify(result.stderr.slice(-400))}`,
      // The parse failure is the symptom; the cause is kept so neither is lost.
      { cause: error },
    );
  }
}

/** Parses the NDJSON log records emitted on stderr. */
export function parseLogRecords(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
