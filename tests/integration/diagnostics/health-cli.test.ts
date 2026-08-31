import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';

/**
 * `ferret status` and `ferret doctor` end to end, as real processes.
 *
 * The property under test throughout is the one Governance §20 demands: these
 * commands stay dependable *when other things are broken*, which is exactly
 * when they are worth running. Every case here breaks something and asserts a
 * report still comes back.
 */

interface Component {
  readonly name: string;
  readonly area: string;
  readonly status: string;
  readonly required: boolean;
  readonly detail?: string;
  readonly remediation?: string;
}

interface StatusPayload {
  readonly status: string;
  readonly summary: string;
  readonly components: Component[];
  readonly durationMs: number;
  readonly ferret: { version: string };
}

interface DoctorPayload extends StatusPayload {
  readonly diagnoses: { id: string; severity: string; area: string; finding: string; remediation: string }[];
  readonly checked: number;
  readonly counts: { error: number; warning: number; unknown: number };
}

function payload<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as { ok: boolean; data: T };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

function find(components: readonly Component[], name: string): Component | undefined {
  return components.find((component) => component.name === name);
}

let home: string;
let cwd: string;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferret-health-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'ferret-health-cwd-'));
  env = { FERRET_CONFIG_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('a Ferret with nothing configured', () => {
  it('still produces a report, and says what is missing', async () => {
    const result = await runCli(['status', '--json'], { env, cwd });
    const data = payload<StatusPayload>(result.stdout);

    expect(data.status).toBe('unavailable');
    expect(find(data.components, 'node')?.status).toBe('ok');
    expect(find(data.components, 'configuration')?.status).toBe('ok');

    const configured = find(data.components, 'database-configured');
    expect(configured?.status).toBe('unavailable');
    expect(configured?.detail).toContain('missing host');
    expect(configured?.remediation).toContain('ferret init --save');
  });

  it('exits 3, attributing the failure to configuration rather than the database', async () => {
    // Deterministic classification: "you have not told Ferret about a database"
    // and "the database is down" have different remediations and different codes.
    const result = await runCli(['status', '--json'], { env, cwd });
    expect(result.code).toBe(ExitCode.CONFIG);
  });

  it('gives doctor a remediation for every finding', async () => {
    const result = await runCli(['doctor', '--json'], { env, cwd });
    const data = payload<DoctorPayload>(result.stdout);

    expect(data.diagnoses.length).toBeGreaterThan(0);
    for (const diagnosis of data.diagnoses) {
      expect(diagnosis.remediation.length).toBeGreaterThan(0);
      expect(diagnosis.id).toMatch(/^[\w-]+:(ok|degraded|unavailable|unknown)$/);
    }
    expect(data.counts.error).toBeGreaterThanOrEqual(1);
  });
});

describe('a Ferret whose configuration will not parse', () => {
  it('reports the configuration itself as the failure instead of crashing', async () => {
    // The hardest case for a diagnostic: the thing it needs in order to run is
    // the thing that is broken.
    writeFileSync(join(home, 'config.json'), '{ not json at all', 'utf8');

    const result = await runCli(['status', '--json'], { env, cwd });
    expect(result.code).toBe(ExitCode.CONFIG);

    const data = payload<StatusPayload>(result.stdout);
    const configuration = find(data.components, 'configuration');
    expect(configuration?.status).toBe('unavailable');
    expect(configuration?.detail).toContain('not valid JSON');
    expect(configuration?.remediation).toContain('config.json');
  });

  it('does not go on to blame the database for a configuration failure', async () => {
    writeFileSync(join(home, 'config.json'), '{ not json at all', 'utf8');
    const data = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);

    expect(find(data.components, 'postgres')).toBeUndefined();
    expect(find(data.components, 'database-configured')).toBeUndefined();
  });

  it('reports an unresolvable secret reference as a configuration problem', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, config: { database: { password: { $secret: { env: 'NOT_SET' } } } } }),
      'utf8',
    );

    const data = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);
    const configuration = find(data.components, 'configuration');
    expect(configuration?.status).toBe('unavailable');
    expect(configuration?.detail).toContain('NOT_SET');
  });
});

