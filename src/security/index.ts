export {
  CLASSIFY_WINDOW,
  CONTENT_CLOSE,
  CONTENT_OPEN,
  ContentSafety,
  NO_CONTENT_SAFETY,
  classifyInstructionShape,
  contain,
  containAttributes,
  type ContainedValue,
  type ContentSafetyReport,
  type InstructionShapeVerdict,
} from './containment.js';
export { CREDENTIAL_ENV, withoutCredentials } from './credentials.js';
/**
 * `containsSecret` is deliberately **not** re-exported here.
 *
 * EPIC-100 AC-8's first catch: it was on this barrel, and its only caller was
 * `tests/unit/secrets.test.ts`. A control on the declared surface that no
 * production path reaches is the `EvidenceStore.verify` defect again — correct,
 * tested, and reached by nothing for three Epics.
 *
 * It is a one-line predicate over `redactSecrets` and a useful one *for a
 * test*, so the function stays in `secrets.ts` and that test imports it
 * directly. What changed is the claim: this barrel now declares only controls
 * Ferret actually controls with. Giving it a production caller instead would
 * have invented a use to satisfy a check, which is the other way to make this
 * criterion pass and the wrong one.
 */
export {
  SECRET_PATH_EXCLUSIONS,
  isSecretPath,
  redactSecrets,
  type RedactionResult,
  type SecretKind,
} from './secrets.js';
