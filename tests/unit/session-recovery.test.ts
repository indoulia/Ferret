import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMORY_LIMIT,
  MAX_LINEAGE_DEPTH,
  MemoryKind,
  MemoryOrigin,
  RECOVERY_KIND_ORDER,
  SessionStatus,
  createEngineeringMemory,
  createSession,
  endSession,
  recoverSession,
  resumeSession,
  supersede,
  type EngineeringMemory,
  type Session,
  type SessionCheckpoint,
  type SessionRecoveryPort,
} from '../../src/index.js';

const AT = '2026-08-31T12:00:00.000Z';

function session(id: string, parentSessionId?: string): Session {
  const created = createSession({
    sessionId: id,
    provider: 'claude-code',
    actorId: 'actor-1',
    startedAt: AT,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  });
  return endSession(created, SessionStatus.COMPLETED, new Date(AT));
}

function memory(
  statement: string,
  kind: MemoryKind = MemoryKind.DECISION,
  sessionId = 'session-1',
  recordedAt = AT,
): EngineeringMemory {
  return createEngineeringMemory({
    sessionId,
    kind,
    statement,
    origin: MemoryOrigin.EXPLICIT,
    recordedAt,
  });
}

function checkpoint(sessionId = 'session-1'): SessionCheckpoint {
  return {
    id: 'checkpoint-1',
    sessionId,
    provider: 'claude-code',
    checkpointSequence: 1,
    capturedThroughSequence: 12,
    checkpointedAt: AT,
    summary: 'Wired the parser into the indexer.',
    continuationState: { nextStep: 'run the suite' },
    contentHash: 'hash',
  };
}

interface PortParts {
  readonly sessions?: readonly Session[];
  readonly checkpoints?: Readonly<Record<string, SessionCheckpoint>>;
  readonly memories?: Readonly<Record<string, readonly EngineeringMemory[]>>;
}

function port(parts: PortParts = {}): SessionRecoveryPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getSession: (id) => {
      calls.push(`getSession:${id}`);
      return Promise.resolve((parts.sessions ?? []).find((entry) => entry.sessionId === id));
    },
    latestCheckpoint: (id) => {
      calls.push(`latestCheckpoint:${id}`);
      return Promise.resolve(parts.checkpoints?.[id]);
    },
    memoriesFor: (id) => {
      calls.push(`memoriesFor:${id}`);
      return Promise.resolve(parts.memories?.[id] ?? []);
    },
  };
}

describe('assembling a bundle', () => {
  it('carries the latest checkpoint — AC-1', async () => {
    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], checkpoints: { 'session-1': checkpoint() } }),
    );

    expect(bundle.checkpoint?.summary).toBe('Wired the parser into the indexer.');
    expect(bundle.checkpoint?.continuationState).toStrictEqual({ nextStep: 'run the suite' });
    expect(bundle.empty).toBe(false);
  });

  it('orders memories by usefulness, because the tail is what gets cut — AC-2', async () => {
    const memories = [
      memory('a preference', MemoryKind.PREFERENCE),
      memory('a gotcha', MemoryKind.GOTCHA),
      memory('a next step', MemoryKind.NEXT_STEP),
      memory('a decision', MemoryKind.DECISION),
      memory('a constraint', MemoryKind.CONSTRAINT),
    ];

    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': memories } }),
    );

    expect(bundle.memories.map((entry) => entry.memory.kind)).toStrictEqual([
      ...RECOVERY_KIND_ORDER,
    ]);
  });

  it('recovers memories with no checkpoint at all — AC-3', async () => {
    // The common case for a session that crashed.
    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': [memory('survived')] } }),
    );

    expect(bundle.checkpoint).toBeUndefined();
    expect(bundle.memories).toHaveLength(1);
    expect(bundle.empty).toBe(false);
  });

  it('reports an empty bundle with a reason rather than something that looks like context — AC-4', async () => {
    const bundle = await recoverSession('session-1', port({ sessions: [session('session-1')] }));

    expect(bundle.empty).toBe(true);
    expect(bundle.reason).toContain('nothing to recover');
    expect(bundle.memories).toStrictEqual([]);
  });

  it('refuses an empty session id', async () => {
    await expect(recoverSession('', port())).rejects.toThrow(/needs a session id/);
  });

  it('is deterministic for the same inputs — AC-11', async () => {
    const parts: PortParts = {
      sessions: [session('session-1')],
      checkpoints: { 'session-1': checkpoint() },
      memories: {
        'session-1': [memory('one'), memory('two', MemoryKind.GOTCHA), memory('three', MemoryKind.NEXT_STEP)],
      },
    };

    const first = await recoverSession('session-1', port(parts));
    const second = await recoverSession('session-1', port(parts));

    expect(second).toStrictEqual(first);
  });
});

