import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { createNullLogger } from '../../../src/index.js';
import { migrate, targetSchemaVersion } from '../../../src/storage/index.js';
import { runCli } from '../../helpers/cli.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Health against a real PostgreSQL.
 *
 * The states an operator actually hits — a schema that is behind, credentials
 * that are wrong, a database from a newer Ferret — and the classification each
 * must receive. Nothing is mocked: a mocked "database is down" proves only that
 * the mock works.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

interface Component {
  readonly name: string;
  readonly status: string;
  readonly required: boolean;
  readonly detail?: string;
  readonly remediation?: string;
}

interface StatusPayload {
  readonly status: string;
  readonly summary: string;
  readonly components: Component[];
}

interface DoctorPayload extends StatusPayload {
  readonly diagnoses: { id: string; severity: string; finding: string; remediation: string }[];
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

describeDb(`health against real PostgreSQL (${databaseAvailable() ? 'available' : SKIP_REASON})`, () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ferret-health-db-'));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('a database that has never been initialized', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('healthfresh');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('reports the pending migration as degraded, not as a failure', async () => {
      // Ferret can still start and answer; it simply is not current. Calling
      // this unavailable would push an operator toward drastic remedies.
      const result = await runCli(['status', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<StatusPayload>(result.stdout);

      const schema = find(data.components, 'postgres-schema');
      expect(schema?.status).toBe('degraded');
      expect(schema?.detail).toContain('pending');
      expect(schema?.remediation).toContain('ferret init');
      expect(find(data.components, 'postgres')?.status).toBe('ok');
    });

    it('exits 0, because a database that is merely behind is still usable', async () => {
      const result = await runCli(['status', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      expect(result.code).toBe(ExitCode.OK);
    });

    it('exits non-zero under --strict, for callers that want anything less than perfect to fail', async () => {
      const result = await runCli(['status', '--strict', '--json'], {
        env: { ...db.env, FERRET_CONFIG_HOME: home },
      });
      expect(result.code).toBe(ExitCode.DEPENDENCY);
    });

    it('leaves the database untouched — checking health never migrates', async () => {
      // EPIC-004 requires health checks not to mutate. The migration policy is
      // forced to `off`, so this is enforced rather than intended.
      await runCli(['status', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      await runCli(['doctor', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });

      const applied = await db.pool.query<{ exists: boolean }>(
        "SELECT to_regclass('ferret.schema_migrations') IS NOT NULL AS exists",
      );
      expect(applied.rows[0]?.exists).toBe(false);
    });

    it('tells doctor to run `ferret init`', async () => {
      const result = await runCli(['doctor', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<DoctorPayload>(result.stdout);

      const schema = data.diagnoses.find((diagnosis) => diagnosis.id === 'postgres-schema:degraded');
      expect(schema?.severity).toBe('warning');
      expect(schema?.remediation).toContain('ferret init');
    });
  });

  describe('a fully provisioned database', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('healthready');
      // `ferret init`, not `migrate()`: pgvector is installed per *database*,
      // and a freshly created one does not inherit it from the template. Only
      // `init` provisions extensions, so only `init` produces the state a user
      // would call fully provisioned.
      const provisioned = await runCli(['init', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      expect(provisioned.code, provisioned.stderr).toBe(ExitCode.OK);
    });
    afterAll(async () => {
      await db.drop();
    });

    it('reports the database, its schema and pgvector as healthy', async () => {
      const result = await runCli(['status', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<StatusPayload>(result.stdout);

      expect(find(data.components, 'postgres')?.status).toBe('ok');
      expect(find(data.components, 'postgres-schema')?.status).toBe('ok');
      expect(find(data.components, 'postgres-schema')?.detail).toContain(
        `version ${String(targetSchemaVersion())}`,
      );
      // The test image ships pgvector; it stays optional regardless.
      // Installed by `ferret init`, and optional regardless: deterministic
      // retrieval does not need it, only semantic retrieval (EPIC-054) does.
      const vector = find(data.components, 'postgres-extension-vector');
      expect(vector?.required).toBe(false);
      expect(vector?.status).toBe('ok');
    });

    it('is degraded overall only because capabilities that do not exist yet are undetermined', async () => {
      const result = await runCli(['status', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<StatusPayload>(result.stdout);

      expect(result.code).toBe(ExitCode.OK);
      const notOk = data.components.filter((component) => component.status !== 'ok');
      // Everything still outstanding is optional and undetermined — an
      // unimplemented capability, honestly reported rather than hidden.
      for (const component of notOk) {
        expect(component.required).toBe(false);
        expect(component.status).toBe('unknown');
      }
    });

    it('gives doctor no errors and no warnings', async () => {
      const result = await runCli(['doctor', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<DoctorPayload>(result.stdout);

      expect(data.counts.error).toBe(0);
      expect(data.counts.warning).toBe(0);
      expect(data.diagnoses.every((diagnosis) => diagnosis.severity === 'unknown')).toBe(true);
    });
  });

  describe('wrong credentials', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('healthcreds');
      await migrate(db.pool, { logger });
    });
    afterAll(async () => {
      await db.drop();
    });

    it('is classified as a credential problem, not an outage', async () => {
      const result = await runCli(['doctor', '--json'], {
        env: { ...db.env, FERRET_DATABASE_PASSWORD: 'definitely-not-the-password', FERRET_CONFIG_HOME: home },
      });
      const data = payload<DoctorPayload>(result.stdout);

      const postgres = data.diagnoses.find((diagnosis) => diagnosis.id === 'postgres:unavailable');
      expect(postgres?.severity).toBe('error');
      expect(postgres?.finding).toContain('rejected the credentials');
      expect(postgres?.remediation).toContain('FERRET_DATABASE_USER');
      expect(result.code).toBe(ExitCode.DEPENDENCY);
    });

    it('does not echo the rejected password anywhere', async () => {
      const password = 'rejected-but-still-secret';
      const result = await runCli(['doctor', '--json', '--log-level', 'trace'], {
        env: { ...db.env, FERRET_DATABASE_PASSWORD: password, FERRET_CONFIG_HOME: home },
      });
      expect(result.stdout).not.toContain(password);
      expect(result.stderr).not.toContain(password);
    });
  });

  describe('a database from a newer Ferret', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('healthnewer');
      await migrate(db.pool, { logger });
      await db.pool.query(
        `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
         VALUES ($1, 'from_the_future', 'unknown', 0, '@indoulia/ferret@99.0.0')`,
        [targetSchemaVersion() + 1],
      );
    });
    afterAll(async () => {
      await db.drop();
    });

    it('is classified as a schema problem and exits 6, telling the user to upgrade', async () => {
      // A distinct code from "the database is down": the remedy is to upgrade
      // Ferret, not to restart PostgreSQL.
      const result = await runCli(['doctor', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      expect(result.code).toBe(ExitCode.STORAGE);

      const data = payload<DoctorPayload>(result.stdout);
      const schema = data.diagnoses.find((diagnosis) => diagnosis.id.startsWith('postgres-schema'));
      expect(schema?.severity).toBe('error');
      expect(schema?.remediation).toContain('Upgrade Ferret');
    });
  });

  describe('a migration that failed', () => {
    let db: TestDatabase;
    afterEach(async () => {
      await db.drop();
    });

    it('is surfaced with the recorded reason and a path back', async () => {
      db = await createTestDatabase('healthfailed');
      await migrate(db.pool, { logger });
      // Simulate the state EPIC-002 leaves behind when a migration fails: the
      // database is at its last good version, with the reason recorded.
      await db.pool.query(
        `INSERT INTO ferret.schema_migration_failures (version, name, attempted_by, error_code, error_message)
         VALUES (99, 'broken_migration', '@indoulia/ferret@0.1.0', '42601', 'syntax error at or near "SELCT"')`,
      );

      const result = await runCli(['doctor', '--json'], { env: { ...db.env, FERRET_CONFIG_HOME: home } });
      const data = payload<DoctorPayload>(result.stdout);

      const schema = data.diagnoses.find((diagnosis) => diagnosis.id === 'postgres-schema:unavailable');
      expect(schema?.finding).toContain('broken_migration');
      expect(schema?.finding).toContain('syntax error');
      expect(schema?.remediation).toContain('ferret init');
      expect(result.code).toBe(ExitCode.STORAGE);
    });
  });
});
