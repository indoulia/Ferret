import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../src/cli/exit-codes.js';
import { VERSION } from '../../src/index.js';
import { parseLogRecords, runCli } from '../helpers/cli.js';

const SECRET = 'sup3r-s3cret-passw0rd';
const CREDENTIALS: NodeJS.ProcessEnv = {
  FERRET_DATABASE_HOST: 'db.internal',
  FERRET_DATABASE_NAME: 'ferretdb',
  FERRET_DATABASE_USER: 'ferret',
  FERRET_DATABASE_PASSWORD: SECRET,
};

describe('installed CLI — startup', () => {
  it('starts and reports its version', async () => {
    const result = await runCli(['version']);
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain(VERSION);
  });

  it('completes a full initialize/shutdown cycle through `env`', async () => {
    const result = await runCli(['env', '--json']);
    expect(result.code).toBe(ExitCode.OK);

    const payload = JSON.parse(result.stdout) as { ok: boolean; data: { node: { supported: boolean } } };
    expect(payload.ok).toBe(true);
    expect(payload.data.node.supported).toBe(true);
  });

  it('is deterministic across repeated startups', async () => {
    const runs = await Promise.all([runCli(['version', '--json']), runCli(['version', '--json'])]);
    expect(runs[0]?.code).toBe(ExitCode.OK);
    expect(runs[0]?.stdout).toBe(runs[1]?.stdout);
  });

  it('exits cleanly, leaving nothing that keeps the process alive', async () => {
    // execFile resolving at all proves the event loop drained; a leaked handle
    // would hit the 30 s timeout instead.
    const result = await runCli(['env']);
    expect(result.code).toBe(ExitCode.OK);
  });
});

describe('installed CLI — exit codes', () => {
  it.each([
    [['--help'], ExitCode.OK],
    [['--version'], ExitCode.OK],
    [['version'], ExitCode.OK],
    [['env'], ExitCode.OK],
    [['status'], ExitCode.NOT_IMPLEMENTED],
    [['doctor'], ExitCode.NOT_IMPLEMENTED],
    [['mcp'], ExitCode.NOT_IMPLEMENTED],
    [['nope'], ExitCode.USAGE],
    [['version', '--bad-flag'], ExitCode.USAGE],
  ])('exits %j with code %i', async (args, expected) => {
    expect((await runCli(args)).code).toBe(expected);
  });

  it('exits 3 when configuration is invalid', async () => {
    const result = await runCli(['env'], { env: { FERRET_DATABASE_PORT: '70000' } });
    expect(result.code).toBe(ExitCode.CONFIG);
    expect(result.stderr).toContain('E_CONFIG_INVALID');
  });
});

describe('installed CLI — stream discipline', () => {
  it('keeps stdout free of log output so JSON stays parseable', async () => {
    const result = await runCli(['env', '--json', '--log-level', 'trace']);
    expect(result.code).toBe(ExitCode.OK);
    expect(() => {
      JSON.parse(result.stdout);
    }).not.toThrow();
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('emits diagnostics as NDJSON on stderr with severity, time and component', async () => {
    const result = await runCli(['env', '--log-level', 'info']);
    const records = parseLogRecords(result.stderr);

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(typeof record.level).toBe('string');
      expect(typeof record.time).toBe('string');
      expect(typeof record.msg).toBe('string');
    }
    expect(records.some((r) => r.operation === 'runtime.initialize')).toBe(true);
    expect(records.some((r) => r.operation === 'runtime.shutdown')).toBe(true);
  });

  it('is quiet by default', async () => {
    expect((await runCli(['env'])).stderr).toBe('');
  });

  it('writes human errors to stderr and leaves stdout empty', async () => {
    const result = await runCli(['status']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('E_NOT_IMPLEMENTED');
  });
});

describe('installed CLI — secret safety', () => {
  it('never prints the database password, even at trace level', async () => {
    const result = await runCli(['env', '--json', '--log-level', 'trace'], { env: CREDENTIALS });

    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stdout).toContain('[redacted]');
    // The non-secret fields survive, so the output is still diagnosable.
    expect(result.stdout).toContain('db.internal');
  });

  it('never prints the password in a configuration error', async () => {
    const result = await runCli(['env', '--json'], {
      env: { ...CREDENTIALS, FERRET_DATABASE_PORT: 'not-a-number' },
    });

    expect(result.code).toBe(ExitCode.CONFIG);
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  });

  it('does not echo unrelated environment variables', async () => {
    const result = await runCli(['env', '--json', '--log-level', 'trace'], {
      env: { ...CREDENTIALS, AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI0000EXAMPLEKEY' },
    });

    expect(result.stdout).not.toContain('wJalrXUtnFEMI0000EXAMPLEKEY');
    expect(result.stderr).not.toContain('wJalrXUtnFEMI0000EXAMPLEKEY');
  });
});
