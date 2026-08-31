import { describe, expect, it } from 'vitest';

import {
  SessionCaptureKind,
  createSessionCapture,
  sessionCaptureKey,
} from '../../src/domain/index.js';

describe('session capture', () => {
  const base = {
    sessionId: 'session-1',
    sequence: 1,
    kind: SessionCaptureKind.USER,
    content: 'Investigate the indexing regression.',
    capturedAt: '2026-08-31T06:00:00.000Z',
    provider: 'claude',
  } as const;

  it('creates a deterministic immutable capture', () => {
    const first = createSessionCapture(base);
    const second = createSessionCapture({ ...base });

    expect(first.id).toBe(second.id);
    expect(first.contentHash).toHaveLength(64);
    expect(Object.isFrozen(first)).toBe(true);
    expect(sessionCaptureKey(base.sessionId, base.sequence)).toContain('session-1');
  });

  it.each(Object.values(SessionCaptureKind))('accepts %s events', (kind) => {
    expect(createSessionCapture({ ...base, kind }).kind).toBe(kind);
  });

  it('distinguishes sequence values within a session', () => {
    const first = createSessionCapture(base);
    const second = createSessionCapture({ ...base, sequence: 2 });

    expect(second.id).not.toBe(first.id);
  });

  it('rejects zero and fractional sequences', () => {
    expect(() => createSessionCapture({ ...base, sequence: 0 })).toThrow();
    expect(() => createSessionCapture({ ...base, sequence: 1.5 })).toThrow();
  });

  it('rejects unknown event kinds and malformed timestamps', () => {
    expect(() => createSessionCapture({ ...base, kind: 'thinking' as never })).toThrow();
    expect(() => createSessionCapture({ ...base, capturedAt: 'not-a-date' })).toThrow();
  });

  it('preserves provider-neutral metadata without mutating the input object', () => {
    const metadata = { model: 'opaque-model-id', source: 'client-adapter' };
    const capture = createSessionCapture({ ...base, metadata });

    expect(capture.metadata).toEqual(metadata);
    expect(Object.isFrozen(capture.metadata)).toBe(true);
    expect(capture.provider).toBe('claude');
  });
});
