import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger } from '../../../src/index.js';
import { migrate } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * Performance and scale — EPIC-101.
 *
 * **A plan assertion, not a stopwatch.** Ferret declares 22 indexes in the
 * schema and more in raw migrations, and nothing checked that any of them was
 * used. An index PostgreSQL never chooses is not neutral: it is a write cost
 * paid on every insert, an object in every backup, and a false sense that a
 * query is fast.
 *
 * Issue #109 is why the seeding matters. That was a plan test which passed only
 * while the table had no statistics:
 *
 * > *"On 74 rows a sequential scan **is** cheaper, so the assertion held only
 * > until autoanalyze happened to run… The flake was never a race in Ferret; it
 * > was a test measuring the absence of statistics."*
 *
 * So every table here is seeded to a size where the index is genuinely the
 * cheaper plan, and `ANALYZE` is run rather than left to a background worker.
 * Both halves are needed: the rows make the index cheaper, the `ANALYZE` makes
 * the decision reproducible.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/**
 * Ceilings a regression would breach, not targets.
 *
 * EPIC-002's rule, restated because it is why these survive: *"several times
 * the figures observed on a laptop and on CI, because a budget tight enough to
 * flake is a budget that gets deleted — and a deleted budget catches nothing."*
 */
const BUDGET = {
  /** One entity by canonical key, which every upsert performs. */
  entityByKeyP95Ms: 100,
  /** Every observation about one subject — the traceability read. */
  evidenceBySubjectP95Ms: 150,
  /** One entity's edges, which traversal performs per hop. */
  relationshipsByEndpointP95Ms: 150,
  /** A symbol prefix lookup — "where is resolveConfig defined". */
  symbolPrefixP95Ms: 200,
  /** The permission filter's cost, as a multiple of the same query unscoped. */
  permissionOverheadRatio: 4,
} as const;

/** Rows per table. Large enough for the planner to prefer an index. */
const SCALE = { entities: 20_000, evidence: 20_000, relationships: 20_000 } as const;

const SAMPLES = 30;

/**
 * How many `_idx` indexes this sweep does not exercise — §8.6.
 *
 * Pinned rather than asserted zero, because "no query needs this index" and
 * "this Epic did not write the query" are different facts and only a reader can
 * tell them apart. Most of the remainder are on tables this fixture does not
 * seed — `derived_artifact`, `identity_alias`, `index_run` — and the three GIN
 * `*_search_idx` indexes, which need a `tsquery` rather than an equality.
 *
 * Adding an index without a query fails the build; writing a query for one
 * fails too. Both are the review moment.
 *
 * **Raised from 27 on 2026-09-04, and this is that review moment.** Migration
 * `0014` adds `instance_restore_restored_at_idx` for EPIC-090 D2. It is
 * unexercised here for the first of the two reasons above and not the second:
 * this fixture seeds no restore, because a restore is an import and this sweep
 * measures query plans over a seeded index. The index has one reader —
 * `readLatestRestore`, which is `ORDER BY restored_at DESC LIMIT 1`, exactly
 * what a descending index is for — and that reader is exercised by
 * `backup-contract.test.ts` against real rows.
 */
const PINNED_UNEXERCISED = 28;

interface Measurement {
  readonly label: string;
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly budgetMs: number;
}

const measurements: Measurement[] = [];
/** Indexes the sweep never saw the planner choose — §8.3. */
const unexercised: string[] = [];
const exercised = new Set<string>();

let db: TestDatabase;
let repositoryId: string;
let subjectId: string;
let canonicalKey: string;

const round = (value: number): number => Math.round(value * 100) / 100;

function summarize(label: string, durations: readonly number[], budgetMs: number): Measurement {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const measurement: Measurement = {
    label,
    samples: sorted.length,
    medianMs: round(at(0.5)),
    p95Ms: round(at(0.95)),
    budgetMs,
  };
  measurements.push(measurement);
  return measurement;
}

