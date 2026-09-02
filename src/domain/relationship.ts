import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';

import { canonicalId, canonicalInstant, contentHash, encodeKeyParts } from './identity.js';
import { EntityKind } from './kinds.js';

/**
 * Typed, directed, temporal relationships.
 *
 * Ferret's value is not in holding entities but in knowing how they relate over
 * time: which commit fixed which issue, which release contains it, who reviewed
 * it, which branch it landed on. That is what EPIC-007 models.
 *
 * Two properties shape everything here:
 *
 * **Relationships are bitemporal.** A relationship has a *valid* interval —
 * when the fact was true in the world — and separately the times Ferret learned
 * and last confirmed it. EPIC-007 AC-6 requires temporal queries to distinguish
 * observed time from indexed time, and one timestamp cannot do it: a commit
 * authored last year and indexed today is not a fact about today.
 *
 * **History coexists with the present.** Closing a relationship sets `validTo`;
 * it never deletes the row. "Which branch did this used to point at" stays
 * answerable, which is the whole reason for recording time at all.
 */

/**
 * Relationship types the core ships.
 *
 * Each declares which entity kinds it may connect, which is how AC-4 —
 * "branch and worktree relationships remain distinct" — is enforced
 * structurally rather than by convention. `WORKTREE_CHECKS_OUT_BRANCH` and
 * `REPOSITORY_CONTAINS_BRANCH` cannot be confused, because a worktree cannot
 * appear on either end of the latter.
 *
 * Names read `SUBJECT_VERB_OBJECT` so the direction is unambiguous at every
 * call site. A relationship is directed: `a CONTAINS b` is not `b CONTAINS a`.
 */
export const RelationshipType = {
  // Structure
  REPOSITORY_CONTAINS_BRANCH: 'repository_contains_branch',
  REPOSITORY_CONTAINS_WORKTREE: 'repository_contains_worktree',
  REPOSITORY_CONTAINS_FILE: 'repository_contains_file',
  REPOSITORY_CONTAINS_COMMIT: 'repository_contains_commit',
  /** Distinct from containment: a worktree *holds* a branch, transiently. */
  WORKTREE_CHECKS_OUT_BRANCH: 'worktree_checks_out_branch',
  BRANCH_POINTS_TO_COMMIT: 'branch_points_to_commit',

  // History
  COMMIT_PARENT_OF_COMMIT: 'commit_parent_of_commit',
  COMMIT_MODIFIES_FILE: 'commit_modifies_file',
  COMMIT_PRODUCES_FILE_VERSION: 'commit_produces_file_version',
  FILE_HAS_VERSION: 'file_has_version',

  // People and agents
  DEVELOPER_AUTHORED_COMMIT: 'developer_authored_commit',
  /**
   * A non-human actor authored a commit — EPIC-036.
   *
   * Separate from the developer edge rather than widening it. EPIC-009 made the
   * two identity classes distinct because "who wrote this code" and "which
   * machine touched this file" are different questions; a single edge that
   * accepted both would make the distinction unqueryable at exactly the point
   * it matters.
   */
  AGENT_AUTHORED_COMMIT: 'agent_authored_commit',
  DEVELOPER_REVIEWED_PULL_REQUEST: 'developer_reviewed_pull_request',
  AGENT_RAN_SESSION: 'agent_ran_session',
  DEVELOPER_RAN_SESSION: 'developer_ran_session',
  SESSION_TOUCHED_FILE: 'session_touched_file',
  SESSION_WORKED_ON_ISSUE: 'session_worked_on_issue',

  // Change management
  PULL_REQUEST_PROPOSES_COMMIT: 'pull_request_proposes_commit',
  PULL_REQUEST_TARGETS_BRANCH: 'pull_request_targets_branch',
  PULL_REQUEST_RESOLVES_ISSUE: 'pull_request_resolves_issue',
  REVIEW_REVIEWS_PULL_REQUEST: 'review_reviews_pull_request',
  COMMIT_RESOLVES_ISSUE: 'commit_resolves_issue',

  // Delivery
  RELEASE_INCLUDES_COMMIT: 'release_includes_commit',
  DEPLOYMENT_DEPLOYS_RELEASE: 'deployment_deploys_release',

  // Knowledge
  EVIDENCE_SUPPORTS_ENTITY: 'evidence_supports_entity',
  DOCUMENT_DESCRIBES_ENTITY: 'document_describes_entity',
  /** A rename, or two identities resolved into one. */
  ENTITY_SUPERSEDES_ENTITY: 'entity_supersedes_entity',
} as const;

