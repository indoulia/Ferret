import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';
import { canonicalId, encodeKeyParts } from './identity.js';

export const SessionStatus = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const sessionInputSchema = z
  .object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    actorId: z.string().min(1),
    repositoryId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
    parentSessionId: z.string().min(1).optional(),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type SessionInput = z.input<typeof sessionInputSchema>;

export interface Session {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly actorId: string;
  readonly repositoryId: string | undefined;
  readonly worktreeId: string | undefined;
  readonly branch: string | undefined;
  readonly parentSessionId: string | undefined;
  readonly startedAt: string;
  readonly lastActivityAt: string;
  readonly endedAt: string | null;
  readonly status: SessionStatus;
}

export function sessionKey(sessionId: string): string {
  return encodeKeyParts(['session', sessionId]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.IDENTITY_INVALID, message, { details, remediation });
}

export function createSession(input: SessionInput): Session {
  const parsed = sessionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Session is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields.',
    );
  }

  const value = parsed.data;
  return Object.freeze({
    id: canonicalId(sessionKey(value.sessionId)),
    sessionId: value.sessionId,
    provider: value.provider,
    actorId: value.actorId,
    repositoryId: value.repositoryId,
    worktreeId: value.worktreeId,
    branch: value.branch,
    parentSessionId: value.parentSessionId,
    startedAt: value.startedAt,
    lastActivityAt: value.startedAt,
    endedAt: null,
    status: SessionStatus.ACTIVE,
  });
}

export function touchSession(session: Session, at: Date): Session {
  if (session.status !== SessionStatus.ACTIVE) {
    throw invalid(
      `Cannot update activity for a ${session.status} session`,
      { sessionId: session.sessionId, status: session.status },
      'Create a continuation session instead of reopening a terminal session.',
    );
  }
  // Compared as instants: startedAt keeps the offset it arrived with, and an
  // offset string does not sort chronologically against a UTC one.
  if (at.getTime() < Date.parse(session.lastActivityAt)) {
    throw invalid(
      'Session activity cannot move backwards in time',
      { sessionId: session.sessionId, lastActivityAt: session.lastActivityAt, attemptedAt: at.toISOString() },
      'Provide an activity timestamp at or after the current last activity.',
    );
  }
  return Object.freeze({ ...session, lastActivityAt: at.toISOString() });
}

export function endSession(session: Session, status: Exclude<SessionStatus, 'active'>, at: Date): Session {
  if (session.status !== SessionStatus.ACTIVE) {
    throw invalid(
      `Cannot transition a ${session.status} session again`,
      { sessionId: session.sessionId, status: session.status },
      'Terminal sessions are immutable; create a continuation session for new work.',
    );
  }
  if (at.getTime() < Date.parse(session.lastActivityAt)) {
    throw invalid(
      'Session end cannot precede last activity',
      { sessionId: session.sessionId, lastActivityAt: session.lastActivityAt, attemptedAt: at.toISOString() },
      'Provide an end timestamp at or after the current last activity.',
    );
  }
  return Object.freeze({ ...session, status, lastActivityAt: at.toISOString(), endedAt: at.toISOString() });
}

export function continueSession(previous: Session, sessionId: string, startedAt: Date): Session {
  if (previous.status === SessionStatus.ACTIVE) {
    throw invalid(
      'An active session cannot be continued',
      { sessionId: previous.sessionId },
      'End the current session before creating a continuation.',
    );
  }
  return createSession({
    sessionId,
    provider: previous.provider,
    actorId: previous.actorId,
    repositoryId: previous.repositoryId,
    worktreeId: previous.worktreeId,
    branch: previous.branch,
    parentSessionId: previous.sessionId,
    startedAt: startedAt.toISOString(),
  });
}