describe('an unreachable database', () => {
  const unreachable = { FERRET_DATABASE_HOST: '127.0.0.1', FERRET_DATABASE_PORT: '1', FERRET_DATABASE_NAME: 'x', FERRET_DATABASE_USER: 'x', FERRET_DATABASE_PASSWORD: 'x' };

  it('is reported rather than thrown, with the check to perform', async () => {
    const result = await runCli(['status', '--json'], { env: { ...env, ...unreachable }, cwd });
    const data = payload<StatusPayload>(result.stdout);

    expect(data.status).toBe('unavailable');
    const postgres = find(data.components, 'postgres');
    expect(postgres?.status).toBe('unavailable');
    expect(postgres?.detail).toContain('Cannot reach PostgreSQL');
    expect(postgres?.remediation).toContain('FERRET_DATABASE_HOST');
  });

  it('exits 4 — a dependency problem, not a configuration one', async () => {
    const result = await runCli(['status', '--json'], { env: { ...env, ...unreachable }, cwd });
    expect(result.code).toBe(ExitCode.DEPENDENCY);
  });

  it('still reports everything it could determine', async () => {
    // Health must not become all-or-nothing because one component is down.
    const data = payload<StatusPayload>(
      (await runCli(['status', '--json'], { env: { ...env, ...unreachable }, cwd })).stdout,
    );
    expect(find(data.components, 'node')?.status).toBe('ok');
    expect(find(data.components, 'configuration')?.status).toBe('ok');
    expect(find(data.components, 'database-configured')?.status).toBe('ok');
  });
});

describe('an optional dependency that is unavailable', () => {
  it('degrades the report without making Ferret unusable', async () => {
    // `git` is optional by decision: TECHNOLOGY-DECISIONS §5 selected the
    // installed binary, and its absence disables repository features rather
    // than Ferret. Forced here by pointing PATH at an empty directory.
    const emptyPath = mkdtempSync(join(tmpdir(), 'ferret-nopath-'));
    try {
      const result = await runCli(['status', '--json'], {
        env: { ...env, PATH: emptyPath, Path: emptyPath },
        cwd,
      });
      const data = payload<StatusPayload>(result.stdout);

      const git = find(data.components, 'git');
      expect(git?.status).toBe('degraded');
      expect(git?.required).toBe(false);
      expect(git?.remediation).toContain('PATH');

      // The absence of an optional dependency never makes the whole report
      // unavailable — only a required one can.
      expect(['degraded', 'unavailable']).toContain(data.status);
      const requiredFailures = data.components.filter(
        (component) => component.required && component.status === 'unavailable',
      );
      expect(requiredFailures.every((component) => component.name !== 'git')).toBe(true);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});

describe('a repository that oversteps its policy', () => {
  it('is reported as degraded, naming the keys that were refused', async () => {
    mkdirSync(join(cwd, '.ferret'), { recursive: true });
    writeFileSync(
      join(cwd, '.ferret', 'config.json'),
      JSON.stringify({ exclude: ['ok/**'], database: { host: 'attacker.example' }, logLevel: 'trace' }),
      'utf8',
    );

    const data = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);
    const policy = find(data.components, 'repository-policy');

    expect(policy?.status).toBe('degraded');
    expect(policy?.detail).toContain('database');
    expect(policy?.detail).toContain('logLevel');
    expect(policy?.remediation).toContain('may only set');
  });
});

describe('capabilities that do not exist yet', () => {
  it('reports them as undetermined rather than omitting them', async () => {
    // Governance §6: not-indexed must be representable. An operator reading a
    // clean bill of health should see that indexing was never checked, rather
    // than infer it from an absence.
    const data = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);

    // No database is configured here, so the index genuinely cannot be
    // assessed. It must say that, and say what to do about it — this component
    // used to be a hard-coded stub that told every operator "no index exists
    // yet" including those whose database held three hundred indexed files.
    const index = find(data.components, 'index-integrity');
    expect(index?.status).toBe('unknown');
    expect(index?.required).toBe(false);
    expect(index?.remediation).toContain('ferret init');
    expect(index?.detail).not.toContain('No index exists yet');

    expect(find(data.components, 'synchronization')?.status).toBe('unknown');
  });

  it('never lets an unimplemented capability read as healthy', async () => {
    const data = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);
    // `index-integrity` is no longer in this list: it is implemented, and with a
    // database holding a current index it reports `ok` — which is the whole
    // point of having replaced the stub.
    for (const name of ['synchronization']) {
      expect(find(data.components, name)?.status).not.toBe('ok');
    }
  });
});

