/**
 * Who is asking, and what they may do — EPIC-068.
 *
 * Its own module rather than part of `security/`, and the boundary test is what
 * decided it: `domain/memory-extraction.ts` imports `security/index.ts`, so
 * anything in that barrel is reachable from the canonical model — and
 * authorization reads configuration and produces a retrieval context, which
 * would have dragged `picomatch` and `pino` into a graph EPIC-006 requires to
 * depend on nothing but the error model and zod.
 *
 * The split is also the honest one. `security/` holds *content* controls —
 * containment and secret detection, which the model itself needs. This holds a
 * *caller* control, which only the surfaces a caller reaches need.
 */

export {
  ANONYMOUS_PRINCIPAL,
  PERMISSIONS,
  Permission,
  PrincipalClass,
  accessContextFor,
  assertPermitted,
  authorize,
  isPermission,
  principalFrom,
  type AuthorizationDecision,
  type Principal,
} from './authorization.js';

/**
 * Whether the operation was *intended* — EPIC-069.
 *
 * Beside authorization because both are controls on what a *caller* may make
 * happen, they compose at the same point, and they carry the same boundary
 * constraints. EPIC-068 §4 drew the line between them: "This Epic decides whether
 * an operation is permitted; EPIC-069 decides whether it was *intended*, and both
 * must hold."
 *
 * Its own file rather than the same one because it differs in the way that
 * matters most about `authorize`: a decision is pure, and a gate necessarily
 * holds state.
 */
export {
  ConfirmationGate,
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_MAX_PENDING_CONFIRMATIONS,
  EffectChange,
  planDigest,
  type ConfirmationGateOptions,
  type ConfirmationRequest,
  type DisclosedEffect,
  type DisclosedPlan,
  type OperationPlan,
  type PlannedEffect,
} from './confirmation.js';
