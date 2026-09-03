import { Confidence } from '../domain/confidence.js';
import { EntityKind } from '../domain/index.js';
import { normalizeGitIdentity, type NormalizedIdentity } from '../identity/index.js';

/**
 * Candidates for resolution, never resolutions — EPIC-051 §8.3.
 *
 * EPIC-009's validation records the gap this fills:
 *
 * > *"Nothing proposes reconciliations. Ferret records and adjudicates a
 * > mapping a caller asserts; it does not go looking for two addresses that are
 * > probably one person."*
 *
 * It still does not merge. `IdentityStore.merge` is the only thing that merges,
 * it requires evidence, and it is deliberately the least reversible operation
 * in the system. What this produces is the evidence — a named rule, a
 * confidence and a rationale — so that a merge becomes a decision somebody can
 * defend rather than a heuristic nobody can see.
 */

/**
 * Why two records might be the same thing. Named, so a decision is reviewable.
 *
 * `CrossSourceRule` rather than `ResolutionRule`: EPIC-035 already exports a
 * `ResolutionRule` for *reference* resolution — which name is closer to that
 * word's ordinary meaning in a compiler — and two exports called the same thing
 * is how a consumer imports the wrong one and gets a type error three files
 * away. Found by the compiler, which is where it should be found.
 */
export const CrossSourceRule = {
  /** The same email address, once normalized, in two systems. */
  SAME_ADDRESS: 'same-address',
  /** A GitHub noreply login matching another system's username. */
  NOREPLY_LOGIN: 'noreply-login',
  /** The same username string in two systems. */
  SAME_USERNAME: 'same-username',
  /** The same display name, and nothing else. */
  SAME_DISPLAY_NAME: 'same-display-name',
  /** An issue key quoted in the other system's record. */
  QUOTED_KEY: 'quoted-key',
} as const;

export type CrossSourceRule = (typeof CrossSourceRule)[keyof typeof CrossSourceRule];

/**
 * What each rule is worth.
 *
 * Stated here rather than at each call site so the ordering between rules is
 * one decision. `SAME_DISPLAY_NAME` is deliberately low: two people called
 * "admin" are two people, and this rule exists to surface a candidate for a
 * human rather than to carry one over a threshold.
 */
export const RULE_CONFIDENCE: Readonly<Record<CrossSourceRule, number>> = Object.freeze({
  [CrossSourceRule.SAME_ADDRESS]: Confidence.STRONG,
  [CrossSourceRule.NOREPLY_LOGIN]: Confidence.PROBABLE,
  [CrossSourceRule.QUOTED_KEY]: Confidence.PROBABLE,
  [CrossSourceRule.SAME_USERNAME]: Confidence.PLAUSIBLE,
  [CrossSourceRule.SAME_DISPLAY_NAME]: Confidence.EVEN,
});

/** One actor, as one system describes it. */
export interface ActorRecord {
  /** The entity id this actor already has in Ferret. */
  readonly entityId: string;
  readonly sourceSystem: string;
  readonly identity: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly email?: string;
}

/** One issue, as one system describes it. */
export interface IssueRecord {
  readonly entityId: string;
  readonly sourceSystem: string;
  /** `FER-12`, `42`. */
  readonly key: string;
  readonly title?: string;
  /** Free text that may quote another system's key. */
  readonly body?: string;
}

export interface ResolutionProposal {
  readonly left: string;
  readonly right: string;
  readonly kind: string;
  readonly rule: CrossSourceRule;
  readonly confidence: number;
  /** What a reviewer needs in order to agree or disagree. */
  readonly rationale: string;
}

export interface ResolutionInput {
  readonly actors?: readonly ActorRecord[];
  readonly issues?: readonly IssueRecord[];
}

/**
 * Every candidate, strongest rule per pair.
 *
 * Two rules agreeing does not make a pair more certain than its best evidence,
 * and keeping both would let a reviewer count the same fact twice — EPIC-036's
 * `proposeIdentityLinks` records the same reasoning.
 */
export function proposeResolutions(input: ResolutionInput): readonly ResolutionProposal[] {
  const proposals = new Map<string, ResolutionProposal>();

  const record = (proposal: ResolutionProposal): void => {
    // Ordered, so the same pair proposed from either side is one key.
    const [left, right] = [proposal.left, proposal.right].sort();
    const key = `${String(left)}|${String(right)}|${proposal.kind}`;
    const held = proposals.get(key);
    if (held === undefined || proposal.confidence > held.confidence) {
      proposals.set(key, { ...proposal, left: left ?? proposal.left, right: right ?? proposal.right });
    }
  };

  proposeActors(input.actors ?? [], record);
  proposeIssues(input.issues ?? [], record);

  return [...proposals.values()].sort((one, two) => two.confidence - one.confidence);
}

