import { createHash, randomBytes } from 'node:crypto';

import { auditValue } from '../config/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * Whether a destructive operation was *intended* — EPIC-069.
 *
 * Governance §12 states the requirement in one line and does not qualify it:
 * "Destructive operations require explicit confirmation." EPIC-068 built the
 * other half of that control and deliberately stopped: its §4 excludes "the
 * confirmation prompt for a destructive operation — EPIC-069. This Epic decides
 * whether an operation is permitted; EPIC-069 decides whether it was *intended*,
 * and both must hold." `MUTATE` and `CONFIG_WRITE` exist, are denied by default,
 * and gate nothing.
 *
 * **This confirms an operation; it cannot confirm a person.** Ferret is spawned
 * over stdio by the client it serves, and there is no channel on which a human
 * could answer it. So what the gate guarantees is narrower than "someone agreed",
 * and specification §16 states it exactly rather than dressing it up: the effect
 * was disclosed before it happened, nothing happened on the call that disclosed
 * it, what happened was bound by digest to what was disclosed, and the confirming
 * value came from Ferret's CSPRNG — so it could not have come from indexed
 * content, from a tool argument, or from a model. A repository that can write
 * arbitrary text cannot write a confirmation. That last property is the one that
 * makes this hold under EPIC-084's threat model.
 *
 * Beside authorization rather than in `security/` for the reason EPIC-068 gave:
 * `security/` holds *content* controls, which the canonical model itself needs,
 * and this is a *caller* control that only the surfaces a caller reaches need.
 * In its own file because it differs from `authorize` in one important way — a
 * decision is pure, and this necessarily holds state.
 */

/** What a single effect would do to a single thing. */
export const EffectChange = {
  /** A value that was not set becomes set. */
  SET: 'set',
  /** A value that was already set is replaced. The destructive one. */
  OVERWRITE: 'overwrite',
  /** A value is removed. */
  UNSET: 'unset',
  /** An entity or record is removed. */
  DELETE: 'delete',
  /** Two things become one, and the second stops existing separately. */
  MERGE: 'merge',
} as const;

export type EffectChange = (typeof EffectChange)[keyof typeof EffectChange];

export interface PlannedEffect {
  /**
   * What would change, named the way an operator names it: a configuration path,
   * an entity id, a provider name.
   *
   * Also how {@link ConfirmationGate.request} decides whether a value is secret —
   * `auditValue` classifies by the path's last segment, so `database.password`
   * discloses a redaction and `database.host` discloses a host.
   */
  readonly target: string;
  readonly change: EffectChange;
  /** What is there now, if anything. Redacted on disclosure. */
  readonly from?: unknown;
  /** What would be there afterwards, if anything. Redacted on disclosure. */
  readonly to?: unknown;
}

/**
 * What a destructive operation would do, disclosed before it is done.
 *
 * Built by the operation, not by the gate: §4 excludes deciding for itself
 * whether something is destructive, because a mechanism that classified
 * operations it cannot see would be guessing.
 */
export interface OperationPlan {
  /** The operation, dotted and stable: `config.set`, `identity.merge`. */
  readonly operation: string;
  /** One sentence in Ferret's words. Never interpolates indexed content. */
  readonly summary: string;
  readonly effects: readonly PlannedEffect[];
}

/** An effect as it is disclosed: rendered, and redacted. */
export interface DisclosedEffect {
  readonly target: string;
  readonly change: EffectChange;
  readonly from?: string;
  readonly to?: string;
}

/** The plan as it is disclosed. */
export interface DisclosedPlan {
  readonly operation: string;
  readonly summary: string;
  readonly effects: readonly DisclosedEffect[];
}

