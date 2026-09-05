import { z } from 'zod';

import {
  MAX_STATEMENT_LENGTH,
  MEMORY_KINDS,
  contentHash,
  createEntity,
  entityKindDefinition,
  registerEntityKind,
  registerRelationshipType,
  type CanonicalEntity,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { redactSecrets } from '../security/index.js';

/**
 * Durable context — EPIC-126.
 *
 * Evidence is keyed on *who observed it*; durable context is keyed on *what is
 * said*. That change of key is the whole merge: two agents writing the same
 * statement derive the same id, so merging costs a hash rather than a scan.
 * `engineeringMemoryKey` contains the session, which is why two sessions
 * recording one decision produce two rows today.
 */

/** Registered, not built-in — EPIC-006 AC-4. */
export const DURABLE_CONTEXT_KIND = 'context';
export const DURABLE_CONTEXT_SYSTEM = 'ferret';

/** EPIC-042's memory vocabulary plus `fact`, so promotion is a mapping. */
export const ContextKind = {
  DECISION: 'decision',
  CONSTRAINT: 'constraint',
  PREFERENCE: 'preference',
  GOTCHA: 'gotcha',
  NEXT_STEP: 'next-step',
  FACT: 'fact',
} as const;

export type ContextKind = (typeof ContextKind)[keyof typeof ContextKind];

export const CONTEXT_KINDS: readonly ContextKind[] = Object.freeze(Object.values(ContextKind));

export function isContextKind(value: unknown): value is ContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value);
}

/** The assignment is the proof: it fails to compile if a memory kind leaves. */
export const MEMORY_CONTEXT_KINDS: readonly ContextKind[] = MEMORY_KINDS;

/**
 * Crossing this writes a relationship, never a merge — so a false positive
 * costs an edge, not a belief. Chosen, not tuned, and not configurable.
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.8;

/** How many stored records one write may compare itself against. */
export const MAX_CANDIDATES = 25;

/**
 * NFKC, case-folded, separator punctuation dropped, whitespace collapsed,
 * terminal punctuation dropped. Nothing else — stemming or a synonym table
 * would silently merge two beliefs.
 *
 * Separator punctuation is `,;:` **only where a space or the end follows**, so
 * `1,000` and `src:main` keep theirs. Dogfooding EPIC-126 against this
 * repository's own records found the case: four wordings of one constraint
 * converged to two records, and the pair that stayed apart differed by one
 * comma. Considered and rejected: dropping punctuation everywhere, which
 * changes what a statement contains rather than how it is spelled.
 */
export function normalizeStatement(statement: string): string {
  return statement
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[,;:](?=\s|$)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?;:,]+$/u, '')
    .trim();
}

export function statementTokens(normalized: string): ReadonlySet<string> {
  return new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0));
}

/** Jaccard overlap, in [0, 1]. Two empty sets share nothing, not everything. */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export const MergeVerdict = {
  /** One statement, because the two derive the same id. */
  SAME: 'same',
  /** Close enough to relate, never close enough to merge. */
  NEAR: 'near',
  DISTINCT: 'distinct',
} as const;

export type MergeVerdict = (typeof MergeVerdict)[keyof typeof MergeVerdict];

export interface PairVerdict {
  readonly verdict: MergeVerdict;
  readonly similarity: number;
}

/** `same` is decided by identity alone, never by a score. */
export function classifyPair(a: DurableContext, b: DurableContext): PairVerdict {
  if (a.entity.id === b.entity.id) return { verdict: MergeVerdict.SAME, similarity: 1 };
  const score = similarity(statementTokens(a.normalized), statementTokens(b.normalized));
  return {
    verdict: score >= NEAR_DUPLICATE_SIMILARITY ? MergeVerdict.NEAR : MergeVerdict.DISTINCT,
    similarity: score,
  };
}

/**
 * Detectable only when a producer named a `subjectId` on both. Without one,
 * calling two statements rivals would be a guess — Governance §6.
 */
export function contradicts(a: DurableContext, b: DurableContext): boolean {
  if (a.entity.id === b.entity.id) return false;
  if (a.subjectId === undefined || a.subjectId !== b.subjectId) return false;
  if (a.contextKind !== b.contextKind) return false;
  return classifyPair(a, b).verdict === MergeVerdict.NEAR;
}

export const durableContextAttributes = z
  .object({
    /** The first writer's wording. */
    statement: z.string().min(1).max(MAX_STATEMENT_LENGTH),
    contextKind: z.enum(CONTEXT_KINDS as [ContextKind, ...ContextKind[]]),
    /** Stored so the id is recomputable from the row it identifies. */
    normalized: z.string().min(1),
    subjectId: z.string().min(1).optional(),
  })
  .strict();

export type DurableContextAttributes = z.infer<typeof durableContextAttributes>;

