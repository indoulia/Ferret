import { mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

import { json, useConfigCli } from './config-cli-fixture.js';

/**
 * Repository policy and exclusions, end to end as a real process.

 * Two topics in one file because they are the same subject from two directions:
 * a repository may express exclusions and nothing else, and an exclusion is a
 * decision that is evaluated rather than an action that deletes.
 *
 * Split out of `config-cli.test.ts`, verbatim. That file's 26 cases each spawn a
 * real process and ran in series, because vitest parallelizes across files rather
 * than within one — 167s of a 177s suite in a single file. Nothing any case
 * asserts changed.
 */

const context = useConfigCli();

describe('repository policy', () => {
  function writeRepositoryPolicy(config: Record<string, unknown>): void {
    mkdirSync(join(context.repo, '.ferret'), { recursive: true });
    writeFileSync(join(context.repo, '.ferret', 'config.json'), JSON.stringify(config), 'utf8');
  }

  it('applies exclusions a repository declares for its own content', async () => {
    writeRepositoryPolicy({ exclude: [{ pattern: 'secrets/**', scope: 'repository', reason: 'sensitive' }] });

    const result = await runCli(['config', 'exclude', 'test', 'secrets/key.pem', '--json'], { env: context.env, cwd: context.repo });
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

    const result = await runCli(['config', 'list', '--json'], { env: context.env, cwd: context.repo });
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
    const nested = join(context.repo, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const result = await runCli(['config', 'exclude', 'test', 'generated/api.ts', '--json'], {
      env: context.env,
      cwd: nested,
    });
    expect(json<{ excluded: boolean }>(result.stdout).excluded).toBe(true);
  });
});

describe('exclusions', () => {
  it('lists Ferret\'s defaults alongside the user\'s own rules', async () => {
    await runCli(['config', 'set', 'exclude', '["my-scratch"]'], { env: context.env, cwd: context.repo });

    const result = await runCli(['config', 'exclude', 'list', '--json'], { env: context.env, cwd: context.repo });
    const rules = json<{ pattern: string; builtIn: boolean; reason: string | null }[]>(result.stdout);

    expect(rules.some((rule) => rule.pattern === '.git' && rule.builtIn)).toBe(true);
    expect(rules.some((rule) => rule.pattern === 'my-scratch' && !rule.builtIn)).toBe(true);
    // Defaults carry a reason, so a user can see why Ferret skips them.
    expect(rules.find((rule) => rule.pattern === '.git')?.reason).toBeTruthy();
  });

  it('explains which rule excluded a path', async () => {
    const result = await runCli(['config', 'exclude', 'test', 'node_modules/pkg/index.js', '--json'], {
      env: context.env,
      cwd: context.repo,
    });
    const data = json<{ excluded: boolean; rule: { pattern: string }; note: string }>(result.stdout);

    expect(data.excluded).toBe(true);
    expect(data.rule.pattern).toBe('node_modules');
    // The non-destructive contract is stated in the output, because it is the
    // property EPIC-003 is required to preserve.
    expect(data.note).toContain('never deletes evidence');
  });

  it('reports a path that is not excluded', async () => {
    const result = await runCli(['config', 'exclude', 'test', 'src/index.ts', '--json'], { env: context.env, cwd: context.repo });
    const data = json<{ excluded: boolean; rule: unknown }>(result.stdout);
    expect(data.excluded).toBe(false);
    expect(data.rule).toBeNull();
  });

  it('answers as policy stood at an earlier instant', async () => {
    await runCli(
      ['config', 'set', 'exclude', '[{"pattern":"archive","scope":"global","effectiveFrom":"2026-06-01T00:00:00Z"}]'],
      { env: context.env, cwd: context.repo },
    );

    const before = await runCli(
      ['config', 'exclude', 'test', 'archive/old.md', '--at', '2026-01-01T00:00:00Z', '--json'],
      { env: context.env, cwd: context.repo },
    );
    const after = await runCli(['config', 'exclude', 'test', 'archive/old.md', '--json'], { env: context.env, cwd: context.repo });

    // Evidence indexed before the rule existed stays answerable as it was.
    expect(json<{ excluded: boolean }>(before.stdout).excluded).toBe(false);
    expect(json<{ excluded: boolean }>(after.stdout).excluded).toBe(true);
  });
});
