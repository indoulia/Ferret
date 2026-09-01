
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

import { json, useConfigCli } from './config-cli-fixture.js';

/**
 * The change journal and stdout discipline, end to end as a real process.

 * Grouped because both are about Ferret's *output* rather than its
 * configuration: what it records about a change, and the guarantee that every
 * subcommand emits exactly one parseable JSON document on stdout even at
 * `--log-level trace` — which is what `EPIC-003-VALIDATION.md` §25 cites as
 * making the CLI wrappable by an AI client.
 *
 * Split out of `config-cli.test.ts`, verbatim. That file's 26 cases each spawn a
 * real process and ran in series, because vitest parallelizes across files rather
 * than within one — 167s of a 177s suite in a single file. Nothing any case
 * asserts changed.
 */

const context = useConfigCli();

describe('the audit journal', () => {
  it('records each change in order, and limits output on request', async () => {
    await runCli(['config', 'set', 'logLevel', 'debug'], { env: context.env, cwd: context.repo });
    await runCli(['config', 'set', 'database.host', 'h'], { env: context.env, cwd: context.repo });
    await runCli(['config', 'unset', 'logLevel'], { env: context.env, cwd: context.repo });

    const all = await runCli(['config', 'audit', '--json'], { env: context.env, cwd: context.repo });
    const entries = json<{ action: string; path: string }[]>(all.stdout);
    expect(entries.map((entry) => entry.action)).toStrictEqual(['create', 'set', 'set', 'unset']);

    const limited = await runCli(['config', 'audit', '-n', '2', '--json'], { env: context.env, cwd: context.repo });
    expect(json<unknown[]>(limited.stdout)).toHaveLength(2);
  });

  it('reports an empty journal without failing', async () => {
    const result = await runCli(['config', 'audit', '--json'], { env: context.env, cwd: context.repo });
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
      const result = await runCli(argv, { env: { ...context.env, FERRET_LOG_LEVEL: 'trace' }, cwd: context.repo });
      expect(result.code, `${argv.join(' ')} → ${result.stderr}`).toBe(ExitCode.OK);
      expect(
        () => JSON.parse(result.stdout) as unknown,
        `${argv.join(' ')} stdout was not one JSON document`,
      ).not.toThrow();
    }
  }, 120_000);
});
