import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';

import { redactSecrets } from '../security/index.js';

import { Confidence } from './confidence.js';
import { canonicalId, contentHash, encodeKeyParts } from './identity.js';

/**
 * What a session decided and learned, kept apart from the transcript.
 *
 * EPIC-039 to EPIC-041 preserve the session; what they preserve is a
 * *transcript*, and a transcript is the wrong thing to hand a later session.
 * The valuable part is a few dozen sentences — we chose this over that and why,
 * this API returns null rather than throwing, do not run the suite without
 * Docker — and those are worth more than the ten thousand lines around them.
 *
 * The registry's P0 focus statement sets the constraint that makes this safe:
 * the raw session remains evidence, and derived memory remains traceable to it.
 * A memory that cannot be traced back to what was actually said is a claim
 * Ferret invented.
 */

export const MemoryKind = {
  /** A choice that was made, ideally with what it was chosen over. */
  DECISION: 'decision',
  /** Something that must hold — a rule, a limit, a requirement. */
  CONSTRAINT: 'constraint',
  /** How this project likes things done. Weaker than a constraint. */
  PREFERENCE: 'preference',
  /** A surprise worth not rediscovering. */
  GOTCHA: 'gotcha',
  /** Work identified and not done. */
  NEXT_STEP: 'next-step',
} as const;

export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

export const MEMORY_KINDS: readonly MemoryKind[] = Object.freeze(Object.values(MemoryKind));

/**
 * How a memory came to exist.
 *
 * Distinguishable in the record because it changes how much weight the memory
 * deserves: a client that states a decision knows it made one, and a marker
 * that matched a line only knows the line matched.
 */
export const MemoryOrigin = {
  /** An AI client recorded it deliberately. */
  EXPLICIT: 'explicit',
  /** A marker or phrasing matched a captured line. */
  EXTRACTED: 'extracted',
} as const;

export type MemoryOrigin = (typeof MemoryOrigin)[keyof typeof MemoryOrigin];

/** Confidence by origin. Stated once so the ordering is one decision. */
export const ORIGIN_CONFIDENCE: Readonly<Record<MemoryOrigin, number>> = Object.freeze({
  [MemoryOrigin.EXPLICIT]: Confidence.STRONG,
  [MemoryOrigin.EXTRACTED]: Confidence.PLAUSIBLE,
});

/** Longest statement retained. A pasted essay is not a memory. */
export const MAX_STATEMENT_LENGTH = 1000;

/** Where a memory came from, in the raw session. */
export interface MemoryEvidence {
  readonly captureId: string;
  readonly sequence: number;
}

const evidenceSchema = z
  .object({ captureId: z.string().min(1), sequence: z.number().int().positive() })
  .strict();

export const engineeringMemoryInputSchema = z
  .object({
    sessionId: z.string().min(1),
    kind: z.enum(MEMORY_KINDS),
    statement: z.string().trim().min(1),
    rationale: z.string().trim().optional(),
    origin: z.enum([MemoryOrigin.EXPLICIT, MemoryOrigin.EXTRACTED]),
    /** The rule that matched, for an extracted memory. */
    rule: z.string().min(1).optional(),
    derivedFrom: z.array(evidenceSchema).default([]),
    recordedAt: z.iso.datetime({ offset: true }),
    /** Credentials removed from the statement and rationale. */
    redactedSecrets: z.number().int().nonnegative().default(0),
  })
  .strict();

export type EngineeringMemoryInput = z.input<typeof engineeringMemoryInputSchema>;

export interface EngineeringMemory {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: MemoryKind;
  readonly statement: string;
  readonly rationale: string | undefined;
  readonly origin: MemoryOrigin;
  readonly rule: string | undefined;
  readonly confidence: number;
  readonly derivedFrom: readonly MemoryEvidence[];
  readonly recordedAt: string;
  readonly redactedSecrets: number;
  /** True when the statement was cut at {@link MAX_STATEMENT_LENGTH}. */
  readonly truncated: boolean;
  /** The memory that replaced this one. */
  readonly supersededBy: string | undefined;
  /** The memory this one replaced. */
  readonly supersedes: string | undefined;
  readonly contentHash: string;
}

