import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';

import { ENTITY_ATTRIBUTE_SCHEMAS } from './attributes.js';
import { canonicalId, canonicalInstant, canonicalKey, contentHash, UUID_PATTERN } from './identity.js';
import { LifecycleState, isEntityKind, lifecycleStateSchema, type EntityKind } from './kinds.js';

/**
 * The canonical entity.
 *
 * One shape for every kind. Repositories, issues and file versions differ in
 * their `attributes`, not in their structure — which is what lets retrieval,
 * provenance and relationships be written once rather than sixteen times, and
 * what lets a provider add a kind without a core redesign (EPIC-006 AC-4).
 *
 * The model draws three lines that the rest of Ferret depends on:
 *
 * - **Canonical attributes** are what Ferret understands provider-neutrally and
 *   validates strictly.
 * - **Unknown fields** are everything else the source returned, retained
 *   verbatim and never validated. AC-5 requires unsupported source fields to be
 *   retained *without corrupting the canonical model*; keeping them in a
 *   separate box is how both halves of that are satisfied at once.
 * - **External ids** keep every source identifier traceable (AC-3), including
 *   the ones from other systems that refer to the same thing.
 */

/** The version of the canonical entity envelope itself. EPIC-010 owns changes. */
export const ENTITY_SCHEMA_VERSION = 1;

/**
 * Where an entity came from.
 *
 * `system` is the provider's stable identifier (`git`, `github`, `jira`), not a
 * hostname: two GitHub Enterprise installations are both `github`, and what
 * distinguishes their objects is `id` and `scope`.
 */
export const entitySourceSchema = z
  .object({
    system: z.string().min(1),
    id: z.string().min(1),
    /** A stable link back to the object, when one exists. */
    url: z.string().min(1).optional(),
    /** The entity this one is identified within — see `canonicalKey`. */
    scope: z.string().min(1).optional(),
  })
  .strict();

export type EntitySource = z.infer<typeof entitySourceSchema>;

/**
 * An identifier another system uses for the same thing.
 *
 * This is what makes cross-source questions answerable: a commit known to Git by
 * its SHA and to GitHub by a node id is one entity with two external ids, so
 * "which release contains the fix for FER-12" can be traversed without asking
 * either system at query time. EPIC-051 (Cross-Source Entity Resolution) decides
 * *when* two identifiers denote the same thing; EPIC-006 provides the place to
 * record it.
 */
export const externalIdSchema = z
  .object({
    system: z.string().min(1),
    id: z.string().min(1),
    url: z.string().min(1).optional(),
  })
  .strict();

export type ExternalId = z.infer<typeof externalIdSchema>;

/** Kind names are lowercase snake_case, so they are stable across systems. */
export const ENTITY_KIND_PATTERN = /^[a-z][a-z0-9_]*$/;

