import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAuditEvents } from '../../../src/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * `ferret prune` end to end — EPIC-088 AC-1, AC-2, AC-12.
 *
 * Through the CLI because the two properties that matter most are the CLI's:
 * `--yes` is what stands between a plan and a deletion, and the audit event is
 * what an operator reads afterwards. A test against the service alone would
 * prove neither.
 *
 * No `index` run — an orphan blob is inserted directly, because what is being
 * tested is the confirmation and the trail, not how a blob comes to exist.
 */

const describeCli = databaseAvailable() ? describe : describe.skip;

let db: TestDatabase;
let home: string;
let env: NodeJS.ProcessEnv;

interface PruneEnvelope {
  readonly ok: boolean;
  readonly data: {
    readonly plan: {
      readonly counts: readonly {
        readonly target: string;
        readonly rows: number;
        readonly bytes?: number;
        readonly note?: string;
      }[];
      readonly applied: boolean;
    };
    readonly confirmed: boolean;
    readonly wouldDelete: boolean;
  };
}

async function prune(args: readonly string[]): Promise<PruneEnvelope['data']> {
  const result = await runCli(['prune', '--json', ...args], { env });
  expect(result.code, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as PruneEnvelope).data;
}

async function orphan(hash: string): Promise<void> {
  const handle = drizzle(db.pool);
  await handle.execute(
    sql`INSERT INTO ferret.content_blob (content_hash, byte_size, text_content)
        VALUES (${hash}, 12, 'orphan body')
        ON CONFLICT (content_hash) DO NOTHING`,
  );
}

async function blobCount(): Promise<number> {
  const handle = drizzle(db.pool);
  const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
    sql`SELECT count(*)::text AS n FROM ferret.content_blob`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

function journalPath(): string {
  return join(home, 'audit-events.ndjson');
}

describeCli(`ferret prune (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('prunecli');
    home = mkdtempSync(join(tmpdir(), 'ferret-prune-home-'));
    // The journal lands beside the configuration file, so pointing
    // `FERRET_CONFIG` at a temp directory is what isolates the trail.
    env = { ...db.env, FERRET_CONFIG: join(home, 'config.json') };
    writeFileSync(join(home, 'config.json'), '{}\n', 'utf8');

    const initialised = await runCli(['init', '--json'], { env });
    expect(initialised.code, initialised.stderr).toBe(0);
  }, 120_000);

  afterAll(async () => {
    rmSync(home, { recursive: true, force: true });
    await db.drop();
  });

  it('reports every target and deletes nothing when none is named — AC-1', async () => {
    await orphan('h:cli-unnamed');
    const before = await blobCount();

    const body = await prune([]);

    expect(body.plan.applied).toBe(false);
    expect(body.plan.counts.map((count) => count.target)).toStrictEqual([
      'blobs',
      'journals',
      'evidence',
    ]);
    expect(await blobCount()).toBe(before);
  });

  it('deletes nothing when a target is named without --yes — AC-2', async () => {
    const before = await blobCount();

    const body = await prune(['--blobs']);

    expect(body.confirmed).toBe(false);
    expect(body.wouldDelete).toBe(true);
    expect(await blobCount()).toBe(before);
  });

  it('deletes nothing for --yes with no target named — AC-1', async () => {
    // A caller who typed `--yes` alone asked to delete nothing in particular,
    // which is nothing. The flag is a confirmation, not a target.
    const before = await blobCount();

    const body = await prune(['--yes']);

    expect(body.plan.applied).toBe(false);
    expect(await blobCount()).toBe(before);
  });

  it('deletes when the target is named and confirmed, and records one event — AC-12', async () => {
    await orphan('h:cli-confirmed');
    const before = await blobCount();

    const body = await prune(['--blobs', '--yes']);

    expect(body.plan.applied).toBe(true);
    expect(await blobCount()).toBeLessThan(before);

    const events = readAuditEvents(journalPath()).filter((one) => one.action === 'prune.blobs');
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('permitted');
    expect(events[0]?.subject).toBe('blobs');
    // The count, never a row's contents — §8.6.
    expect(events[0]?.reason).toMatch(/^\d+ row\(s\)$/);
  });

  it('writes no row content into the trail — AC-12', async () => {
    // A prune audit that quoted the body it deleted would put content back on
    // disk that the operator asked to be reclaimed.
    await orphan('h:cli-secretish');
    await prune(['--blobs', '--yes']);

    const raw = readAuditEvents(journalPath())
      .map((one) => JSON.stringify(one))
      .join('\n');
    expect(raw).not.toContain('orphan body');
    expect(raw).not.toContain('h:cli-secretish');
  });

  it('reclaims nothing the second time — AC-13', async () => {
    await orphan('h:cli-twice');

    const first = await prune(['--blobs', '--yes']);
    const second = await prune(['--blobs', '--yes']);

    expect(first.plan.counts[0]?.rows).toBeGreaterThan(0);
    expect(second.plan.counts[0]?.rows).toBe(0);
  });

  it('says an age is required rather than choosing one — AC-6', async () => {
    const body = await prune(['--evidence', '--yes']);

    expect(body.plan.counts[0]?.rows).toBe(0);
    expect(body.plan.counts[0]?.note).toContain('age in days is required');
  });

  it('offers no flag that deletes a tombstone — AC-9', async () => {
    const help = await runCli(['prune', '--help'], { env });

    expect(help.stdout).toContain('--blobs');
    expect(help.stdout).not.toContain('tombstone');
    expect(help.stdout).not.toContain('--entities');
  });
});
