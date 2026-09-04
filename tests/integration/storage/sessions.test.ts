import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createEngineeringMemory,
  createNullLogger,
  createSession,
  createSessionCapture,
  createSessionCheckpoint,
  endSession,
  recoverSession,
  supersede,
  touchSession,
  verifySessionCheckpointIntegrity,
} from '../../../src/index.js';
import { SessionStore, migrate, type FerretDatabase } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-109 — context that outlives the process.
 *
 * The Session & Agent Memory domain was complete, validated and unreachable:
 * `SessionRecoveryPort` had one implementation and it was a test double in a
 * unit suite. These cases are about the adapter that closes that, and they run
 * against a real PostgreSQL because the invariants being claimed — a unique
 * sequence, a terminal session that cannot be amended, an extracted memory that
 * must carry evidence — are enforced by the table and cannot be demonstrated
 * against a fake.
 *
 * The recovery cases deliberately drive `recoverSession` *unmodified* over the
 * real store. That is the whole point of the Epic: the orchestration written in
 * EPIC-043 should not have to know that its port is now a database.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let store: SessionStore;

const START = '2026-09-01T09:00:00.000Z';

function sessionFor(sessionId: string, extra: Record<string, unknown> = {}) {
  return createSession({
    sessionId,
    provider: 'claude-code',
    actorId: 'actor-1',
    startedAt: START,
    ...extra,
  });
}

async function recordedSession(sessionId: string, extra: Record<string, unknown> = {}) {
  const value = sessionFor(sessionId, extra);
  await store.save(value);
  return value;
}

