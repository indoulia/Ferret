import { ActorClass, type ScopeSelector } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { PUBLIC_ACCESS, type AccessContext } from '../retrieval/index.js';
import { effectiveExclusions, type FerretConfig } from '../config/index.js';

/**
 * Who is asking, and what they may do — EPIC-068.
 *
 * EPIC-059/065's validation stated the position without softening it: "**No
 * authorization: every indexed thing is reachable by any client that can spawn
 * the process.** stdio limits the blast radius to whoever can already run
 * commands as that user, but it is not an authorization model."
 *
 * Three things were waiting on this. Every MCP tool is read-only *by omission*,
 * which is a safe default and not a model — the moment one mutating tool is
 * wanted there is nothing to hang the decision on, and EPIC-066 is exactly that
 * tool. EPIC-058 enforces permission scopes correctly against a grant that is
 * always empty, because "there is no principal whose scopes could be looked up".
 * And EPIC-036's identity proposals "currently go nowhere … merging needs an
 * authorization decision (EPIC-068)".
 *
 * **This authorizes; it cannot authenticate.** Ferret is spawned over stdio by
 * the client it serves, so there is no channel on which that client could
 * present a credential Ferret could verify. A principal is asserted by
 * configuration on the machine and trusted because the operating system already
 * trusts whoever can run the process. That is a real limit; the specification
 * §16 states it rather than dressing it up. What this prevents is a *configured*
 * client exceeding its grant.
 */

/**
 * What a caller may ask Ferret to do.
 *
 * Coarse on purpose, at the granularity a decision is actually made rather than
 * one permission per tool: a vocabulary with thirty entries is a vocabulary
 * nobody configures correctly, and Governance §2 makes simplicity a product
 * requirement.
 *
 * Distinct from `Capability`, which is about *providers* — what a plugin can do —
 * and has nothing to say about what a caller may ask for.
 */