export interface ConfirmationRequest {
  /** Always true. A client branching on one field should find this one. */
  readonly confirmationRequired: true;
  /**
   * What to present to perform the operation.
   *
   * 256 bits from `crypto.randomBytes`. Unguessable is the whole mechanism: a
   * token that could be derived from the plan would let anything that can write
   * text into a repository confirm its own destructive operation.
   */
  readonly token: string;
  readonly expiresAt: string;
  /** Redacted. Safe to show a model and a person. */
  readonly plan: DisclosedPlan;
  readonly howToConfirm: string;
}

/** Five minutes: long enough for one exchange, far too short to be a capability. */
export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** A ceiling, so a long-lived stdio server cannot accumulate them without limit. */
export const DEFAULT_MAX_PENDING_CONFIRMATIONS = 16;

export interface ConfirmationGateOptions {
  readonly ttlMs?: number;
  readonly maxPending?: number;
  /**
   * Injected so expiry is tested rather than waited for.
   *
   * Same shape as EPIC-079's rate limiter, which had the same need.
   */
  readonly now?: () => number;
}

/**
 * The digest a token is bound to.
 *
 * Computed over the **true** plan, not the redacted disclosure, and the direction
 * matters: two different passwords redact to the same string, so binding to the
 * disclosure would let a token issued for one confirm the other.
 *
 * Field order is fixed here rather than left to `JSON.stringify`'s insertion
 * order, so two callers that build the same plan with their object literals in a
 * different order produce the same digest — otherwise a confirmation would fail
 * for a reason no one could see.
 *
 * The binding itself is EPIC-011's pattern rather than a new one. `encodeCursor`
 * in `providers/sdk/operation.ts` binds a pagination cursor to its issuing
 * provider and capability for the same reason, and states it better than this
 * comment could: a token "travels out to an AI client over MCP and comes back
 * later, by which time nothing guarantees it comes back to the same place it
 * left", and an unbound one "decodes cleanly into a position that means something
 * else entirely — silently, which is the worst way for it to be wrong". A
 * confirmation is that shape exactly, with a destructive operation on the end of
 * it instead of a page of results.
 */