function proposeActors(
  actors: readonly ActorRecord[],
  record: (proposal: ResolutionProposal) => void,
): void {
  // Only across systems. Two GitHub accounts are two people until GitHub says
  // otherwise, and proposing within one system would rediscover every
  // colleague who shares a surname.
  for (let index = 0; index < actors.length; index += 1) {
    for (let other = index + 1; other < actors.length; other += 1) {
      const left = actors[index];
      const right = actors[other];
      if (left === undefined || right === undefined) continue;
      if (left.sourceSystem === right.sourceSystem) continue;

      const rule = actorRule(left, right);
      if (rule === undefined) continue;
      record({
        left: left.entityId,
        right: right.entityId,
        kind: EntityKind.DEVELOPER,
        rule,
        confidence: RULE_CONFIDENCE[rule],
        rationale: actorRationale(rule, left, right),
      });
    }
  }
}

function actorRule(left: ActorRecord, right: ActorRecord): CrossSourceRule | undefined {
  const leftIdentity = identityOf(left);
  const rightIdentity = identityOf(right);

  if (
    leftIdentity !== undefined &&
    rightIdentity !== undefined &&
    leftIdentity.comparable === rightIdentity.comparable
  ) {
    return CrossSourceRule.SAME_ADDRESS;
  }

  // EPIC-036 recovers a login from a GitHub noreply address. A commit authored
  // through the web UI carries `12345+octocat@users.noreply.github.com`, and
  // this is the rule that joins it to the reviewer called `octocat`.
  if (leftIdentity?.login !== undefined && leftIdentity.login === right.login) {
    return CrossSourceRule.NOREPLY_LOGIN;
  }
  if (rightIdentity?.login !== undefined && rightIdentity.login === left.login) {
    return CrossSourceRule.NOREPLY_LOGIN;
  }

  if (left.login !== undefined && left.login === right.login) {
    return CrossSourceRule.SAME_USERNAME;
  }

  // Last, and worth least. Two people called "admin" are two people.
  if (
    left.displayName !== undefined &&
    left.displayName.trim().length > 0 &&
    left.displayName.trim().toLowerCase() === right.displayName?.trim().toLowerCase()
  ) {
    return CrossSourceRule.SAME_DISPLAY_NAME;
  }
  return undefined;
}

function identityOf(actor: ActorRecord): NormalizedIdentity | undefined {
  if (actor.email !== undefined) {
    return normalizeGitIdentity(actor.displayName ?? actor.login ?? '', actor.email);
  }
  return undefined;
}

function actorRationale(rule: CrossSourceRule, left: ActorRecord, right: ActorRecord): string {
  const name = (actor: ActorRecord): string =>
    `${actor.sourceSystem}:${actor.login ?? actor.identity}`;
  switch (rule) {
    case CrossSourceRule.SAME_ADDRESS:
      return `${name(left)} and ${name(right)} use the same mailbox once casing and plus-tags are normalized`;
    case CrossSourceRule.NOREPLY_LOGIN:
      return `a GitHub noreply address recovers a login that matches the other record's username`;
    case CrossSourceRule.SAME_USERNAME:
      return `${name(left)} and ${name(right)} share a username, which is a signal and not a proof`;
    default:
      return `${name(left)} and ${name(right)} share a display name only — the weakest signal there is`;
  }
}

/**
 * An issue that quotes another system's key — §8.4.
 *
 * `FER-12` in a GitHub issue's title or body is the strongest cross-tracker
 * signal available and is still only a mention: teams reference a ticket to
 * give context as often as to say "this is that". So it is `PROBABLE` rather
 * than `STRONG`, and it is a proposal, and the rationale quotes the text so a reviewer can see which of
 * the two it was.
 */
const ISSUE_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/gu;

function proposeIssues(
  issues: readonly IssueRecord[],
  record: (proposal: ResolutionProposal) => void,
): void {
  const byKey = new Map<string, IssueRecord>();
  for (const issue of issues) byKey.set(`${issue.sourceSystem}|${issue.key}`, issue);

  for (const issue of issues) {
    const text = `${issue.title ?? ''} ${issue.body ?? ''}`;
    for (const match of text.matchAll(ISSUE_KEY)) {
      const quoted = match[1];
      if (quoted === undefined) continue;
      for (const candidate of issues) {
        if (candidate.sourceSystem === issue.sourceSystem) continue;
        if (candidate.key !== quoted) continue;
        record({
          left: issue.entityId,
          right: candidate.entityId,
          kind: EntityKind.ISSUE,
          rule: CrossSourceRule.QUOTED_KEY,
          confidence: RULE_CONFIDENCE[CrossSourceRule.QUOTED_KEY],
          rationale: `${issue.sourceSystem}:${issue.key} quotes "${quoted}", which is ${candidate.sourceSystem}:${candidate.key}`,
        });
      }
    }
  }
}
