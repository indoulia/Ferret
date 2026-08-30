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
}

/**
 * Runs the built CLI as a real child process.
 *
 * `execFile` passes the argument vector straight to the OS, so nothing here
 * depends on shell quoting and the test exercises the same entry point that
 * `npm install -g` produces.
 */
export async function runCli(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...options.env },
      cwd: options.cwd ?? ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
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
