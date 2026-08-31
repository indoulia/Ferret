import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';
import { canonicalId, contentHash, encodeKeyParts, stableStringify } from './identity.js';

const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export const sessionCheckpointInputSchema = z
  .object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    checkpointSequence: z.number().int().positive(),
    capturedThroughSequence: z.number().int().nonnegative(),
    checkpointedAt: z.iso.datetime({ offset: true }),
    summary: z.string().trim().min(1),
    continuationState: z.record(z.string(), jsonValueSchema),
  })
  .strict();

export type SessionCheckpointInput = z.input<typeof sessionCheckpointInputSchema>;

export interface SessionCheckpoint {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly checkpointSequence: number;
  readonly capturedThroughSequence: number;
  readonly checkpointedAt: string;
  readonly summary: string;
  readonly continuationState: Readonly<Record<string, JsonValue>>;
  readonly contentHash: string;
}

export function sessionCheckpointKey(sessionId: string, checkpointSequence: number): string {
  return encodeKeyParts(['session-checkpoint', sessionId, String(checkpointSequence)]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.IDENTITY_INVALID, message, { details, remediation });
}

function payloadOf(checkpoint: SessionCheckpoint): Record<string, unknown> {
  return {
    sessionId: checkpoint.sessionId,
    provider: checkpoint.provider,
    checkpointSequence: checkpoint.checkpointSequence,
    capturedThroughSequence: checkpoint.capturedThroughSequence,
    checkpointedAt: checkpoint.checkpointedAt,
    summary: checkpoint.summary,
    continuationState: checkpoint.continuationState,
  };
}

function buildCheckpoint(value: SessionCheckpointInput): SessionCheckpoint {
  const payload = {
    sessionId: value.sessionId,
    provider: value.provider,
    checkpointSequence: value.checkpointSequence,
    capturedThroughSequence: value.capturedThroughSequence,
    checkpointedAt: value.checkpointedAt,
    summary: value.summary,
    continuationState: value.continuationState,
  };

  return Object.freeze({
    id: canonicalId(sessionCheckpointKey(value.sessionId, value.checkpointSequence)),
    ...payload,
    continuationState: Object.freeze({ ...value.continuationState }),
    contentHash: contentHash(stableStringify(payload)),
  });
}

export function createSessionCheckpoint(input: SessionCheckpointInput): SessionCheckpoint {
  const parsed = sessionCheckpointInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Session checkpoint is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields and provide a positive checkpoint sequence.',
    );
  }
  return buildCheckpoint(parsed.data);
}

export function advanceSessionCheckpoint(
  previous: SessionCheckpoint,
  input: Omit<SessionCheckpointInput, 'sessionId' | 'provider'>,
): SessionCheckpoint {
  if (input.checkpointSequence <= previous.checkpointSequence) {
    throw invalid(
      'Checkpoint sequence must increase monotonically',
      { sessionId: previous.sessionId, previousSequence: previous.checkpointSequence, attemptedSequence: input.checkpointSequence },
      'Use a checkpoint sequence greater than the previous checkpoint.',
    );
  }
  if (input.capturedThroughSequence < previous.capturedThroughSequence) {
    throw invalid(
      'Checkpoint capture watermark cannot move backwards',
      { sessionId: previous.sessionId, previousCapturedThroughSequence: previous.capturedThroughSequence, attemptedCapturedThroughSequence: input.capturedThroughSequence },
      'Advance the capture watermark or create a new session.',
    );
  }
  if (input.checkpointedAt < previous.checkpointedAt) {
    throw invalid(
      'Checkpoint timestamp cannot move backwards',
      { sessionId: previous.sessionId, previousCheckpointedAt: previous.checkpointedAt, attemptedCheckpointedAt: input.checkpointedAt },
      'Use a checkpoint timestamp at or after the previous checkpoint.',
    );
  }
  return createSessionCheckpoint({ ...input, sessionId: previous.sessionId, provider: previous.provider });
}

export function serializeSessionCheckpoint(checkpoint: SessionCheckpoint): string {
  return stableStringify(payloadOf(checkpoint));
}

export function verifySessionCheckpointIntegrity(checkpoint: SessionCheckpoint): boolean {
  return contentHash(serializeSessionCheckpoint(checkpoint)) === checkpoint.contentHash;
}