export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

/** `undefined` on either end means "any kind", used by the generic types. */
export interface RelationshipTypeDefinition {
  readonly type: string;
  readonly fromKinds: readonly string[] | undefined;
  readonly toKinds: readonly string[] | undefined;
  /** Whether the core ships this type. Registered types report false. */
  readonly builtIn: boolean;
  /**
   * Whether an entity may hold only one open relationship of this type at a
   * time.
   *
   * A branch points at exactly one commit; a worktree has at most one branch
   * checked out. Asserting a new one closes the previous, which is what turns a
   * stream of observations into a history rather than a pile of contradictions.
   */
  readonly exclusiveFrom: boolean;
}

const ANY = undefined;

const BUILT_IN: ReadonlyArray<
  readonly [RelationshipType, readonly string[] | undefined, readonly string[] | undefined, boolean]
> = [
  [RelationshipType.REPOSITORY_CONTAINS_BRANCH, [EntityKind.REPOSITORY], [EntityKind.BRANCH], false],
  [RelationshipType.REPOSITORY_CONTAINS_WORKTREE, [EntityKind.REPOSITORY], [EntityKind.WORKTREE], false],
  [RelationshipType.REPOSITORY_CONTAINS_FILE, [EntityKind.REPOSITORY], [EntityKind.FILE], false],
  [RelationshipType.REPOSITORY_CONTAINS_COMMIT, [EntityKind.REPOSITORY], [EntityKind.COMMIT], false],
  [RelationshipType.WORKTREE_CHECKS_OUT_BRANCH, [EntityKind.WORKTREE], [EntityKind.BRANCH], true],
  [RelationshipType.BRANCH_POINTS_TO_COMMIT, [EntityKind.BRANCH], [EntityKind.COMMIT], true],

  [RelationshipType.COMMIT_PARENT_OF_COMMIT, [EntityKind.COMMIT], [EntityKind.COMMIT], false],
  [RelationshipType.COMMIT_MODIFIES_FILE, [EntityKind.COMMIT], [EntityKind.FILE], false],
  [RelationshipType.COMMIT_PRODUCES_FILE_VERSION, [EntityKind.COMMIT], [EntityKind.FILE_VERSION], false],
  [RelationshipType.FILE_HAS_VERSION, [EntityKind.FILE], [EntityKind.FILE_VERSION], false],

  [RelationshipType.DEVELOPER_AUTHORED_COMMIT, [EntityKind.DEVELOPER], [EntityKind.COMMIT], false],
  [RelationshipType.AGENT_AUTHORED_COMMIT, [EntityKind.AGENT], [EntityKind.COMMIT], false],
  [RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST, [EntityKind.DEVELOPER], [EntityKind.PULL_REQUEST], false],
  [RelationshipType.AGENT_RAN_SESSION, [EntityKind.AGENT], [EntityKind.SESSION], false],
  [RelationshipType.DEVELOPER_RAN_SESSION, [EntityKind.DEVELOPER], [EntityKind.SESSION], false],
  [RelationshipType.SESSION_TOUCHED_FILE, [EntityKind.SESSION], [EntityKind.FILE], false],
  [RelationshipType.SESSION_WORKED_ON_ISSUE, [EntityKind.SESSION], [EntityKind.ISSUE], false],

  [RelationshipType.PULL_REQUEST_PROPOSES_COMMIT, [EntityKind.PULL_REQUEST], [EntityKind.COMMIT], false],
  [RelationshipType.PULL_REQUEST_TARGETS_BRANCH, [EntityKind.PULL_REQUEST], [EntityKind.BRANCH], true],
  [RelationshipType.PULL_REQUEST_RESOLVES_ISSUE, [EntityKind.PULL_REQUEST], [EntityKind.ISSUE], false],
  [RelationshipType.REVIEW_REVIEWS_PULL_REQUEST, [EntityKind.REVIEW], [EntityKind.PULL_REQUEST], true],
  [RelationshipType.COMMIT_RESOLVES_ISSUE, [EntityKind.COMMIT], [EntityKind.ISSUE], false],

  [RelationshipType.RELEASE_INCLUDES_COMMIT, [EntityKind.RELEASE], [EntityKind.COMMIT], false],
  [RelationshipType.DEPLOYMENT_DEPLOYS_RELEASE, [EntityKind.DEPLOYMENT], [EntityKind.RELEASE], true],

  [RelationshipType.EVIDENCE_SUPPORTS_ENTITY, [EntityKind.EVIDENCE], ANY, false],
  [RelationshipType.DOCUMENT_DESCRIBES_ENTITY, [EntityKind.DOCUMENT], ANY, false],
  [RelationshipType.ENTITY_SUPERSEDES_ENTITY, ANY, ANY, false],
];