/**
 * The key a memory's id is derived from.
 *
 * Session, kind and statement — not the timestamp, and not the evidence. Two
 * runs of extraction over the same captures must produce the same id, or an
 * incremental capture that re-reads earlier turns duplicates every memory it
 * already recorded.
 */
export function engineeringMemoryKey(
  sessionId: string,
  kind: MemoryKind,
  statement: string,
): string {
  return encodeKeyParts(['engineering-memory', sessionId, kind, statement]);
}

function invalid(message: string, details: Record<string, unknown>): FerretError {
  return new FerretError(ErrorCode.ENTITY_INVALID, message, {
    details,
    remediation: 'Correct the reported fields. A memory needs a session, a kind and a statement.',
  });
}

export function createEngineeringMemory(input: EngineeringMemoryInput): EngineeringMemory {
  const parsed = engineeringMemoryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Engineering memory is not valid — ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') })) },
    );
  }
  const value = parsed.data;

  if (value.origin === MemoryOrigin.EXTRACTED && value.derivedFrom.length === 0) {
    // An extracted memory with no evidence is exactly the thing this Epic
    // exists to make impossible: a claim with nothing behind it.
    throw invalid('An extracted memory must name the captures it came from', {
      sessionId: value.sessionId,
      kind: value.kind,
    });
  }

  // Redacted here rather than by the caller — EPIC-112.
  //
  // `memory-extraction.ts` always did this, and its comment said why: a secret
  // "is redacted before it becomes a memory rather than after". The *explicit*
  // path had no such caller. `ferret session remember --statement …` passed a
  // person's text through untouched and `ferret_session_recall` handed it to an
  // AI client, so the one path a human types into was the one path that did not
  // redact. Doing it in the constructor is what makes "a memory cannot carry a
  // credential" true of every caller rather than of the careful ones.
  //
  // Before truncation, so a secret straddling the limit cannot survive as a
  // prefix, and before the id is derived, so the identifier is over the text
  // that is actually stored.
  //
  // The caller's own count is added to rather than replaced: extraction
  // redacts first and reports what it removed, and running redaction again over
  // already-redacted text finds nothing more — a count it had earned would
  // otherwise be lost here.
  const cleanedStatement = redactSecrets(value.statement);
  const cleanedRationale = value.rationale === undefined ? undefined : redactSecrets(value.rationale);
  const redactedSecrets =
    value.redactedSecrets + cleanedStatement.redacted + (cleanedRationale?.redacted ?? 0);

  const truncated = cleanedStatement.text.length > MAX_STATEMENT_LENGTH;
  const statement = truncated
    ? `${cleanedStatement.text.slice(0, MAX_STATEMENT_LENGTH - 1)}…`
    : cleanedStatement.text;

  const memory: Omit<EngineeringMemory, 'id' | 'contentHash'> = {
    sessionId: value.sessionId,
    kind: value.kind,
    statement,
    rationale: cleanedRationale?.text,
    origin: value.origin,
    rule: value.rule,
    confidence: ORIGIN_CONFIDENCE[value.origin],
    derivedFrom: [...value.derivedFrom].sort((a, b) => a.sequence - b.sequence),
    recordedAt: value.recordedAt,
    redactedSecrets,
    truncated,
    supersededBy: undefined,
    supersedes: undefined,
  };

  return {
    ...memory,
    id: canonicalId(engineeringMemoryKey(value.sessionId, value.kind, statement)),
    contentHash: contentHash({
      sessionId: memory.sessionId,
      kind: memory.kind,
      statement: memory.statement,
      rationale: memory.rationale ?? null,
      origin: memory.origin,
    }),
  };
}

/**
 * Replaces one memory with another, retaining both.
 *
 * A decision reversed later is not deleted: "why did we change our mind" is
 * worth answering, and deleting the first half makes it unanswerable.
 */
export function supersede(
  original: EngineeringMemory,
  replacement: EngineeringMemory,
): { original: EngineeringMemory; replacement: EngineeringMemory } {
  if (original.id === replacement.id) {
    throw invalid('A memory cannot supersede itself', { memoryId: original.id });
  }
  return {
    original: { ...original, supersededBy: replacement.id },
    replacement: { ...replacement, supersedes: original.id },
  };
}
