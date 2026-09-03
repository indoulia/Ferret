import { z } from 'zod';

import { ErrorCode, FerretError, redact } from '../errors/index.js';

import { canonicalId, canonicalInstant, contentHash, encodeKeyParts, stableStringify } from './identity.js';

/**
 * Evidence and provenance.
 *
 * Governance §6 draws the line this module exists to keep: Ferret must
 * distinguish *observed source evidence* from *derived or AI-generated
 * knowledge*, must not silently rewrite the former, and must never manufacture
 * certainty. EPIC-008 makes that structural rather than aspirational.
 *
 * Three ideas do most of the work:
 *
 * - **Evidence is immutable in content.** A new observation is a new record, not
 *   an edit. What Ferret may change is its own *interpretation* — whether a
 *   record is still current — never what was observed. The integrity hash covers
 *   only the immutable half, so a superseded record can still be verified.
 * - **Derivation is recorded, not implied.** A fact Ferret worked out from other
 *   facts says so, names what produced it and at which version, and links to the
 *   evidence it came from. "Why do you believe this" is then a query rather than
 *   an archaeology exercise.
 * - **Not-knowing is representable.** `unknown` confidence, `partial`
 *   completeness and an `unavailable` state are first-class. A model that can
 *   only say "true" will eventually say it about something it never checked.
 */

/** How Ferret came to hold this. */
export const EvidenceMethod = {
  /** Read directly from the source. The strongest kind. */
  OBSERVED: 'observed',
  /** Extracted from source content by a parser. */
  PARSED: 'parsed',
  /** Worked out from other evidence — a heuristic, a join, a rule. */
  INFERRED: 'inferred',
  /** Produced by a model. Never conflated with observation. */
  GENERATED: 'generated',
  /** Stated by a person or an operator. */
  ASSERTED: 'asserted',
  /** Summed, counted or rolled up from other evidence. */
  AGGREGATED: 'aggregated',
} as const;

export type EvidenceMethod = (typeof EvidenceMethod)[keyof typeof EvidenceMethod];

export const EVIDENCE_METHODS: readonly EvidenceMethod[] = Object.freeze(Object.values(EvidenceMethod));

/** Methods whose content Ferret read rather than worked out. */
const DIRECT_METHODS: ReadonlySet<string> = new Set([EvidenceMethod.OBSERVED, EvidenceMethod.PARSED]);

/** True when this evidence records something Ferret saw rather than concluded. */
export function isDirectObservation(method: string): boolean {
  return DIRECT_METHODS.has(method);
}

/**
 * Ferret's current view of a piece of evidence.
 *
 * Mutable, unlike the evidence itself — this is Ferret's interpretation, not the
 * observation. Governance §6 requires stale, partial, unavailable, unknown and
 * conflicting to be representable, and this is where most of that lives.
 */
export const EvidenceState = {
  /** Believed to still hold. */
  CURRENT: 'current',
  /** The source has changed since this was observed. */
  STALE: 'stale',
  /** A newer observation of the same fact replaced it. */
  SUPERSEDED: 'superseded',
  /** Another current record disagrees, and Ferret has not resolved which wins. */
  CONFLICTING: 'conflicting',
  /** The source could not be reached when Ferret last tried. */
  UNAVAILABLE: 'unavailable',
} as const;

export type EvidenceState = (typeof EvidenceState)[keyof typeof EvidenceState];

export const EVIDENCE_STATES: readonly EvidenceState[] = Object.freeze(Object.values(EvidenceState));

/**
 * How much of the fact this evidence covers.
 *
 * `partial` is the important one: a parser that extracted three of five sheets
 * has evidence, but not the whole answer, and a retrieval that treats it as
 * complete will confidently omit things.
 */
export const Completeness = {
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
} as const;

export type Completeness = (typeof Completeness)[keyof typeof Completeness];

