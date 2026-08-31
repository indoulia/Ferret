import { ActorClass } from '../domain/actor.js';

/**
 * The identities a Git repository records, and what they actually are.
 *
 * Today every commit author becomes a `developer` keyed on a lowercased email.
 * Three things are wrong with that, and each is invisible until someone acts on
 * the answer:
 *
 * - **Bots are people.** `dependabot[bot]` is recorded as a human contributor,
 *   so "who has worked on this file" answers with a machine. EPIC-009 made
 *   developer and agent distinct identity classes precisely so that would not
 *   happen.
 * - **The same person is several people**, one per address they commit from,
 *   each holding a fraction of the history.
 * - **Git already knows** — `.mailmap` is the project's own maintained answer,
 *   honoured by `git log` and `git shortlog`, and nothing was reading it.
 *
 * An address is the identity; a display name never is. Two people called
 * "admin" are two people, and an identity with no address is not recorded at
 * all — inventing one from a name would merge every unattributed author in a
 * repository into one person.
 */

export interface RawIdentity {
  readonly name: string;
  readonly email: string;
}

export interface NormalizedIdentity {
  /** The display name, trimmed. May be empty. */
  readonly name: string;
  /** The address as written, trimmed. Retained as evidence. */
  readonly email: string;
  /**
   * The address used for comparison: lowercased, plus-tag removed.
   *
   * `ada+ferret@example.com` and `ada@example.com` are the same mailbox by
   * RFC 5233 convention at every major provider, so the tag is stripped *for
   * comparison* while `email` keeps what the commit actually said.
   */
  readonly comparable: string;
  readonly localPart: string;
  readonly domain: string;
  /** The login recovered from a GitHub noreply address, when it is one. */
  readonly login: string | undefined;
}

/**
 * GitHub's noreply forms.
 *
 * `login@users.noreply.github.com` is the original; `12345+login@…` is what
 * GitHub has issued since 2017. The numeric id is not part of the login and
 * treating it as one produces a handle that matches nothing.
 */
const GITHUB_NOREPLY = /^(?:(\d+)\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/;

/** GitHub Apps commit as `<id>+<slug>[bot]@users.noreply.github.com`. */
const GITHUB_APP_NOREPLY = /^(?:\d+\+)?[A-Za-z0-9-]{1,39}\[bot\]@users\.noreply\.github\.com$/;

/** A trailing `[bot]`, which is GitHub's own marker for an App. */
const BOT_SUFFIX = /\[bot\]$/i;

/**
 * Service addresses that are machines.
 *
 * Exact addresses and full domains only — never a substring of a local part.
 * A person named Robotham is not a robot, and the cost of that mistake is
 * removing a real contributor from "who wrote this".
 */
const SERVICE_ADDRESSES: ReadonlySet<string> = new Set([
  'action@github.com',
  'actions@github.com',
  'github-actions@github.com',
  'github-actions[bot]@users.noreply.github.com',
  'noreply@github.com',
  'support@github.com',
  'bot@renovateapp.com',
  'renovate@whitesourcesoftware.com',
  'gitlab-bot@gitlab.com',
  'bot@stepsecurity.io',
]);

const SERVICE_DOMAINS: ReadonlySet<string> = new Set([
  'bots.github.com',
  'users.noreply.gitlab.com',
]);

/** Display names that are machines regardless of address. */
const SERVICE_NAMES: ReadonlySet<string> = new Set([
  'github actions',
  'github-actions',
  'dependabot',
  'renovate',
  'renovate bot',
  'semantic-release-bot',
  'greenkeeper',
  'snyk bot',
]);

/**
 * Normalizes a Git identity.
 *
 * Returns `undefined` when there is no address: no address means no identity,
 * and this is the one place that decision is made.
 */
export function normalizeGitIdentity(name: string, email: string): NormalizedIdentity | undefined {
  const trimmedEmail = email.trim().replace(/^<|>$/g, '').trim();
  if (trimmedEmail.length === 0) return undefined;

  const lowered = trimmedEmail.toLowerCase();
  const at = lowered.lastIndexOf('@');
  if (at <= 0 || at === lowered.length - 1) {
    // Not an address. Kept as an opaque identity rather than discarded: Git
    // permits it, and a commit that has one is still attributable to whatever
    // it says.
    return {
      name: name.trim(),
      email: trimmedEmail,
      comparable: lowered,
      localPart: lowered,
      domain: '',
      login: undefined,
    };
  }

  const rawLocal = lowered.slice(0, at);
  const domain = lowered.slice(at + 1);
  const plus = rawLocal.indexOf('+');
  // Never on a GitHub noreply address: there the `+` separates the numeric id
  // from the login and is structural, not a subaddress tag.
  const isNoreply = domain === 'users.noreply.github.com';
  const localPart = plus > 0 && !isNoreply ? rawLocal.slice(0, plus) : rawLocal;
  const comparable = `${localPart}@${domain}`;

  const noreply = GITHUB_NOREPLY.exec(lowered);
  return {
    name: name.trim(),
    email: trimmedEmail,
    comparable,
    localPart,
    domain,
    login: noreply?.[2],
  };
}

export interface IdentityClassification {
  readonly actorClass: ActorClass;
  /** What decided it. Never empty. */
  readonly reason: string;
}

/**
 * Whether an identity is a person or a machine.
 *
 * Conservative by design: anything unrecognised is a person. Misclassifying a
 * person as a bot removes them from "who wrote this", which is a worse and much
 * quieter failure than the reverse.
 */
export function classifyIdentity(identity: NormalizedIdentity): IdentityClassification {
  const lowerName = identity.name.toLowerCase();

  if (GITHUB_APP_NOREPLY.test(identity.email.toLowerCase())) {
    return { actorClass: ActorClass.AGENT, reason: 'github-app-noreply-address' };
  }
  if (BOT_SUFFIX.test(identity.name)) {
    return { actorClass: ActorClass.AGENT, reason: 'name ends with [bot]' };
  }
  if (BOT_SUFFIX.test(identity.localPart)) {
    return { actorClass: ActorClass.AGENT, reason: 'address local part ends with [bot]' };
  }
  if (SERVICE_ADDRESSES.has(identity.comparable) || SERVICE_ADDRESSES.has(identity.email.toLowerCase())) {
    return { actorClass: ActorClass.AGENT, reason: `known service address ${identity.comparable}` };
  }
  if (SERVICE_DOMAINS.has(identity.domain)) {
    return { actorClass: ActorClass.AGENT, reason: `service domain ${identity.domain}` };
  }
  if (SERVICE_NAMES.has(lowerName)) {
    return { actorClass: ActorClass.AGENT, reason: `known service name "${identity.name}"` };
  }
  return { actorClass: ActorClass.DEVELOPER, reason: 'no non-human signal' };
}
