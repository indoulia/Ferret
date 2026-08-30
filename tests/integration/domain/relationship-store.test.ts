import { performance } from 'node:perf_hooks';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, RelationshipType, createNullLogger } from '../../../src/index.js';
import {
  AssertOutcome,
  EntityStore,
  RelationshipStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Relationships against a real PostgreSQL.
 *
 * The Epic's test list names the hard cases directly — duplicate events,
 * out-of-order events, concurrent updates — and each is a property of how the
 * database behaves under real transactions, not of the code in isolation.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let entities: EntityStore;
let store: RelationshipStore;
let handle: FerretDatabase;

/** Creates an entity and returns its canonical id. */
async function entityId(kind: EntityKind, sourceId: string, attributes: Record<string, unknown>): Promise<string> {
  const result = await entities.upsert({
    kind,
    source: { system: 'git', id: sourceId, scope: 'rel-repo' },
    attributes,
  });
  return result.entity.id;
}

const T = (iso: string): Date => new Date(iso);

describeDb(`relationships (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let branch: string;
  let commitA: string;
  let commitB: string;
  let commitC: string;
  let worktree: string;
  let issue: string;

  beforeAll(async () => {
    db = await createTestDatabase('relationships');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    store = new RelationshipStore(handle);

    branch = await entityId(EntityKind.BRANCH, 'refs/heads/main', { ref: 'refs/heads/main' });
    commitA = await entityId(EntityKind.COMMIT, 'sha-a', { sha: 'sha-a' });
    commitB = await entityId(EntityKind.COMMIT, 'sha-b', { sha: 'sha-b' });
    commitC = await entityId(EntityKind.COMMIT, 'sha-c', { sha: 'sha-c' });
    worktree = await entityId(EntityKind.WORKTREE, '/tmp/wt', { path: '/tmp/wt' });
    issue = await entityId(EntityKind.ISSUE, 'FER-1', { key: 'FER-1' });
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the schema the migration created', () => {
    it('matches what the Drizzle schema declares', async () => {
      const columns = await db.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'ferret' AND table_name = 'relationship' ORDER BY column_name`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

      expect([...byName.keys()]).toStrictEqual([
        'content_hash',
        'first_indexed_at',
        'from_id',
        'id',
        'last_indexed_at',
        'metadata',
        'source_id',
        'source_system',
        'to_id',
        'type',
        'valid_from',
        'valid_to',
      ]);
      // `valid_to` must be nullable: that is how "still true" is represented.
      expect(byName.get('valid_to')?.is_nullable).toBe('YES');
      expect(byName.get('valid_from')?.is_nullable).toBe('NO');
      expect(byName.get('valid_from')?.data_type).toBe('timestamp with time zone');
    });

    it('indexes both directions and the open-relationship lookup', async () => {
      const indexes = await db.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'ferret' AND tablename = 'relationship'`,
      );
      const names = indexes.rows.map((row) => row.indexname);

      expect(names).toContain('relationship_assertion_idx');
      expect(names).toContain('relationship_from_idx');
      expect(names).toContain('relationship_to_idx');
      expect(names).toContain('relationship_open_idx');
    });

    it('refuses a relationship to an entity that does not exist', async () => {
      // A dangling edge resolves to nothing and is indistinguishable from a
      // source that never reported the entity.
      await expect(
        store.assert({
          fromId: branch,
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
          toId: '00000000-0000-8000-8000-000000000000',
          sourceSystem: 'git',
        }),
      ).rejects.toThrow();
    });
  });

  describe('duplicate events', () => {
    it('records a replayed assertion once', async () => {
      const at = T('2026-01-01T00:00:00.000Z');
      const first = await store.assert(
        {
          fromId: commitA,
          type: RelationshipType.COMMIT_RESOLVES_ISSUE,
          toId: issue,
          validFrom: at.toISOString(),
          sourceSystem: 'git',
        },
        at,
      );
      expect(first.outcome).toBe(AssertOutcome.OPENED);

      for (let i = 0; i < 5; i += 1) {
        const repeat = await store.assert(
          {
            fromId: commitA,
            type: RelationshipType.COMMIT_RESOLVES_ISSUE,
            toId: issue,
            validFrom: at.toISOString(),
            sourceSystem: 'git',
          },
          at,
        );
        expect(repeat.outcome).toBe(AssertOutcome.UNCHANGED);
      }

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship
          WHERE from_id = $1 AND type = $2 AND to_id = $3`,
        [commitA, RelationshipType.COMMIT_RESOLVES_ISSUE, issue],
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('updates in place when the metadata changes, without adding a row', async () => {
      const at = T('2026-01-01T00:00:00.000Z');
      const updated = await store.assert(
        {
          fromId: commitA,
          type: RelationshipType.COMMIT_RESOLVES_ISSUE,
          toId: issue,
          validFrom: at.toISOString(),
          metadata: { via: 'commit message' },
          sourceSystem: 'git',
        },
        at,
      );

      expect(updated.outcome).toBe(AssertOutcome.UPDATED);
      expect(updated.relationship.metadata).toStrictEqual({ via: 'commit message' });

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship
          WHERE from_id = $1 AND type = $2 AND to_id = $3`,
        [commitA, RelationshipType.COMMIT_RESOLVES_ISSUE, issue],
      );
      expect(rows.rows[0]?.count).toBe('1');
    });
  });

  describe('an exclusive relationship over time', () => {
    it('closes the previous interval when the branch moves', async () => {
      // A branch points at one commit. Asserting a new one closes the previous,
      // which is what turns a stream of observations into a history rather than
      // a pile of contradictions.
      await store.assert(
        {
          fromId: branch,
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
          toId: commitA,
          validFrom: '2026-01-01T00:00:00.000Z',
          sourceSystem: 'git',
        },
        T('2026-01-01T00:00:00.000Z'),
      );

      const second = await store.assert(
        {
          fromId: branch,
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
          toId: commitB,
          validFrom: '2026-03-01T00:00:00.000Z',
          sourceSystem: 'git',
        },
        T('2026-03-01T00:00:00.000Z'),
      );

      expect(second.outcome).toBe(AssertOutcome.OPENED);
      expect(second.closed).toHaveLength(1);

      const open = await store.outgoing(branch, { type: RelationshipType.BRANCH_POINTS_TO_COMMIT });
      expect(open).toHaveLength(1);
      expect(open[0]?.toId).toBe(commitB);
    });

    it('keeps the closed interval, so the history stays answerable', async () => {
      // AC-2: historical relationships coexist with current ones.
      const history = await store.history(branch, RelationshipType.BRANCH_POINTS_TO_COMMIT, commitA);
      expect(history).toHaveLength(1);
      expect(history[0]?.validTo).toBe('2026-03-01T00:00:00.000Z');
    });

    it('answers what was true at an earlier instant', async () => {
      const inJanuary = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        at: T('2026-02-01T00:00:00.000Z'),
      });
      expect(inJanuary).toHaveLength(1);
      expect(inJanuary[0]?.toId).toBe(commitA);

      const inApril = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        at: T('2026-04-01T00:00:00.000Z'),
      });
      expect(inApril[0]?.toId).toBe(commitB);
    });

    it('returns exactly one answer at the instant of the handover', async () => {
      // The half-open interval earns its keep here: without it the closing and
      // the opening relationship would both be true at that instant.
      const atHandover = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        at: T('2026-03-01T00:00:00.000Z'),
      });
      expect(atHandover).toHaveLength(1);
      expect(atHandover[0]?.toId).toBe(commitB);
    });

    it('returns nothing before the first observation', async () => {
      const before = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        at: T('2025-01-01T00:00:00.000Z'),
      });
      expect(before).toStrictEqual([]);
    });

    it('can list the whole history when asked', async () => {
      const all = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        includeHistorical: true,
      });
      expect(all.map((entry) => entry.toId).sort()).toStrictEqual([commitA, commitB].sort());
    });
  });

  describe('out-of-order events', () => {
    it('does not let an older observation close a newer interval', async () => {
      // Synchronization does not guarantee order. A late-arriving older event
      // must not rewrite current knowledge with stale knowledge — Governance
      // §15 calls that silently discarding conflicting evidence.
      const openBefore = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
      });
      expect(openBefore[0]?.toId).toBe(commitB);

      const late = await store.assert(
        {
          fromId: branch,
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
          toId: commitC,
          validFrom: '2026-02-01T00:00:00.000Z',
          sourceSystem: 'git',
        },
        T('2026-08-01T00:00:00.000Z'),
      );
      expect(late.outcome).toBe(AssertOutcome.OPENED);

      // The current answer is unchanged: the newer interval was not closed by
      // an event that predates it.
      const openAfter = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
      });
      expect(openAfter.map((entry) => entry.toId)).toContain(commitB);
    });

    it('inserts a late event between two known intervals without overlapping either', async () => {
      // The subtle case. Asserting Jan 5 when Jan 3 and Jan 8 already exist must
      // truncate Jan 3 rather than leave two intervals covering the same days —
      // "close whatever is open" would miss it, because Jan 3 is already closed.
      const midBranch = await entityId(EntityKind.BRANCH, 'refs/heads/mid', { ref: 'refs/heads/mid' });
      const early = await entityId(EntityKind.COMMIT, 'mid-early', { sha: 'mid-early' });
      const late = await entityId(EntityKind.COMMIT, 'mid-late', { sha: 'mid-late' });
      const middle = await entityId(EntityKind.COMMIT, 'mid-middle', { sha: 'mid-middle' });

      const point = async (toId: string, iso: string): Promise<void> => {
        await store.assert(
          {
            fromId: midBranch,
            type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
            toId,
            validFrom: iso,
            sourceSystem: 'git',
          },
          T(iso),
        );
      };

      await point(early, '2026-01-03T00:00:00.000Z');
      await point(late, '2026-01-08T00:00:00.000Z');
      await point(middle, '2026-01-05T00:00:00.000Z');

      const all = await store.outgoing(midBranch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        includeHistorical: true,
      });
      const byStart = [...all].sort((a, b) => a.validFrom.localeCompare(b.validFrom));

      expect(byStart.map((entry) => [entry.validFrom, entry.validTo])).toStrictEqual([
        ['2026-01-03T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
        ['2026-01-05T00:00:00.000Z', '2026-01-08T00:00:00.000Z'],
        ['2026-01-08T00:00:00.000Z', null],
      ]);

      // The timeline answers each day unambiguously, with exactly one answer.
      for (const [day, expected] of [
        ['2026-01-04T00:00:00.000Z', early],
        ['2026-01-06T00:00:00.000Z', middle],
        ['2026-01-09T00:00:00.000Z', late],
      ] as const) {
        const at = await store.outgoing(midBranch, {
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
          at: T(day),
        });
        expect(at, `at ${day}`).toHaveLength(1);
        expect(at[0]?.toId).toBe(expected);
      }
    });

    it('refuses to retire a relationship before it began', async () => {
      const at = T('2026-01-01T00:00:00.000Z');
      await store.assert(
        {
          fromId: commitB,
          type: RelationshipType.COMMIT_RESOLVES_ISSUE,
          toId: issue,
          validFrom: at.toISOString(),
          sourceSystem: 'git',
        },
        at,
      );

      // An impossible interval would have to be defended against by every
      // temporal query for the rest of time.
      const result = await store.retire(
        commitB,
        RelationshipType.COMMIT_RESOLVES_ISSUE,
        issue,
        T('2025-01-01T00:00:00.000Z'),
      );
      expect(result?.validTo).toBeNull();
    });

    it('reports nothing when asked to retire something that was never asserted', async () => {
      const result = await store.retire(commitC, RelationshipType.COMMIT_RESOLVES_ISSUE, issue);
      expect(result).toBeUndefined();
    });
  });

  describe('retiring', () => {
    it('closes the interval rather than deleting the row', async () => {
      // Governance §6: a relationship that simply vanished would be
      // indistinguishable from one that was never observed.
      const at = T('2026-05-01T00:00:00.000Z');
      await store.assert(
        {
          fromId: worktree,
          type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
          toId: branch,
          validFrom: '2026-01-01T00:00:00.000Z',
          sourceSystem: 'git',
        },
        T('2026-01-01T00:00:00.000Z'),
      );

      const retired = await store.retire(
        worktree,
        RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
        branch,
        at,
      );
      expect(retired?.validTo).toBe('2026-05-01T00:00:00.000Z');

      expect(await store.outgoing(worktree, { type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH })).toStrictEqual(
        [],
      );

      // Still there, still answerable.
      const history = await store.history(worktree, RelationshipType.WORKTREE_CHECKS_OUT_BRANCH, branch);
      expect(history).toHaveLength(1);
      expect(
        await store.outgoing(worktree, {
          type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
          at: T('2026-03-01T00:00:00.000Z'),
        }),
      ).toHaveLength(1);
    });
  });

  describe('traversal', () => {
    it('finds relationships in both directions', async () => {
      // "What does this contain" and "what contains this" are equally common
      // questions, which is why both directions are indexed.
      const out = await store.outgoing(commitA, { type: RelationshipType.COMMIT_RESOLVES_ISSUE });
      const back = await store.incoming(issue, { type: RelationshipType.COMMIT_RESOLVES_ISSUE });

      expect(out.map((entry) => entry.toId)).toContain(issue);
      expect(back.map((entry) => entry.fromId)).toContain(commitA);
    });

    it('finds neighbours regardless of direction', async () => {
      const neighbours = await store.neighbours(issue);
      expect(neighbours.length).toBeGreaterThan(0);
      expect(neighbours.every((entry) => entry.fromId === issue || entry.toId === issue)).toBe(true);
    });

    it('filters by type', async () => {
      const filtered = await store.outgoing(branch, { type: RelationshipType.BRANCH_POINTS_TO_COMMIT });
      expect(filtered.every((entry) => entry.type === RelationshipType.BRANCH_POINTS_TO_COMMIT)).toBe(true);
    });

    it('uses an index rather than scanning', async () => {
      const plan = await db.pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM ferret.relationship WHERE from_id = $1 AND type = $2`,
        [branch, RelationshipType.BRANCH_POINTS_TO_COMMIT],
      );
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).toMatch(/relationship_(from|open|assertion)_idx/);
    });
  });

  describe('cross-source relationships', () => {
    it('connects entities that came from different providers', async () => {
      // AC-5. Endpoints are canonical ids, which carry no provider in them, so
      // a Jira issue and a GitHub pull request relate without either system
      // knowing about the other.
      const jiraIssue = await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-77' },
        attributes: { key: 'FER-77' },
      });
      const githubPr = await entities.upsert({
        kind: EntityKind.PULL_REQUEST,
        source: { system: 'github', id: 'indoulia/Ferret#42' },
        attributes: { number: '42' },
      });

      const asserted = await store.assert({
        fromId: githubPr.entity.id,
        type: RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
        toId: jiraIssue.entity.id,
        fromKind: EntityKind.PULL_REQUEST,
        toKind: EntityKind.ISSUE,
        sourceSystem: 'ferret',
        metadata: { inferredFrom: 'branch name' },
      });

      expect(asserted.outcome).toBe(AssertOutcome.OPENED);
      // And it is traceable to whichever system made the connection, which is
      // not either of the endpoints' systems.
      expect(asserted.relationship.sourceSystem).toBe('ferret');

      const found = await store.incoming(jiraIssue.entity.id, {
        type: RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
      });
      expect(found[0]?.fromId).toBe(githubPr.entity.id);
    });
  });

  describe('concurrent updates', () => {
    it('leaves exactly one open relationship when 8 writers race an exclusive type', async () => {
      // Two providers can assert about the same entity at once. An exclusive
      // type that ended up with several open intervals would make "what does
      // this branch point at" return several answers to a question with one.
      const racedBranch = await entityId(EntityKind.BRANCH, 'refs/heads/race', { ref: 'refs/heads/race' });
      const targets = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          entityId(EntityKind.COMMIT, `race-sha-${String(index)}`, { sha: `race-sha-${String(index)}` }),
        ),
      );

      await Promise.all(
        targets.map((target, index) =>
          store.assert(
            {
              fromId: racedBranch,
              type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
              toId: target,
              validFrom: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
              sourceSystem: 'git',
            },
            new Date(Date.UTC(2026, 0, index + 1)),
          ),
        ),
      );

      const open = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship
          WHERE from_id = $1 AND type = $2 AND valid_to IS NULL`,
        [racedBranch, RelationshipType.BRANCH_POINTS_TO_COMMIT],
      );
      expect(open.rows[0]?.count).toBe('1');

      // And every assertion is still recorded — the losers were closed, not
      // discarded.
      const all = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship WHERE from_id = $1 AND type = $2`,
        [racedBranch, RelationshipType.BRANCH_POINTS_TO_COMMIT],
      );
      expect(all.rows[0]?.count).toBe('8');
    }, 60_000);

    it('applies a duplicate assertion once under concurrency', async () => {
      const at = T('2026-07-01T00:00:00.000Z');
      const target = await entityId(EntityKind.COMMIT, 'dup-race', { sha: 'dup-race' });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          store.assert(
            {
              fromId: target,
              type: RelationshipType.COMMIT_RESOLVES_ISSUE,
              toId: issue,
              validFrom: at.toISOString(),
              sourceSystem: 'git',
            },
            at,
          ).catch(() => undefined),
        ),
      );

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship
          WHERE from_id = $1 AND type = $2 AND to_id = $3`,
        [target, RelationshipType.COMMIT_RESOLVES_ISSUE, issue],
      );
      expect(rows.rows[0]?.count).toBe('1');
    }, 60_000);
  });

  describe('durability', () => {
    it('cascades when an endpoint entity is removed, leaving no dangling edge', async () => {
      const doomed = await entityId(EntityKind.COMMIT, 'doomed', { sha: 'doomed' });
      await store.assert({
        fromId: doomed,
        type: RelationshipType.COMMIT_RESOLVES_ISSUE,
        toId: issue,
        sourceSystem: 'git',
      });

      await db.pool.query('DELETE FROM ferret.entity WHERE id = $1', [doomed]);
      const remaining = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.relationship WHERE from_id = $1',
        [doomed],
      );
      expect(remaining.rows[0]?.count).toBe('0');
    });

    it('survives the server terminating every connection', async () => {
      const before = await store.outgoing(branch, { type: RelationshipType.BRANCH_POINTS_TO_COMMIT });
      await db.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      const after = await store.outgoing(branch, { type: RelationshipType.BRANCH_POINTS_TO_COMMIT });
      expect(after.map((entry) => entry.toId)).toStrictEqual(before.map((entry) => entry.toId));
    });

    it('refuses two assertions claiming the same identity', async () => {
      const existing = await store.outgoing(branch, {
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        includeHistorical: true,
      });
      const one = existing[0];
      expect(one).toBeDefined();

      await expect(
        db.pool.query(
          `INSERT INTO ferret.relationship (id, from_id, type, to_id, valid_from, source_system, content_hash)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'git', 'h')`,
          [one?.fromId, one?.type, one?.toId, one?.validFrom],
        ),
      ).rejects.toThrow();
    });
  });

  describe('performance', () => {
    // Ingesting a repository's history asserts one relationship per commit
    // parent, per changed file, per author. Per-assertion cost is multiplied by
    // the size of the history.
    const BUDGET = { assertMs: 300, traverseMs: 100 } as const;

    it(`asserts a relationship in under ${String(BUDGET.assertMs)} ms at p95`, async () => {
      const commits = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          entityId(EntityKind.COMMIT, `perf-sha-${String(index)}`, { sha: `perf-sha-${String(index)}` }),
        ),
      );

      const durations: number[] = [];
      for (const target of commits) {
        const started = performance.now();
        await store.assert({
          fromId: target,
          type: RelationshipType.COMMIT_RESOLVES_ISSUE,
          toId: issue,
          sourceSystem: 'git',
        });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.assertMs);
    }, 120_000);

    it(`traverses in under ${String(BUDGET.traverseMs)} ms at p95`, async () => {
      const durations: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const started = performance.now();
        await store.incoming(issue, { type: RelationshipType.COMMIT_RESOLVES_ISSUE });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.traverseMs);
    }, 60_000);
  });
});