/**
 * Where in a source a fact was found.
 *
 * Deliberately open: a line range in a file, a page in a PDF, a cell in a
 * spreadsheet, a byte offset, a JSON pointer, a commit. Governance §6 asks for
 * source *location* wherever applicable, and a shape that fits every format
 * would fit none of them well.
 */
export const evidenceLocatorSchema = z
  .object({
    /** What kind of location this is: `line`, `page`, `cell`, `byte`, `path`. */
    kind: z.string().min(1),
    /** First position, inclusive. Semantics depend on `kind`. */
    start: z.union([z.number(), z.string()]).optional(),
    /** Last position, inclusive. */
    end: z.union([z.number(), z.string()]).optional(),
    /** Free-form detail: a sheet name, a selector, a section heading. */
    detail: z.string().optional(),
  })
  .strict();

export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;

export const evidenceInputSchema = z
  .object({
    /** The entity this is evidence about. */
    subjectId: z.string().min(1),
    /**
     * Which fact within the subject, as a dotted path — `attributes.title`.
     *
     * Omitted means the evidence is about the entity as a whole. Recording the
     * field is what makes conflict detection possible: two records disagreeing
     * about a title are a conflict, two records about different fields are not.
     */
    field: z.string().min(1).optional(),
    /** What was observed or concluded. */
    statement: z.unknown(),

    method: z.enum(EVIDENCE_METHODS as [EvidenceMethod, ...EvidenceMethod[]]),
    /** What produced this — a parser, a provider, a model. */
    producer: z.string().min(1),
    /**
     * The producer's version.
     *
     * Governance §21 requires parsers, models and extraction mechanisms to be
     * versioned where changes affect reproducibility. Without it, "re-extract
     * everything the old PDF parser touched" is unanswerable.
     */
    producerVersion: z.string().min(1),

    sourceSystem: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    sourceUrl: z.string().min(1).optional(),
    locator: evidenceLocatorSchema.optional(),
    /**
     * Hash of the source content this was read from.
     *
     * What makes staleness detectable: when the source's content hash no longer
     * matches, the evidence describes something that no longer exists.
     */
    sourceContentHash: z.string().min(1).optional(),

    /**
     * 0..1, or omitted for unknown.
     *
     * Omitted is not the same as zero. Zero says "believed false"; omitted says
     * "not assessed", and Governance §6 forbids collapsing the two.
     */
    confidence: z.number().min(0).max(1).optional(),
    completeness: z.enum([Completeness.COMPLETE, Completeness.PARTIAL, Completeness.UNKNOWN]).default(
      Completeness.UNKNOWN,
    ),
    /** Rank of the source's authority. EPIC-045 owns the policy. */
    authority: z.number().int().default(0),

    /** When the source says the fact was true. */
    observedAt: z.iso.datetime({ offset: true }).optional(),

    /** Evidence this was derived from, forming the provenance chain. */
    derivedFrom: z.array(z.string().min(1)).default([]),

    /**
     * An opaque token naming who may see this.
     *
     * EPIC-058 and EPIC-083 enforce it; EPIC-008 carries it, so permission is
     * attached to the evidence rather than inferred at query time from where it
     * happened to be stored.
     */
    permissionScope: z.string().min(1).optional(),

    /**
     * Whether this field holds one fact or a set of them.
     *
     * `single` — the default and the common case — means a later observation of
     * the same field by the same source *replaces* the earlier one: a branch has
     * one head commit, a file has one path.
     *
     * `collection` means the field is a set and each row is a member. Three
     * shipping producers write one: a row per resolved reference, and a row per
     * closing reference in a pull request body. Superseding those collapsed the
     * set to whichever member was written last, marked the rest "replaced by a
     * newer observation" — which was false, they are different facts — and then
     * rendered the loss to a caller as "a current record covers `references`".
     *
     * Declared by the producer rather than inferred here, because cardinality is
     * a property of the fact being recorded and nothing at this layer can see
     * it. It is not stored: it directs how this write is applied, and a field
     * whose kind changed between builds would be a producer defect rather than
     * something to persist.
     */
    cardinality: z.enum(['single', 'collection']).default('single'),
  })
  .strict();

