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
    // EPIC-004 implemented these. With no database configured they report an
    // unavailable configuration, which is exit code 3 — deterministically, so
    // it is a usable assertion rather than an environment-dependent one.
    [['status'], ExitCode.CONFIG],
    [['doctor'], ExitCode.CONFIG],
    // EPIC-064 implemented `mcp`. With no database configured it reports an
    // unavailable configuration and exits 3, like every other command that
    // needs storage — it does not start serving and then fail.
    [['mcp'], ExitCode.CONFIG],
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
    // An unknown command is a genuine error and always will be. `status` served
    // here until EPIC-004 made it succeed at reporting, and `mcp` until
    // EPIC-064 implemented it — so this uses the one case that cannot become a
    // success later.
    //
    // stdout staying empty matters more for `mcp` than for anything else:
    // stdout *is* the MCP transport, and a single stray line corrupts it.
    const result = await runCli(['nope']);
    expect(result.stdout).toBe('');
    // Commander words this one, not Ferret — an unknown command never reaches
    // Ferret's error taxonomy. What matters here is the stream, not the code:
    // the exit-code table above asserts that separately.
    expect(result.stderr).toContain("unknown command 'nope'");
  });

  it('keeps stdout empty when `mcp` cannot start', async () => {
    // The specific case the transport depends on. If Ferret ever prints its
    // failure to stdout, an AI client reads it as a protocol message.
    const result = await runCli(['mcp']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('E_CONFIG_MISSING');
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

/**
 * EPIC-091 — the two commands Governance §20 names by name.
 *
 * Both emitted nothing at any level. `probeHealth` accepted a logger and
 * threaded it only into storage probing; no probe, verdict, component or
 * duration was ever logged, so a `status` that answered `unknown` left nothing
 * behind to diagnose. And both built a logger only when `--log-level` was
 * present, so a configured level reached `ferret env` and not these two.
 *
 * Asserted against a real process rather than by calling `probeHealth`
 * directly: the gap was in how the commands *composed* the logger, and a unit
 * test of the function they call would have passed throughout.
 */
describe('installed CLI — health-path logging (EPIC-091)', () => {
  it('logs one record per probed component, with its verdict — AC-5', async () => {
    const result = await runCli(['status', '--log-level', 'debug']);

    const probes = parseLogRecords(result.stderr).filter((r) => r['operation'] === 'health.probe');
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe['component']).toBeTypeOf('string');
      expect(probe['status']).toBeTypeOf('string');
    }
  });

  it('logs a summary carrying the verdict and the duration — AC-5', async () => {
    const result = await runCli(['doctor', '--log-level', 'debug']);

    const summary = parseLogRecords(result.stderr).find((r) => r['operation'] === 'health.report');
    expect(summary).toBeDefined();
    expect(summary?.['status']).toBeTypeOf('string');
    expect(summary?.['durationMs']).toBeTypeOf('number');
  });

  it('still produces a report when a subsystem is unavailable — AC-6', async () => {
    // No database configured, which is the state §20 means by "dependable even
    // when other subsystems are unhealthy": the report and the records are both
    // required, and the one most likely to regress is the records.
    const result = await runCli(['status', '--json', '--log-level', 'debug']);

    expect(result.code).toBe(ExitCode.CONFIG);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBeTypeOf('boolean');
    expect(parseLogRecords(result.stderr).some((r) => r['operation'] === 'health.probe')).toBe(true);
  });

  it('honours a configured level with no flag — AC-7', async () => {
    // The direct regression for §2.3: `FERRET_LOG_LEVEL=trace ferret status`
    // produced zero lines while `ferret env` produced two.
    const result = await runCli(['status'], { env: { FERRET_LOG_LEVEL: 'trace' } });

    expect(parseLogRecords(result.stderr).length).toBeGreaterThan(0);
  });

  it('lets the flag override the configured level — AC-8', async () => {
    const result = await runCli(['status', '--log-level', 'silent'], {
      env: { FERRET_LOG_LEVEL: 'trace' },
    });

    expect(parseLogRecords(result.stderr)).toStrictEqual([]);
  });

  it('stays silent with neither a flag nor a configured level — AC-17', async () => {
    const result = await runCli(['status'], { env: { FERRET_LOG_LEVEL: '' } });

    expect(parseLogRecords(result.stderr)).toStrictEqual([]);
  });

  it('keeps stdout to exactly one document under --json at trace — AC-16', async () => {
    const result = await runCli(['status', '--json'], { env: { FERRET_LOG_LEVEL: 'trace' } });

    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
  });

  it('stamps every record with the build, the process and one invocation id — AC-2, AC-3', async () => {
    const result = await runCli(['status', '--log-level', 'debug']);
    const records = parseLogRecords(result.stderr);

    expect(records.length).toBeGreaterThan(0);
    const invocations = new Set(records.map((r) => r['invocation']));
    expect(invocations.size).toBe(1);
    for (const record of records) {
      expect(record['ferret']).toBe(VERSION);
      expect(record['pid']).toBeTypeOf('number');
    }
  });

  it('gives two concurrent invocations different ids — AC-3', async () => {
    const [first, second] = await Promise.all([
      runCli(['status', '--log-level', 'debug']),
      runCli(['status', '--log-level', 'debug']),
    ]);

    const idOf = (stderr: string): string => {
      const value = parseLogRecords(stderr)[0]?.['invocation'];
      return typeof value === 'string' ? value : '';
    };
    expect(idOf(first?.stderr ?? '')).not.toBe('');
    expect(idOf(first?.stderr ?? '')).not.toBe(idOf(second?.stderr ?? ''));
  });
});
