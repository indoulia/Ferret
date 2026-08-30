/**
 * The Provider SDK — the machinery every provider needs, implemented once.
 *
 * EPIC-011 said what a provider must offer. This is what makes offering it
 * survivable: lifecycle that is correct under concurrent initialization and
 * shutdown, emission that cannot forget its attribution, cancellation that does
 * not leak, retry that knows Ferret's error taxonomy, a rate limiter that stays
 * fair under abort, and a cursor protocol that treats a returning token as the
 * untrusted input it is.
 *
 * Test doubles are *not* re-exported here. They ship under
 * `@indoulia/ferret/testing`, so nothing pulls them into a production bundle by
 * reaching for the SDK.
 */

export { BaseProvider, ProviderState } from './base.js';
export {
  abortableDelay,
  interrupted,
  isAbortError,
  linkSignals,
  throwIfAborted,
  withDeadline,
  type DerivedSignal,
} from './cancellation.js';
export {
  BatchEmitter,
  Emitter,
  type BatchCounts,
  type EmissionIdentity,
  type EmittedEntityInput,
  type EmittedEvidenceInput,
  type EmittedRelationshipInput,
} from './emit.js';
export {
  MAX_CURSOR_LENGTH,
  decodeCursor,
  encodeCursor,
  paginate,
  type Page,
  type PageRequest,
  type ProviderOperationContext,
} from './operation.js';
export { RateLimiter, type RateLimiterOptions, type RateLimiterStats } from './rate-limit.js';
export { nextDelayMs, retry, type RetryAttemptInfo, type RetryOptions } from './retry.js';
