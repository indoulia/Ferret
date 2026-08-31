import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';
import { canonicalId, contentHash, encodeKeyParts } from './identity.js';

export const SessionCaptureKind = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
} as const;

export type SessionCaptureKind = (typeof SessionCaptureKind)[keyof typeof SessionCaptureKind];

const captureKindSchema = z.enum([
  SessionCaptureKind.SYSTEM,
  SessionCaptureKind.USER,
  SessionCaptureKind.ASSISTANT,
  SessionCaptureKind.TOOL_CALL,
  SessionCaptureKind.TOOL_RESULT,
]);

export const sessionCaptureInputSchema = z
  .object({
    sessionId: z.string().min(1),
    sequence: z.number().int().positive(),
    kind: captureKindSchema,
    content: z.string(),
    capturedAt: z.iso.datetime({ offset: true }),
    provider: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type SessionCaptureInput = z.input<typeof sessionCaptureInputSchema>;

export interface SessionCapture {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: SessionCaptureKind;
  readonly content: string;
  readonly contentHash: string;
  readonly capturedAt: string;
  readonly provider: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

export function sessionCaptureKey(sessionId: string, sequence: number): string {
  return encodeKeyParts(['session-capture', sessionId, String(sequence)]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.IDENTITY_INVALID, message, { details, remediation });
}

export function createSessionCapture(input: SessionCaptureInput): SessionCapture {
  const parsed = sessionCaptureInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Session capture is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields and provide a positive sequence number.',
    );
  }

  const value = parsed.data;
  return Object.freeze({
    id: canonicalId(sessionCaptureKey(value.sessionId, value.sequence)),
    sessionId: value.sessionId,
    sequence: value.sequence,
    kind: value.kind,
    content: value.content,
    contentHash: contentHash(value.content),
    capturedAt: value.capturedAt,
    provider: value.provider,
    metadata: value.metadata ? Object.freeze({ ...value.metadata }) : undefined,
  });
}
