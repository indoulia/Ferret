import { describe, expect, it } from 'vitest';

import {
  SessionStatus,
  continueSession,
  createSession,
  endSession,
  sessionInputSchema,
  sessionKey,
  touchSession,
} from '../../src/domain/session.js';

describe('session model', () => {
  const input = {
    sessionId: 'claude-session-001',
    provider: 'claude',
    actorId: 'actor:agent:claude-code',
    repositoryId: 'repo:ferret',
    worktreeId: 'worktree:main',
    branch: 'main',
    startedAt: '2026-08-31T05:00:00.000Z',
  };

  it('creates a stable active session without fabricating optional scope', () => {
    const a = createSession(input);
    const b = createSession(input);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe(SessionStatus.ACTIVE);
    expect(a.endedAt).toBeNull();
    expect(a.lastActivityAt).toBe(input.startedAt);

    const minimal = createSession({
      sessionId: 's-min',
      provider: 'provider-x',
      actorId: 'actor-x',
      startedAt: input.startedAt,
    });
    expect(minimal.repositoryId).toBeUndefined();
    expect(minimal.worktreeId).toBeUndefined();
    expect(minimal.branch).toBeUndefined();
  });

  it('uses a provider-neutral deterministic session key', () => {
    expect(sessionKey('abc')).toBe(sessionKey('abc'));
    expect(sessionKey('abc')).not.toBe(sessionKey('def'));
  });

  it('touches active sessions monotonically', () => {
    const session = createSession(input);
    const touched = touchSession(session, new Date('2026-08-31T05:05:00.000Z'));
    expect(touched.lastActivityAt).toBe('2026-08-31T05:05:00.000Z');
    expect(() => touchSession(touched, new Date('2026-08-31T05:04:59.000Z'))).toThrow();
  });

  it('orders activity by instant, not by the written form of startedAt', () => {
    // startedAt keeps the offset it arrived with, and an offset string does not
    // sort chronologically against the UTC form of the timestamps compared to it.
    const ahead = createSession({ ...input, startedAt: '2026-08-31T23:00:00.000+05:30' }); // 17:30Z
    expect(touchSession(ahead, new Date('2026-08-31T18:00:00.000Z')).lastActivityAt).toBe('2026-08-31T18:00:00.000Z');
    expect(() => touchSession(ahead, new Date('2026-08-31T17:00:00.000Z'))).toThrow();

    const behind = createSession({ ...input, startedAt: '2026-08-31T01:00:00.000-05:00' }); // 06:00Z
    expect(() => touchSession(behind, new Date('2026-08-31T05:00:00.000Z'))).toThrow();
    expect(() => endSession(behind, SessionStatus.COMPLETED, new Date('2026-08-31T05:00:00.000Z'))).toThrow();
  });

  it('supports completed and abandoned terminal transitions', () => {
    const session = createSession(input);
    const completed = endSession(session, SessionStatus.COMPLETED, new Date('2026-08-31T06:00:00.000Z'));
    expect(completed.status).toBe(SessionStatus.COMPLETED);
    expect(completed.endedAt).toBe('2026-08-31T06:00:00.000Z');
    expect(() => touchSession(completed, new Date('2026-08-31T06:01:00.000Z'))).toThrow();
    expect(() => endSession(completed, SessionStatus.ABANDONED, new Date('2026-08-31T06:02:00.000Z'))).toThrow();
  });

  it('creates a linked continuation rather than reopening a terminal session', () => {
    const previous = endSession(createSession(input), SessionStatus.COMPLETED, new Date('2026-08-31T06:00:00.000Z'));
    const next = continueSession(previous, 'claude-session-002', new Date('2026-08-31T06:01:00.000Z'));
    expect(next.parentSessionId).toBe(previous.sessionId);
    expect(next.status).toBe(SessionStatus.ACTIVE);
    expect(next.provider).toBe(previous.provider);
    expect(() => continueSession(createSession(input), 'claude-session-003', new Date('2026-08-31T06:01:00.000Z'))).toThrow();
  });

  it('rejects invalid input and impossible boundaries', () => {
    expect(() => createSession({ ...input, sessionId: '' })).toThrow();
    expect(() => createSession({ ...input, startedAt: 'not-a-date' })).toThrow();
    expect(sessionInputSchema.safeParse({ ...input, credentials: 'secret' }).success).toBe(false);
    expect(() => endSession(createSession(input), SessionStatus.COMPLETED, new Date('2026-08-31T04:59:59.000Z'))).toThrow();
  });
});