export function planDigest(plan: OperationPlan): string {
  const canonical = JSON.stringify([
    plan.operation,
    plan.summary,
    plan.effects.map((effect) => [
      effect.target,
      effect.change,
      // `null` rather than `undefined`: `JSON.stringify` drops `undefined` in an
      // array to `null` anyway, and being explicit keeps "absent" and "null"
      // from being two different digests for the same plan.
      effect.from ?? null,
      effect.to ?? null,
    ]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

interface Pending {
  readonly digest: string;
  readonly expiresAt: number;
}

/**
 * Issues and consumes confirmations for destructive operations.
 *
 * Process-local and never persisted, on purpose: a confirmation that survived a
 * restart is a confirmation nobody is still present for.
 */
export class ConfirmationGate {
  readonly #pending = new Map<string, Pending>();
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #now: () => number;

  constructor(options: ConfirmationGateOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_CONFIRMATIONS;
    this.#now = options.now ?? Date.now;
  }

  /** How many confirmations are outstanding. For a test and a diagnostic. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Discloses what an operation would do, and issues a token for exactly that.
   *
   * Changes nothing. This is the call a destructive operation's *first*
   * invocation makes.
   */
  request(plan: OperationPlan): ConfirmationRequest {
    this.#dropExpired();
    this.#makeRoom();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#pending.set(token, { digest: planDigest(plan), expiresAt });

    return Object.freeze({
      confirmationRequired: true as const,
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      plan: disclose(plan),
      howToConfirm:
        `Show this plan to the person you are acting for. To perform it, call the ` +
        `same tool again with the same arguments and confirm: "${token}". ` +
        `The token is valid once, for this exact plan, until ${new Date(expiresAt).toISOString()}.`,
    });
  }

  /**
   * Permits an operation to proceed, or refuses it.
   *
   * The plan is passed again rather than remembered by token alone, so what is
   * about to happen is checked against what was disclosed. A plan whose `from`
   * has changed underneath produces a different digest and is refused — which is
   * the right outcome, not a defect: the state the operator was shown no longer
   * holds.
   *
   * @throws {FerretError} `E_CONFIRMATION_REQUIRED` when no token was presented.
   * @throws {FerretError} `E_CONFIRMATION_INVALID` when the token cannot be used.
   */
  consume(plan: OperationPlan, token: string | undefined): void {
    if (token === undefined || token.length === 0) {
      const request = this.request(plan);
      throw new FerretError(
        ErrorCode.CONFIRMATION_REQUIRED,
        `${plan.operation} would change something and has not been confirmed`,
        {
          details: {
            operation: plan.operation,
            confirmationRequired: true,
            plan: request.plan,
            confirm: request.token,
            expiresAt: request.expiresAt,
          },
          remediation: request.howToConfirm,
          // Repeating it unchanged fails identically. Only repeating it *with the
          // token* succeeds, which is a different request.
          retryable: false,
        },
      );
    }

    // Expired entries only. Making room here could evict the very token being
    // presented, which would turn a valid confirmation into an invalid one under
    // concurrency — a refusal nobody could explain.
    this.#dropExpired();

    const pending = this.#pending.get(token);
    // One refusal for unknown, expired, spent and mismatched. A caller that could
    // tell them apart could probe for a token's existence, and there is nothing a
    // legitimate caller does differently in the four cases: request again.
    if (pending === undefined || pending.digest !== planDigest(plan)) {
      throw new FerretError(
        ErrorCode.CONFIRMATION_INVALID,
        `The confirmation presented for ${plan.operation} cannot be used`,
        {
          details: { operation: plan.operation },
          remediation:
            `Call ${plan.operation} again without a confirmation to see what it ` +
            'would do now, and confirm with the token that call returns.',
        },
      );
    }

    // Single use, and spent before the operation runs rather than after. An
    // operation that fails half way has still spent its confirmation: the state
    // the plan described may no longer hold, so the next attempt must disclose
    // again rather than reuse an approval for a world that has moved.
    this.#pending.delete(token);
  }

  #dropExpired(): void {
    const now = this.#now();
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(token);
    }
  }

  /**
   * Makes room for one more, oldest first — which is insertion order, and `Map`
   * guarantees it.
   *
   * An evicted token is indistinguishable from an unknown one, which is what
   * makes eviction safe to do silently: the caller is refused and asked to
   * request again, and the plan it is then shown reflects current state rather
   * than state from sixteen requests ago.
   */
  #makeRoom(): void {
    while (this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) break;
      this.#pending.delete(oldest.value);
    }
  }
}

/**
 * Renders a plan for disclosure, with every value redacted.
 *
 * A plan is the first thing in Ferret that deliberately shows a *configuration
 * value* to a model, so it is the one place that exposure has to be handled.
 * `auditValue` is EPIC-003's existing redactor and classifies by the path's last
 * segment, which is what catches `database.password` — a value a pattern-based
 * detector cannot recognise, because a password does not look like anything.
 *
 * Pattern-shaped credentials in a value that is *not* secret-named are caught
 * downstream: every refusal crosses to a client through EPIC-009's serializer,
 * which redacts. Doing it twice here would duplicate a control that already
 * holds on the only path this takes.
 */
function disclose(plan: OperationPlan): DisclosedPlan {
  return Object.freeze({
    operation: plan.operation,
    summary: plan.summary,
    effects: Object.freeze(
      plan.effects.map((effect) => {
        const disclosed: { target: string; change: EffectChange; from?: string; to?: string } = {
          target: effect.target,
          change: effect.change,
        };
        if (effect.from !== undefined) disclosed.from = render(effect.target, effect.from);
        if (effect.to !== undefined) disclosed.to = render(effect.target, effect.to);
        return Object.freeze(disclosed);
      }),
    ),
  });
}

function render(target: string, value: unknown): string {
  const safe = auditValue(target, value);
  return typeof safe === 'string' ? safe : JSON.stringify(safe);
}
