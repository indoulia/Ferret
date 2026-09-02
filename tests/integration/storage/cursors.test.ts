import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger, synchronizationComponent } from '../../../src/index.js';
import { SyncCursorStore, migrate, type FerretDatabase } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-075 — where each source got to.
 *
 * The mechanism existed and was correct; what it lacked was a shape anything
 * but Git could use, a reader outside `RepositoryIndexer`, and any way for an
 * operator to see it. The tests below are about those three, and deliberately
 * *not* about what a Git run resumes from — that is unchanged, and the existing
 * indexing suites are the proof (AC-5).
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let cursors: SyncCursorStore;

/**
 * Scope ids are `uuid` in `derived_artifact`, so a readable label is not one.
 *
 * Named rather than inlined so the tests below read as "repository A" instead
 * of as a hex string — and derived deterministically, so a failure names the
 * same scope twice.
 */
const SCOPE = {
  repoA: '00000000-0000-4000-8000-000000000075',
  repoB: '00000000-0000-4000-8000-000000000076',
  repoC: '00000000-0000-4000-8000-000000000077',
  jira: '00000000-0000-4000-8000-000000000078',
  old: '00000000-0000-4000-8000-000000000079',
  never: '00000000-0000-4000-8000-00000000007a',
} as const;

describeDb(`sync cursors (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('cursors');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    cursors = new SyncCursorStore(handle, db.pool);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('a position is stored and returned untouched — AC-1', () => {
    it('round-trips a Git-shaped position', async () => {
      await cursors.advance('ferret.indexer', SCOPE.repoA, { lastCommitAt: '2026-01-01T00:00:00.000Z' });

      const read = await cursors.read(SCOPE.repoA);
      expect(read?.position['lastCommitAt']).toBe('2026-01-01T00:00:00.000Z');
      expect(read?.producer).toBe('ferret.indexer');
    });

    it('round-trips a position of a shape Git would never produce', async () => {
      // The whole point of the contract: the core stores it and understands
      // none of it. A page token and a cursor id are what the next source will
      // resume from, and neither is a commit timestamp.
      const position = { pageToken: 'eyJvZmZzZXQiOjQyfQ', updatedSince: 1234567890, etag: 'W/"abc"' };
      await cursors.advance('ferret.sync.jira', SCOPE.jira, position);

      expect((await cursors.read(SCOPE.jira))?.position).toMatchObject(position);
    });

    it('keeps cursors for different scopes apart', async () => {
      await cursors.advance('ferret.indexer', SCOPE.repoB, { lastCommitAt: 'b' });

      expect((await cursors.read(SCOPE.repoA))?.position['lastCommitAt']).toBe('2026-01-01T00:00:00.000Z');
      expect((await cursors.read(SCOPE.repoB))?.position['lastCommitAt']).toBe('b');
    });

    it('reports nothing for a scope that has never advanced', async () => {
      expect(await cursors.read(SCOPE.never)).toBeUndefined();
    });
  });

  describe('advancing is explicit — AC-2', () => {
    it('reading does not move a cursor', async () => {
      await cursors.advance('ferret.indexer', SCOPE.repoC, { lastCommitAt: 'c' });
      const first = await cursors.read(SCOPE.repoC);
      await cursors.read(SCOPE.repoC);
      const second = await cursors.read(SCOPE.repoC);

      // EPIC-031's rule: a run that failed halfway must be repeated, not
      // resumed from a position it never reached. A read that advanced would
      // make that impossible to guarantee.
      expect(second?.advancedAt.toISOString()).toBe(first?.advancedAt.toISOString());
    });

    it('advancing again moves it', async () => {
      const before = await cursors.read(SCOPE.repoC);
      await cursors.advance('ferret.indexer', SCOPE.repoC, { lastCommitAt: 'c2' }, new Date(Date.now() + 60_000));
      const after = await cursors.read(SCOPE.repoC);

      expect(after?.position['lastCommitAt']).toBe('c2');
      expect(after?.advancedAt.getTime()).toBeGreaterThan(before?.advancedAt.getTime() ?? 0);
    });
  });

  describe('a cursor from another build is not returned — AC-3', () => {
    it('reports no cursor rather than a stale one', async () => {
      await cursors.advance('ferret.indexer', SCOPE.old, { lastCommitAt: 'old' });
      await db.pool.query(
        `UPDATE ferret.derived_artifact SET producer_version = '0.0.0-other' WHERE scope_id = $1`,
        [SCOPE.old],
      );

      // Not "an old cursor" — *no* cursor. A caller must fall back to a full
      // read, and any value returned here would be resumed from.
      expect(await cursors.read(SCOPE.old)).toBeUndefined();
      expect((await cursors.list()).some((one) => one.scopeId === SCOPE.old)).toBe(false);
    });
  });

  describe('listing, for the health surface — AC-4', () => {
    it('reports every current cursor with how long ago it advanced', async () => {
      const listed = await cursors.list();

      expect(listed.length).toBeGreaterThan(0);
      for (const entry of listed) {
        expect(entry.ageSeconds).toBeGreaterThanOrEqual(0);
        expect(entry.producer.length).toBeGreaterThan(0);
      }
    });

    it('reports no position, only an age', async () => {
      // A position is provider data and can name a branch or a URL. The
      // question this answers is "how far behind", which needs only the age —
      // the rule EPIC-094 §11 set for findings, applied here.
      //
      // Asserted on the returned rows. The first version of this stringified
      // the *method* and checked that for the word "position", which is not a
      // test of anything: `JSON.stringify` of a function is `undefined`.
      const listed = await cursors.list();

      expect(listed.length).toBeGreaterThan(0);
      for (const entry of listed) {
        expect(entry).not.toHaveProperty('position');
      }
      expect(JSON.stringify(listed)).not.toContain('lastCommitAt');
    });
  });

  describe('synchronization health — AC-7, AC-8', () => {
    it('is unknown when nothing has synced, not ok with zero', () => {
      // Never synced and just synced must not look the same (Governance §6).
      // Reporting `ok, 0s behind` for an empty database is the shape of defect
      // EPIC-032 corrected on `index-integrity`.
      const component = synchronizationComponent([]);

      expect(component.status).toBe('unknown');
      expect(component.detail).toContain('Nothing has been synchronized');
      expect(component.remediation).toContain('ferret index');
    });

    it('reports the newest and oldest when several sources are current', () => {
      const component = synchronizationComponent([
        { scopeId: 'a', producer: 'ferret.indexer', ageSeconds: 30 },
        { scopeId: 'b', producer: 'ferret.indexer', ageSeconds: 3600 },
      ]);

      expect(component.status).toBe('ok');
      expect(component.detail).toContain('30s');
      expect(component.detail).toContain('3600s');
    });

    it('reads the singular case as one source', () => {
      const component = synchronizationComponent([{ scopeId: 'a', producer: 'ferret.indexer', ageSeconds: 5 }]);

      expect(component.detail).toContain('1 source');
    });

    it('sets no staleness threshold', () => {
      // Deciding that four hours behind is degraded would invent a number
      // nobody argued for: how stale is too stale depends on how often the
      // operator indexes, which Ferret cannot know and EPIC-078 will.
      const veryOld = synchronizationComponent([{ scopeId: 'a', producer: 'p', ageSeconds: 60 * 60 * 24 * 30 }]);

      expect(veryOld.status).toBe('ok');
    });
  });
});