describe('bounds', () => {
  it('reports what it dropped, by count — AC-5', async () => {
    const memories = Array.from({ length: 10 }, (_, index) => memory(`memory ${String(index)}`));

    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': memories } }),
      { memoryLimit: 4 },
    );

    expect(bundle.memories).toHaveLength(4);
    const omission = bundle.omissions.find((entry) => entry.reason === 'memory-limit');
    expect(omission?.count).toBe(6);
    // A caller must be able to tell "there was nothing else" from "there was
    // more than fits".
    expect(omission?.detail).toContain('6');
  });

  it('has a default bound, so a bundle is never unbounded', () => {
    expect(DEFAULT_MEMORY_LIMIT).toBeGreaterThan(0);
    expect(MAX_LINEAGE_DEPTH).toBeGreaterThan(0);
  });

  it('reports no omission when everything fitted', async () => {
    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': [memory('only one')] } }),
    );

    expect(bundle.omissions).toStrictEqual([]);
  });
});

describe('superseded memories', () => {
  it('excludes them by default and says how many — AC-6', async () => {
    const original = memory('use SQLite');
    const replacement = memory('use PostgreSQL');
    const { original: retired } = supersede(original, replacement);

    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': [retired, replacement] } }),
    );

    expect(bundle.memories.map((entry) => entry.memory.statement)).toStrictEqual(['use PostgreSQL']);
    expect(bundle.omissions.find((entry) => entry.reason === 'superseded')?.count).toBe(1);
  });

  it('includes them on request — AC-6', async () => {
    const original = memory('use SQLite');
    const replacement = memory('use PostgreSQL');
    const { original: retired } = supersede(original, replacement);

    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1')], memories: { 'session-1': [retired, replacement] } }),
      { includeSuperseded: true },
    );

    expect(bundle.memories).toHaveLength(2);
    expect(bundle.omissions).toStrictEqual([]);
  });
});