/** What a caller supplies to create or update an entity. */
export const entityInputSchema = z
  .object({
    /**
     * Validated for *shape* here and for *existence* against the registry, not
     * against a fixed list of the built-in kinds.
     *
     * An enum here would make `registerEntityKind` a lie: a provider could
     * register a kind and still have every entity of it rejected by the
     * envelope before the registry was ever consulted. EPIC-006 AC-4 requires
     * extensions not to need a core change, and a hard-coded enum is exactly
     * the core change it forbids.
     */
    kind: z.string().regex(ENTITY_KIND_PATTERN, 'Entity kinds are lowercase snake_case'),
    source: entitySourceSchema,
    lifecycle: lifecycleStateSchema.default(LifecycleState.ACTIVE),
    /** Validated against the schema for `kind`. */
    attributes: z.record(z.string(), z.unknown()).default({}),
    /** Retained verbatim. Never validated, never interpreted. */
    unknownFields: z.record(z.string(), z.unknown()).default({}),
    externalIds: z.array(externalIdSchema).default([]),
    /**
     * When the *source* says the object last changed.
     *
     * Distinct from when Ferret indexed it. EPIC-007 builds temporal queries on
     * that distinction; recording only the indexing time would make "what did
     * this look like last Tuesday" unanswerable.
     */
    sourceObservedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type EntityInput = z.input<typeof entityInputSchema>;

export interface CanonicalEntity {
  /** Derived from {@link canonicalKey}; stable across re-ingestion. */
  readonly id: string;
  /**
   * A built-in kind, or one a provider registered.
   *
   * Typed as the union plus `string` rather than the union alone: narrowing to
   * the built-ins would be a type that says extensions are impossible, which is
   * the opposite of what the registry provides. The union half keeps
   * autocomplete useful for the sixteen kinds the core ships.
   */
  readonly kind: EntityKind | (string & {});
  readonly canonicalKey: string;
  readonly schemaVersion: number;
  readonly source: EntitySource;
  readonly lifecycle: LifecycleState;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly unknownFields: Readonly<Record<string, unknown>>;
  readonly externalIds: readonly ExternalId[];
  readonly sourceObservedAt: string | undefined;
  /** Fingerprint of the canonical content, for change detection. */
  readonly contentHash: string;
}

/**
 * A kind Ferret knows how to validate.
 *
 * The registry is what makes the model extensible. A provider that needs a kind
 * the core does not ship registers one, and everything downstream — persistence,
 * relationships, retrieval — works unchanged because nothing else branches on
 * kind.
 */
export interface EntityKindDefinition {
  readonly kind: string;
  readonly schema: z.ZodType;
  /** Whether the core ships this kind. Registered kinds report false. */
  readonly builtIn: boolean;
}

const registry = new Map<string, EntityKindDefinition>();

for (const [kind, schema] of Object.entries(ENTITY_ATTRIBUTE_SCHEMAS)) {
  registry.set(kind, { kind, schema, builtIn: true });
}

/**
 * Registers an entity kind.
 *
 * @throws {FerretError} `E_USAGE` when the kind is already registered.
 * Silently replacing one would let a provider redefine `commit` and change what
 * every other provider's data validates against.
 */
export function registerEntityKind(kind: string, schema: z.ZodType): void {
  if (registry.has(kind)) {
    throw new FerretError(ErrorCode.USAGE, `Entity kind "${kind}" is already registered`, {
      details: { kind },
      remediation: 'Choose a distinct kind name, or extend the existing schema through its owning Epic.',
    });
  }
  registry.set(kind, { kind, schema, builtIn: false });
}

export function entityKindDefinition(kind: string): EntityKindDefinition | undefined {
  return registry.get(kind);
}

export function registeredEntityKinds(): readonly EntityKindDefinition[] {
  return [...registry.values()];
}

/** Test seam: forgets kinds registered at runtime, keeping the built-ins. */
export function resetEntityKindRegistry(): void {
  for (const [kind, definition] of [...registry.entries()]) {
    if (!definition.builtIn) registry.delete(kind);
  }
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.ENTITY_INVALID, message, { details, remediation });
}

/**
 * Validates an input and derives the canonical entity from it.
 *
 * Everything that makes an entity canonical happens here and nowhere else: the
 * id is derived, the attributes are validated against the kind, the fingerprint
 * is computed. A caller cannot construct a half-canonical entity by assembling
 * the fields itself, which is what keeps ids stable across every ingestion path.
 *
 * @throws {FerretError} `E_ENTITY_INVALID`, naming the failing paths. Rejected
 * *values* are never echoed: an entity can carry content from a repository
 * Ferret does not trust.
 */
export function createEntity(input: EntityInput): CanonicalEntity {
  const parsed = entityInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Entity is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields. Source fields Ferret does not model belong in `unknownFields`, which is retained verbatim.',
    );
  }

  const value = parsed.data;
  const definition = registry.get(value.kind);
  if (definition === undefined) {
    throw invalid(
      `Entity kind "${value.kind}" is not registered`,
      { kind: value.kind, registered: [...registry.keys()] },
      'Register the kind with registerEntityKind() before creating entities of it.',
    );
  }

  const attributes = definition.schema.safeParse(value.attributes);
  if (!attributes.success) {
    throw invalid(
      `Attributes for ${value.kind} are not valid — ${attributes.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      {
        kind: value.kind,
        issues: attributes.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          rule: issue.code,
        })),
      },
      'A field Ferret does not model is not an error — put it in `unknownFields` instead of `attributes`.',
    );
  }

  const key = canonicalKey({
    kind: value.kind,
    sourceSystem: value.source.system,
    sourceId: value.source.id,
    scope: value.source.scope,
  });

  const canonicalAttributes = attributes.data as Record<string, unknown>;

  const created: CanonicalEntity = {
    id: canonicalId(key),
    kind: value.kind,
    canonicalKey: key,
    schemaVersion: ENTITY_SCHEMA_VERSION,
    source: value.source,
    lifecycle: value.lifecycle,
    attributes: Object.freeze(canonicalAttributes),
    unknownFields: Object.freeze(value.unknownFields),
    externalIds: Object.freeze(dedupeExternalIds(value.externalIds)),
    sourceObservedAt: value.sourceObservedAt,
    // Fingerprints everything a change could alter. Ingestion timestamps are
    // excluded deliberately: re-indexing an unchanged object must not look like
    // a change (Governance §10).
    contentHash: contentHash({
      kind: value.kind,
      lifecycle: value.lifecycle,
      attributes: canonicalAttributes,
      unknownFields: value.unknownFields,
      externalIds: dedupeExternalIds(value.externalIds),
      source: value.source,
      // Canonicalised — see `canonicalInstant`. The column normalises this to
      // UTC, so hashing the source's own spelling made the hash unrecomputable
      // from the row it describes.
      sourceObservedAt: canonicalInstant(value.sourceObservedAt),
    }),
  };
  return Object.freeze(created);
}

/** Removes duplicate external ids, keeping the first and sorting for stability. */
function dedupeExternalIds(ids: readonly ExternalId[]): ExternalId[] {
  const seen = new Map<string, ExternalId>();
  for (const id of ids) {
    const key = `${id.system}\u0000${id.id}`;
    if (!seen.has(key)) seen.set(key, id);
  }
  // Sorted so two ingestions that report the same ids in a different order
  // produce the same content hash.
  return [...seen.values()].sort((a, b) =>
    a.system === b.system ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.system < b.system ? -1 : 1,
  );
}

/** True when two entities are the same logical thing with the same content. */
export function isUnchanged(a: CanonicalEntity, b: CanonicalEntity): boolean {
  return a.id === b.id && a.contentHash === b.contentHash;
}

/** Validates a value read back from storage. Guards against a corrupted row. */
export function assertCanonicalEntity(value: unknown): asserts value is CanonicalEntity {
  if (typeof value !== 'object' || value === null) {
    throw invalid('Entity must be an object', { received: typeof value }, 'Re-index the source object.');
  }
  const entity = value as Partial<CanonicalEntity>;
  if (typeof entity.id !== 'string' || !UUID_PATTERN.test(entity.id)) {
    throw invalid('Entity id is not a canonical identifier', { id: String(entity.id) }, 'Re-index the source object.');
  }
  if (!isEntityKind(entity.kind) && !registry.has(String(entity.kind))) {
    throw invalid(
      `Entity kind "${String(entity.kind)}" is not registered`,
      { kind: String(entity.kind) },
      'Register the kind, or re-index with a build that ships it.',
    );
  }
}
