import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  MemoryKind,
  MemoryOrigin,
  SessionCaptureKind,
  createEngineeringMemory,
  createNullLogger,
  createSession,
  createSessionCapture,
  createSessionCheckpoint,
} from '../../../src/index.js';
import {
  EntityStore,
  ExportService,
  ImportService,
  SESSION_TABLES,
  SessionStore,
  migrate,
  readDocument,
  type ExportManifest,
  type ExportTrailer,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-116 — session export fidelity.
 *
 * EPIC-109 excluded all four session tables from `ferret export` and said so in
 * the manifest, because a scoped export narrows by entity id and a session is
 * not an entity. That was the honest answer to an undecided question, not an
 * answer to it. The question is now decided, and these cases assert the three
 * decisions rather than the implementation that carries them:
 *
 * - **D-116.1** a session travels when it is explicitly in scope, never because
 *   its free-text `repository_id` resembles a scope;
 * - **D-116.2** the transcript travels with it, and the document is readable
 *   without the installation that wrote it;
 * - **D-116.3** `engineering_memory_extracted_has_evidence` is authoritative and
 *   is not weakened to make a restore succeed.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** Collects a document the way `ferret export --out` writes one. */
async function documentOf(
  service: ExportService,
  options: Parameters<ExportService['exportDocument']>[1],
): Promise<{ lines: string[]; manifest: ExportManifest; trailer: ExportTrailer }> {
  const lines: string[] = [];
  const result = await service.exportDocument((line) => {
    lines.push(line);
  }, options);
  return { lines, manifest: result.manifest, trailer: result.trailer };
}

/**
 * The digest the reader checks against.
 *
 * Supplied by the caller rather than computed inside `readDocument`, which is
 * EPIC-090's arrangement: the reader was written against the format by someone
 * other than its writer, and a reader that recomputed with the writer's own
 * helper would validate nothing.
 */
function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Row lines for one table.
 *
 * Parsed rather than matched as a substring: the manifest's `excluded` array is
 * a list of `{ table, reason, recovery }` objects, so a substring count of
 * `"table":"session"` counts the manifest as a row — which it did, and which is
 * why this parses.
 */
function rowsOf(lines: readonly string[], table: string): Array<Record<string, unknown>> {
  return lines
    .map((line) => JSON.parse(line) as { table?: unknown; row?: Record<string, unknown> })
    .filter((parsed) => parsed.table === table && parsed.row !== undefined)
    .map((parsed) => parsed.row as Record<string, unknown>);
}

function countOf(lines: readonly string[], table: string): number {
  return rowsOf(lines, table).length;
}

describeDb(`session export (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let db: TestDatabase;
  let handle: FerretDatabase;
  let sessions: SessionStore;
  let service: ExportService;

  const at = '2026-03-01T00:00:00.000Z';

  beforeAll(async () => {
    db = await createTestDatabase('session-export');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    sessions = new SessionStore(handle);
    service = new ExportService(handle);

    // An entity, so an entity-scoped export has something to narrow to.
    await new EntityStore(handle).upsert({
      kind: EntityKind.REPOSITORY,
      source: { id: 'o/scoped', system: 'git' },
      attributes: { name: 'o/scoped' },
    });

    for (const name of ['alpha', 'beta']) {
      await sessions.save(
        createSession({
          sessionId: `sess-${name}`,
          provider: 'claude-code',
          actorId: 'ada',
          // Free text, and deliberately shaped like something an inferring
          // implementation would match on — D-116.1's whole point.
          repositoryId: 'o/scoped',
          startedAt: at,
        }),
      );
      await sessions.appendCapture(
        createSessionCapture({
          sessionId: `sess-${name}`,
          sequence: 1,
          kind: SessionCaptureKind.USER,
          content: `the ${name} session said this`,
          capturedAt: at,
          provider: 'claude-code',
        }),
      );
      await sessions.saveCheckpoint(
        createSessionCheckpoint({
          sessionId: `sess-${name}`,
          provider: 'claude-code',
          checkpointSequence: 1,
          capturedThroughSequence: 1,
          checkpointedAt: at,
          summary: `where ${name} got to`,
          continuationState: { next: 'carry on' },
        }),
      );
    }

    // One extracted memory, with the capture it was drawn from. The pairing is
    // what D-116.3 is about, so it is set up as the real extraction path does.
    const capture = (await sessions.capturesFor('sess-alpha'))[0];
    await sessions.recordMemory(
      createEngineeringMemory({
        sessionId: 'sess-alpha',
        kind: MemoryKind.DECISION,
        statement: 'the symlink refusal stays broad until somebody measures it',
        origin: MemoryOrigin.EXTRACTED,
        rule: 'decision-phrase',
        derivedFrom: [{ captureId: capture?.id ?? '', sequence: 1 }],
        recordedAt: at,
      }),
    );
    await sessions.recordMemory(
      createEngineeringMemory({
        sessionId: 'sess-beta',
        kind: MemoryKind.GOTCHA,
        statement: 'the Windows runner cannot run Linux containers',
        origin: MemoryOrigin.EXPLICIT,
        recordedAt: at,
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('a full export carries every session — D-116.1, D-116.2', () => {
    it('carries the session, its transcript, its checkpoints and its memories', async () => {
      const { lines, manifest } = await documentOf(service, {});

      expect(countOf(lines, 'session')).toBe(2);
      expect(countOf(lines, 'session_capture')).toBe(2);
      expect(countOf(lines, 'session_checkpoint')).toBe(2);
      expect(countOf(lines, 'engineering_memory')).toBe(2);

      // And it no longer declares them excluded, because they are not.
      const excluded = new Set((manifest.excluded ?? []).map((entry) => entry.table));
      for (const table of SESSION_TABLES) expect(excluded.has(table)).toBe(false);
    }, 60_000);

    it('carries the transcript verbatim, so the document does not need this installation', async () => {
      const { lines } = await documentOf(service, {});
      const transcript = rowsOf(lines, 'session_capture');

      expect(transcript.map((row) => row['content']).sort()).toStrictEqual([
        'the alpha session said this',
        'the beta session said this',
      ]);
      // The content hash travels with the content, so a reader elsewhere can
      // check the turn it is quoting rather than trusting the document.
      for (const row of transcript) expect(row['content_hash']).toMatch(/^[0-9a-f]{64}$/);
    }, 60_000);
  });

  describe('an entity-scoped export carries none, and says why — D-116.1', () => {
    it('does not match a session against a scope by its free-text repository_id', async () => {
      const scope = (
        await db.pool.query<{ id: string }>(
          `SELECT id FROM ferret.entity WHERE kind = 'repository' LIMIT 1`,
        )
      ).rows[0]?.id;
      expect(scope).toBeDefined();

      const { lines, manifest } = await documentOf(service, { scope });

      for (const table of SESSION_TABLES) expect(countOf(lines, table)).toBe(0);

      // Stated, not silent. F-45's rule, applied to an omission that depends on
      // how the export was narrowed rather than on the format.
      const excluded = new Map((manifest.excluded ?? []).map((entry) => [entry.table, entry]));
      for (const table of SESSION_TABLES) {
        expect(excluded.get(table)?.reason).toContain('not an entity');
        expect(excluded.get(table)?.recovery).toContain('--session');
      }
      expect(manifest.sessionScope).toStrictEqual({ requested: [], resolved: [], unresolved: [] });
    }, 60_000);
  });

  describe('a named session travels, and only that one — D-116.1', () => {
    it('carries exactly the session asked for', async () => {
      const { lines, manifest } = await documentOf(service, { sessions: ['sess-alpha'] });

      expect(countOf(lines, 'session')).toBe(1);
      expect(lines.some((line) => line.includes('sess-alpha'))).toBe(true);
      expect(lines.some((line) => line.includes('sess-beta'))).toBe(false);
      expect(manifest.sessionScope?.resolved).toStrictEqual(['sess-alpha']);
    }, 60_000);

    it('resolves the canonical id as well as the session id', async () => {
      const alpha = await sessions.getSession('sess-alpha');
      const { manifest } = await documentOf(service, { sessions: [alpha?.id ?? ''] });

      // `ferret session` prints both identifiers side by side; refusing one of
      // them would make an operator translate between two things Ferret shows.
      expect(manifest.sessionScope?.resolved).toStrictEqual(['sess-alpha']);
      expect(manifest.sessionScope?.unresolved).toStrictEqual([]);
    }, 60_000);

    it('reports a session it was asked for and does not have', async () => {
      const { lines, manifest } = await documentOf(service, {
        sessions: ['sess-alpha', 'sess-nowhere'],
      });

      expect(manifest.sessionScope?.resolved).toStrictEqual(['sess-alpha']);
      expect(manifest.sessionScope?.unresolved).toStrictEqual(['sess-nowhere']);
      // The count that did not resolve is the statement, and it is not the same
      // claim as "this installation has one session".
      expect(countOf(lines, 'session')).toBe(1);
    }, 60_000);
  });

  describe('an extracted memory travels with its evidence — D-116.3', () => {
    it('reports nothing missing when the transcript came too', async () => {
      const { trailer } = await documentOf(service, { sessions: ['sess-alpha'] });

      // An empty array is the positive claim that the check ran. `undefined`
      // would be a document that did not look.
      expect(trailer.memoryEvidenceGaps).toStrictEqual([]);
    }, 60_000);

    it('reports a memory whose cited capture is not in the document', async () => {
      // Inserted directly, because no path in Ferret produces one: the
      // constraint is satisfied — `derived_from` is non-empty — and the id it
      // names is not a capture that exists. That is exactly the gap the
      // constraint cannot see, and the reason D-116.3 needed a report rather
      // than a stronger check.
      await db.pool.query(
        `INSERT INTO ferret.engineering_memory
           (id, session_id, kind, statement, origin, rule, confidence, derived_from,
            recorded_at, redacted_secrets, truncated, content_hash)
         VALUES (gen_random_uuid(), 'sess-beta', 'gotcha', 'cites a capture that is not here',
                 'extracted', 'test', 0.5,
                 '[{"captureId":"00000000-0000-4000-8000-000000000000","sequence":9}]'::jsonb,
                 now(), 0, false, 'deadbeef')`,
      );

      const { trailer } = await documentOf(service, { sessions: ['sess-beta'] });

      expect(trailer.memoryEvidenceGaps).toHaveLength(1);
      expect(trailer.memoryEvidenceGaps?.[0]).toMatchObject({ sessionId: 'sess-beta', missing: 1 });

      await db.pool.query(
        `DELETE FROM ferret.engineering_memory WHERE statement = 'cites a capture that is not here'`,
      );
    }, 60_000);

    it('refuses a memory the constraint rejects, and does not weaken it', async () => {
      // The invariant, asserted against the database rather than against the
      // domain: EPIC-116 must not have relaxed it to make a restore succeed.
      await expect(
        db.pool.query(
          `INSERT INTO ferret.engineering_memory
             (id, session_id, kind, statement, origin, confidence, derived_from,
              recorded_at, redacted_secrets, truncated, content_hash)
           VALUES (gen_random_uuid(), 'sess-beta', 'gotcha', 'no evidence at all',
                   'extracted', 0.5, '[]'::jsonb, now(), 0, false, 'deadbeef')`,
        ),
      ).rejects.toMatchObject({ constraint: 'engineering_memory_extracted_has_evidence' });
    }, 60_000);
  });

  describe('the document restores into an installation that never saw the session — D-116.2', () => {
    let target: TestDatabase;

    afterAll(async () => {
      await target?.drop();
    });

    it('restores the session, its transcript, its checkpoints and its memories', async () => {
      const { lines } = await documentOf(service, { sessions: ['sess-alpha'] });

      target = await createTestDatabase('session-export-target');
      await migrate(target.pool, { logger });
      const targetHandle = drizzle(target.pool);

      const report = await new ImportService(targetHandle).importDocument(
        readDocument(lines.join('\n'), digestOf),
        { apply: true },
      );

      const written = new Map(report.tables.map((table) => [table.table, table]));
      for (const table of SESSION_TABLES) {
        expect(written.get(table)?.failure, `${table} failed to import`).toBeUndefined();
        expect(written.get(table)?.orphaned, `${table} arrived orphaned`).toBe(0);
      }
      expect(written.get('session')?.written).toBe(1);
      expect(written.get('session_capture')?.written).toBe(1);
      expect(written.get('engineering_memory')?.written).toBe(1);

      // Read back through the domain rather than through SQL: the claim is that
      // a *session* was restored, not that rows landed.
      const restored = new SessionStore(targetHandle);
      const session = await restored.getSession('sess-alpha');
      expect(session?.provider).toBe('claude-code');

      const transcript = await restored.capturesFor('sess-alpha');
      expect(transcript[0]?.content).toBe('the alpha session said this');

      const memories = await restored.memoriesFor('sess-alpha');
      expect(memories[0]?.statement).toBe(
        'the symlink refusal stays broad until somebody measures it',
      );
      // The memory's evidence points at a capture that arrived with it, which is
      // the whole of D-116.3 stated as an assertion.
      expect(memories[0]?.derivedFrom[0]?.captureId).toBe(transcript[0]?.id);

      expect(await restored.latestCheckpoint('sess-alpha')).toBeDefined();
      expect(report.sessions?.resolved).toStrictEqual(['sess-alpha']);
    }, 180_000);
  });
});
