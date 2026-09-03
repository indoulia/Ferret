/**
 * Cross-source entity resolution — EPIC-051.
 *
 * Two mechanisms, and knowing which applies is most of the Epic. Some
 * identifiers are global — a commit SHA is a hash, and there is one commit with
 * it — and those resolve by *construction*: derive the entity in the canonical
 * system and the collision is simply right. The rest are proposals, because a
 * login and an email are not the same identifier however often they belong to
 * the same person.
 *
 * Nothing here merges. `IdentityStore.merge` remains the only thing that does,
 * and it requires evidence — which is what this produces.
 */

export {
  CANONICAL_SOURCE_SYSTEM,
  canonicalSourceSystem,
  hasGlobalIdentifier,
  hostOf,
  repositoryIdentifierFor,
} from './global.js';

export {
  RULE_CONFIDENCE,
  CrossSourceRule,
  proposeResolutions,
  type ActorRecord,
  type IssueRecord,
  type ResolutionInput,
  type ResolutionProposal,
} from './propose.js';
