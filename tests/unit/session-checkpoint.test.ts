import { describe, expect, it } from 'vitest';

import {
  advanceSessionCheckpoint,
  createSessionCheckpoint,
  serializeSessionCheckpoint,
  sessionCheckpointInputSchema,
  sessionCheckpointKey,
  verifySessionCheckpointIntegrity,
} from '../../src/domain/session-checkpoint.js';

describe('durable session checkpoints', () => {
  const input = {
    sessionId: 'claude-session-001',
    provider: 'claude',
    checkpointSequence: 1,
    capturedThroughSequence: 12,
    checkpointedAt: '2026-08-31T07:00:00.000Z',
    summary: 'Implemented session capture and prepared durable continuation.',
    continuationState: {
      epic: 'EPIC-041',
      nextAction: 'persist checkpoint',
      tests: ['session', 'capture'],
      approved: true,
    },
  } as const;

  it('creates deterministic immutable first checkpoints', () => {
    const a = createSessionCheckpoint(input);
    const b = createSessionCheckpoint(input);
    expect(a.id).toBe(b.id);
    expect(a.contentHash).toBe(b.contentHash);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.continuationState)).toBe(true);
    expect(a.capturedThroughSequence).toBe(12);
  });

  it('advances checkpoint and capture watermarks monotonically', () => {
    const first = createSessionCheckpoint(input);
    const second = advanceSessionCheckpoint(first, {
      checkpointSequence: 2,
      capturedThroughSequence: 20,
      checkpointedAt: '2026-08-31T07:05:00.000Z',
      summary: 'Ready for the next implementation step.',
      continuationState: { nextAction: 'continue EPIC-041' },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.checkpointSequence).toBe(2);
    expect(second.capturedThroughSequence).toBe(20);
    expect(() => advanceSessionCheckpoint(first, { ...second, checkpointSequence: 1 })).toThrow();
    expect(() => advanceSessionCheckpoint(first, { ...second, checkpointSequence: 3, capturedThroughSequence: 19 })).toThrow();
    expect(() => advanceSessionCheckpoint(first, { ...second, checkpointSequence: 3, checkpointedAt: '2026-08-31T06:59:59.000Z' })).toThrow();
  });

  it('orders checkpoint timestamps by instant, not by their written form', () => {
    // The schema accepts an offset, so '…T23:00:00+05:30' (17:30Z) precedes
    // '…T18:00:00Z' even though it sorts after it as text.
    const offset = createSessionCheckpoint({ ...input, checkpointedAt: '2026-08-31T23:00:00.000+05:30' });
    const later = advanceSessionCheckpoint(offset, {
      checkpointSequence: 2,
      capturedThroughSequence: 20,
      checkpointedAt: '2026-08-31T18:00:00.000Z',
      summary: 'Recorded from a client reporting UTC.',
      continuationState: { nextAction: 'continue EPIC-041' },
    });
    expect(later.checkpointSequence).toBe(2);
    expect(() =>
      advanceSessionCheckpoint(offset, {
        checkpointSequence: 3,
        capturedThroughSequence: 20,
        checkpointedAt: '2026-08-31T17:00:00.000Z',
        summary: 'Earlier instant, later text.',
        continuationState: { nextAction: 'reject' },
      }),
    ).toThrow();
  });

  it('serializes stably and verifies integrity', () => {
    const checkpoint = createSessionCheckpoint(input);
    const serialized = serializeSessionCheckpoint(checkpoint);
    expect(serialized).toContain('claude-session-001');
    expect(serialized).not.toContain(checkpoint.contentHash);
    expect(verifySessionCheckpointIntegrity(checkpoint)).toBe(true);
  });

  it('uses session plus checkpoint sequence for identity', () => {
    expect(sessionCheckpointKey('session-a', 1)).toBe(sessionCheckpointKey('session-a', 1));
    expect(sessionCheckpointKey('session-a', 1)).not.toBe(sessionCheckpointKey('session-a', 2));
    expect(sessionCheckpointKey('session-a', 1)).not.toBe(sessionCheckpointKey('session-b', 1));
  });

  it('rejects invalid, empty, negative, non-finite, and extra input', () => {
    expect(() => createSessionCheckpoint({ ...input, sessionId: '' })).toThrow();
    expect(() => createSessionCheckpoint({ ...input, summary: '   ' })).toThrow();
    expect(() => createSessionCheckpoint({ ...input, checkpointSequence: 0 })).toThrow();
    expect(() => createSessionCheckpoint({ ...input, capturedThroughSequence: -1 })).toThrow();
    expect(() => createSessionCheckpoint({ ...input, capturedThroughSequence: Number.POSITIVE_INFINITY })).toThrow();
    expect(sessionCheckpointInputSchema.safeParse({ ...input, secret: 'must not be accepted' }).success).toBe(false);
  });
});
