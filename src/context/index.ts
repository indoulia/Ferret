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
