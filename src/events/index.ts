/**
 * Event-driven sources — EPIC-077.
 *
 * Two things that look different and are the same: a webhook says something
 * changed on a server, and a filesystem watcher says something changed on disk.
 * Both produce a `SourceEvent`, both are hints rather than truth, and EPIC-078's
 * reconciliation remains what is actually correct.
 *
 * **Ferret does not host an HTTP endpoint.** Verification, normalization and
 * deduplication are here; terminating a request is the host's, which is the
 * ports-and-adapters position taken everywhere else in this codebase.
 */

export {
  SIGNATURE_REFUSAL_MESSAGE,
  SignatureRefusal,
  SignatureScheme,
  verifySignature,
  type SignatureVerdict,
} from './signature.js';

export {
  EventSubject,
  normalizeGithubEvent,
  normalizeJiraEvent,
  type NormalizeResult,
  type SourceEvent,
} from './normalize.js';

export { DeliveryLedger, MAX_REMEMBERED_DELIVERIES } from './deliveries.js';

export {
  DEFAULT_WATCH_DEBOUNCE_MS,
  MAX_WATCHED_ROOTS,
  RepositoryWatcher,
  type WatchOptions,
} from './watch.js';
