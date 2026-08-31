import { normalizeGitIdentity, type NormalizedIdentity } from './git-identity.js';

/**
 * `.mailmap` — Git's own answer to "these addresses are the same person".
 *
 * Maintained by the project, honoured by `git log` and `git shortlog`, and
 * nothing in Ferret was reading it. Governance §5 makes this the obvious call:
 * the alternative is inventing a mapping format and asking projects to maintain
 * a second one.
 *
 * It is authoritative *within its repository* and nowhere else. A `.mailmap` is
 * repository content and can claim any mapping it likes, so it governs identity
 * for that repository's history and must never grant authority anywhere
 * (Governance §12).
 *
 * Git defines four forms:
 *
 * ```text
 * Proper Name <proper@email>
 * <proper@email> <commit@email>
 * Proper Name <proper@email> <commit@email>
 * Proper Name <proper@email> Commit Name <commit@email>
 * ```
 */

export interface MailmapEntry {
  /** The name to report, when the entry supplies one. */
  readonly properName: string | undefined;
  readonly properEmail: string;
  /** The address this entry matches. Absent for the name-only first form. */
  readonly commitEmail: string | undefined;
  /** The name this entry also requires, for the fourth form. */
  readonly commitName: string | undefined;
}

export interface Mailmap {
  readonly entries: readonly MailmapEntry[];
  /** Lines that were not understood, so a malformed file is visible. */
  readonly ignored: readonly string[];
  readonly truncated: boolean;
}

export const EMPTY_MAILMAP: Mailmap = Object.freeze({
  entries: Object.freeze([]),
  ignored: Object.freeze([]),
  truncated: false,
});

/** Lines read. A repository file must not be able to make parsing expensive. */
export const MAX_MAILMAP_LINES = 20_000;

/**
 * Splits a line into its `Name <email>` pairs.
 *
 * Hand-scanned rather than matched with a regular expression: a name may
 * contain almost anything, and the only reliable structure is the angle
 * brackets. A greedy pattern over an attacker-controlled line is the sort of
 * thing that backtracks for a very long time.
 */
function splitPairs(line: string): readonly { name: string; email: string }[] {
  const pairs: { name: string; email: string }[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('<', cursor);
    if (open === -1) break;
    const close = line.indexOf('>', open + 1);
    if (close === -1) break;
    pairs.push({
      name: line.slice(cursor, open).trim(),
      email: line.slice(open + 1, close).trim(),
    });
    cursor = close + 1;
  }
  return pairs;
}

export function parseMailmap(text: string): Mailmap {
  const allLines = text.split(/\r?\n/);
  const truncated = allLines.length > MAX_MAILMAP_LINES;
  const lines = truncated ? allLines.slice(0, MAX_MAILMAP_LINES) : allLines;

  const entries: MailmapEntry[] = [];
  const ignored: string[] = [];

  for (const raw of lines) {
    // A `#` starts a comment anywhere Git accepts one, and a bare comment line
    // is by far the common case.
    const withoutComment = raw.split('#', 1)[0] ?? '';
    const line = withoutComment.trim();
    if (line.length === 0) continue;

    const pairs = splitPairs(line);
    const first = pairs[0];
    if (first === undefined || first.email.length === 0) {
      ignored.push(raw.trim());
      continue;
    }
    const second = pairs[1];

    entries.push({
      properName: first.name.length === 0 ? undefined : first.name,
      properEmail: first.email.toLowerCase(),
      commitEmail: second === undefined ? undefined : second.email.toLowerCase(),
      commitName: second === undefined || second.name.length === 0 ? undefined : second.name,
    });
  }

  return { entries, ignored, truncated };
}

/**
 * Applies a `.mailmap` to an identity.
 *
 * Returns the identity unchanged when nothing matches, so a caller can apply it
 * unconditionally. Matching follows Git's own precedence: the most specific
 * form — name *and* address — wins over an address-only entry, which wins over
 * the name-only form.
 */
export function applyMailmap(mailmap: Mailmap, identity: NormalizedIdentity): NormalizedIdentity {
  const email = identity.comparable;
  const name = identity.name.toLowerCase();

  const byNameAndEmail = mailmap.entries.find(
    (entry) =>
      entry.commitEmail === email &&
      entry.commitName !== undefined &&
      entry.commitName.toLowerCase() === name,
  );
  const byEmail = mailmap.entries.find(
    (entry) => entry.commitEmail === email && entry.commitName === undefined,
  );
  // The name-only form rewrites the *name* of whoever already commits as that
  // address, which is why it matches on `properEmail` rather than on a commit
  // address it does not have.
  const byProperEmail = mailmap.entries.find(
    (entry) => entry.commitEmail === undefined && entry.properEmail === email,
  );

  const entry = byNameAndEmail ?? byEmail ?? byProperEmail;
  if (entry === undefined) return identity;

  const rewritten = normalizeGitIdentity(entry.properName ?? identity.name, entry.properEmail);
  // A `.mailmap` entry with an address Ferret cannot normalize leaves the
  // identity alone rather than replacing it with nothing.
  return rewritten ?? identity;
}