describe('secret safety', () => {
  it('never prints the database password, in any command or output mode', async () => {
    const password = 'sup3r-s3cret-health';
    const withSecret = {
      ...env,
      FERRET_DATABASE_HOST: '127.0.0.1',
      FERRET_DATABASE_PORT: '1',
      FERRET_DATABASE_NAME: 'x',
      FERRET_DATABASE_USER: 'x',
      FERRET_DATABASE_PASSWORD: password,
    };

    const results = await Promise.all([
      runCli(['status', '--json', '--log-level', 'trace'], { env: withSecret, cwd }),
      runCli(['status', '--log-level', 'trace'], { env: withSecret, cwd }),
      runCli(['doctor', '--json', '--log-level', 'trace'], { env: withSecret, cwd }),
      runCli(['doctor', '--log-level', 'trace'], { env: withSecret, cwd }),
      runCli(['doctor', '--show-config', '--json'], { env: withSecret, cwd }),
    ]);

    for (const result of results) {
      expect(result.stdout).not.toContain(password);
      expect(result.stderr).not.toContain(password);
    }
  }, 120_000);

  it('redacts rather than omits when doctor is asked to show configuration', async () => {
    const withSecret = {
      ...env,
      FERRET_DATABASE_HOST: '127.0.0.1',
      FERRET_DATABASE_PORT: '1',
      FERRET_DATABASE_NAME: 'x',
      FERRET_DATABASE_USER: 'x',
      FERRET_DATABASE_PASSWORD: 'another-secret',
    };
    const result = await runCli(['doctor', '--show-config', '--json'], { env: withSecret, cwd });
    // Proof the field was seen and masked, not merely absent.
    expect(result.stdout).toContain('[redacted]');
    expect(result.stdout).not.toContain('another-secret');
  });
});

describe('contract', () => {
  it('keeps stdout as exactly one JSON document even at trace log level', async () => {
    for (const argv of [
      ['status', '--json', '--log-level', 'trace'],
      ['doctor', '--json', '--log-level', 'trace'],
    ]) {
      const result = await runCli(argv, { env, cwd });
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    }
  }, 60_000);

  it('agrees between status and doctor about the verdict', async () => {
    // Two commands that disagreed about whether Ferret was healthy would be
    // worse than either alone.
    const status = payload<StatusPayload>((await runCli(['status', '--json'], { env, cwd })).stdout);
    const doctor = payload<DoctorPayload>((await runCli(['doctor', '--json'], { env, cwd })).stdout);

    expect(doctor.status).toBe(status.status);
    expect(doctor.components.map((component) => component.name)).toStrictEqual(
      status.components.map((component) => component.name),
    );
  });

  it('renders a readable report without --json', async () => {
    const result = await runCli(['status'], { env, cwd });
    expect(result.stdout).toContain('ferret 0.1.0');
    expect(result.stdout).toContain('database-configured');
    expect(result.stdout).toContain('Ferret is not usable');
  });

  it('lists both commands in help, no longer marked planned', async () => {
    const help = await runCli(['--help'], { env, cwd });
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('doctor');
    expect(help.stdout).not.toMatch(/status.*\(planned/);
    expect(help.stdout).not.toMatch(/doctor.*\(planned/);
  });
});

describe('performance', () => {
  // An AI client calls `status` to decide whether Ferret can answer, and
  // Governance §3 has it spawn Ferret per session. A diagnostic that is slow
  // when everything is broken is a diagnostic nobody runs. The budget is a
  // regression ceiling and includes full process startup.
  const BUDGET_MS = 15_000;

  it(`answers within ${String(BUDGET_MS)} ms even when the database is unreachable`, async () => {
    const started = performance.now();
    const result = await runCli(['status', '--json'], {
      env: {
        ...env,
        FERRET_DATABASE_HOST: '127.0.0.1',
        FERRET_DATABASE_PORT: '1',
        FERRET_DATABASE_NAME: 'x',
        FERRET_DATABASE_USER: 'x',
        FERRET_DATABASE_PASSWORD: 'x',
      },
      cwd,
    });
    const elapsed = performance.now() - started;

    expect(result.code).toBe(ExitCode.DEPENDENCY);
    expect(elapsed).toBeLessThan(BUDGET_MS);
    // And the report says how long the probing itself took, so a slow start can
    // be attributed rather than guessed at.
    expect(payload<StatusPayload>(result.stdout).durationMs).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('read-only guarantee', () => {
  it('creates no configuration file merely by being run', async () => {
    // EPIC-004: health checks must not mutate. A `status` that wrote a config
    // file would change the thing it was reporting on.
    await runCli(['status', '--json'], { env, cwd });
    await runCli(['doctor', '--json'], { env, cwd });

    const { readdirSync } = await import('node:fs');
    expect(readdirSync(home)).toStrictEqual([]);
    expect(readdirSync(cwd)).toStrictEqual([]);
  });

  it('does not need PATH entries beyond what the process already has', async () => {
    // Guards against a future check shelling out to something undeclared.
    const result = await runCli(['status', '--json'], {
      env: { ...env, PATH: process.env['PATH'] ?? '', SOMETHING_UNRELATED: `a${delimiter}b` },
      cwd,
    });
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
  });
});