export const Permission = {
  /** Read indexed knowledge: search, lookup, traversal, evidence, packs. */
  READ: 'read',
  /** Read what Ferret is configured to do. Not to change it. */
  CONFIG_READ: 'config.read',
  /** Change configuration — EPIC-066's permission. */
  CONFIG_WRITE: 'config.write',
  /** Index or re-index a source. */
  INDEX: 'index',
  /**
   * Change canonical knowledge: merge identities, resolve a conflict, retract.
   *
   * The decision EPIC-036's proposals are waiting on. Never granted by default,
   * and holding it is still not enough on its own — a destructive operation also
   * requires EPIC-069's confirmation.
   */
  MUTATE: 'mutate',
  /** Administer providers — EPIC-067's permission. */
  PROVIDER_ADMIN: 'provider.admin',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const PERMISSIONS: readonly Permission[] = Object.freeze(Object.values(Permission));

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * What kind of caller this is.
 *
 * Reuses EPIC-009's `ActorClass` words rather than inventing a parallel set, so
 * a principal's class and an indexed actor's class are the same vocabulary — and
 * a future "which agent asked for this" question does not need a translation
 * table between two enums that mean the same thing.
 */
export const PrincipalClass = {
  /** A person operating Ferret directly, through the CLI. */
  OPERATOR: 'operator',
  /** An AI client over MCP. The primary interface, per Governance §3. */
  AI_CLIENT: ActorClass.AGENT,
  /** Unattended: a scheduler, a hook, CI. */
  AUTOMATION: 'automation',
} as const;

export type PrincipalClass = (typeof PrincipalClass)[keyof typeof PrincipalClass];

export interface Principal {
  /** Stable identifier, for a log line and a denial. Never a credential. */
  readonly id: string;
  readonly class: PrincipalClass;
  /** What this principal was granted. Anything absent is denied. */
  readonly permissions: readonly Permission[];
  /**
   * Permission scopes this principal holds — EPIC-058.
   *
   * The value that closes that Epic's stated hole: it enforced scopes correctly
   * against a set nothing ever populated. Opaque tokens, compared and never
   * parsed (EPIC-083 owns meaning).
   */
  readonly permittedScopes: readonly string[];
  /** Which repositories, worktrees and sessions this principal may see. */
  readonly scope: ScopeSelector;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  /**
   * Why, in a form a person can check.
   *
   * Names the **permission**, never the thing being reached. "You may not
   * configure" is a fact about the caller; "you may not read `/etc/shadow`" is a
   * fact about the data, and a denial that leaks one is worse than the access it
   * refused.
   */
  readonly reason: string;
}

/**
 * The principal a process gets when nothing granted it anything.
 *
 * `READ` and nothing else. Everything Ferret indexes today is unscoped local
 * source the caller could read with `cat`, and Governance §3 makes the AI client
 * the primary interface — so denying reads out of the box would cost every user
 * something and protect nobody. Every other permission is denied, which is why
 * EPIC-066 and EPIC-067 cannot exist by accident.
 *
 * That `READ` is granted at all is a decision rather than a finding;
 * specification §16 records it.
 */
export const ANONYMOUS_PRINCIPAL: Principal = Object.freeze({
  id: 'ferret.anonymous',
  class: PrincipalClass.AI_CLIENT,
  permissions: Object.freeze([Permission.READ]),
  permittedScopes: Object.freeze([]),
  scope: Object.freeze({ include: [], exclude: [] }),
});

/**
 * Whether this principal may do this.
 *
 * Pure: same principal and permission in, same decision out. An authorization
 * decision that cannot be reproduced cannot be reviewed, and a decision that
 * consulted a clock or a database would be a different decision on every call.
 *
 * Deny by default, and the consequence is deliberate: a permission added to the
 * vocabulary later is denied for every existing principal until granted, which is
 * the only safe direction for that change.
 */
export function authorize(principal: Principal, permission: Permission): AuthorizationDecision {
  if (principal.permissions.includes(permission)) {
    return { allowed: true, reason: `${principal.id} is granted ${permission}` };
  }
  return {
    allowed: false,
    // The permission and the principal's id only. No target, no path, no scope,
    // no configuration value — see `AuthorizationDecision.reason`.
    reason: `${principal.id} is not granted ${permission}`,
  };
}

/**
 * Refuses an operation the principal was not granted.
 *
 * An **error**, not an empty result — the opposite of EPIC-058's rule for
 * withheld content, and deliberately so. Retrieval withholds *part* of an answer
 * and must stay answerable; an unpermitted operation did not happen at all, and
 * returning success for it would be a lie.
 *
 * `operation` names what was refused for the log and the remediation. It must not
 * name a *target*: `NOT_PERMITTED` is returned identically whether or not the
 * target exists, so a refusal cannot be used to probe for one.
 *
 * @throws {FerretError} `E_NOT_PERMITTED`
 */
export function assertPermitted(
  principal: Principal,
  permission: Permission,
  operation: string,
): void {
  const decision = authorize(principal, permission);
  if (decision.allowed) return;

  throw new FerretError(ErrorCode.NOT_PERMITTED, `Not permitted: ${operation}`, {
    details: { principal: principal.id, permission, operation },
    remediation:
      `Grant "${permission}" to this principal in Ferret's configuration ` +
      '(`authorization.permissions`), then restart the client.',
  });
}

/**
 * What this principal's grant means on the retrieval path — EPIC-058.
 *
 * The **only** conversion, so a scope granted for reading and a scope enforced on
 * reading cannot drift apart. Exclusions come from configuration rather than from
 * the principal because exclusion is additive and one-way (EPIC-003): a principal
 * cannot be granted *less* exclusion, and letting one carry its own would be a
 * way to ask for more.
 */
export function accessContextFor(principal: Principal, config?: FerretConfig): AccessContext {
  return {
    ...PUBLIC_ACCESS,
    permittedScopes: principal.permittedScopes,
    scope: principal.scope,
    ...(config === undefined ? {} : { exclusions: effectiveExclusions(config) }),
  };
}

/**
 * The grant this configuration declares.
 *
 * The one place a grant is read, and it reads **only** configuration —
 * Governance §12: nothing a client sends and nothing Ferret indexed can widen
 * it. Absent configuration yields {@link ANONYMOUS_PRINCIPAL} rather than
 * everything, because a Ferret nobody configured should be the restricted one.
 *
 * Refuses a malformed grant here rather than narrowing or widening it silently.
 * An operator whose permission is misspelled must hear about it at startup: a
 * typo that quietly denied would look like a broken product, and one that
 * quietly allowed would be worse.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` when the grant names something unknown.
 */
export function principalFrom(config: FerretConfig): Principal {
  const declared = config.authorization;
  if (declared === undefined) return ANONYMOUS_PRINCIPAL;

  const unknown = declared.permissions.filter((candidate) => !isPermission(candidate));
  if (unknown.length > 0) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Configuration grants unknown permission(s): ${unknown.join(', ')}`,
      {
        details: { unknown, known: [...PERMISSIONS] },
        remediation: `Use one of: ${PERMISSIONS.join(', ')}.`,
      },
    );
  }

  return Object.freeze({
    id: declared.principalId,
    class: declared.principalClass,
    // Sorted and deduplicated so two configurations that grant the same thing
    // produce the same principal, which is what makes a decision reproducible.
    permissions: Object.freeze([...new Set(declared.permissions)].sort() as Permission[]),
    permittedScopes: Object.freeze([...new Set(declared.permittedScopes)].sort()),
    scope: Object.freeze({
      include: [...(declared.scope?.include ?? [])],
      exclude: [...(declared.scope?.exclude ?? [])],
    }),
  });
}
