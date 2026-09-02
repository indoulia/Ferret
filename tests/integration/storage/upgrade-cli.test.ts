import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { createNullLogger } from '../../../src/index.js';
import { MigrationPolicy, allMigrations, migrate, readSchemaStatus } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * `ferret upgrade` end to end — EPIC-106.
 *
 * `validation/EPIC-010-VALIDATION.md` states the gap: *"No user-facing upgrade
 * experience. `ferret init` applies migrations and `ferret doctor` reports
 * state; nothing guides an upgrade."*
 *
 * Through the CLI, because the whole Epic is about what a user *sees* — and
 * against a database migrated to an earlier version, because a plan naming zero
 * pending migrations would prove nothing.
 */

const describeCli = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

interface Envelope {
  readonly ok: boolean;
  readonly data: {
    readonly outcome: string;
    readonly status: {
      readonly initialized: boolean;
      readonly schemaVersion: number;
      readonly targetVersion: number;
      readonly pending: readonly { readonly version: number; readonly name: string }[];
      readonly drift: readonly { readonly version: number }[];
      readonly failures: readonly { readonly version: number; readonly errorCode?: string }[];
      readonly unknown: readonly number[];
    };
    readonly applied: readonly { readonly version: number; readonly name: string }[];
    readonly remediation?: string;
  };
}

/** A database migrated only part of the way, so an upgrade has work to do. */
async function partial(label: string, upTo: number): Promise<TestDatabase> {
  const db = await createTestDatabase(label);
  const subset = allMigrations().filter((one) => one.version <= upTo);
  await migrate(db.pool, { policy: MigrationPolicy.AUTO, logger, migrations: subset });
  return db;
}

async function upgrade(
  db: TestDatabase,
  args: readonly string[] = [],
): Promise<{ code: number; body: Envelope['data']; text: string }> {
  const result = await runCli(['upgrade', '--json', ...args], { env: db.env });
  return {
    code: result.code,
    body: (JSON.parse(result.stdout) as Envelope).data,
    text: result.stdout + result.stderr,
  };
}

let current: TestDatabase;

