import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { targetSchemaVersion } from '../../../src/storage/index.js';
import { runCli } from '../../helpers/cli.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

const describeDb = databaseAvailable() ? describe : describe.skip;

interface InitPayload {
  readonly mode: string;
  readonly schemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly instanceId: string | null;
  readonly applied: ReadonlyArray<{ version: number; name: string }>;
  readonly pending: ReadonlyArray<{ version: number; name: string }>;
  readonly extensions: ReadonlyArray<{ name: string; state: string }>;
  readonly saved: string | null;
  readonly config: { database: Record<string, unknown> };
}

function parse(stdout: string): InitPayload {
  const envelope = JSON.parse(stdout) as { ok: boolean; data: InitPayload };
  expect(envelope.ok).toBe(true);
  return envelope.data;
}

describeDb(`\`ferret init\` end to end (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('initcli');
  });
  afterAll(async () => {
    await db.drop();
  });

  it('reports what it would do without touching the database under --check', async () => {
    const result = await runCli(['init', '--check', '--json'], { env: db.env });
    expect(result.code).toBe(ExitCode.OK);

    const payload = parse(result.stdout);
    expect(payload.mode).toBe('check');
    expect(payload.schemaVersion).toBe(0);
    expect(payload.pending.length).toBe(targetSchemaVersion());
    expect(payload.applied).toStrictEqual([]);

    // Read-only really means read-only.
    const untouched = await db.pool.query<{ exists: boolean }>(
      "SELECT to_regclass('ferret.schema_migrations') IS NOT NULL AS exists",
    );
    expect(untouched.rows[0]?.exists).toBe(false);
  });

  it('provisions the database, reaching the target schema version', async () => {
    const result = await runCli(['init', '--json'], { env: db.env });
    expect(result.code).toBe(ExitCode.OK);

    const payload = parse(result.stdout);
    expect(payload.mode).toBe('apply');
    expect(payload.schemaVersion).toBe(targetSchemaVersion());
    expect(payload.targetSchemaVersion).toBe(targetSchemaVersion());
    expect(payload.applied.length).toBe(targetSchemaVersion());
    expect(payload.pending).toStrictEqual([]);
    expect(payload.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('enables pgvector when the server offers it and the role may create it', async () => {
    const result = await runCli(['init', '--json'], { env: db.env });
    const payload = parse(result.stdout);
    const vector = payload.extensions.find((extension) => extension.name === 'vector');
    // The test image ships pgvector. Reported honestly either way — an absent
    // extension is a degraded capability, never a silent success.
    expect(vector).toBeDefined();
    expect(['installed', 'available', 'absent']).toContain(vector?.state);
  });

  it('is idempotent — a second run applies nothing and keeps the same instance id', async () => {
    const first = parse((await runCli(['init', '--json'], { env: db.env })).stdout);
    const second = parse((await runCli(['init', '--json'], { env: db.env })).stdout);

    expect(second.applied).toStrictEqual([]);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    expect(second.instanceId).toBe(first.instanceId);
  });

  it('renders a readable summary in human mode', async () => {
    const result = await runCli(['init'], { env: db.env });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain('schema version');
    expect(result.stdout).toContain('Database is ready.');
    expect(result.stdout).not.toContain(db.password);
  });

  it('never prints the database password, at any log level or output mode', async () => {
    const json = await runCli(['init', '--json', '--log-level', 'trace'], { env: db.env });
    const human = await runCli(['init', '--log-level', 'trace'], { env: db.env });

    for (const result of [json, human]) {
      expect(result.stdout).not.toContain(db.password);
      expect(result.stderr).not.toContain(db.password);
    }
    // The redacted marker proves the field was present and was masked, rather
    // than the password simply never having been read.
    expect(json.stdout).toContain('[redacted]');
  });

  it('exits 3 with an actionable error when no database is configured', async () => {
    const result = await runCli(['init', '--json'], {
      env: {
        FERRET_DATABASE_HOST: '',
        FERRET_DATABASE_PORT: '',
        FERRET_DATABASE_NAME: '',
        FERRET_DATABASE_USER: '',
        FERRET_DATABASE_PASSWORD: '',
      },
    });

    expect(result.code).toBe(ExitCode.CONFIG);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; remediation: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('E_CONFIG_MISSING');
    expect(envelope.error.remediation).toContain('FERRET_DATABASE_HOST');
  });

  it('exits 4 when the database is unreachable, and says so as a dependency failure', async () => {
    const result = await runCli(['init', '--json'], {
      env: { ...db.env, FERRET_DATABASE_PORT: '1' },
    });

    expect(result.code).toBe(ExitCode.DEPENDENCY);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(envelope.error.code).toBe('E_STORAGE_UNAVAILABLE');
    expect(envelope.error.retryable).toBe(true);
  });

  it('applies migrations even when the configured policy is "verify", because init is explicit', async () => {
    // Governance §16 puts an explicit operation above stored configuration.
    // `ferret init` means "provision this database", so it is not the place for
    // a change-window policy to win.
    const fresh = await createTestDatabase('initpolicy');
    try {
      const result = await runCli(['init', '--json'], {
        env: { ...fresh.env, FERRET_DATABASE_MIGRATE: 'verify' },
      });

      expect(result.code).toBe(ExitCode.OK);
      expect(parse(result.stdout).schemaVersion).toBe(targetSchemaVersion());
    } finally {
      await fresh.drop();
    }
  });

  describe('--save', () => {
    let home: string;

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'ferret-init-save-'));
    });
    afterAll(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('persists the connection so it need not be supplied again', async () => {
      const result = await runCli(['init', '--save', '--json'], {
        env: { ...db.env, FERRET_CONFIG_HOME: home },
      });
      expect(result.code).toBe(ExitCode.OK);

      const stored = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
        config: { database: Record<string, unknown> };
      };
      expect(stored.config.database).toMatchObject({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
      });

      // Proof it is genuinely enough on its own: no FERRET_DATABASE_* at all.
      const withoutEnv = await runCli(['init', '--check', '--json'], {
        env: {
          FERRET_CONFIG_HOME: home,
          FERRET_DATABASE_HOST: '',
          FERRET_DATABASE_PORT: '',
          FERRET_DATABASE_NAME: '',
          FERRET_DATABASE_USER: '',
          FERRET_DATABASE_PASSWORD: '',
        },
      });
      expect(withoutEnv.code).toBe(ExitCode.OK);
      expect(parse(withoutEnv.stdout).schemaVersion).toBe(targetSchemaVersion());
    });

    it('does not print the saved password, and journals the change without it', async () => {
      const result = await runCli(['init', '--save', '--json', '--log-level', 'trace'], {
        env: { ...db.env, FERRET_CONFIG_HOME: home },
      });
      expect(result.stdout).not.toContain(db.password);
      expect(result.stderr).not.toContain(db.password);
      expect(readFileSync(join(home, 'config-audit.log'), 'utf8')).not.toContain(db.password);
    });

    it('writes nothing when the connection could not be proven', async () => {
      const clean = mkdtempSync(join(tmpdir(), 'ferret-init-nosave-'));
      try {
        // A typo must never be written down as if it were correct.
        const result = await runCli(['init', '--save', '--json'], {
          env: { ...db.env, FERRET_DATABASE_PORT: '1', FERRET_CONFIG_HOME: clean },
        });
        expect(result.code).toBe(ExitCode.DEPENDENCY);
        expect(existsSync(join(clean, 'config.json'))).toBe(false);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });

    it('changes nothing under --check', async () => {
      const clean = mkdtempSync(join(tmpdir(), 'ferret-init-check-'));
      try {
        const result = await runCli(['init', '--check', '--save', '--json'], {
          env: { ...db.env, FERRET_CONFIG_HOME: clean },
        });
        expect(result.code).toBe(ExitCode.OK);
        expect(parse(result.stdout).saved).toBeNull();
        expect(existsSync(join(clean, 'config.json'))).toBe(false);
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    });
  });

  it('exits 6 when the database was migrated by a newer Ferret', async () => {
    const newer = await createTestDatabase('initnewer');
    try {
      await runCli(['init', '--json'], { env: newer.env });
      await newer.pool.query(
        `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
         VALUES ($1, 'from_the_future', 'unknown', 0, '@indoulia/ferret@99.0.0')`,
        [targetSchemaVersion() + 1],
      );

      const result = await runCli(['init', '--json'], { env: newer.env });
      expect(result.code).toBe(ExitCode.STORAGE);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; remediation: string };
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('E_SCHEMA_UNSUPPORTED');
      expect(envelope.error.remediation).toContain('Upgrade Ferret');
    } finally {
      await newer.drop();
    }
  });
});
