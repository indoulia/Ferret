import { encodeKeyParts } from '../domain/identity.js';

import type { NormalizedIdentity } from './git-identity.js';

/**
 * Proposing that two identities are the same person — and never deciding it.
 *
 * EPIC-009 requires reconciliation to carry auditable evidence, to detect
 * collisions rather than merge silently, and to retain history. This module
 * produces the evidence half: candidates with a confidence and the rule that
 * produced them. Something else — a person, or an AI client that has been given
 * the authority — decides, and `IdentityStore.merge` is the only thing that
 * acts.
 *
 * That split is the point. Identity is where a manufactured certainty does the
 * most damage: merging two contributors is nearly invisible and corrupts every
 * "who knows this code" answer afterwards.
 */

/** Why two identities were proposed as one person. */
export const LinkRule = {
  /** The project's own `.mailmap` says so. Not a proposal; recorded for completeness. */
  MAILMAP: 'mailmap',
  /** The same mailbox, once casing and plus-tags are normalized. */
  SAME_ADDRESS: 'same-address',
  /** A GitHub noreply login matching another identity's local part. */
  GITHUB_NOREPLY_LOGIN: 'github-noreply-login',
  /** The same display name and the same local part at different domains. */
  SAME_NAME_AND_LOCAL_PART: 'same-name-and-local-part',
} as const;

export type LinkRule = (typeof LinkRule)[keyof typeof LinkRule];

/**
 * How much each rule is worth.
 *
 * Numbers rather than words so a caller can threshold, and stated here rather
 * than at each call site so the ordering between rules is one decision. An
 * address match is as close to certain as this Epic gets without `.mailmap`; a
 * name and local part matching across domains is a genuine signal and a
 * genuinely fallible one — `admin@a.com` and `admin@b.com` are usually two
 * people.
 */
export const RULE_CONFIDENCE: Readonly<Record<LinkRule, number>> = Object.freeze({
  [LinkRule.MAILMAP]: 1,
  [LinkRule.SAME_ADDRESS]: 0.95,
  [LinkRule.GITHUB_NOREPLY_LOGIN]: 0.8,
  [LinkRule.SAME_NAME_AND_LOCAL_PART]: 0.5,
});

export interface IdentityLinkProposal {
  /** The two comparable addresses, ordered, so a pair appears once. */
  readonly left: string;
  readonly right: string;
  readonly rule: LinkRule;
  readonly confidence: number;
  /** What matched, for a reviewer. Contains no address beyond the pair itself. */
  readonly detail: string;
}

/**
 * Local parts too generic to be evidence of anything.
 *
 * `admin@a.example` and `admin@b.example` are two administrators far more often
 * than they are one person, and proposing them wastes a reviewer's attention on
 * the least likely candidates in the set.
 */
const GENERIC_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'admin',
  'root',
  'user',
  'git',
  'dev',
  'developer',
  'info',
  'me',
  'test',
  'build',
  'ci',
  'jenkins',
  'noreply',
  'no-reply',
]);

function pair(a: string, b: string): { left: string; right: string } {
  return a < b ? { left: a, right: b } : { left: b, right: a };
}

/**
 * Proposes links between identities that may be the same person.
 *
 * Grouped by key rather than compared pairwise, so this is linear in the number
 * of identities. A repository with ten thousand contributors is not unusual and
 * a quadratic scan of it is a hundred million comparisons.
 *
 * A display name alone never produces a proposal. Two people called "admin" are
 * two people, and a rule that says otherwise would fire on every repository
 * with a generic committer.
 */