export type EvidenceInput = z.input<typeof evidenceInputSchema>;

export interface CanonicalEvidence {
  readonly id: string;
  /**
   * How this field's cardinality was declared, when a producer said.
   *
   * A **write directive**, not a stored fact: it travels from the producer to
   * the store so that evidence emitted through the SDK's `Emitter` — which
   * builds a canonical record before anything writes it — does not lose it on
   * the way. A record read back from the database has no cardinality, because
   * the column does not exist and the directive has already been applied.
   *
   * Excluded from the integrity hash, deliberately: it describes how the write
   * is applied rather than what was observed, and including it would make two
   * identical observations hash differently.
   */
  readonly cardinality?: 'single' | 'collection';
  readonly subjectId: string;
  readonly field: string | undefined;
  readonly statement: unknown;
  readonly method: EvidenceMethod;
  readonly producer: string;
  readonly producerVersion: string;
  readonly sourceSystem: string;
  readonly sourceId: string | undefined;
  readonly sourceUrl: string | undefined;
  readonly locator: EvidenceLocator | undefined;
  readonly sourceContentHash: string | undefined;
  readonly confidence: number | undefined;
  readonly completeness: Completeness;
  readonly authority: number;
  readonly observedAt: string | undefined;
  readonly derivedFrom: readonly string[];
  readonly permissionScope: string | undefined;
  /**
   * Hash over the immutable content only.
   *
   * State, and the fact that something later superseded this, are Ferret's
   * interpretation rather than the observation, so they are excluded — a
   * superseded record must still verify, or integrity checking would be useless
   * exactly where history matters most.
   */
  readonly integrityHash: string;
  /** True when a secret-shaped value was masked before storage. */
  readonly redacted: boolean;
}

/**
 * Removes anything credential-shaped from evidence content.
 *
 * EPIC-008's security requirement: credentials and secrets must never be stored
 * as evidence content *merely because they were encountered*. Ferret indexes
 * configuration files, environment dumps and logs, and will encounter them.
 *
 * The result is deliberately not "drop the fact". Recording that a token was
 * present at a location, with the token masked, is more useful than recording
 * nothing — and far more useful than recording the token. The existing
 * redaction is reused rather than reimplemented, so evidence is protected by the
 * same rules as logs and errors.
 *
 * EPIC-082 adds entropy-based detection for secrets that do not match a known
 * shape.
 */
export function redactStatement(statement: unknown): { statement: unknown; redacted: boolean } {
  const cleaned = redact(statement);
  return { statement: cleaned, redacted: stableStringify(cleaned) !== stableStringify(statement) };
}

/**
 * The identity of one piece of evidence.
 *
 * Everything that makes an observation *this* observation: what it is about,
 * what it says, where it came from, and what produced it. Two identical
 * observations therefore deduplicate rather than accumulating — re-indexing an
 * unchanged file must not multiply its evidence — while a different producer or
 * a different version is a genuinely different observation and stays separate.
 */
export function evidenceKey(input: {
  subjectId: string;
  field: string | undefined;
  statement: unknown;
  method: string;
  producer: string;
  producerVersion: string;
  sourceSystem: string;
  sourceId: string | undefined;
  locator: EvidenceLocator | undefined;
}): string {
  return encodeKeyParts([
    'evidence',
    input.subjectId,
    input.field ?? '',
    stableStringify(input.statement),
    input.method,
    input.producer,
    input.producerVersion,
    input.sourceSystem,
    input.sourceId ?? '',
    input.locator === undefined ? '' : stableStringify(input.locator),
  ]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.EVIDENCE_INVALID, message, { details, remediation });
}