export const CONTEXT_RELATES_TO_CONTEXT = 'context_relates_to_context';
export const CONTEXT_CONTRADICTS_CONTEXT = 'context_contradicts_context';
export const CONTEXT_CONCERNS_ENTITY = 'context_concerns_entity';

/**
 * The `code_symbol` pattern — a registered kind needs no core change, and its
 * edges belong beside it. Neither relation is exclusive: a statement resembles
 * as many others as it resembles.
 */
export function registerDurableContextKind(): void {
  if (entityKindDefinition(DURABLE_CONTEXT_KIND) !== undefined) return;
  registerEntityKind(DURABLE_CONTEXT_KIND, durableContextAttributes);
  registerRelationshipType(CONTEXT_RELATES_TO_CONTEXT, {
    fromKinds: [DURABLE_CONTEXT_KIND],
    toKinds: [DURABLE_CONTEXT_KIND],
  });
  registerRelationshipType(CONTEXT_CONTRADICTS_CONTEXT, {
    fromKinds: [DURABLE_CONTEXT_KIND],
    toKinds: [DURABLE_CONTEXT_KIND],
  });
  registerRelationshipType(CONTEXT_CONCERNS_ENTITY, { fromKinds: [DURABLE_CONTEXT_KIND] });
}

export interface DurableContextInput {
  readonly statement: string;
  readonly contextKind: ContextKind;
  /** Part of identity: same words, different subject. */
  readonly subjectId?: string | undefined;
  /**
   * A repository id, or absent. Part of identity — a statement true of one
   * repository need not be true of another. `retrieval/access.ts` reads the
   * same field for visibility.
   */
  readonly scope?: string | undefined;
}

export interface DurableContext {
  readonly entity: CanonicalEntity;
  readonly statement: string;
  readonly normalized: string;
  readonly contextKind: ContextKind;
  readonly subjectId: string | undefined;
  readonly scope: string | undefined;
  /** Credential-shaped values masked before the id was derived. */
  readonly redactedSecrets: number;
}

/**
 * Over the normalized text, kind and subject — never the producer, session or
 * time. Those belong to an observation and live on the evidence.
 */
export function durableContextSourceId(
  contextKind: ContextKind,
  subjectId: string | undefined,
  normalized: string,
): string {
  return contentHash({ contextKind, subjectId: subjectId ?? null, normalized });
}

/**
 * Credentials are removed before the id is derived — an identifier is the one
 * field no later redaction can reach.
 *
 * @throws {FerretError} `E_ENTITY_INVALID` when nothing survives normalization,
 * or when the statement is over {@link MAX_STATEMENT_LENGTH}. Refused rather
 * than truncated: truncating changes what a record says while keeping its id.
 */
export function createDurableContext(input: DurableContextInput): DurableContext {
  const cleaned = redactSecrets(input.statement);
  const statement = cleaned.text.trim();
  const normalized = normalizeStatement(statement);

  if (normalized.length === 0) {
    throw new FerretError(ErrorCode.ENTITY_INVALID, 'A durable context statement cannot be empty', {
      details: { contextKind: input.contextKind },
      remediation: 'Record a statement with content.',
    });
  }
  if (statement.length > MAX_STATEMENT_LENGTH) {
    throw new FerretError(
      ErrorCode.ENTITY_INVALID,
      `A durable context statement may be at most ${String(MAX_STATEMENT_LENGTH)} characters`,
      {
        details: { contextKind: input.contextKind, length: statement.length },
        remediation: 'Record the durable statement rather than the material it came from.',
      },
    );
  }

  const attributes: DurableContextAttributes = {
    statement,
    contextKind: input.contextKind,
    normalized,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
  };

  const entity = createEntity({
    kind: DURABLE_CONTEXT_KIND,
    source: {
      system: DURABLE_CONTEXT_SYSTEM,
      id: durableContextSourceId(input.contextKind, input.subjectId, normalized),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    },
    attributes,
  });

  return {
    entity,
    statement,
    normalized,
    contextKind: input.contextKind,
    subjectId: input.subjectId,
    scope: input.scope,
    redactedSecrets: cleaned.redacted,
  };
}

/** Reads a stored entity back as durable context. */
export function durableContextOf(entity: CanonicalEntity): DurableContext {
  if (entity.kind !== DURABLE_CONTEXT_KIND) {
    throw new FerretError(ErrorCode.ENTITY_INVALID, `Entity ${entity.id} is not durable context`, {
      details: { entityId: entity.id, kind: entity.kind },
      remediation: 'Read durable context through the context store, which selects by kind.',
    });
  }
  const attributes = durableContextAttributes.parse(entity.attributes);
  return {
    entity,
    statement: attributes.statement,
    normalized: attributes.normalized,
    contextKind: attributes.contextKind,
    subjectId: attributes.subjectId,
    scope: entity.source.scope,
    redactedSecrets: 0,
  };
}
