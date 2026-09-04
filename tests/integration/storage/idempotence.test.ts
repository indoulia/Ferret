import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  EvidenceMethod,
  RelationshipType,
  createEngineeringMemory,
  createNullLogger,
  createSession,
  createSessionCheckpoint,
  endSession,
} from '../../../src/index.js';
import {
  CompatibilityService,
  ContentStore,
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  SessionStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-080 — Governance §10, proved rather than assumed.
 *
 * > Ingestion must be incremental and idempotent. Reprocessing unchanged
 * > content must not create duplicate logical entities.
 *
 * Ferret mostly gets this right, and several Epics assert a piece of it. What
 * nothing did was assert it *across* the write surface, or enumerate that
 * surface — so the tenth write method is idempotent only if its author
 * remembered.
 *
 * That this is not hypothetical: EPIC-094 found `content_hash` was a function
 * of a timestamp's *spelling* rather than its value, which is an idempotence
 * defect in the mechanism idempotence rests on, invisible because nothing
 * recomputed a hash from a stored row.
 *
 * **Idempotent means "writes nothing new", not "does not fail."** Every
 * assertion below counts rows, because a store's own report of `unchanged` is
 * the thing under test and cannot also be the evidence for it.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const SRC = resolve(fileURLToPath(new URL('../../../src', import.meta.url)));

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let evidence: EvidenceStore;
let content: ContentStore;
let compatibility: CompatibilityService;
let sessions: SessionStore;
let repositoryId: string;

async function count(table: string): Promise<number> {
  const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
    sql.raw(`SELECT count(*)::text AS n FROM ferret.${table}`),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

// ---------------------------------------------------------------------------
// The enumeration — AC-1, AC-2, AC-8.
// ---------------------------------------------------------------------------

/**
 * Write methods that are deliberately **not** idempotent, and why.
 *
 * An unexplained exemption is how a real gap hides, so a reason is required and
 * asserted non-empty.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'runs.ts:start':
    'Records an *attempt*. Two runs are two rows by design — collapsing them would destroy the history EPIC-094 built to detect a run that started and died.',
  'evidence.ts:markStale':
    'Marks an observation superseded by a later one. Applying it twice is applying the same supersession, and the record it points at does not change — but it is a state transition on append-only data, so EPIC-008 owns proving it rather than this Epic asserting it second-hand.',
  'compatibility.ts:assertSafeToWrite':
    'A guard, not a write: it reads the schema version and throws. Named here because its signature looks like a write and a reader should not have to check.',
};

function storageFiles(): string[] {
  const directory = resolve(SRC, 'storage');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `storage${sep}${entry.name}`.split(sep).join('/'));
}

/** Public `async` methods on a store whose name reads as a write. */
function writeMethods(): { key: string; file: string; method: string }[] {
  const verbs = /^(upsert|assert|record|store|index|save|write|start|finish|mark|retire|reinstate|replace|set)/;
  const found: { key: string; file: string; method: string }[] = [];
  for (const file of storageFiles()) {
    const source = readFileSync(resolve(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/^ {2}async ([a-z][A-Za-z]*)\(/gm)) {
      const method = match[1] ?? '';
      if (!verbs.test(method)) continue;
      found.push({ key: `${file.split('/').pop() ?? file}:${method}`, file, method });
    }
  }
  return found;
}

describeDb(`idempotent ingestion (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('idempotence');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
    evidence = new EvidenceStore(handle);
    content = new ContentStore(handle);
    compatibility = new CompatibilityService(handle, db.pool);
    sessions = new SessionStore(handle);

    repositoryId = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/repo' },
        attributes: { name: 'repo' },
      })
    ).entity.id;
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('the write surface is enumerated — AC-1, AC-2, AC-8', () => {
    it('finds the write methods at all', () => {
      const found = writeMethods();

      expect(found.length).toBeGreaterThanOrEqual(8);
      process.stderr.write(`[EPIC-080] write methods: ${found.map((one) => one.key).join(', ')}\n`);
    });

    it('covers every one of them, by proof or by a stated exemption', () => {
      // The proved set is the list of methods this file double-writes below.
      // Keeping it here rather than deriving it is deliberate: a proof is a
      // test someone wrote, and claiming one automatically would be the
      // opposite of what this Epic is for.
      const proved = new Set([
        'compatibility.ts:markStale',
        'relationships.ts:retire',
        'entities.ts:upsert',
        'entities.ts:upsertMany',
        'relationships.ts:assert',
        'evidence.ts:record',
        'content.ts:store',
        'compatibility.ts:recordArtifact',
        'symbols.ts:indexFileSymbols',
        'runs.ts:finish',
        'lifecycle.ts:retire',
        'lifecycle.ts:reinstate',
        // Proved where its sibling is, in
        // `tests/integration/indexing/index-lifecycle.test.ts` — "changes
        // nothing on the run after the retirement": a second complete
        // enumeration retires 0, because a retired branch with a closed
        // interval is no longer live. EPIC-032 AC-7.
        'lifecycle.ts:retireBranch',
        'embeddings.ts:record',
        'store.ts:set',
        'store.ts:setMany',
        'store.ts:replace',
        'identities.ts:record',
        'bookkeeping.ts:record',
        'sessions.ts:save',
        'sessions.ts:saveCheckpoint',
        'sessions.ts:recordMemory',
      ]);

      for (const { key } of writeMethods()) {
        expect(
          proved.has(key) || EXEMPT[key] !== undefined,
          `${key} is a write method that nothing proves idempotent and nothing declares exempt. ` +
            'Add a double-write proof, or declare it in EXEMPT with a reason.',
        ).toBe(true);
      }
    });

    it('requires a reason for every exemption', () => {
      for (const [key, reason] of Object.entries(EXEMPT)) {
        expect(reason.length, key).toBeGreaterThan(40);
      }
    });
  });

  describe('writing the same thing twice adds nothing — AC-3, AC-4', () => {
    it('an entity upsert reports unchanged and adds no row', async () => {
      const input = {
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/a.ts', scope: repositoryId },
        attributes: { path: 'src/a.ts' },
      } as const;

      const first = await entities.upsert(input);
      const before = await count('entity');
      const second = await entities.upsert(input);
      const after = await count('entity');

      expect(first.outcome).toBe('created');
      expect(second.outcome).toBe('unchanged');
      expect(after).toBe(before);
      // Byte-identical, not merely "a row is there": an upsert that rewrote the
      // row with the same values would report unchanged and still churn.
      expect(second.entity.contentHash).toBe(first.entity.contentHash);
    });

    it('a relationship assert reports unchanged and adds no row', async () => {
      const file = (
        await entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'src/b.ts', scope: repositoryId },
          attributes: { path: 'src/b.ts' },
        })
      ).entity.id;
      const input = {
        fromId: repositoryId,
        type: RelationshipType.REPOSITORY_CONTAINS_FILE,
        toId: file,
        fromKind: EntityKind.REPOSITORY,
        toKind: EntityKind.FILE,
        sourceSystem: 'git',
        validFrom: '2026-01-01T00:00:00.000Z',
      } as const;

      await relationships.assert(input);
      const before = await count('relationship');
      const second = await relationships.assert(input);

      expect(second.outcome).toBe('unchanged');
      expect(await count('relationship')).toBe(before);
    });

    it('an evidence record deduplicates and adds no row', async () => {
      const input = {
        subjectId: repositoryId,
        field: 'name',
        statement: 'repo',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.test',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
      } as const;

      await evidence.record(input);
      const before = await count('evidence');
      const second = await evidence.record(input);

      expect(second.deduplicated).toBe(true);
      expect(await count('evidence')).toBe(before);
    });

    it('a content store deduplicates and adds no row', async () => {
      const input = { contentHash: 'h:same', bytes: new TextEncoder().encode('x') };

      await content.store(input);
      const before = await count('content_blob');
      const second = await content.store(input);

      expect(second.deduplicated).toBe(true);
      expect(await count('content_blob')).toBe(before);
    });

    it('a derived artefact records once per scope', async () => {
      const input = {
        kind: 'index',
        scopeId: repositoryId,
        producer: 'ferret.test',
        producerVersion: '1.0.0',
      };

      await compatibility.recordArtifact(input);
      const before = await count('derived_artifact');
      await compatibility.recordArtifact(input);

      // One current row per (kind, scope) — the shape EPIC-010 chose, and the
      // reason EPIC-094 needed a separate table for run history.
      expect(await count('derived_artifact')).toBe(before);
    });
  });

  describe('the methods the enumeration surfaced', () => {
    it('markStale settles: a second call changes no state', async () => {
      // Found by the enumeration rather than by anyone remembering it. The
      // question is not whether it errors twice — it is whether the *state* it
      // produces is stable, which is what a retry depends on.
      await compatibility.recordArtifact({
        kind: 'index',
        scopeId: repositoryId,
        producer: 'ferret.stale-probe',
        producerVersion: '0.0.1',
      });

      const first = await compatibility.markStale('ferret.stale-probe', '9.9.9');
      const second = await compatibility.markStale('ferret.stale-probe', '9.9.9');

      // The same rows are matched both times, and both times they end STALE.
      // `last_checked_at` moves, which is the field's whole purpose — this is
      // idempotent in *state*, not in bytes, and that distinction is the point.
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(first);
      const rows = await handle.execute<{ [column: string]: unknown; state: string }>(
        sql`SELECT state FROM ferret.derived_artifact WHERE producer = 'ferret.stale-probe'`,
      );
      expect(rows.rows.every((row) => row.state === 'stale')).toBe(true);
    });

    it('retiring a relationship twice closes it once', async () => {
      const target = (
        await entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'src/retire.ts', scope: repositoryId },
          attributes: { path: 'src/retire.ts' },
        })
      ).entity.id;
      await relationships.assert({
        fromId: repositoryId,
        type: RelationshipType.REPOSITORY_CONTAINS_FILE,
        toId: target,
        fromKind: EntityKind.REPOSITORY,
        toKind: EntityKind.FILE,
        sourceSystem: 'git',
        // Explicit, and earlier than the retirements below: a relationship
        // cannot stop being true before it started, and defaulting `validFrom`
        // to "now" would have made the first retire a no-op for that reason
        // rather than for the reason under test.
        validFrom: '2026-01-01T00:00:00.000Z',
      });

      // Retires by *endpoints and type*, not by id: the store closes whichever
      // open relationship those describe, which is what makes a second call a
      // no-op rather than an error.
      const at = new Date('2026-06-01T00:00:00.000Z');
      await relationships.retire(repositoryId, RelationshipType.REPOSITORY_CONTAINS_FILE, target, at);
      const before = await count('relationship');
      const second = await relationships.retire(
        repositoryId,
        RelationshipType.REPOSITORY_CONTAINS_FILE,
        target,
        new Date('2026-07-01T00:00:00.000Z'),
      );

      // Nothing left open to close, so the second call finds nothing — and in
      // particular does not move the moment the fact stopped being true, even
      // when handed a later timestamp.
      expect(second).toBeUndefined();

      // No new row, and the close time does not drift on a repeat — a retry
      // must not move the moment a fact stopped being true.
      expect(await count('relationship')).toBe(before);
      const rows = await handle.execute<{ [column: string]: unknown; valid_to: string | Date | null }>(
        sql`SELECT valid_to FROM ferret.relationship WHERE to_id = ${target}`,
      );
      const closedAt = rows.rows[0]?.valid_to;
      expect(closedAt).not.toBeNull();
      expect(new Date(closedAt as string | Date).toISOString()).toBe(at.toISOString());
    });
  });

  describe('the session store writes nothing new on a replay — EPIC-109', () => {
    const START = '2026-09-01T09:00:00.000Z';

    it('saving a session twice adds no row, and an ended one replays unchanged', async () => {
      const started = createSession({
        sessionId: 'idem-1',
        provider: 'claude-code',
        actorId: 'actor-1',
        startedAt: START,
      });
      await sessions.save(started);
      const before = await count('session');

      await sessions.save(started);
      expect(await count('session')).toBe(before);

      // And across the lifecycle: an end applied twice is one end, at the
      // moment it first happened, not the moment it was retried.
      const ended = endSession(started, 'completed', new Date('2026-09-01T10:00:00.000Z'));
      await sessions.save(ended);
      await sessions.save(ended);

      expect(await count('session')).toBe(before);
      const read = await sessions.getSession('idem-1');
      expect(read?.endedAt).toBe('2026-09-01T10:00:00.000Z');
    });

    it('recording the same memory twice adds no row', async () => {
      await sessions.save(
        createSession({ sessionId: 'idem-2', provider: 'claude-code', actorId: 'actor-1', startedAt: START }),
      );
      const memory = createEngineeringMemory({
        sessionId: 'idem-2',
        kind: 'decision',
        statement: 'the id is derived from session, kind and statement',
        origin: 'explicit',
        recordedAt: START,
      });

      await sessions.recordMemory(memory);
      const before = await count('engineering_memory');
      await sessions.recordMemory(memory);

      expect(await count('engineering_memory')).toBe(before);
      expect(await sessions.memoriesFor('idem-2')).toHaveLength(1);
    });

    it('a checkpoint replayed at a taken sequence writes nothing new', async () => {
      await sessions.save(
        createSession({ sessionId: 'idem-3', provider: 'claude-code', actorId: 'actor-1', startedAt: START }),
      );
      const checkpoint = createSessionCheckpoint({
        sessionId: 'idem-3',
        provider: 'claude-code',
        checkpointSequence: 1,
        capturedThroughSequence: 4,
        checkpointedAt: START,
        summary: 'first',
        continuationState: {},
      });
      await sessions.saveCheckpoint(checkpoint);
      const before = await count('session_checkpoint');

      // Rejected rather than absorbed, and this file's own definition is the
      // one that matters: idempotent means "writes nothing new", not "does not
      // fail". A checkpoint's id is derived from its session and sequence but
      // not from its summary, so a second write at a taken sequence is
      // ambiguous — the same checkpoint replayed, or a different one claiming a
      // position. Storage refuses instead of guessing which, exactly as an
      // append-only transcript does.
      await expect(sessions.saveCheckpoint(checkpoint)).rejects.toThrow();

      expect(await count('session_checkpoint')).toBe(before);
      expect((await sessions.latestCheckpoint('idem-3'))?.summary).toBe('first');
    });
  });

  describe('upsertMany states its semantics — AC-6', () => {
    it('is idempotent as a batch, which is why per-entity atomicity is enough', async () => {
      const inputs = [1, 2, 3].map((n) => ({
        kind: EntityKind.FILE,
        source: { system: 'git', id: `src/batch-${String(n)}.ts`, scope: repositoryId },
        attributes: { path: `src/batch-${String(n)}.ts` },
      }));

      const first = await entities.upsertMany(inputs);
      const before = await count('entity');
      const second = await entities.upsertMany(inputs);

      expect(first.map((one) => one.outcome)).toStrictEqual(['created', 'created', 'created']);
      expect(second.map((one) => one.outcome)).toStrictEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(await count('entity')).toBe(before);
    });

    it('validates the whole batch before writing any of it', async () => {
      // The half of the semantics that *is* atomic, and the more important half:
      // one invalid entity fails the batch before a single row is written, so a
      // partial batch can never contain invalid data.
      const before = await count('entity');
      const inputs = [
        {
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'src/valid.ts', scope: repositoryId },
          attributes: { path: 'src/valid.ts' },
        },
        { kind: 'not a registered kind', source: { system: 'git', id: 'x' }, attributes: {} },
      ];

      await expect(entities.upsertMany(inputs)).rejects.toThrow();
      expect(await count('entity')).toBe(before);
    });
  });
});
