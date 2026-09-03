export {
  CLASSIFY_WINDOW,
  CONTENT_CLOSE,
  CONTENT_OPEN,
  ContentSafety,
  MAX_CONTAIN_DEPTH,
  NO_CONTENT_SAFETY,
  classifyInstructionShape,
  contain,
  containAttributes,
  containEntityContent,
  containEvidenceContent,
  containUntrusted,
  isContained,
  truncateContained,
  type ContainedValue,
  type ContentSafetyReport,
  type InstructionShapeVerdict,
} from './containment.js';
/**
 * `delimitersBalanced` and `outsideFences` are deliberately **not** on this
 * barrel either, for the reason spelled out below about `containsSecret`.
 *
 * They are the two checkers Batch 5 added to prove the boundary — "is every
 * region this response opened also closed" and "did any untrusted byte escape a
 * fence" — and they have no production caller by design. Ferret does not repair
 * a broken fence at runtime: a boundary defect turned into a thrown error is an
 * outage in place of a wrong answer, and a boundary defect *silently repaired*
 * is F-32 again with the evidence removed. What they are for is failing a test.
 * So `tests/security/injection-boundary.test.ts` imports them from
 * `./containment.js` directly, and this barrel keeps its claim: it declares only
 * controls a production path reaches.
 */
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