const registry = new Map<string, RelationshipTypeDefinition>();
for (const [type, fromKinds, toKinds, exclusiveFrom] of BUILT_IN) {
  registry.set(type, { type, fromKinds, toKinds, builtIn: true, exclusiveFrom });
}

export const RELATIONSHIP_TYPES: readonly RelationshipType[] = Object.freeze(
  Object.values(RelationshipType),
);

/** Type names are lowercase snake_case, like entity kinds. */
export const RELATIONSHIP_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface RegisterRelationshipTypeOptions {
  readonly fromKinds?: readonly string[];
  readonly toKinds?: readonly string[];
  readonly exclusiveFrom?: boolean;
}

/**
 * Registers a relationship type a provider needs.
 *
 * The same extensibility contract as entity kinds: nothing downstream branches
 * on type, so a provider can add one without a core change.
 */
export function registerRelationshipType(
  type: string,
  options: RegisterRelationshipTypeOptions = {},
): void {
  if (!RELATIONSHIP_TYPE_PATTERN.test(type)) {
    throw new FerretError(ErrorCode.USAGE, `"${type}" is not a valid relationship type name`, {
      details: { type },
      remediation: 'Relationship types are lowercase snake_case, e.g. `pipeline_builds_commit`.',
    });
  }
  if (registry.has(type)) {
    throw new FerretError(ErrorCode.USAGE, `Relationship type "${type}" is already registered`, {
      details: { type },
      remediation: 'Choose a distinct type name rather than redefining an existing one.',
    });
  }
  registry.set(type, {
    type,
    fromKinds: options.fromKinds,
    toKinds: options.toKinds,
    builtIn: false,
    exclusiveFrom: options.exclusiveFrom ?? false,
  });
}

export function relationshipTypeDefinition(type: string): RelationshipTypeDefinition | undefined {
  return registry.get(type);
}

export function registeredRelationshipTypes(): readonly RelationshipTypeDefinition[] {
  return [...registry.values()];
}

/** Test seam: forgets types registered at runtime, keeping the built-ins. */
export function resetRelationshipTypeRegistry(): void {
  for (const [type, definition] of [...registry.entries()]) {
    if (!definition.builtIn) registry.delete(type);
  }
}

/**
 * The end of time.
 *
 * A relationship that is still true has no `validTo`. Representing that as
 * `null` rather than a sentinel date keeps "is this current" a simple predicate
 * and stops a far-future date from being mistaken for a real observation.
 */
export const OPEN_INTERVAL = null;

export const relationshipInputSchema = z
  .object({
    fromId: z.string().min(1),
    type: z.string().regex(RELATIONSHIP_TYPE_PATTERN, 'Relationship types are lowercase snake_case'),
    toId: z.string().min(1),
    /** Kinds of the endpoints, so the type's constraints can be checked. */
    fromKind: z.string().min(1).optional(),
    toKind: z.string().min(1).optional(),
    /**
     * When the relationship became true in the world.
     *
     * Not when Ferret learned it. Defaults to the moment of assertion only
     * because a provider that cannot say is better served by an honest "as far
     * as Ferret knows, from now" than by a fabricated past.
     */
    validFrom: z.iso.datetime({ offset: true }).optional(),
    /** When it stopped being true. Absent means it still is. */
    validTo: z.iso.datetime({ offset: true }).optional(),
    /** Anything the source said about the relationship itself. */
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** Which system observed it, so a relationship stays source-traceable. */
    sourceSystem: z.string().min(1),
    /** Optional identifier of the observation within that system. */
    sourceId: z.string().min(1).optional(),
  })
  .strict();

export type RelationshipInput = z.input<typeof relationshipInputSchema>;

export interface CanonicalRelationship {
  readonly id: string;
  readonly fromId: string;
  readonly type: string;
  readonly toId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceSystem: string;
  readonly sourceId: string | undefined;
  readonly contentHash: string;
}