/**
 * Validates an input and derives the canonical evidence record.
 *
 * @throws {FerretError} `E_EVIDENCE_INVALID`. Rejected values are never echoed:
 * evidence content comes from sources Ferret does not trust, and may be the very
 * secret this module exists to keep out of the record.
 */
export function createEvidence(input: EvidenceInput): CanonicalEvidence {
  const parsed = evidenceInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Evidence is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields.',
    );
  }

  const value = parsed.data;

  // A derived fact that names nothing it derived from cannot be traced, which
  // is the whole point of recording derivation.
  if (!isDirectObservation(value.method) && value.method !== EvidenceMethod.ASSERTED) {
    if (value.derivedFrom.length === 0) {
      throw invalid(
        `Evidence produced by "${value.method}" must name the evidence it was derived from`,
        { method: value.method, producer: value.producer },
        'Pass `derivedFrom` with the ids of the evidence this conclusion rests on, or record it as `observed`/`parsed` if it was read directly.',
      );
    }
  }

  const { statement, redacted } = redactStatement(value.statement);

  const key = evidenceKey({
    subjectId: value.subjectId,
    field: value.field,
    statement,
    method: value.method,
    producer: value.producer,
    producerVersion: value.producerVersion,
    sourceSystem: value.sourceSystem,
    sourceId: value.sourceId,
    locator: value.locator,
  });

  // Hashed through `integrityHashOf`, not through a second copy of its field
  // list — EPIC-094.
  //
  // This function used to build its own `immutable` object and hash that, so
  // the write path and the verify path were two implementations of one hash,
  // thirty lines apart. They drifted exactly as that arrangement predicts:
  // canonicalising `observedAt` in one of them left every record with a
  // non-UTC observation unverifiable, and the check had been silently failing
  // on those rows before that. One definition, used twice.
  const immutable = {
    subjectId: value.subjectId,
    field: value.field,
    statement,
    method: value.method,
    producer: value.producer,
    producerVersion: value.producerVersion,
    sourceSystem: value.sourceSystem,
    sourceId: value.sourceId,
    sourceUrl: value.sourceUrl,
    locator: value.locator,
    sourceContentHash: value.sourceContentHash,
    confidence: value.confidence,
    completeness: value.completeness,
    authority: value.authority,
    observedAt: value.observedAt,
    derivedFrom: value.derivedFrom,
    permissionScope: value.permissionScope,
  };

  return Object.freeze({
    id: canonicalId(key),
    // Only when a producer declared it, so an ordinary record is unchanged and
    // two identical observations still compare equal.
    ...(value.cardinality === 'collection' ? { cardinality: 'collection' as const } : {}),
    subjectId: value.subjectId,
    field: value.field,
    statement,
    method: value.method,
    producer: value.producer,
    producerVersion: value.producerVersion,
    sourceSystem: value.sourceSystem,
    sourceId: value.sourceId,
    sourceUrl: value.sourceUrl,
    locator: value.locator,
    sourceContentHash: value.sourceContentHash,
    confidence: value.confidence,
    completeness: value.completeness,
    authority: value.authority,
    observedAt: value.observedAt,
    derivedFrom: Object.freeze([...value.derivedFrom].sort()),
    permissionScope: value.permissionScope,
    integrityHash: integrityHashOf(immutable),
    redacted,
  });
}

/**
 * Recomputes the integrity hash of a stored record.
 *
 * The check EPIC-008 AC-6 asks for. A mismatch means the row was altered outside
 * Ferret — evidence is append-only through this module, so nothing legitimate
 * changes it after it is written.
 */