export function proposeIdentityLinks(
  identities: readonly NormalizedIdentity[],
): readonly IdentityLinkProposal[] {
  const proposals = new Map<string, IdentityLinkProposal>();
  const record = (proposal: IdentityLinkProposal): void => {
    const key = `${proposal.left}|${proposal.right}`;
    const existing = proposals.get(key);
    // The strongest rule for a pair wins. Two rules agreeing does not make a
    // pair more certain than its best evidence, and keeping both would let a
    // reviewer count the same fact twice.
    if (existing === undefined || proposal.confidence > existing.confidence) {
      proposals.set(key, proposal);
    }
  };

  const byAddress = new Map<string, NormalizedIdentity[]>();
  const byNameAndLocal = new Map<string, NormalizedIdentity[]>();
  const byLocalPart = new Map<string, NormalizedIdentity[]>();

  for (const identity of identities) {
    const addressGroup = byAddress.get(identity.comparable) ?? [];
    addressGroup.push(identity);
    byAddress.set(identity.comparable, addressGroup);

    if (identity.name.length > 0 && !GENERIC_LOCAL_PARTS.has(identity.localPart)) {
      // Length-prefixed rather than joined with a separator, for the reason
      // `encodeKeyParts` exists: a display name is an arbitrary string, so
      // "Ada B" + "c" and "Ada" + "B c" would otherwise group together.
      const key = encodeKeyParts([identity.name.toLowerCase(), identity.localPart]);
      const group = byNameAndLocal.get(key) ?? [];
      group.push(identity);
      byNameAndLocal.set(key, group);
    }

    if (!GENERIC_LOCAL_PARTS.has(identity.localPart)) {
      const group = byLocalPart.get(identity.localPart) ?? [];
      group.push(identity);
      byLocalPart.set(identity.localPart, group);
    }
  }

  // The same mailbox written two ways — `Ada <A@x.com>` and `ada <ada+t@x.com>`
  // — which is the one rule that is almost never wrong.
  for (const [address, group] of byAddress) {
    const distinct = [...new Set(group.map((identity) => identity.email.toLowerCase()))];
    if (distinct.length < 2) continue;
    for (let i = 0; i < distinct.length; i += 1) {
      for (let j = i + 1; j < distinct.length; j += 1) {
        const left = distinct[i];
        const right = distinct[j];
        if (left === undefined || right === undefined) continue;
        record({
          ...pair(left, right),
          rule: LinkRule.SAME_ADDRESS,
          confidence: RULE_CONFIDENCE[LinkRule.SAME_ADDRESS],
          detail: `both normalize to ${address}`,
        });
      }
    }
  }

  // A GitHub noreply address carries the login, and the login is very often the
  // local part of the same person's real address.
  for (const identity of identities) {
    if (identity.login === undefined) continue;
    for (const other of byLocalPart.get(identity.login) ?? []) {
      if (other.comparable === identity.comparable) continue;
      record({
        ...pair(identity.comparable, other.comparable),
        rule: LinkRule.GITHUB_NOREPLY_LOGIN,
        confidence: RULE_CONFIDENCE[LinkRule.GITHUB_NOREPLY_LOGIN],
        detail: `GitHub login "${identity.login}" matches the other address's local part`,
      });
    }
  }

  // The same person at two employers, usually. Weakest of the three, and
  // excluded entirely for generic local parts.
  for (const group of byNameAndLocal.values()) {
    const distinct = [...new Set(group.map((identity) => identity.comparable))];
    if (distinct.length < 2) continue;
    for (let i = 0; i < distinct.length; i += 1) {
      for (let j = i + 1; j < distinct.length; j += 1) {
        const left = distinct[i];
        const right = distinct[j];
        if (left === undefined || right === undefined) continue;
        record({
          ...pair(left, right),
          rule: LinkRule.SAME_NAME_AND_LOCAL_PART,
          confidence: RULE_CONFIDENCE[LinkRule.SAME_NAME_AND_LOCAL_PART],
          detail: 'same display name and same local part at different domains',
        });
      }
    }
  }

  // Sorted so two runs over the same input produce the same list — a proposal
  // set that reorders itself is one a reviewer cannot diff.
  return [...proposals.values()].sort(
    (a, b) => b.confidence - a.confidence || a.left.localeCompare(b.left) || a.right.localeCompare(b.right),
  );
}
