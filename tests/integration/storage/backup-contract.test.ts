import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind } from '../../../src/index.js';
import {
  EXPORT_EXCLUSIONS,
  EXPORT_TABLES,
  EntityStore,
  ExportService,
  ImportService,
  readDocument,
  type ExportManifest,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * **F-45 / D2 — the backup contract, stated rather than implied.**
 *
 * Two decisions, both implemented here and neither invented: vectors are not
 * backup payload, and a restored installation gets a new identity with the
 * source kept as provenance.
 *
 * What made F-45 a finding was never the omissions — EPIC-089 §3's scope is a
 * closed list and §8.1 assigns full fidelity to `pg_dump`. It was that nothing
 * said so. `EXPORT_TABLES` declared what travels and nothing declared what does
 * not, so a restore dropped every vector and minted a fresh identity in
 * silence, and the operator learned it from neither the manifest nor the
 * import report.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;

/**
 * Provisions a database the way an operator does.
 *
 * `ferret init` rather than `migrate`, and the difference is the point: F-16's
 * fix put extension provisioning in the storage provider, so migrations 0008
 * and 0013 create `ferret.embedding` only when pgvector is already installed.
 * A test that called `migrate` alone would have no embedding table and would
 * assert that vectors are excluded from a schema that cannot hold one.
 */
async function provision(db: TestDatabase): Promise<void> {
  const result = await runCli(['init', '--json'], { env: db.env });
  expect(result.code, result.stderr).toBe(0);
}

let source: TestDatabase;
let from: FerretDatabase;
let exporter: ExportService;
let sourceInstanceId: string;
let document: string;

function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function exportToString(): Promise<string> {
  const lines: string[] = [];
  await exporter.exportDocument((line) => void lines.push(line));
  return `${lines.join('\n')}\n`;
}

function manifestOf(text: string): ExportManifest {
  return JSON.parse(text.split('\n')[0] ?? '{}') as ExportManifest;
}

describeDb(`backup contract (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    source = await createTestDatabase('contract-src');
    await provision(source);
    from = drizzle(source.pool);
    exporter = new ExportService(from);

    const entities = new EntityStore(from);
    const repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/contract' },
        attributes: { path: '/contract' },
      })
    ).entity;
    const file = await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: 'src/a.ts', scope: repository.id },
      attributes: { path: 'src/a.ts' },
    });

    // A real vector, so "vectors are excluded" is measured against a table that
    // has something in it. An empty table would make the assertion vacuous —
    // which is how F-45 stayed open: nothing ships an embedding provider, so no
    // test ever had a vector to lose.
    await source.pool.query(
      `INSERT INTO ferret.embedding
         (id, subject_id, subject_kind, model_id, model_version, dimensions, metric,
          vector, source_content_hash)
       VALUES (gen_random_uuid(), $1, 'entity', 'test-model', '1', 3, 'cosine',
               '[0.1,0.2,0.3]', 'h:contract')`,
      [file.entity.id],
    );

    const instance = await source.pool.query<{ instance_id: string }>(
      'SELECT instance_id FROM ferret.instance LIMIT 1',
    );
    sourceInstanceId = instance.rows[0]?.instance_id ?? '';
    expect(sourceInstanceId).not.toBe('');

    document = await exportToString();
  }, 120_000);

  afterAll(async () => {
    await source.drop();
  });

  describe('what the document does not carry, it says it does not carry', () => {
    it('accounts for every table in the live schema — exported or declared', async () => {
      // **The control that stops F-45 recurring.** `embedding` was not omitted
      // by decision; it was omitted by nobody noticing when migration 0008
      // added it. So the schema is the authority, and a table that is neither
      // exported nor declared fails here rather than going missing from a
      // restore three releases later.
      const tables = await source.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'ferret' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );

      const accounted = new Set([
        ...EXPORT_TABLES.map((spec) => spec.table),
        ...EXPORT_EXCLUSIONS.map((entry) => entry.table),
      ]);
      const unaccounted = tables.rows.map((row) => row.table_name).filter((name) => !accounted.has(name));

      expect(
        unaccounted,
        'a table is neither exported nor declared excluded — add it to EXPORT_TABLES or EXPORT_EXCLUSIONS',
      ).toStrictEqual([]);

      // And the reverse, so the declaration cannot name a table that is gone.
      const live = new Set(tables.rows.map((row) => row.table_name));
      const stale = EXPORT_EXCLUSIONS.map((entry) => entry.table).filter((name) => !live.has(name));
      expect(stale, 'EXPORT_EXCLUSIONS names a table the schema does not have').toStrictEqual([]);
    });

    it('names the excluded tables in the manifest, with a recovery for each', () => {
      const manifest = manifestOf(document);
      const excluded = manifest.excluded ?? [];

      expect(excluded.map((entry) => entry.table)).toContain('embedding');
      expect(excluded.map((entry) => entry.table)).toContain('instance');
      // Every declaration says what to do, never just what is missing. "Not
      // applicable" is an answer; silence is not.
      for (const entry of excluded) {
        expect(entry.reason.length, `${entry.table} has no reason`).toBeGreaterThan(0);
        expect(entry.recovery.length, `${entry.table} has no recovery`).toBeGreaterThan(0);
      }
    });

    it('says vectors must be regenerated, and does not claim to carry them', () => {
      const embedding = (manifestOf(document).excluded ?? []).find((entry) => entry.table === 'embedding');

      expect(embedding?.recovery).toMatch(/regenerat/i);
      // The honest half: there is no provider, so there is nothing to
      // regenerate *yet*, and the document says that rather than implying a
      // command exists.
      expect(embedding?.recovery).toMatch(/no embedding provider/i);
      expect(embedding?.recovery).toMatch(/never fabricated/i);
    });
  });

  describe('vectors are not backup payload', () => {
    it('carries no embedding row, even though the table has one', async () => {
      const count = await source.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM ferret.embedding');
      expect(count.rows[0]?.n, 'the fixture has no vector, so this proves nothing').toBe('1');

      const checked = readDocument(document, digestOf);
      expect(checked.rows.some((row) => row.table === 'embedding')).toBe(false);
      expect(checked.manifest.tables).not.toContain('embedding');
    });

    it('does not fabricate a vector on restore', async () => {
      const target = await createTestDatabase('contract-vectors');
      try {
        await provision(target);
        const checked = readDocument(document, digestOf);
        await new ImportService(drizzle(target.pool)).importDocument(checked, { apply: true });

        // Absent, not zero-filled and not invented. A fabricated vector would
        // be worse than none: semantic retrieval would answer confidently from
        // numbers that mean nothing.
        const count = await target.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM ferret.embedding');
        expect(count.rows[0]?.n).toBe('0');
      } finally {
        await target.drop();
      }
    }, 180_000);
  });

  describe('a restored installation gets its own identity', () => {
    it('keeps the target identity and records the source as provenance', async () => {
      const target = await createTestDatabase('contract-identity');
      try {
        await provision(target);
        const before = await target.pool.query<{ instance_id: string }>(
          'SELECT instance_id FROM ferret.instance LIMIT 1',
        );
        const targetInstanceId = before.rows[0]?.instance_id ?? '';

        expect(targetInstanceId).not.toBe('');
        expect(targetInstanceId).not.toBe(sourceInstanceId);

        const checked = readDocument(document, digestOf);
        const report = await new ImportService(drizzle(target.pool)).importDocument(checked, { apply: true });

        // The identity is not adopted from the document.
        const after = await target.pool.query<{ instance_id: string }>(
          'SELECT instance_id FROM ferret.instance LIMIT 1',
        );
        expect(after.rows[0]?.instance_id).toBe(targetInstanceId);
        expect(after.rows).toHaveLength(1);

        // And the source is traceable rather than lost.
        const provenance = await target.pool.query<{
          instance_id: string;
          source_instance_id: string | null;
          document_digest: string;
        }>('SELECT instance_id, source_instance_id, document_digest FROM ferret.instance_restore');
        expect(provenance.rows).toHaveLength(1);
        expect(provenance.rows[0]?.instance_id).toBe(targetInstanceId);
        expect(provenance.rows[0]?.source_instance_id).toBe(sourceInstanceId);
        expect(provenance.rows[0]?.document_digest).toBe(checked.trailer.digest);

        expect(report.provenance.recorded).toBe(true);
        expect(report.provenance.instanceId).toBe(targetInstanceId);
        expect(report.provenance.sourceInstanceId).toBe(sourceInstanceId);
      } finally {
        await target.drop();
      }
    }, 180_000);

    it('gives two independent restores of one document two identities', async () => {
      // The explicit prohibition: one backup restored twice must not produce
      // two installations answering to one identity.
      const first = await createTestDatabase('contract-twin-a');
      const second = await createTestDatabase('contract-twin-b');
      try {
        await provision(first);
        await provision(second);
        const checked = readDocument(document, digestOf);
        await new ImportService(drizzle(first.pool)).importDocument(checked, { apply: true });
        await new ImportService(drizzle(second.pool)).importDocument(checked, { apply: true });

        const a = await first.pool.query<{ instance_id: string }>('SELECT instance_id FROM ferret.instance');
        const b = await second.pool.query<{ instance_id: string }>('SELECT instance_id FROM ferret.instance');

        expect(a.rows[0]?.instance_id).not.toBe(b.rows[0]?.instance_id);
        expect(a.rows[0]?.instance_id).not.toBe(sourceInstanceId);
        expect(b.rows[0]?.instance_id).not.toBe(sourceInstanceId);

        // Both trace back to the same source, which is the point of provenance.
        for (const pool of [first.pool, second.pool]) {
          const row = await pool.query<{ source_instance_id: string | null }>(
            'SELECT source_instance_id FROM ferret.instance_restore',
          );
          expect(row.rows[0]?.source_instance_id).toBe(sourceInstanceId);
        }
      } finally {
        await first.drop();
        await second.drop();
      }
    }, 240_000);

    it('appends a second restore rather than overwriting the first', async () => {
      const target = await createTestDatabase('contract-append');
      try {
        await provision(target);
        const service = new ImportService(drizzle(target.pool));
        const checked = readDocument(document, digestOf);
        await service.importDocument(checked, { apply: true });
        await service.importDocument(checked, { apply: true });

        // Governance §6 — provenance is append-only. Columns on
        // `ferret.instance` would have recorded only the latest import and
        // erased the one before it, which is the rewrite the rule forbids.
        const rows = await target.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM ferret.instance_restore',
        );
        expect(rows.rows[0]?.n).toBe('2');
      } finally {
        await target.drop();
      }
    }, 180_000);

    it('writes no provenance for a plan, and says why', async () => {
      const target = await createTestDatabase('contract-plan');
      try {
        await provision(target);
        const checked = readDocument(document, digestOf);
        const report = await new ImportService(drizzle(target.pool)).importDocument(checked, { apply: false });

        expect(report.provenance.recorded).toBe(false);
        expect(report.provenance.note).toBeDefined();
        const rows = await target.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM ferret.instance_restore',
        );
        expect(rows.rows[0]?.n).toBe('0');
      } finally {
        await target.drop();
      }
    }, 180_000);
  });

  describe('a document written before the declaration', () => {
    it('is reported as not saying, rather than as excluding nothing', async () => {
      // A pre-D2 manifest, rebuilt by removing the two fields it did not have.
      // The digest covers the rows only, so the trailer still verifies.
      const lines = document.trim().split('\n');
      const old = { ...manifestOf(document) } as Record<string, unknown>;
      delete old['excluded'];
      delete old['sourceInstanceId'];
      const legacy = [JSON.stringify(old), ...lines.slice(1)].join('\n');

      const target = await createTestDatabase('contract-legacy');
      try {
        await provision(target);
        const checked = readDocument(`${legacy}\n`, digestOf);
        const report = await new ImportService(drizzle(target.pool)).importDocument(checked, { apply: true });

        // Not `[]`. "This document does not say what it omits" and "this
        // document omits nothing" are different claims, and only the first is
        // true — vectors were absent from that format too.
        expect(report.excluded).toBeUndefined();
        expect(report.provenance.sourceInstanceId).toBeUndefined();
        // Still recorded, so the restore is dated and digest-identified even
        // when the source cannot be named.
        expect(report.provenance.recorded).toBe(true);
        expect(report.provenance.note).toMatch(/predates/i);

        const rows = await target.pool.query<{ source_instance_id: string | null }>(
          'SELECT source_instance_id FROM ferret.instance_restore',
        );
        expect(rows.rows[0]?.source_instance_id).toBeNull();
      } finally {
        await target.drop();
      }
    }, 180_000);
  });
});