export function integrityHashOf(evidence: Omit<CanonicalEvidence, 'integrityHash' | 'redacted' | 'id'>): string {
  return contentHash({
    subjectId: evidence.subjectId,
    field: evidence.field ?? null,
    statement: evidence.statement,
    method: evidence.method,
    producer: evidence.producer,
    producerVersion: evidence.producerVersion,
    sourceSystem: evidence.sourceSystem,
    sourceId: evidence.sourceId ?? null,
    sourceUrl: evidence.sourceUrl ?? null,
    locator: evidence.locator ?? null,
    sourceContentHash: evidence.sourceContentHash ?? null,
    confidence: evidence.confidence ?? null,
    completeness: evidence.completeness,
    authority: evidence.authority,
    // Canonicalised — see `canonicalInstant`. Same round-trip asymmetry as an
    // entity's `sourceObservedAt`, and the same consequence: without this the
    // integrity hash cannot be recomputed from the row it protects.
    observedAt: canonicalInstant(evidence.observedAt),
    derivedFrom: [...evidence.derivedFrom].sort(),
    permissionScope: evidence.permissionScope ?? null,
  });
}

/**
 * A record paired with Ferret's current interpretation of whether it holds.
 *
 * `CanonicalEvidence` deliberately carries no `state`: the observation is
 * append-only and immutable, while state is Ferret's revisable reading of it, and
 * the integrity hash excludes it so a superseded record still verifies. The pair
 * lives here rather than in either the store or the consumer because both need
 * it and neither owns it — evidence selection (EPIC-062) cannot prefer a current
 * record over a replaced one without being handed both halves.
 *
 * `state` is optional: undefined means *unassessed* — a caller that did not read
 * it — which is neither current nor replaced, and is ranked as neither.
 */
export interface StatedEvidence {
  readonly evidence: CanonicalEvidence;
  readonly state?: EvidenceState | undefined;
  readonly supersededBy?: string | undefined;
}

export interface ConflictGroup {
  readonly subjectId: string;
  readonly field: string | undefined;
  /** Current records that disagree about the same fact. */
  readonly evidence: readonly CanonicalEvidence[];
  /** The distinct statements in play, for reporting. */
  readonly statements: readonly unknown[];
}

/**
 * Groups current evidence that disagrees about the same fact.
 *
 * Governance §6 requires conflict to be representable and Governance §15 forbids
 * silently discarding conflicting evidence. Detection is deliberately separate
 * from *resolution*: EPIC-045 decides which source wins, EPIC-047 acts on it.
 * Here, disagreement is simply reported — which is also the honest answer when
 * no authority rule applies.
 */
export function detectConflicts(evidence: readonly CanonicalEvidence[]): ConflictGroup[] {
  const groups = new Map<string, CanonicalEvidence[]>();
  for (const record of evidence) {
    const key = `${record.subjectId}\u0000${record.field ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  const conflicts: ConflictGroup[] = [];
  for (const list of groups.values()) {
    const statements = new Map<string, unknown>();
    for (const record of list) statements.set(stableStringify(record.statement), record.statement);
    if (statements.size <= 1) continue;

    // EPIC-047 §8.1. A conflict is disagreement between *sources*; one source
    // restating a field is supersession, which is what EPIC-057 §8.4 decided for
    // `preferredEvidence` and this is the same rule one layer down. Keyed on
    // `sourceSystem` and not on `producer`, exactly as that rule keys it, so the
    // two cannot drift.
    //
    // Measured on Ferret's own index: both of the two groups this used to report
    // were `branch.attributes.headCommit`, one of them with **twenty** current
    // records, because a branch's head moves with every commit and nothing had
    // ever superseded the earlier readings. `ferret_why` on `main` reported a
    // twenty-way conflict about where `main` points.
    if (new Set(list.map((record) => record.sourceSystem)).size <= 1) continue;

    const first = list[0];
    if (first === undefined) continue;
    conflicts.push({
      subjectId: first.subjectId,
      field: first.field,
      evidence: [...list],
      statements: [...statements.values()],
    });
  }
  return conflicts;
}

// `preferredEvidence` now lives in `authority.ts`, beside the scale it ranks by
// — EPIC-057 §8.4. It was here because evidence is what it takes; it belongs
// there because authority is what it decides with, and EPIC-045 owns that
// policy. Still exported from `domain/index.ts` under the same name.
