/**
 * Who did something — EPIC-036.
 *
 * Core logic: normalizing an address, telling a person from a bot, and reading
 * a `.mailmap` are all provider-neutral, and none of them touch a database or a
 * filesystem. The Git provider supplies the raw identities; this decides what
 * they are.
 *
 * Nothing here merges anything. EPIC-009's `IdentityStore.merge` is the only
 * thing that does, and it requires evidence — which is what `proposeIdentityLinks`
 * produces.
 */

export {
  classifyIdentity,
  normalizeGitIdentity,
  type IdentityClassification,
  type NormalizedIdentity,
  type RawIdentity,
} from './git-identity.js';

export {
  EMPTY_MAILMAP,
  MAX_MAILMAP_LINES,
  applyMailmap,
  parseMailmap,
  type Mailmap,
  type MailmapEntry,
} from './mailmap.js';

export {
  LinkRule,
  RULE_CONFIDENCE,
  proposeIdentityLinks,
  type IdentityLinkProposal,
} from './propose.js';
