import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';

import { canonicalId, encodeKeyParts } from './identity.js';
import { EntityKind } from './kinds.js';

/**
 * Actors, and the identities they are known by.
 *
 * An *actor* is whoever did something: a person, or an AI client, bot or CI
 * runner. EPIC-009 requires the two to be **distinct identity classes**, and the
 * reason is practical rather than taxonomic — "who wrote this code" and "which
 * agent touched this file" are different questions, and an answer that silently
 * merges them is wrong in a way nobody notices until they act on it.
 *
 * One actor is usually known by several external identities: a person commits
 * as two email addresses and reviews under a GitHub login. Mapping those onto
 * one canonical actor is *reconciliation*, and it is a judgement rather than a
 * fact — so EPIC-009 requires it to carry auditable evidence, to detect
 * collisions instead of merging silently, and to retain history when a mapping
 * changes. All three are the difference between a knowledge base and a guess.
 */

export const ActorClass = {
  /** A human contributor. */
  DEVELOPER: 'developer',
  /** An AI client, bot or CI runner. */
  AGENT: 'agent',
} as const;

export type ActorClass = (typeof ActorClass)[keyof typeof ActorClass];

export const ACTOR_CLASSES: readonly ActorClass[] = Object.freeze(Object.values(ActorClass));

export function isActorClass(value: unknown): value is ActorClass {
  return typeof value === 'string' && (ACTOR_CLASSES as readonly string[]).includes(value);
}

/** The entity kind an actor class is stored as. */
export function entityKindForActor(actorClass: ActorClass): EntityKind {
  return actorClass === ActorClass.DEVELOPER ? EntityKind.DEVELOPER : EntityKind.AGENT;
}

/** The actor class an entity kind represents, or `undefined` if it is neither. */
export function actorClassForKind(kind: string): ActorClass | undefined {
  if (kind === EntityKind.DEVELOPER) return ActorClass.DEVELOPER;
  if (kind === EntityKind.AGENT) return ActorClass.AGENT;
  return undefined;
}

export const identityAliasInputSchema = z
  .object({
    /** The system the identity belongs to: `git`, `github`, `jira`, `ferret`. */
    system: z.string().min(1),
    /** The identity as that system expresses it: an email, a login, a bot id. */
    externalId: z.string().min(1),
    /** The canonical actor entity this identity resolves to. */
    actorId: z.string().min(1),
    actorClass: z.enum(ACTOR_CLASSES as [ActorClass, ...ActorClass[]]),
    /**
     * The evidence supporting the mapping.
     *
     * EPIC-009 AC-3 requires reconciliation to be *auditable*. Two email
     * addresses belonging to one person is a conclusion, and a conclusion whose
     * basis is not recorded cannot be reviewed or reversed.
     */
    evidenceId: z.string().min(1).optional(),
    /** 0..1, or omitted for unknown — never defaulted, per Governance §6. */
    confidence: z.number().min(0).max(1).optional(),
    /** When the mapping became true. Defaults to the moment it is asserted. */
    validFrom: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type IdentityAliasInput = z.input<typeof identityAliasInputSchema>;

export interface IdentityAlias {
  readonly id: string;
  readonly system: string;
  readonly externalId: string;
  readonly actorId: string;
  readonly actorClass: ActorClass;
  readonly evidenceId: string | undefined;
  readonly confidence: number | undefined;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * The identity of one alias *assertion*.
 *
 * Includes `validFrom`, for the same reason relationships do (EPIC-007 D-004):
 * a mapping can be true, then wrong, then true again — an address reassigned
 * within an organisation, a bot account handed to a different service. Identity
 * without time collapses those and loses the history AC-6 requires.
 */
export function aliasKey(system: string, externalId: string, actorId: string, validFrom: string): string {
  return encodeKeyParts(['identity-alias', system, externalId, actorId, validFrom]);
}

function invalid(message: string, details: Record<string, unknown>, remediation: string): FerretError {
  return new FerretError(ErrorCode.IDENTITY_INVALID, message, { details, remediation });
}

export function createIdentityAlias(input: IdentityAliasInput, now: Date = new Date()): IdentityAlias {
  const parsed = identityAliasInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid(
      `Identity alias is not valid — ${parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ')}`,
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), rule: issue.code })) },
      'Correct the reported fields.',
    );
  }

  const value = parsed.data;
  const validFrom = value.validFrom ?? now.toISOString();

  return Object.freeze({
    id: canonicalId(aliasKey(value.system, value.externalId, value.actorId, validFrom)),
    system: value.system,
    externalId: value.externalId,
    actorId: value.actorId,
    actorClass: value.actorClass,
    evidenceId: value.evidenceId,
    confidence: value.confidence,
    validFrom,
    validTo: null,
  });
}

/**
 * Two actors both claiming one external identity.
 *
 * EPIC-009 AC-5 requires collisions to be **detected rather than silently
 * merged**, and the distinction matters: merging on the assumption that one
 * address means one person is how two people who once shared a shell account
 * become one contributor, permanently and invisibly. Reporting the collision
 * leaves the judgement where it belongs.
 */
export interface IdentityCollision {
  readonly system: string;
  readonly externalId: string;
  /** The mapping already on record. */
  readonly existingActorId: string;
  /** The mapping that was just asserted. */
  readonly proposedActorId: string;
  /** True when the two actors are of different classes, which is never valid. */
  readonly crossesActorClass: boolean;
}

/**
 * Guards the developer/agent boundary.
 *
 * A collision between two developers may be a genuine reconciliation question.
 * A collision between a developer and an agent is not: they are distinct
 * identity classes, and merging them would answer "who wrote this" with a bot.
 *
 * @throws {FerretError} `E_IDENTITY_INVALID` when the classes differ.
 */
export function assertSameActorClass(a: ActorClass, b: ActorClass, context: Record<string, unknown>): void {
  if (a === b) return;
  throw invalid(
    `Cannot reconcile a ${a} with an ${b} — developers and agents are distinct identity classes`,
    { ...context, actorClasses: [a, b] },
    'If a human and an automation share an address, model them as two actors. Merging them would answer "who wrote this" with a bot.',
  );
}
