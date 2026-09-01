
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

import { json, useConfigCli } from './config-cli-fixture.js';

/**
 * `ferret config` reading, end to end as a real process.

 * List, the default subcommand, `--explain` origins, the files it reads from,
 * a single value by dotted path, an unset value, and validation that changes
 * nothing.
 *
 * Split out of `config-cli.test.ts`, verbatim. That file's 26 cases each spawn a
 * real process and ran in series, because vitest parallelizes across files rather
 * than within one — 167s of a 177s suite in a single file. Nothing any case
 * asserts changed.
 */

const context = useConfigCli();

describe('reading configuration', () => {
  it('lists a usable configuration before anything has been configured', async () => {
    const result = await runCli(['config', 'list', '--json'], { env: context.env, cwd: context.repo });
    expect(result.code).toBe(ExitCode.OK);

    const data = json<{ config: { logLevel: string; database: { port: number } } }>(result.stdout);
    expect(data.config.logLevel).toBe('warn');
    expect(data.config.database.port).toBe(5432);
  });

  it('is the default subcommand, so bare `ferret config` shows the configuration', async () => {
    const result = await runCli(['config', '--json'], { env: context.env, cwd: context.repo });
    expect(result.code).toBe(ExitCode.OK);
    expect(json<{ config: unknown }>(result.stdout).config).toBeDefined();
  });

  it('reports which layer supplied each value under --explain', async () => {
    await runCli(['config', 'set', 'database.host', 'from-file'], { env: context.env, cwd: context.repo });

    const result = await runCli(['config', 'list', '--explain', '--json'], {
      env: { ...context.env, FERRET_LOG_LEVEL: 'error' },
      cwd: context.repo,
    });
    const data = json<{ origins: Record<string, string> }>(result.stdout);

    expect(data.origins['logLevel']).toBe('environment');
    expect(data.origins['database.host']).toContain('file:');
  });

  it('prints the files it reads from', async () => {
    const result = await runCli(['config', 'path', '--json'], { env: context.env, cwd: context.repo });
    const data = json<{ user: string; repository: string | null; audit: string }>(result.stdout);

    expect(data.user).toContain(context.home);
    expect(data.audit).toContain(context.home);
    expect(data.repository).toBeNull();
  });

  it('reads a single value by dotted path, and says where it came from', async () => {
    await runCli(['config', 'set', 'database.host', 'db.example'], { env: context.env, cwd: context.repo });
    const result = await runCli(['config', 'get', 'database.host', '--json'], { env: context.env, cwd: context.repo });

    const data = json<{ value: string; source: string }>(result.stdout);
    expect(data.value).toBe('db.example');
    expect(data.source).toContain('file:');
  });

  it('reports an unset value as null rather than inventing one', async () => {
    const result = await runCli(['config', 'get', 'database.host', '--json'], { env: context.env, cwd: context.repo });
    expect(json<{ value: unknown }>(result.stdout).value).toBeNull();
  });

  it('validates without changing anything', async () => {
    const result = await runCli(['config', 'validate', '--json'], { env: context.env, cwd: context.repo });
    expect(result.code).toBe(ExitCode.OK);
    expect(json<{ valid: boolean }>(result.stdout).valid).toBe(true);
  });

  it('exits 3 when the effective configuration is invalid', async () => {
    const result = await runCli(['config', 'validate', '--json'], {
      env: { ...context.env, FERRET_DATABASE_PORT: '70000' },
      cwd: context.repo,
    });
    expect(result.code).toBe(ExitCode.CONFIG);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('E_CONFIG_INVALID');
  });
});
