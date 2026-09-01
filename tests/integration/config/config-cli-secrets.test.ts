import { readFileSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

import { json, useConfigCli } from './config-cli-fixture.js';

/**
 * Credentials never reaching output, end to end as a real process.

 * EPIC-003 AC-5. A stored password appears in neither stdout nor stderr at
 * `--log-level trace`, nor in the audit journal; a secret reference is stored in
 * place of the value and resolved at startup; an unresolvable one exits 3.
 *
 * Split out of `config-cli.test.ts`, verbatim. That file's 26 cases each spawn a
 * real process and ran in series, because vitest parallelizes across files rather
 * than within one — 167s of a 177s suite in a single file. Nothing any case
 * asserts changed.
 */

const context = useConfigCli();

describe('secrets', () => {
  it('never prints a stored password, in any output mode', async () => {
    await runCli(['config', 'set', 'database.password', 'hunter2'], { env: context.env, cwd: context.repo });

    const list = await runCli(['config', 'list', '--json', '--log-level', 'trace'], { env: context.env, cwd: context.repo });
    const get = await runCli(['config', 'get', 'database.password', '--json'], { env: context.env, cwd: context.repo });
    const human = await runCli(['config', 'get', 'database.password'], { env: context.env, cwd: context.repo });

    for (const result of [list, get, human]) {
      expect(result.stdout).not.toContain('hunter2');
      expect(result.stderr).not.toContain('hunter2');
    }
    // Redacted, not merely absent.
    expect(list.stdout).toContain('[redacted]');
    expect(json<{ redacted: boolean }>(get.stdout).redacted).toBe(true);
  });

  it('keeps the password out of the audit journal too', async () => {
    await runCli(['config', 'set', 'database.password', 'hunter2'], { env: context.env, cwd: context.repo });

    const audit = readFileSync(join(context.home, 'config-audit.log'), 'utf8');
    expect(audit).toContain('database.password');
    expect(audit).not.toContain('hunter2');

    const shown = await runCli(['config', 'audit', '--json'], { env: context.env, cwd: context.repo });
    expect(shown.stdout).not.toContain('hunter2');
  });

  it('stores a secret reference rather than the secret, and resolves it at startup', async () => {
    await runCli(['config', 'set', 'database.password', '{"$secret":{"env":"MY_PW"}}'], {
      env: { ...context.env, MY_PW: 'hunter2' },
      cwd: context.repo,
    });

    const stored = readFileSync(join(context.home, 'config.json'), 'utf8');
    expect(stored).toContain('$secret');
    expect(stored).not.toContain('hunter2');

    // Resolvable at startup, and still never printed.
    const result = await runCli(['config', 'get', 'database.password', '--json'], {
      env: { ...context.env, MY_PW: 'hunter2' },
      cwd: context.repo,
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).not.toContain('hunter2');
  });

  it('exits 3 when a stored secret reference cannot be resolved', async () => {
    await runCli(['config', 'set', 'database.password', '{"$secret":{"env":"MY_PW"}}'], {
      env: { ...context.env, MY_PW: 'hunter2' },
      cwd: context.repo,
    });

    const result = await runCli(['config', 'list', '--json'], { env: context.env, cwd: context.repo });
    expect(result.code).toBe(ExitCode.CONFIG);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; remediation: string } };
    expect(envelope.error.code).toBe('E_CONFIG_INVALID');
    expect(envelope.error.remediation).toContain('MY_PW');
  });
});
