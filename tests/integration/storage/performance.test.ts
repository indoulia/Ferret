import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PROVIDER_SETTINGS, createNullLogger, parseConfig } from '../../../src/index.js';
import {
  PostgresStorageProvider,
  migrate,
  readSchemaStatus,
  targetSchemaVersion,
} from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Performance budgets for the storage layer.
 *
 * These are *ceilings a regression would breach*, not targets. They are set
 * several times the figures observed on a laptop and on CI, because a budget
 * tight enough to flake is a budget that gets deleted — and a deleted budget
 * catches nothing.
 *
 * They matter because Governance §3 makes MCP the primary interface and the AI
 * client spawns Ferret per session: every millisecond here is paid on every
 * session start. EPIC-005 measured Node's MCP cold start at 496 ms, and the
 * storage layer must not dominate that.
 *
 * Measured results are written to `docs/Performance/` as evidence, so a later
 * Epic can compare rather than re-derive.
 */
const BUDGET = {
  /** Whole-database bootstrap from empty, including connect and lock. */
  freshMigrationMs: 5_000,
  /** Startup against an already-current database: the common case. */
  noOpMigrationP95Ms: 750,
  /** Read-only schema inspection, which `ferret status` and MCP will call often. */
  schemaStatusP95Ms: 400,
  /** Acquiring a connection from a warm pool. */
  warmAcquireP95Ms: 50,
  /** A trivial round-trip, isolating driver and network overhead. */
  roundTripMedianMs: 25,
  /** Full provider initialize against a current database. */
  providerInitP95Ms: 2_000,
} as const;

interface Measurement {
  readonly label: string;
  readonly samples: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly budgetMs: number;
}

const measurements: Measurement[] = [];

const round = (value: number): number => Math.round(value * 100) / 100;

function summarize(label: string, durations: readonly number[], budgetMs: number): Measurement {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const measurement: Measurement = {
    label,
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
    budgetMs,
  };
  measurements.push(measurement);
  return measurement;
}

async function timeIt(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

async function sample(count: number, run: () => Promise<unknown>): Promise<number[]> {
  await run(); // discard a warm-up so page-in and plan cache are not measured
  const durations: number[] = [];
  for (let i = 0; i < count; i += 1) durations.push(await timeIt(run));
  return durations;
}

describeDb(`storage performance (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('perf');
  });

  afterAll(async () => {
    await db.drop();

    // Recorded as evidence rather than asserted-and-forgotten. EPIC-101
    // (Performance & Scale Benchmarks) compares against this file.
    if (measurements.length > 0) {
      const target = join(ROOT, 'docs', 'Performance');
      mkdirSync(target, { recursive: true });
      const report = {
        epic: 'EPIC-002',
        recordedAt: new Date().toISOString(),
        platform: `${process.platform}/${process.arch}`,
        node: process.versions.node,
        note: 'Budgets are regression ceilings, not targets. See tests/integration/storage/performance.test.ts.',
        measurements,
      };
      writeFileSync(
        join(target, `EPIC-002-storage-baseline-${process.platform}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
  });

  it(`bootstraps an empty database within ${String(BUDGET.freshMigrationMs)} ms`, async () => {
    const elapsed = await timeIt(() => migrate(db.pool, { logger }));
    summarize('fresh migration (empty database)', [elapsed], BUDGET.freshMigrationMs);

    expect(elapsed).toBeLessThan(BUDGET.freshMigrationMs);
    expect((await readSchemaStatus(db.pool)).schemaVersion).toBe(targetSchemaVersion());
  }, 60_000);

  it(`starts against a current database within ${String(BUDGET.noOpMigrationP95Ms)} ms at p95`, async () => {
    // The path every ordinary `ferret` invocation takes: connect, take the
    // lock, discover nothing to do, release. If this is slow, every AI session
    // pays for it.
    const durations = await sample(20, () => migrate(db.pool, { logger }));
    const result = summarize('no-op migration (schema already current)', durations, BUDGET.noOpMigrationP95Ms);

    expect(result.p95Ms).toBeLessThan(BUDGET.noOpMigrationP95Ms);
  }, 60_000);

  it(`reads schema status within ${String(BUDGET.schemaStatusP95Ms)} ms at p95`, async () => {
    const durations = await sample(30, () => readSchemaStatus(db.pool));
    const result = summarize('readSchemaStatus (read-only)', durations, BUDGET.schemaStatusP95Ms);

    expect(result.p95Ms).toBeLessThan(BUDGET.schemaStatusP95Ms);
  }, 60_000);

  it(`acquires a warm pooled connection within ${String(BUDGET.warmAcquireP95Ms)} ms at p95`, async () => {
    const durations = await sample(50, async () => {
      const client = await db.pool.connect();
      client.release();
    });
    const result = summarize('pool acquire + release (warm)', durations, BUDGET.warmAcquireP95Ms);

    expect(result.p95Ms).toBeLessThan(BUDGET.warmAcquireP95Ms);
  }, 60_000);

  it(`round-trips a trivial query with a median under ${String(BUDGET.roundTripMedianMs)} ms`, async () => {
    const durations = await sample(100, () => db.pool.query('SELECT 1'));
    const result = summarize('SELECT 1 round trip', durations, BUDGET.roundTripMedianMs);

    expect(result.medianMs).toBeLessThan(BUDGET.roundTripMedianMs);
  }, 60_000);

  it(`initializes the storage provider within ${String(BUDGET.providerInitP95Ms)} ms at p95`, async () => {
    const config = parseConfig({
      database: {
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
        password: db.password,
      },
    });

    const durations = await sample(8, async () => {
      const provider = new PostgresStorageProvider();
      await provider.initialize({
        logger,
        config,
        environment: {} as never,
        signal: new AbortController().signal,
        settings: DEFAULT_PROVIDER_SETTINGS,
      });
      await provider.shutdown();
    });
    const result = summarize('provider initialize + shutdown', durations, BUDGET.providerInitP95Ms);

    expect(result.p95Ms).toBeLessThan(BUDGET.providerInitP95Ms);
  }, 120_000);

  it('does not leak connections across repeated initialize/shutdown cycles', async () => {
    // A pool that is not closed shows up as a session that never goes away.
    // Left unchecked, an AI client that restarts Ferret per session would
    // exhaust `max_connections` within an afternoon.
    const sessions = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname = $1 AND application_name LIKE '@indoulia/ferret%'`,
      [db.database],
    );
    expect(Number(sessions.rows[0]?.count ?? '0')).toBe(0);
  }, 30_000);
});
