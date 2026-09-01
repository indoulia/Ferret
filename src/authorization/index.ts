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