async function sample(run: () => Promise<unknown>): Promise<number[]> {
  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  return durations;
}

/** The plan PostgreSQL chose, as one string. */
async function planFor(sql: string, params: readonly unknown[] = []): Promise<string> {
  const explained = await db.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [...params]);
  return explained.rows.map((row) => row['QUERY PLAN']).join(' ');
}

/**
 * Asserts the planner chose a named index, and records that it was exercised.
 *
 * Recording is what makes §8.3's report possible: an index nothing here queries
 * is reported rather than silently passed, because "no query needs it" and
 * "this Epic did not write the query" are different facts and only a reader can
 * tell them apart.
 */
async function expectIndex(
  index: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  const plan = await planFor(sql, params);
  exercised.add(index);
  expect(plan, `${index} was not the plan for: ${sql}`).toContain(index);
}

/** Every index the database actually has, which includes migration-declared ones. */
async function declaredIndexes(): Promise<readonly string[]> {
  const rows = await db.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'ferret' ORDER BY indexname`,
  );
  return rows.rows.map((row) => row.indexname);
}

describeDb(`scale and query plans (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('scale');
    await migrate(db.pool, { logger });

    // Seeded by SQL rather than through the stores. The stores are correct and
    // slow — 20 000 upserts is minutes — and what is under test here is the
    // *planner*, which cares about row counts and statistics and not about how
    // the rows arrived. Deterministic, so two runs measure the same table.
    const repository = await db.pool.query<{ id: string }>(
      `INSERT INTO ferret.entity (
         id, kind, canonical_key, schema_version, source_system, source_id,
         lifecycle, attributes, unknown_fields, content_hash
       ) VALUES (
         gen_random_uuid(), 'repository', 'scale:repository', 1, 'git', '/scale',
         'active', '{"path":"/scale"}'::jsonb, '{}'::jsonb, 'h:repo'
       ) RETURNING id`,
    );
    repositoryId = repository.rows[0]?.id ?? '';

    await db.pool.query(
      `INSERT INTO ferret.entity (
         id, kind, canonical_key, schema_version, source_system, source_id,
         source_scope, lifecycle, attributes, unknown_fields, content_hash
       )
       SELECT gen_random_uuid(),
              CASE WHEN g % 3 = 0 THEN 'code_symbol' ELSE 'file' END,
              'scale:file:' || g, 1, 'git', 'src/file-' || g || '.ts',
              $1, 'active',
              jsonb_build_object('path', 'src/file-' || g || '.ts', 'name', 'symbol' || g),
              '{}'::jsonb, 'h:' || g
         FROM generate_series(1, $2) AS g`,
      [repositoryId, SCALE.entities],
    );

    const one = await db.pool.query<{ id: string; canonical_key: string }>(
      `SELECT id, canonical_key FROM ferret.entity WHERE canonical_key = 'scale:file:1'`,
    );
    subjectId = one.rows[0]?.id ?? '';
    canonicalKey = one.rows[0]?.canonical_key ?? '';

    await db.pool.query(
      `INSERT INTO ferret.evidence (
         id, subject_id, field, statement, method, producer, producer_version,
         source_system, state, completeness, integrity_hash, permission_scope,
         observed_at, recorded_at
       )
       SELECT gen_random_uuid(), $1, 'attributes.field-' || g,
              to_jsonb('scale'::text), 'observed', 'ferret.scale', '1.0.0', 'git',
              'current', 'complete', encode(sha256(g::text::bytea), 'hex'),
              CASE WHEN g % 2 = 0 THEN $3 ELSE NULL END,
              now(), now()
         FROM generate_series(1, $2) AS g`,
      [subjectId, SCALE.evidence, repositoryId],
    );

    // **Selective, not merely large** — and this was a finding. The first seed
    // gave every edge the same `from_id`, so `WHERE from_id = $1` matched
    // 13 334 of 20 000 rows and PostgreSQL correctly chose a sequential scan.
    // The fixture was wrong, not the index: a real graph has many distinct
    // endpoints, and an index is only the cheaper plan when a lookup returns a
    // small fraction of the table. A scale fixture has to be *selective*.
    //
    // One edge per file, so `from_id` is distinct per row — and a handful from
    // the repository besides, for the traversal read that genuinely fans out.
    await db.pool.query(
      `INSERT INTO ferret.relationship (
         id, from_id, type, to_id, valid_from, metadata, source_system, content_hash
       )
       SELECT gen_random_uuid(), e.id, 'file_has_version', $1, now(),
              '{}'::jsonb, 'git', 'h:rel:' || e.id
         FROM (SELECT id FROM ferret.entity WHERE kind = 'file' LIMIT $2) AS e`,
      [repositoryId, SCALE.relationships],
    );
    await db.pool.query(
      `INSERT INTO ferret.relationship (
         id, from_id, type, to_id, valid_from, metadata, source_system, content_hash
       )
       SELECT gen_random_uuid(), $1, 'repository_contains_file', e.id, now(),
              '{}'::jsonb, 'git', 'h:contains:' || e.id
         FROM (SELECT id FROM ferret.entity WHERE kind = 'file' LIMIT 40) AS e`,
      [repositoryId],
    );

    // §8.2 — never left to autoanalyze. Issue #109's defect was "a plan that
    // depended on whether a background worker had run yet", and a sweep with
    // the same dependency would flake across every assertion rather than one.
    await db.pool.query('ANALYZE ferret.entity');
    await db.pool.query('ANALYZE ferret.evidence');
    await db.pool.query('ANALYZE ferret.relationship');
  }, 600_000);

  afterAll(async () => {
    if (measurements.length > 0) {
      const rows = measurements.map(
        (one) =>
          `[EPIC-101] ${one.label.padEnd(34)} p95 ${String(one.p95Ms).padStart(8)} ms  budget ${String(one.budgetMs)} ms`,
      );
      process.stderr.write(`${rows.join('\n')}\n`);

      // §8.7 — EPIC-002's convention: "an ordinary run must leave the
      // repository exactly as it found it, and someone re-recording the
      // baseline knows they are doing it."
      if (process.env['FERRET_RECORD_BASELINE'] === '1') {
        const path = join(
          fileURLToPath(new URL('../../../docs/Performance/', import.meta.url)),
          `EPIC-101-scale-baseline-${process.platform}.json`,
        );
        writeFileSync(
          path,
          `${JSON.stringify({ scale: SCALE, samples: SAMPLES, measurements, unexercised }, null, 2)}\n`,
          'utf8',
        );
      }
    }
    await db.drop();
  });

  describe('every declared index is the plan for the query it exists for — AC-1 to AC-6', () => {
    it('finds the indexes from the catalogue, so a migration-declared one is covered', async () => {
      // Read from `pg_indexes` rather than parsed from the Drizzle schema:
      // migrations `0007`, `0010` and `0011` declare indexes in raw SQL —
      // including the `text_pattern_ops` one AC-5 covers — and a sweep over the
      // schema file would have missed exactly those.
      const indexes = await declaredIndexes();

      expect(indexes.length).toBeGreaterThan(25);
      expect(indexes).toContain('entity_canonical_key_idx');
      expect(indexes).toContain('entity_code_symbol_name_prefix_idx');
    });

    it('looks an entity up by canonical key through its index — AC-2', async () => {
      // The read every upsert performs, so a sequential scan here would be paid
      // on every row of every index run.
      await expectIndex(
        'entity_canonical_key_idx',
        `SELECT * FROM ferret.entity WHERE canonical_key = $1`,
        [canonicalKey],
      );
    });

    it('reads one subject s evidence through evidence_subject_idx — AC-3', async () => {
      await expectIndex(
        'evidence_subject_idx',
        `SELECT * FROM ferret.evidence WHERE subject_id = $1 AND field = $2`,
        [subjectId, 'attributes.field-1'],
      );
    });

    it('reads one entity s outgoing edges through its index — AC-4', async () => {
      // A *file*, which has one outgoing edge — not the repository, which has
      // forty. An index is the cheaper plan only when a lookup returns a small
      // fraction of the table, so the query has to be the selective one a
      // traversal actually issues per hop.
      const plan = await planFor(
        `SELECT * FROM ferret.relationship WHERE from_id = $1 AND type = $2`,
        [subjectId, 'file_has_version'],
      );
      exercised.add('relationship_from_idx');
      // Either the endpoint index or the open-interval partial index is a
      // correct answer here; both exist and both are cheaper than a scan.
      expect(plan).toMatch(/relationship_(from|open|assertion)_idx/);
      for (const name of ['relationship_open_idx', 'relationship_assertion_idx']) {
        if (plan.includes(name)) exercised.add(name);
      }
    });

    it('reads an incoming edge through relationship_to_idx', async () => {
      await expectIndex(
        'relationship_to_idx',
        `SELECT * FROM ferret.relationship WHERE to_id = $1 AND type = $2`,
        [subjectId, 'repository_contains_file'],
      );
    });

    it('finds an entity by its source identity through entity_source_idx', async () => {
      // What every provider emit resolves against.
      await expectIndex(
        'entity_source_idx',
        `SELECT * FROM ferret.entity WHERE source_system = $1 AND source_id = $2`,
        ['git', 'src/file-7.ts'],
      );
    });

    it('finds a scope s children through entity_scope_idx', async () => {
      // EPIC-089's export closure and EPIC-032's reconciliation both issue this.
      // Selective on a *file*, whose children are few — the repository's are
      // twenty thousand, which is a scan and correctly so.
      await expectIndex(
        'entity_scope_idx',
        `SELECT * FROM ferret.entity WHERE source_scope = $1`,
        [subjectId],
      );
    });

    it('finds a symbol by exact name through entity_code_symbol_name_idx', async () => {
      await expectIndex(
        'entity_code_symbol_name_idx',
        `SELECT * FROM ferret.entity
          WHERE kind = 'code_symbol' AND (attributes->>'name') = $1`,
        ['symbol9'],
      );
    });

    it('finds evidence by permission scope through evidence_permission_idx', async () => {
      // EPIC-058's filter. Half the seeded rows carry a scope, which is not
      // selective enough for an index — so this asks for a scope that almost
      // nothing has, which is the shape a real multi-repository index produces.
      await db.pool.query(
        `UPDATE ferret.evidence SET permission_scope = 'scale:rare'
          WHERE field = 'attributes.field-5'`,
      );
      await db.pool.query('ANALYZE ferret.evidence');

      await expectIndex(
        'evidence_permission_idx',
        `SELECT * FROM ferret.evidence WHERE permission_scope = $1`,
        ['scale:rare'],
      );
    });

    it('finds the stalest repositories through entity_last_indexed_idx', async () => {
      // EPIC-078's reconcile pass orders by staleness, oldest first — this is
      // the index that read needs, and the first assertion it has ever had.
      await expectIndex(
        'entity_last_indexed_idx',
        `SELECT id FROM ferret.entity ORDER BY last_indexed_at LIMIT 10`,
      );
    });

    it('finds a symbol by name prefix through the text_pattern_ops index — AC-5', async () => {
      // EPIC-034 recorded why this index needs `text_pattern_ops`: "without it
      // the lookup is a sequential scan that looks fine on a fixture and is
      // unusable on a real repository." This is the assertion that keeps that
      // true at a size where it matters.
      await expectIndex(
        'entity_code_symbol_name_prefix_idx',
        `SELECT * FROM ferret.entity
          WHERE kind = 'code_symbol' AND (attributes->>'name') LIKE $1`,
        ['symbol1%'],
      );
    });

    it('scans rather than indexes when the whole table is wanted, which is correct', async () => {
      // The control, and it has to be a *selectivity* control to be worth
      // anything: a plan assertion that could not distinguish "index chosen"
      // from "index always chosen" would pass against a database that had lost
      // its statistics — the exact failure issue #109 recorded.
      //
      // F-101. This asked for the plan of `SELECT count(*) FROM ferret.entity`
      // and required a sequential scan. That is not a control, it is a coin
      // toss: PostgreSQL answers `count(*)` with an **Index Only Scan** as soon
      // as the visibility map is sufficiently frozen, and an index-only scan of
      // a whole table is not a wrong plan — it is usually the better one. The
      // assertion therefore pinned an autovacuum timing artefact, passed in
      // isolation, and failed after a full suite had dirtied and then frozen
      // the table. It failed the merged `main` run on CI (33864075157), which
      // is what took it out of the "intermittent, probably infrastructure"
      // bucket: the test was wrong, not the environment.
      //
      // The property actually worth holding is the one the sibling above names
      // — "the repository's are twenty thousand, which is a scan and correctly
      // so". Same column, same index, same table: selective asks for the index,
      // unselective does not. That is discrimination by selectivity, which is
      // what makes every `expectIndex` in this block mean something, and it does
      // not depend on when a visibility map was last frozen.
      const plan = await planFor(`SELECT * FROM ferret.entity WHERE source_scope = $1`, [
        repositoryId,
      ]);

      expect(plan, 'an unselective scope lookup should not use entity_scope_idx').not.toContain(
        'entity_scope_idx',
      );
      expect(plan).toMatch(/Seq Scan|Parallel Seq Scan/i);
    });
  });

  describe('an unexercised index is reported — AC-7, AC-8', () => {
    it('pins how many indexes this sweep does not exercise', async () => {
      const indexes = await declaredIndexes();
      // Primary keys and unique constraints are not query indexes in the sense
      // this sweep is about; they exist to enforce a constraint and are used by
      // the insert path whether or not a SELECT names them.
      const queryable = indexes.filter((name) => name.endsWith('_idx'));
      unexercised.push(...queryable.filter((name) => !exercised.has(name)));

      // §8.3 — reported, not failed. An index may be unexercised because no
      // query needs it (a real defect: a write cost with no reader) or because
      // this Epic did not write the query (a gap in the sweep). Only a reader
      // can tell those apart.
      //
      // §8.8 — the count is pinned, so a 23rd index without a query fails the
      // build and writing a query for an existing one fails too. Both are the
      // review moment; a number nobody is asked about drifts.
      expect(unexercised.length, unexercised.join(', ')).toBe(PINNED_UNEXERCISED);
    });
  });

  describe('the read paths stay within their ceilings at scale — AC-9, AC-10', () => {
    it(`looks an entity up within ${String(BUDGET.entityByKeyP95Ms)} ms at p95`, async () => {
      const result = summarize(
        'entity by canonical key',
        await sample(() =>
          db.pool.query(`SELECT * FROM ferret.entity WHERE canonical_key = $1`, [canonicalKey]),
        ),
        BUDGET.entityByKeyP95Ms,
      );

      expect(result.p95Ms).toBeLessThan(BUDGET.entityByKeyP95Ms);
    });

    it(`reads a subject s evidence within ${String(BUDGET.evidenceBySubjectP95Ms)} ms at p95`, async () => {
      const result = summarize(
        'evidence by subject',
        await sample(() =>
          db.pool.query(
            `SELECT * FROM ferret.evidence WHERE subject_id = $1 AND field = $2`,
            [subjectId, 'attributes.field-2'],
          ),
        ),
        BUDGET.evidenceBySubjectP95Ms,
      );

      expect(result.p95Ms).toBeLessThan(BUDGET.evidenceBySubjectP95Ms);
    });

    it(`reads one hop of edges within ${String(BUDGET.relationshipsByEndpointP95Ms)} ms at p95`, async () => {
      // One hop, which is what traversal performs per level — so this figure
      // multiplies by depth in EPIC-050's bounded walk.
      const result = summarize(
        'edges by endpoint (one hop)',
        await sample(() =>
          db.pool.query(
            `SELECT * FROM ferret.relationship WHERE from_id = $1 AND valid_to IS NULL LIMIT 50`,
            [subjectId],
          ),
        ),
        BUDGET.relationshipsByEndpointP95Ms,
      );

      expect(result.p95Ms).toBeLessThan(BUDGET.relationshipsByEndpointP95Ms);
    });

    it(`finds a symbol by prefix within ${String(BUDGET.symbolPrefixP95Ms)} ms at p95`, async () => {
      const result = summarize(
        'symbol by name prefix',
        await sample(() =>
          db.pool.query(
            `SELECT * FROM ferret.entity
              WHERE kind = 'code_symbol' AND (attributes->>'name') LIKE $1 LIMIT 50`,
            ['symbol1%'],
          ),
        ),
        BUDGET.symbolPrefixP95Ms,
      );

      expect(result.p95Ms).toBeLessThan(BUDGET.symbolPrefixP95Ms);
    });
  });

  describe('what the permission filter costs — AC-11', () => {
    it('reports the scoped read as a ratio of the unscoped one', async () => {
      // EPIC-100 §4 asks what the security path costs. The honest answer is a
      // *difference*, so the same query is measured with and without a scope —
      // an absolute number would be a fact about this machine.
      const unscoped = summarize(
        'evidence read, unscoped',
        await sample(() =>
          db.pool.query(`SELECT * FROM ferret.evidence WHERE subject_id = $1 LIMIT 50`, [subjectId]),
        ),
        BUDGET.evidenceBySubjectP95Ms,
      );
      const scoped = summarize(
        'evidence read, scoped',
        await sample(() =>
          db.pool.query(
            `SELECT * FROM ferret.evidence
              WHERE subject_id = $1 AND (permission_scope IS NULL OR permission_scope = $2)
              LIMIT 50`,
            [subjectId, repositoryId],
          ),
        ),
        BUDGET.evidenceBySubjectP95Ms,
      );

      const ratio = scoped.p95Ms / Math.max(unscoped.p95Ms, 0.01);
      process.stderr.write(
        `[EPIC-101] permission filter overhead: ${String(round(ratio))}x (${String(unscoped.p95Ms)} ms → ${String(scoped.p95Ms)} ms at p95)\n`,
      );

      expect(ratio).toBeLessThan(BUDGET.permissionOverheadRatio);
    });
  });

  describe('the assertions are load-bearing — AC-12', () => {
    it('fails to find the index once it is dropped', async () => {
      // The only way to prove a plan assertion means anything: drop the index
      // and watch the plan change. Restored in `finally`, so nothing after
      // this measures a different table.
      const before = await planFor(
        `SELECT * FROM ferret.evidence WHERE subject_id = $1 AND field = $2`,
        [subjectId, 'attributes.field-3'],
      );
      expect(before).toContain('evidence_subject_idx');

      await db.pool.query('DROP INDEX ferret.evidence_subject_idx');
      try {
        const after = await planFor(
          `SELECT * FROM ferret.evidence WHERE subject_id = $1 AND field = $2`,
          [subjectId, 'attributes.field-3'],
        );

        expect(after).not.toContain('evidence_subject_idx');
        expect(after).toMatch(/Seq Scan|Parallel Seq Scan/i);
      } finally {
        await db.pool.query(
          'CREATE INDEX evidence_subject_idx ON ferret.evidence (subject_id, field)',
        );
        await db.pool.query('ANALYZE ferret.evidence');
      }
    });
  });
});