describeCli(`ferret upgrade (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    current = await createTestDatabase('upgrade-current');
    await migrate(current.pool, { policy: MigrationPolicy.AUTO, logger });
  }, 180_000);

  afterAll(async () => {
    await current.drop();
  });

  describe('the plan comes first — AC-1, AC-2, AC-3', () => {
    it('names the versions and every pending migration, and applies nothing', async () => {
      const db = await partial('upgrade-plan', 4);
      try {
        const before = await readSchemaStatus(db.pool);
        const { code, body } = await upgrade(db);

        expect(code).toBe(ExitCode.OK);
        expect(body.outcome).toBe('planned');
        expect(body.status.schemaVersion).toBe(4);
        expect(body.status.targetVersion).toBeGreaterThan(4);
        // AC-2 — by version *and* name. An operator who cannot see what is
        // about to run has not been offered an upgrade.
        expect(body.status.pending.length).toBeGreaterThan(0);
        for (const one of body.status.pending) {
          expect(one.name.length).toBeGreaterThan(0);
        }

        // AC-3 — nothing applied.
        expect(body.applied).toStrictEqual([]);
        expect((await readSchemaStatus(db.pool)).schemaVersion).toBe(before.schemaVersion);
      } finally {
        await db.drop();
      }
    }, 180_000);

    it('names the pg_dump backup command in the human rendering — AC-10', async () => {
      const db = await partial('upgrade-backup', 4);
      try {
        // §8.6 — the operator reading a plan is the one who still has time to
        // take a backup, so the line belongs in the plan and not after it.
        const result = await runCli(['upgrade'], { env: db.env });

        expect(result.stdout).toContain('pg_dump');
        expect(result.stdout).toContain('--schema=ferret');
        expect(result.stdout).toContain('Re-run with --yes');
      } finally {
        await db.drop();
      }
    }, 180_000);
  });

  describe('the apply — AC-4, AC-12, AC-13', () => {
    it('applies the pending migrations and reports them', async () => {
      const db = await partial('upgrade-apply', 4);
      try {
        const { code, body } = await upgrade(db, ['--yes']);

        expect(code).toBe(ExitCode.OK);
        expect(body.outcome).toBe('applied');
        expect(body.applied.length).toBeGreaterThan(0);

        const after = await readSchemaStatus(db.pool);
        expect(after.schemaVersion).toBe(after.targetVersion);
        expect(after.pending).toStrictEqual([]);
      } finally {
        await db.drop();
      }
    }, 180_000);

    it('records the run in the migrator s own bookkeeping — AC-12', async () => {
      // §8.2 — the apply goes through EPIC-002's `migrate`, so the advisory
      // lock, the ordering, the checksum verification and the journal all
      // apply. The observable proof is that the migration rows this command
      // applied are indistinguishable from ones `init` applied.
      const db = await partial('upgrade-journal', 4);
      try {
        await upgrade(db, ['--yes']);

        const applied = await db.pool.query<{ version: number; checksum: string; applied_by: string }>(
          `SELECT version, checksum, applied_by FROM ferret.schema_migrations ORDER BY version`,
        );

        // Every row has a checksum, which only the migrator writes.
        expect(applied.rows.length).toBeGreaterThan(4);
        for (const row of applied.rows) {
          expect(row.checksum.length).toBeGreaterThan(0);
        }
        // And a second `readSchemaStatus` sees no drift, which is the checksum
        // verification agreeing with what was written.
        expect((await readSchemaStatus(db.pool)).drift).toStrictEqual([]);
      } finally {
        await db.drop();
      }
    }, 180_000);

    it('applies nothing the second time — AC-13', async () => {
      const db = await partial('upgrade-twice', 4);
      try {
        const first = await upgrade(db, ['--yes']);
        const second = await upgrade(db, ['--yes']);

        expect(first.body.applied.length).toBeGreaterThan(0);
        expect(second.body.outcome).toBe('current');
        expect(second.body.applied).toStrictEqual([]);
        expect(second.code).toBe(ExitCode.OK);
      } finally {
        await db.drop();
      }
    }, 240_000);
  });

  describe('already current is a success — AC-5', () => {
    it('says so and exits 0', async () => {
      // §8.7 — a command that exited non-zero because there was nothing to do
      // would make an idempotent upgrade unsafe to run from a script, which is
      // exactly where an upgrade belongs.
      const { code, body } = await upgrade(current);

      expect(code).toBe(ExitCode.OK);
      expect(body.outcome).toBe('current');
      expect(body.status.pending).toStrictEqual([]);
    }, 120_000);

    it('says so in the human rendering too', async () => {
      const result = await runCli(['upgrade'], { env: current.env });

      expect(result.stdout).toContain('Already current');
    }, 120_000);
  });

  describe('a database from a newer Ferret — AC-6, AC-7', () => {
    it('is refused, names the export path, and applies nothing', async () => {
      const db = await createTestDatabase('upgrade-newer');
      try {
        await migrate(db.pool, { policy: MigrationPolicy.AUTO, logger });
        // A version this build does not ship, recorded as applied — which is
        // exactly the state a newer Ferret leaves behind.
        await db.pool.query(
          `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
           VALUES (9999, 'from_a_newer_ferret', 'deadbeef', 1, 'ferret/9.9.9')`,
        );

        const { code, body, text } = await upgrade(db, ['--yes']);

        expect(body.outcome).toBe('newer-database');
        expect(body.status.unknown).toContain(9999);
        // AC-7 — refused *before* anything was applied.
        expect(body.applied).toStrictEqual([]);
        // The sentence after the refusal, which is what this Epic adds: the
        // migrator already refused; nothing told the operator the way out.
        expect(body.remediation).toContain('ferret export');
        expect(body.remediation).toContain('ferret import');
        expect(body.remediation).toContain('no downgrade migration');
        // `STORAGE`: reachable database, unusable schema.
        expect(code).toBe(ExitCode.STORAGE);
        expect(text).not.toContain(db.password);
      } finally {
        await db.drop();
      }
    }, 180_000);
  });

  describe('drift and a prior failure are shown — AC-8, AC-9', () => {
    it('reports drift rather than migrating on top of it', async () => {
      const db = await partial('upgrade-drift', 4);
      try {
        // A recorded checksum that no longer matches the shipped file: the
        // database and the build disagree about what already ran.
        await db.pool.query(
          `UPDATE ferret.schema_migrations SET checksum = 'not-the-shipped-one' WHERE version = 1`,
        );

        const { body, code } = await upgrade(db);

        expect(body.outcome).toBe('drifted');
        expect(body.status.drift.map((one) => one.version)).toContain(1);
        expect(body.remediation).toContain('disagree about what');
        // An applied migration is never edited, so the first remedy is to put
        // the file back — not to force the migration through.
        expect(body.remediation).toContain('never edited');
        // Nothing applied, and `STORAGE`: reachable database, unusable schema.
        expect(body.applied).toStrictEqual([]);
        expect(code).toBe(ExitCode.STORAGE);

        // And the human rendering says the same, for the operator who did not
        // pass `--json`.
        const human = await runCli(['upgrade'], { env: db.env });
        expect(human.stdout).toContain('disagree about what');
      } finally {
        await db.drop();
      }
    }, 180_000);

    it('reports a previous failure, because it changes what to do next', async () => {
      const db = await partial('upgrade-failed', 4);
      try {
        await db.pool.query(
          `INSERT INTO ferret.schema_migration_failures
             (version, name, failed_at, attempted_by, error_code, error_message)
           VALUES (5, 'a_failed_attempt', now(), 'ferret/test', 'E_MIGRATION_FAILED', 'disk full')`,
        );

        const { body, text } = await upgrade(db);

        // §8.5 — a plan that omitted this would say "N migrations pending"
        // while withholding "and the last attempt failed".
        expect(body.status.failures.map((one) => one.version)).toContain(5);
        expect(text).toContain('E_MIGRATION_FAILED');
        // The code, not the message: a message can carry a connection detail.
        expect(text).not.toContain('disk full');
      } finally {
        await db.drop();
      }
    }, 180_000);
  });

  describe('an unprovisioned database is not an upgrade — AC-14', () => {
    it('points at ferret init rather than reporting zero pending', async () => {
      const db = await createTestDatabase('upgrade-empty');
      try {
        const { body, code } = await upgrade(db);

        expect(body.outcome).toBe('not-initialized');
        expect(body.remediation).toContain('ferret init');
        // Not a failure: an empty database is a fact, not a fault.
        expect(code).toBe(ExitCode.OK);
      } finally {
        await db.drop();
      }
    }, 120_000);
  });
});
