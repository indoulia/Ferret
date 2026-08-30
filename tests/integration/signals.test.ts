import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../src/cli/exit-codes.js';
import { ROOT } from '../helpers/cli.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/long-running.mjs', import.meta.url));

/**
 * Node.js does not deliver POSIX signals to a process on Windows: `SIGTERM` is
 * not supported at all, and `SIGINT` only arrives through console emulation
 * that a spawned, non-interactive child does not get. These cases therefore run
 * on POSIX only, and the Windows gap is recorded as a known limitation rather
 * than papered over with a mock.
 */
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

interface SignalRun {
  readonly code: number | null;
  readonly stdout: string;
}

function runUntilSignal(signal: NodeJS.Signals): Promise<SignalRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let signalled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture did not exit after ${signal}`));
    }, 20_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!signalled && stdout.includes('READY')) {
        signalled = true;
        child.kill(signal);
      }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.on('error', reject);
  });
}

posixOnly('graceful shutdown on signals', () => {
  it('shuts down cleanly on SIGINT and exits 130', async () => {
    const result = await runUntilSignal('SIGINT');

    expect(result.stdout).toContain('READY');
    expect(result.stdout).toContain('STATE stopped');
    expect(result.code).toBe(ExitCode.INTERRUPTED);
  });

  it('shuts down cleanly on SIGTERM and exits 143', async () => {
    const result = await runUntilSignal('SIGTERM');

    expect(result.stdout).toContain('STATE stopped');
    expect(result.code).toBe(ExitCode.TERMINATED);
  });

  it('releases providers and disposables before exiting', async () => {
    const result = await runUntilSignal('SIGTERM');
    expect(result.stdout).toContain('RELEASED provider,disposable');
  });
});

describe('signal handler contract', () => {
  it('declares the exit code each signal implies', async () => {
    const { SHUTDOWN_SIGNALS } = await import('../../src/index.js');
    expect(SHUTDOWN_SIGNALS).toStrictEqual({ SIGINT: 130, SIGTERM: 143 });
  });

  it('removes every handler it installed', async () => {
    const { installSignalHandlers, createNullLogger } = await import('../../src/index.js');
    const before = process.listenerCount('SIGINT');

    const remove = installSignalHandlers({
      shutdown: () => Promise.resolve(),
      logger: createNullLogger(),
      onExit: () => undefined,
    });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    remove();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('runs shutdown exactly once and reports the signal exit code', async () => {
    const { installSignalHandlers, createNullLogger } = await import('../../src/index.js');
    let shutdowns = 0;
    const exits: number[] = [];

    const remove = installSignalHandlers({
      shutdown: () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      logger: createNullLogger(),
      onExit: (code) => exits.push(code),
    });

    process.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));
    remove();

    expect(shutdowns).toBe(1);
    expect(exits).toStrictEqual([130]);
  });

  it('exits immediately on a second signal rather than waiting again', async () => {
    const { installSignalHandlers, createNullLogger } = await import('../../src/index.js');
    const exits: number[] = [];
    let resolveShutdown: (() => void) | undefined;

    const remove = installSignalHandlers({
      shutdown: () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
      logger: createNullLogger(),
      onExit: (code) => exits.push(code),
    });

    process.emit('SIGINT');
    process.emit('SIGINT');
    expect(exits).toStrictEqual([130]);

    resolveShutdown?.();
    await new Promise((resolve) => setImmediate(resolve));
    remove();
  });
});
