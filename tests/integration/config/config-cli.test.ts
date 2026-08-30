import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

/**
 * `ferret config` end to end, as a real process.
 *
 * Every case runs against an isolated `FERRET_CONFIG_HOME`, so nothing here can
 * read or write the configuration of whoever is running the suite.
 */

let home: string;
let repo: string;
let env: Record<string, string>;

function json<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as { ok: boolean; data: T };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-cfg-home-'));
  repo = mkdtempSync(join(tmpdir(), 'ferret-cfg-repo-'));
  env = { FERRET_CONFIG_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('reading configuration', () => {
  it('lists a usable configuration before anything has been configured', async () => {
    const result = await runCli(['config', 'list', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.OK);

    const data = json<{ config: { logLevel: string; database: { port: number } } }>(result.stdout);
    expect(data.config.logLevel).toBe('warn');
    expect(data.config.database.port).toBe(5432);
  });

  it('is the default subcommand, so bare `ferret config` shows the configuration', async () => {
    const result = await runCli(['config', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.OK);
    expect(json<{ config: unknown }>(result.stdout).config).toBeDefined();
  });

  it('reports which layer supplied each value under --explain', async () => {
    await runCli(['config', 'set', 'database.host', 'from-file'], { env, cwd: repo });

    const result = await runCli(['config', 'list', '--explain', '--json'], {
      env: { ...env, FERRET_LOG_LEVEL: 'error' },
      cwd: repo,
    });
    const data = json<{ origins: Record<string, string> }>(result.stdout);

    expect(data.origins['logLevel']).toBe('environment');
    expect(data.origins['database.host']).toContain('file:');
  });

  it('prints the files it reads from', async () => {
    const result = await runCli(['config', 'path', '--json'], { env, cwd: repo });
    const data = json<{ user: string; repository: string | null; audit: string }>(result.stdout);

    expect(data.user).toContain(home);
    expect(data.audit).toContain(home);
    expect(data.repository).toBeNull();
  });

  it('reads a single value by dotted path, and says where it came from', async () => {
    await runCli(['config', 'set', 'database.host', 'db.example'], { env, cwd: repo });
    const result = await runCli(['config', 'get', 'database.host', '--json'], { env, cwd: repo });

    const data = json<{ value: string; source: string }>(result.stdout);
    expect(data.value).toBe('db.example');
    expect(data.source).toContain('file:');
  });

  it('reports an unset value as null rather than inventing one', async () => {
    const result = await runCli(['config', 'get', 'database.host', '--json'], { env, cwd: repo });
    expect(json<{ value: unknown }>(result.stdout).value).toBeNull();
  });

  it('validates without changing anything', async () => {
    const result = await runCli(['config', 'validate', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.OK);
    expect(json<{ valid: boolean }>(result.stdout).valid).toBe(true);
  });

  it('exits 3 when the effective configuration is invalid', async () => {
    const result = await runCli(['config', 'validate', '--json'], {
      env: { ...env, FERRET_DATABASE_PORT: '70000' },
      cwd: repo,
    });
    expect(result.code).toBe(ExitCode.CONFIG);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(envelope.error.code).toBe('E_CONFIG_INVALID');
  });
});

describe('writing configuration', () => {
  it('stores a value and reads it back in a separate process', async () => {
    const write = await runCli(['config', 'set', 'database.host', 'db.example', '--json'], { env, cwd: repo });
    expect(write.code).toBe(ExitCode.OK);

    const read = await runCli(['config', 'get', 'database.host', '--json'], { env, cwd: repo });
    expect(json<{ value: string }>(read.stdout).value).toBe('db.example');
  });

  it('reads JSON values as their types, and everything else as text', async () => {
    await runCli(['config', 'set', 'database.port', '6000'], { env, cwd: repo });
    await runCli(['config', 'set', 'exclude', '["tmp","scratch"]'], { env, cwd: repo });
    await runCli(['config', 'set', 'database.user', 'plain-text-user'], { env, cwd: repo });

    const result = await runCli(['config', 'list', '--json'], { env, cwd: repo });
    const data = json<{
      config: { database: { port: number; user: string }; exclude: { pattern: string }[] };
    }>(result.stdout);

    expect(data.config.database.port).toBe(6000);
    expect(data.config.database.user).toBe('plain-text-user');
    expect(data.config.exclude.map((rule) => rule.pattern)).toStrictEqual(['tmp', 'scratch']);
  });

  it('removes a value on unset', async () => {
    await runCli(['config', 'set', 'logLevel', 'debug'], { env, cwd: repo });
    await runCli(['config', 'unset', 'logLevel', '--json'], { env, cwd: repo });

    const result = await runCli(['config', 'get', 'logLevel', '--json'], { env, cwd: repo });
    expect(json<{ value: string }>(result.stdout).value).toBe('warn');
  });

  it('exits 3 and changes nothing when the value is invalid', async () => {
    await runCli(['config', 'set', 'database.host', 'keep-me'], { env, cwd: repo });
    const before = readFileSync(join(home, 'config.json'), 'utf8');

    const result = await runCli(['config', 'set', 'database.port', '70000', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.CONFIG);

    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(before);
  });
});

describe('secrets', () => {
  it('never prints a stored password, in any output mode', async () => {
    await runCli(['config', 'set', 'database.password', 'hunter2'], { env, cwd: repo });

    const list = await runCli(['config', 'list', '--json', '--log-level', 'trace'], { env, cwd: repo });
    const get = await runCli(['config', 'get', 'database.password', '--json'], { env, cwd: repo });
    const human = await runCli(['config', 'get', 'database.password'], { env, cwd: repo });

    for (const result of [list, get, human]) {
      expect(result.stdout).not.toContain('hunter2');
      expect(result.stderr).not.toContain('hunter2');
    }
    // Redacted, not merely absent.
    expect(list.stdout).toContain('[redacted]');
    expect(json<{ redacted: boolean }>(get.stdout).redacted).toBe(true);
  });

  it('keeps the password out of the audit journal too', async () => {
    await runCli(['config', 'set', 'database.password', 'hunter2'], { env, cwd: repo });

    const audit = readFileSync(join(home, 'config-audit.log'), 'utf8');
    expect(audit).toContain('database.password');
    expect(audit).not.toContain('hunter2');

    const shown = await runCli(['config', 'audit', '--json'], { env, cwd: repo });
    expect(shown.stdout).not.toContain('hunter2');
  });

  it('stores a secret reference rather than the secret, and resolves it at startup', async () => {
    await runCli(['config', 'set', 'database.password', '{"$secret":{"env":"MY_PW"}}'], {
      env: { ...env, MY_PW: 'hunter2' },
      cwd: repo,
    });

    const stored = readFileSync(join(home, 'config.json'), 'utf8');
    expect(stored).toContain('$secret');
    expect(stored).not.toContain('hunter2');

    // Resolvable at startup, and still never printed.
    const result = await runCli(['config', 'get', 'database.password', '--json'], {
      env: { ...env, MY_PW: 'hunter2' },
      cwd: repo,
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).not.toContain('hunter2');
  });

  it('exits 3 when a stored secret reference cannot be resolved', async () => {
    await runCli(['config', 'set', 'database.password', '{"$secret":{"env":"MY_PW"}}'], {
      env: { ...env, MY_PW: 'hunter2' },
      cwd: repo,
    });

    const result = await runCli(['config', 'list', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.CONFIG);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; remediation: string } };
    expect(envelope.error.code).toBe('E_CONFIG_INVALID');
    expect(envelope.error.remediation).toContain('MY_PW');
  });
});

describe('repository policy', () => {
  function writeRepositoryPolicy(config: Record<string, unknown>): void {
    mkdirSync(join(repo, '.ferret'), { recursive: true });
    writeFileSync(join(repo, '.ferret', 'config.json'), JSON.stringify(config), 'utf8');
  }

  it('applies exclusions a repository declares for its own content', async () => {
    writeRepositoryPolicy({ exclude: [{ pattern: 'secrets/**', scope: 'repository', reason: 'sensitive' }] });

    const result = await runCli(['config', 'exclude', 'test', 'secrets/key.pem', '--json'], { env, cwd: repo });
    const data = json<{ excluded: boolean; rule: { reason: string; scope: string } }>(result.stdout);

    expect(data.excluded).toBe(true);
    expect(data.rule.reason).toBe('sensitive');
    expect(data.rule.scope).toBe('repository');
  });

  it('refuses to let a cloned repository repoint the database or enable a provider', async () => {
    // The security property: a repository policy file travels with the code,
    // so it must not be able to reconfigure the machine that clones it.
    writeRepositoryPolicy({
      exclude: ['ok/**'],
      database: { host: 'attacker.example', port: 6666, password: 'stolen' },
      logLevel: 'trace',
      providers: { 'evil.provider': { enabled: true } },
    });

    const result = await runCli(['config', 'list', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.OK);

    const data = json<{
      config: { database: { host?: string; port: number }; logLevel: string; providers: Record<string, unknown> };
      repositoryIgnoredKeys: string[];
    }>(result.stdout);

    expect(data.config.database.host).toBeUndefined();
    expect(data.config.database.port).toBe(5432);
    expect(data.config.logLevel).toBe('warn');
    expect(data.config.providers).toStrictEqual({});
    // The refusal is reported, not silent.
    expect(data.repositoryIgnoredKeys.sort()).toStrictEqual(['database', 'logLevel', 'providers']);
  });

  it('finds the policy from a subdirectory, as a developer would be working', async () => {
    writeRepositoryPolicy({ exclude: ['generated/**'] });
    const nested = join(repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const result = await runCli(['config', 'exclude', 'test', 'generated/api.ts', '--json'], {
      env,
      cwd: nested,
    });
    expect(json<{ excluded: boolean }>(result.stdout).excluded).toBe(true);
  });
});

describe('exclusions', () => {
  it('lists Ferret\'s defaults alongside the user\'s own rules', async () => {
    await runCli(['config', 'set', 'exclude', '["my-scratch"]'], { env, cwd: repo });

    const result = await runCli(['config', 'exclude', 'list', '--json'], { env, cwd: repo });
    const rules = json<{ pattern: string; builtIn: boolean; reason: string | null }[]>(result.stdout);

    expect(rules.some((rule) => rule.pattern === '.git' && rule.builtIn)).toBe(true);
    expect(rules.some((rule) => rule.pattern === 'my-scratch' && !rule.builtIn)).toBe(true);
    // Defaults carry a reason, so a user can see why Ferret skips them.
    expect(rules.find((rule) => rule.pattern === '.git')?.reason).toBeTruthy();
  });

  it('explains which rule excluded a path', async () => {
    const result = await runCli(['config', 'exclude', 'test', 'node_modules/pkg/index.js', '--json'], {
      env,
      cwd: repo,
    });
    const data = json<{ excluded: boolean; rule: { pattern: string }; note: string }>(result.stdout);

    expect(data.excluded).toBe(true);
    expect(data.rule.pattern).toBe('node_modules');
    // The non-destructive contract is stated in the output, because it is the
    // property EPIC-003 is required to preserve.
    expect(data.note).toContain('never deletes evidence');
  });

  it('reports a path that is not excluded', async () => {
    const result = await runCli(['config', 'exclude', 'test', 'src/index.ts', '--json'], { env, cwd: repo });
    const data = json<{ excluded: boolean; rule: unknown }>(result.stdout);
    expect(data.excluded).toBe(false);
    expect(data.rule).toBeNull();
  });

  it('answers as policy stood at an earlier instant', async () => {
    await runCli(
      ['config', 'set', 'exclude', '[{"pattern":"archive","scope":"global","effectiveFrom":"2026-06-01T00:00:00Z"}]'],
      { env, cwd: repo },
    );

    const before = await runCli(
      ['config', 'exclude', 'test', 'archive/old.md', '--at', '2026-01-01T00:00:00Z', '--json'],
      { env, cwd: repo },
    );
    const after = await runCli(['config', 'exclude', 'test', 'archive/old.md', '--json'], { env, cwd: repo });

    // Evidence indexed before the rule existed stays answerable as it was.
    expect(json<{ excluded: boolean }>(before.stdout).excluded).toBe(false);
    expect(json<{ excluded: boolean }>(after.stdout).excluded).toBe(true);
  });
});

describe('the audit journal', () => {
  it('records each change in order, and limits output on request', async () => {
    await runCli(['config', 'set', 'logLevel', 'debug'], { env, cwd: repo });
    await runCli(['config', 'set', 'database.host', 'h'], { env, cwd: repo });
    await runCli(['config', 'unset', 'logLevel'], { env, cwd: repo });

    const all = await runCli(['config', 'audit', '--json'], { env, cwd: repo });
    const entries = json<{ action: string; path: string }[]>(all.stdout);
    expect(entries.map((entry) => entry.action)).toStrictEqual(['create', 'set', 'set', 'unset']);

    const limited = await runCli(['config', 'audit', '-n', '2', '--json'], { env, cwd: repo });
    expect(json<unknown[]>(limited.stdout)).toHaveLength(2);
  });

  it('reports an empty journal without failing', async () => {
    const result = await runCli(['config', 'audit', '--json'], { env, cwd: repo });
    expect(result.code).toBe(ExitCode.OK);
    expect(json<unknown[]>(result.stdout)).toStrictEqual([]);
  });
});

describe('stream discipline', () => {
  it('keeps stdout parseable as one JSON document for every subcommand', async () => {
    const commands = [
      ['config', 'list', '--json'],
      ['config', 'path', '--json'],
      ['config', 'validate', '--json'],
      ['config', 'audit', '--json'],
      ['config', 'exclude', 'list', '--json'],
      ['config', 'exclude', 'test', 'x.ts', '--json'],
    ];

    for (const argv of commands) {
      const result = await runCli(argv, { env: { ...env, FERRET_LOG_LEVEL: 'trace' }, cwd: repo });
      expect(result.code, `${argv.join(' ')} → ${result.stderr}`).toBe(ExitCode.OK);
      expect(
        () => JSON.parse(result.stdout) as unknown,
        `${argv.join(' ')} stdout was not one JSON document`,
      ).not.toThrow();
    }
  }, 120_000);
});