describe('lineage', () => {
  it('recovers a parent session’s memories, marked with where they came from — AC-7', async () => {
    const parts: PortParts = {
      sessions: [session('session-2', 'session-1'), session('session-1')],
      memories: {
        'session-2': [memory('from the child', MemoryKind.DECISION, 'session-2')],
        'session-1': [memory('from the parent', MemoryKind.DECISION, 'session-1')],
      },
    };

    const bundle = await recoverSession('session-2', port(parts));

    expect(bundle.lineage).toStrictEqual(['session-2', 'session-1']);
    expect(bundle.memories.map((entry) => [entry.sessionId, entry.generation])).toStrictEqual([
      ['session-2', 0],
      ['session-1', 1],
    ]);
  });

  it('puts the nearer generation first, whatever the kind — AC-2, AC-7', async () => {
    // A preference from this session outranks a constraint from a grandparent:
    // the closer context is the one being resumed.
    const parts: PortParts = {
      sessions: [session('session-2', 'session-1'), session('session-1')],
      memories: {
        'session-2': [memory('near preference', MemoryKind.PREFERENCE, 'session-2')],
        'session-1': [memory('far constraint', MemoryKind.CONSTRAINT, 'session-1')],
      },
    };

    const bundle = await recoverSession('session-2', port(parts));

    expect(bundle.memories.map((entry) => entry.memory.statement)).toStrictEqual([
      'near preference',
      'far constraint',
    ]);
  });

  it('does not loop on a session that is its own parent — AC-8', async () => {
    // A corrupt record, not an impossible one.
    const bundle = await recoverSession(
      'session-1',
      port({ sessions: [session('session-1', 'session-1')], memories: { 'session-1': [memory('once')] } }),
    );

    expect(bundle.lineage).toStrictEqual(['session-1']);
    expect(bundle.memories).toHaveLength(1);
  });

  it('bounds a long chain and says so — AC-8', async () => {
    const sessions: Session[] = [];
    const memories: Record<string, readonly EngineeringMemory[]> = {};
    for (let index = 0; index < 6; index += 1) {
      const id = `s${String(index)}`;
      const parent = index < 5 ? `s${String(index + 1)}` : undefined;
      sessions.push(session(id, parent));
      memories[id] = [memory(`from ${id}`, MemoryKind.DECISION, id)];
    }

    const bundle = await recoverSession('s0', port({ sessions, memories }), { maxLineageDepth: 3 });

    expect(bundle.lineage).toStrictEqual(['s0', 's1', 's2']);
    expect(bundle.omissions.find((entry) => entry.reason === 'lineage-limit')).toBeDefined();
  });

  it('stops cleanly at a parent that is not on record', async () => {
    const bundle = await recoverSession(
      'session-2',
      port({ sessions: [session('session-2', 'missing')] }),
    );

    expect(bundle.lineage).toStrictEqual(['session-2', 'missing']);
  });
});

describe('resuming', () => {
  it('links the continuation to the session it resumes — AC-9', async () => {
    const previous = session('session-1');
    const result = await resumeSession(
      'session-1',
      'session-2',
      port({ sessions: [previous], memories: { 'session-1': [memory('carried forward')] } }),
      new Date('2026-09-01T09:00:00.000Z'),
    );

    expect(result.session.sessionId).toBe('session-2');
    expect(result.session.parentSessionId).toBe('session-1');
    expect(result.session.status).toBe(SessionStatus.ACTIVE);
    expect(result.bundle.memories).toHaveLength(1);
  });

  it('refuses to resume a session that is not on record', async () => {
    await expect(
      resumeSession('missing', 'new', port(), new Date(AT)),
    ).rejects.toThrow(/is not on record/);
  });
});

describe('recovery reads and never writes — AC-10, AC-12', () => {
  it('calls only the three reads the port declares', async () => {
    const reading = port({
      sessions: [session('session-1')],
      checkpoints: { 'session-1': checkpoint() },
      memories: { 'session-1': [memory('one')] },
    });

    await recoverSession('session-1', reading);

    // The port has no write method at all, so this asserts the shape of what
    // was called rather than the absence of a write — which is the stronger
    // guarantee, because a write would not compile.
    expect(reading.calls).toStrictEqual([
      'memoriesFor:session-1',
      'getSession:session-1',
      'latestCheckpoint:session-1',
    ]);
  });

  it('reads each session in the lineage once', async () => {
    const reading = port({
      sessions: [session('session-2', 'session-1'), session('session-1')],
      memories: { 'session-2': [], 'session-1': [] },
    });

    await recoverSession('session-2', reading);

    expect(reading.calls.filter((call) => call.startsWith('memoriesFor:'))).toStrictEqual([
      'memoriesFor:session-2',
      'memoriesFor:session-1',
    ]);
  });

  it('reads no captures — the transcript stays evidence', async () => {
    // The property that keeps recovery cheap and safe: there is no path from a
    // raw capture to a bundle, so nothing unredacted can reach one.
    const reading = port({ sessions: [session('session-1')] });
    await recoverSession('session-1', reading);

    expect(reading.calls.some((call) => call.includes('capture'))).toBe(false);
  });
});