describeDb(`session store (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('sessions');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    store = new SessionStore(handle);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('a session round-trips — AC-1', () => {
    it('returns what was written, including optional scope and lineage', async () => {
      const written = await recordedSession('rt-1', {
        repositoryId: 'repo-7',
        worktreeId: 'wt-2',
        branch: 'feat/x',
        parentSessionId: 'rt-0',
      });

      expect(await store.getSession('rt-1')).toEqual(written);
    });

    it('omits optional scope rather than inventing it — EPIC-039 AC-3', async () => {
      await recordedSession('rt-2');
      const read = await store.getSession('rt-2');

      expect(read?.repositoryId).toBeUndefined();
      expect(read?.branch).toBeUndefined();
      expect(read?.parentSessionId).toBeUndefined();
    });

    it('is undefined when nothing was recorded', async () => {
      expect(await store.getSession('never-existed')).toBeUndefined();
    });
  });

  describe('lifecycle persists and terminal sessions are immutable — AC-2', () => {
    it('advances an active session', async () => {
      const started = await recordedSession('life-1');
      const touched = touchSession(started, new Date('2026-09-01T09:30:00.000Z'));
      await store.save(touched);

      const read = await store.getSession('life-1');
      expect(read?.lastActivityAt).toBe('2026-09-01T09:30:00.000Z');
      expect(read?.status).toBe('active');
      expect(read?.endedAt).toBeNull();
    });

    it('records an ending', async () => {
      const started = await recordedSession('life-2');
      await store.save(endSession(started, 'completed', new Date('2026-09-01T10:00:00.000Z')));

      const read = await store.getSession('life-2');
      expect(read?.status).toBe('completed');
      expect(read?.endedAt).toBe('2026-09-01T10:00:00.000Z');
    });

    it('refuses a write that would amend a session that has ended', async () => {
      const started = await recordedSession('life-3');
      const ended = endSession(started, 'completed', new Date('2026-09-01T10:00:00.000Z'));
      await store.save(ended);

      // The domain would refuse to build this; the store must refuse to store
      // one that arrived another way.
      await expect(store.save({ ...ended, status: 'active', endedAt: null })).rejects.toThrow(
        /has ended and cannot be changed/,
      );

      expect((await store.getSession('life-3'))?.status).toBe('completed');
    });

    it('accepts an unchanged replay of a terminal session', async () => {
      const started = await recordedSession('life-4');
      const ended = endSession(started, 'abandoned', new Date('2026-09-01T10:00:00.000Z'));
      await store.save(ended);

      // Idempotent, not an amendment — nothing about the row changes.
      await expect(store.save(ended)).resolves.toBeUndefined();
      expect((await store.getSession('life-4'))?.status).toBe('abandoned');
    });
  });

  describe('captures persist and a sequence is not reusable — AC-3', () => {
    it('round-trips a turn with its kind, hash and metadata', async () => {
      await recordedSession('cap-1');
      const capture = createSessionCapture({
        sessionId: 'cap-1',
        sequence: 1,
        kind: 'user',
        content: 'why does the suite need Docker?',
        capturedAt: START,
        provider: 'claude-code',
        metadata: { tokens: 12 },
      });
      await store.appendCapture(capture);

      expect(await store.capturesFor('cap-1')).toEqual([capture]);
    });

    it('orders a transcript by sequence, not by insertion', async () => {
      await recordedSession('cap-2');
      for (const sequence of [3, 1, 2]) {
        await store.appendCapture(
          createSessionCapture({
            sessionId: 'cap-2',
            sequence,
            kind: 'assistant',
            content: `turn ${String(sequence)}`,
            capturedAt: START,
            provider: 'claude-code',
          }),
        );
      }

      expect((await store.capturesFor('cap-2')).map((capture) => capture.sequence)).toEqual([1, 2, 3]);
    });

    it('rejects a second turn claiming a taken sequence', async () => {
      await recordedSession('cap-3');
      const first = createSessionCapture({
        sessionId: 'cap-3',
        sequence: 1,
        kind: 'user',
        content: 'first',
        capturedAt: START,
        provider: 'claude-code',
      });
      await store.appendCapture(first);

      await expect(
        store.appendCapture({ ...first, id: '00000000-0000-4000-8000-00000000ca03', content: 'different' }),
      ).rejects.toThrow();
    });

    it('refuses a capture for a session that was never recorded', async () => {
      await expect(
        store.appendCapture(
          createSessionCapture({
            sessionId: 'orphan',
            sequence: 1,
            kind: 'user',
            content: 'x',
            capturedAt: START,
            provider: 'claude-code',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('checkpoints persist and verify after the round trip — AC-4, AC-7', () => {
    it('returns the newest by sequence', async () => {
      await recordedSession('cp-1');
      for (const sequence of [1, 2, 3]) {
        await store.saveCheckpoint(
          createSessionCheckpoint({
            sessionId: 'cp-1',
            provider: 'claude-code',
            checkpointSequence: sequence,
            capturedThroughSequence: sequence * 10,
            checkpointedAt: START,
            summary: `checkpoint ${String(sequence)}`,
            continuationState: { step: sequence },
          }),
        );
      }

      const latest = await store.latestCheckpoint('cp-1');
      expect(latest?.checkpointSequence).toBe(3);
      expect(latest?.capturedThroughSequence).toBe(30);
      expect(latest?.continuationState).toEqual({ step: 3 });
    });

    it('rejects a reused checkpoint sequence', async () => {
      await recordedSession('cp-2');
      const checkpoint = createSessionCheckpoint({
        sessionId: 'cp-2',
        provider: 'claude-code',
        checkpointSequence: 1,
        capturedThroughSequence: 5,
        checkpointedAt: START,
        summary: 'first',
        continuationState: {},
      });
      await store.saveCheckpoint(checkpoint);

      await expect(
        store.saveCheckpoint({ ...checkpoint, id: '00000000-0000-4000-8000-0000000000c2', summary: 'second' }),
      ).rejects.toThrow();
    });

    it('a checkpoint written with an offset still verifies when read back', async () => {
      // The regression this Epic found. `checkpointed_at` is a `timestamptz`, so
      // an offset spelling does not survive storage; the content hash covers the
      // *instant* for exactly that reason. Hashing the spelling is what reported
      // 135 commits corrupt before `canonicalInstant` existed.
      await recordedSession('cp-3');
      const checkpoint = createSessionCheckpoint({
        sessionId: 'cp-3',
        provider: 'claude-code',
        checkpointSequence: 1,
        capturedThroughSequence: 2,
        checkpointedAt: '2026-09-01T14:30:00.000+05:30',
        summary: 'written from a machine that is not on UTC',
        continuationState: { branch: 'feat/x' },
      });
      await store.saveCheckpoint(checkpoint);

      const read = await store.latestCheckpoint('cp-3');
      expect(read?.checkpointedAt).toBe('2026-09-01T09:00:00.000Z');
      expect(read?.contentHash).toBe(checkpoint.contentHash);
      expect(verifySessionCheckpointIntegrity(read!)).toBe(true);
    });

    it('is undefined for a session that never checkpointed', async () => {
      await recordedSession('cp-4');
      expect(await store.latestCheckpoint('cp-4')).toBeUndefined();
    });
  });

  describe('memories persist with origin, evidence and supersession — AC-5', () => {
    it('round-trips an explicit memory', async () => {
      await recordedSession('mem-1');
      const memory = createEngineeringMemory({
        sessionId: 'mem-1',
        kind: 'decision',
        statement: 'PostgreSQL 17 with pgvector is the supported server',
        rationale: 'EPIC-005 measured it',
        origin: 'explicit',
        recordedAt: START,
      });
      await store.recordMemory(memory);

      expect(await store.memoriesFor('mem-1')).toEqual([memory]);
    });

    it('round-trips an extracted memory with the captures behind it', async () => {
      await recordedSession('mem-2');
      const memory = createEngineeringMemory({
        sessionId: 'mem-2',
        kind: 'gotcha',
        statement: 'the suite needs Docker',
        origin: 'extracted',
        rule: 'marker:GOTCHA',
        derivedFrom: [{ captureId: 'c-1', sequence: 4 }],
        recordedAt: START,
      });
      await store.recordMemory(memory);

      const [read] = await store.memoriesFor('mem-2');
      expect(read?.derivedFrom).toEqual([{ captureId: 'c-1', sequence: 4 }]);
      expect(read?.origin).toBe('extracted');
      expect(read?.confidence).toBe(memory.confidence);
    });

    it('re-recording the same memory does not duplicate it — EPIC-042', async () => {
      await recordedSession('mem-3');
      const memory = createEngineeringMemory({
        sessionId: 'mem-3',
        kind: 'constraint',
        statement: 'never weaken a test to make CI green',
        origin: 'explicit',
        recordedAt: START,
      });
      await store.recordMemory(memory);
      await store.recordMemory(memory);

      expect(await store.memoriesFor('mem-3')).toHaveLength(1);
    });

    it('keeps both halves of a supersession', async () => {
      await recordedSession('mem-4');
      const first = createEngineeringMemory({
        sessionId: 'mem-4',
        kind: 'decision',
        statement: 'store timestamps as text',
        origin: 'explicit',
        recordedAt: START,
      });
      const second = createEngineeringMemory({
        sessionId: 'mem-4',
        kind: 'decision',
        statement: 'store timestamps as timestamptz and canonicalise the hash',
        origin: 'explicit',
        recordedAt: '2026-09-01T11:00:00.000Z',
      });
      const { original, replacement } = supersede(first, second);
      await store.recordMemory(original);
      await store.recordMemory(replacement);

      const read = await store.memoriesFor('mem-4');
      expect(read).toHaveLength(2);
      expect(read.find((memory) => memory.id === original.id)?.supersededBy).toBe(replacement.id);
      expect(read.find((memory) => memory.id === replacement.id)?.supersedes).toBe(original.id);
    });

    it('refuses an extracted memory with no evidence, whatever built it', async () => {
      await recordedSession('mem-5');
      const memory = createEngineeringMemory({
        sessionId: 'mem-5',
        kind: 'gotcha',
        statement: 'a claim with nothing behind it',
        origin: 'extracted',
        derivedFrom: [{ captureId: 'c-1', sequence: 1 }],
        recordedAt: START,
      });

      await expect(store.recordMemory({ ...memory, derivedFrom: [] })).rejects.toThrow();
    });
  });

  describe('recoverSession runs unmodified against the store — AC-6', () => {
    it('assembles a checkpoint and memories from what was recorded', async () => {
      await recordedSession('rec-1');
      await store.saveCheckpoint(
        createSessionCheckpoint({
          sessionId: 'rec-1',
          provider: 'claude-code',
          checkpointSequence: 1,
          capturedThroughSequence: 9,
          checkpointedAt: START,
          summary: 'halfway through the store',
          continuationState: { next: 'write the tests' },
        }),
      );
      for (const [kind, statement] of [
        ['next-step', 'wire the CLI'],
        ['preference', 'terse comments'],
        ['constraint', 'no weakened tests'],
      ] as const) {
        await store.recordMemory(
          createEngineeringMemory({ sessionId: 'rec-1', kind, statement, origin: 'explicit', recordedAt: START }),
        );
      }

      const bundle = await recoverSession('rec-1', store);

      expect(bundle.empty).toBe(false);
      expect(bundle.checkpoint?.summary).toBe('halfway through the store');
      // EPIC-043's priority order, applied to rows that came out of a database.
      expect(bundle.memories.map((entry) => entry.memory.kind)).toEqual([
        'next-step',
        'constraint',
        'preference',
      ]);
    });

    it('walks a real lineage across sessions', async () => {
      await recordedSession('rec-parent');
      await recordedSession('rec-child', { parentSessionId: 'rec-parent' });
      await store.recordMemory(
        createEngineeringMemory({
          sessionId: 'rec-parent',
          kind: 'decision',
          statement: 'decided in the parent session',
          origin: 'explicit',
          recordedAt: START,
        }),
      );

      const bundle = await recoverSession('rec-child', store);

      expect(bundle.lineage).toEqual(['rec-child', 'rec-parent']);
      expect(bundle.memories[0]?.memory.statement).toBe('decided in the parent session');
      expect(bundle.memories[0]?.generation).toBe(1);
    });

    it('drops superseded memories and says how many — EPIC-043', async () => {
      await recordedSession('rec-2');
      const first = createEngineeringMemory({
        sessionId: 'rec-2',
        kind: 'decision',
        statement: 'the first answer',
        origin: 'explicit',
        recordedAt: START,
      });
      const second = createEngineeringMemory({
        sessionId: 'rec-2',
        kind: 'decision',
        statement: 'the answer we kept',
        origin: 'explicit',
        recordedAt: '2026-09-01T11:00:00.000Z',
      });
      const { original, replacement } = supersede(first, second);
      await store.recordMemory(original);
      await store.recordMemory(replacement);

      const bundle = await recoverSession('rec-2', store);
      expect(bundle.memories).toHaveLength(1);
      expect(bundle.omissions.find((omission) => omission.reason === 'superseded')?.count).toBe(1);
    });

    it('reports an empty recovery as empty rather than as context', async () => {
      await recordedSession('rec-3');
      const bundle = await recoverSession('rec-3', store);

      expect(bundle.empty).toBe(true);
      expect(bundle.reason).toContain('nothing to recover');
    });

    it('ends a lineage at a parent that is not on record', async () => {
      // Not a foreign key, deliberately: a pruned parent shortens a recovery
      // rather than making the continuation unrecordable.
      await recordedSession('rec-4', { parentSessionId: 'pruned-away' });
      const bundle = await recoverSession('rec-4', store);

      expect(bundle.lineage).toEqual(['rec-4', 'pruned-away']);
    });
  });

  describe('storage failures classify — AC-9', () => {
    it('reports a Ferret error rather than a driver error', async () => {
      await recordedSession('err-1');
      const capture = createSessionCapture({
        sessionId: 'err-1',
        sequence: 1,
        kind: 'user',
        content: 'x',
        capturedAt: START,
        provider: 'claude-code',
      });
      await store.appendCapture(capture);

      const error = await store
        .appendCapture({ ...capture, id: '00000000-0000-4000-8000-0000000000e1', content: 'y' })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toMatch(/^E_/);
    });
  });

  describe('the store reports what it holds', () => {
    it('counts the sessions on record', async () => {
      expect(await store.count()).toBeGreaterThan(0);
    });

    it('lists an actor’s sessions, newest first', async () => {
      const sessions = await store.sessionsFor('actor-1', 5);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((value) => value.actorId === 'actor-1')).toBe(true);
    });
  });
});
