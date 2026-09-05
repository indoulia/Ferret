/**
 * Assembling what Ferret knows into something that fits a context window.
 *
 * Core, and deliberately model-agnostic: token *estimation* rather than
 * counting, because a real count needs a specific model's tokenizer and tying
 * Ferret to one would make the AI client something other than a provider.
 */

export {
  ESTIMATE_MARGIN,
  TokenBudget,
  estimateJsonTokens,
  estimateTokens,
} from './budget.js';
export {
  CONTENT_NOTICE,
  ContextPackBuilder,
  DEFAULT_BUDGET,
  MAX_BUDGET,
  PACK_FORMAT_VERSION,
  TruncationReason,
  renderPack,
  type ContextPack,
  type PackItem,
  type PackOmission,
  type PackRequest,
} from './pack.js';

// EPIC-048. The narrow evidence-read port answer traceability needs, and its
// bounds. Exported from the context barrel rather than from `storage/` so a
// caller can name what it needs without importing a database.
export {
  EVIDENCE_CANDIDATE_WINDOW,
  MAX_EVIDENCE_PER_ITEM,
  MAX_LINEAGE_DEPTH,
  type EvidenceReader,
} from './evidence-port.js';

// EPIC-062. Which evidence an item cites, and why — pure, so it is testable
// without a store and reproducible from its inputs alone.
export {
  EvidenceExclusion,
  MAX_EVIDENCE_PER_FIELD,
  selectEvidence,
  type EvidenceSelection,
  type ExcludedEvidence,
  type SelectedEvidence,
  type SelectionOptions,
} from './evidence-selection.js';

// EPIC-060. Answering a question that has one right answer, as claims with
// citations and a stated account of what Ferret does not know.
export {
  ANSWER_FORMAT_VERSION,
  AnswerCompleteness,
  AnswerPackBuilder,
  DEFAULT_ANSWER_BUDGET,
  MAX_ANSWER_BUDGET,
  MAX_ANSWER_CANDIDATES,
  MAX_ANSWER_CLAIMS,
  MAX_CITATIONS_PER_CLAIM,
  renderAnswer,
  type AnswerCandidate,
  type AnswerCitation,
  type AnswerClaim,
  type AnswerDependencies,
  type AnswerPack,
  type AnswerRequest,
} from './answer.js';

// EPIC-124. One context out of many sources: the cross-source hops a connector
// cannot make, because `normalize` is pure and cannot read a store.
export {
  DEFAULT_EXAMINE_LIMIT,
  MAX_SCAN_CHARACTERS,
  CrossSourceReferenceKind,
  findCrossSourceReferences,
  linkCrossSourceReferences,
  type CrossSourceDependencies,
  type CrossSourceOptions,
  type CrossSourceReference,
  type CrossSourceReport,
  type ResolvedLink,
} from './cross-source.js';
