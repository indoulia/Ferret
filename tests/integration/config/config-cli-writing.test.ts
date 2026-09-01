import { readFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

import { json, useConfigCli } from './config-cli-fixture.js';

/**
 * `ferret config set` and `unset`, end to end as a real process.

 * The durability half of EPIC-003: a value survives into a separate process, a
 * type survives the round trip, an unset restores the default, and an invalid
 * value changes nothing.
 *
 * Split out of `config-cli.test.ts`, verbatim. That file's 26 cases each spawn a
 * real process and ran in series, because vitest parallelizes across files rather
 * than within one — 167s of a 177s suite in a single file. Nothing any case
 * asserts changed.
 */

const context = useConfigCli();

describe('writing configuration', () => {
  it('stores a value and reads it back in a separate process', async () => {
    const write = await runCli(['config', 'set', 'database.host', 'db.example', '--json'], { env: context.env, cwd: context.repo });
    expect(write.code).toBe(ExitCode.OK);

    const read = await runCli(['config', 'get', 'database.host', '--json'], { env: context.env, cwd: context.repo });
    expect(json<{ value: string }>(read.stdout).value).toBe('db.example');
  });

  it('reads JSON values as their types, and everything else as text', async () => {
    await runCli(['config', 'set', 'database.port', '6000'], { env: context.env, cwd: context.repo });
    await runCli(['config', 'set', 'exclude', '["tmp","scratch"]'], { env: context.env, cwd: context.repo });
    await runCli(['config', 'set', 'database.user', 'plain-text-user'], { env: context.env, cwd: context.repo });

    const result = await runCli(['config', 'list', '--json'], { env: context.env, cwd: context.repo });
    const data = json<{
      config: { database: { port: number; user: string }; exclude: { pattern: string }[] };
    }>(result.stdout);

    expect(data.config.database.port).toBe(6000);
    expect(data.config.database.user).toBe('plain-text-user');
    expect(data.config.exclude.map((rule) => rule.pattern)).toStrictEqual(['tmp', 'scratch']);
  });

  it('removes a value on unset', async () => {
    await runCli(['config', 'set', 'logLevel', 'debug'], { env: context.env, cwd: context.repo });
    await runCli(['config', 'unset', 'logLevel', '--json'], { env: context.env, cwd: context.repo });

    const result = await runCli(['config', 'get', 'logLevel', '--json'], { env: context.env, cwd: context.repo });
    expect(json<{ value: string }>(result.stdout).value).toBe('warn');
  });

  it('exits 3 and changes nothing when the value is invalid', async () => {
    await runCli(['config', 'set', 'database.host', 'keep-me'], { env: context.env, cwd: context.repo });
    const before = readFileSync(join(context.home, 'config.json'), 'utf8');

    const result = await runCli(['config', 'set', 'database.port', '70000', '--json'], { env: context.env, cwd: context.repo });
    expect(result.code).toBe(ExitCode.CONFIG);

    expect(readFileSync(join(context.home, 'config.json'), 'utf8')).toBe(before);
  });
});