/**
 * The identity of one relationship *assertion*.
 *
 * `validFrom` is part of it, deliberately. The same edge can be true over
 * several disjoint periods — a file removed from a directory and later restored,
 * a branch checked out, detached, and checked out again — and identity without
 * time would collapse those into one, making the history unrepresentable.
 */
export function relationshipKey(fromId: string, type: string, toId: string, validFrom: string): string {
  return encodeKeyParts(['relationship', fromId, type, toId, validFrom]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.RELATIONSHIP_INVALID, message, { details, remediation });
}

/**
 * Validates an input and derives the canonical relationship.
 *
 * @throws {FerretError} `E_RELATIONSHIP_INVALID`. Endpoint kinds are checked
 * against the type's declared constraints when the caller supplies them, which
 * is what makes "a worktree cannot be contained the way a branch is" a rule
 * rather than a convention.
 */
export function createRelationship(
  input: RelationshipInput,
  now: Date = new Date(),
): CanonicalRelationship {
  const parsed = relationshipInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Relationship is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields.',
    );
  }

  const value = parsed.data;
  const definition = registry.get(value.type);
  if (definition === undefined) {
    throw invalid(
      `Relationship type "${value.type}" is not registered`,
      { type: value.type },
      'Register the type with registerRelationshipType() before using it.',
    );
  }

  if (value.fromKind !== undefined && definition.fromKinds !== undefined && !definition.fromKinds.includes(value.fromKind)) {
    throw invalid(
      `"${value.type}" cannot start at a ${value.fromKind}`,
      { type: value.type, fromKind: value.fromKind, allowed: definition.fromKinds },
      `Allowed source kinds: ${definition.fromKinds.join(', ')}.`,
    );
  }
  if (value.toKind !== undefined && definition.toKinds !== undefined && !definition.toKinds.includes(value.toKind)) {
    throw invalid(
      `"${value.type}" cannot end at a ${value.toKind}`,
      { type: value.type, toKind: value.toKind, allowed: definition.toKinds },
      `Allowed target kinds: ${definition.toKinds.join(', ')}.`,
    );
  }

  // A self-loop is almost always a provider bug — a commit is not its own
  // parent — and letting one in produces traversals that never terminate.
  if (value.fromId === value.toId) {
    throw invalid(
      `A relationship cannot connect an entity to itself`,
      { type: value.type, entityId: value.fromId },
      'Check the provider mapping: both endpoints resolved to the same canonical entity.',
    );
  }

  const validFrom = value.validFrom ?? now.toISOString();
  const validTo = value.validTo ?? OPEN_INTERVAL;

  if (validTo !== null && new Date(validTo) < new Date(validFrom)) {
    throw invalid(
      'A relationship cannot stop being true before it started',
      { validFrom, validTo },
      'Check the timestamps the provider supplied.',
    );
  }

  const key = relationshipKey(value.fromId, value.type, value.toId, validFrom);

  return Object.freeze({
    id: canonicalId(key),
    fromId: value.fromId,
    type: value.type,
    toId: value.toId,
    validFrom,
    validTo,
    metadata: Object.freeze(value.metadata),
    sourceSystem: value.sourceSystem,
    sourceId: value.sourceId,
    contentHash: contentHash({
      fromId: value.fromId,
      type: value.type,
      toId: value.toId,
      // Canonicalised for the same reason as an entity's `sourceObservedAt`:
      // both columns are `timestamptz` and normalise what they are given. The
      // *key* above keeps the original spelling, deliberately — it is a stored
      // identifier, and renormalising it would re-point every relationship.
      validFrom: canonicalInstant(validFrom),
      validTo: canonicalInstant(validTo),
      metadata: value.metadata,
      sourceSystem: value.sourceSystem,
      sourceId: value.sourceId ?? null,
    }),
  });
}

/** True when the relationship was true at `at`. */
export function isValidAt(relationship: Pick<CanonicalRelationship, 'validFrom' | 'validTo'>, at: Date): boolean {
  const from = new Date(relationship.validFrom);
  if (at < from) return false;
  if (relationship.validTo === null) return true;
  // The interval is half-open: a relationship that ended at T was not true *at*
  // T. Without that, closing one interval and opening another at the same
  // instant would make both true simultaneously.
  return at < new Date(relationship.validTo);
}

/** True when the relationship has not been closed. */
export function isOpen(relationship: Pick<CanonicalRelationship, 'validTo'>): boolean {
  return relationship.validTo === null;
}
