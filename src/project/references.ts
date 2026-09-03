/**
 * Closing references in prose — EPIC-072 §8.4.
 *
 * "Fixes #12" is text a human wrote, so reading it is **inference** and every
 * caller of this module is required to label it as such. What makes the
 * inference defensible rather than a guess is that the keyword list is
 * GitHub's documented one: a list Ferret invented would be a claim about a
 * convention it does not own.
 */

/**
 * The keywords GitHub documents as closing a linked issue.
 *
 * All three verbs in all three tenses, which is GitHub's own set. Nothing is
 * added — `addresses`, `refs` and `see` are mentions, and §8.4 refuses to read
 * a mention as a resolution.
 */
export const CLOSING_KEYWORDS: readonly string[] = Object.freeze([
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]);

/**
 * How much text is scanned.
 *
 * A generated pull request description can be megabytes — a dependency bot
 * pasting a changelog, a template with a hundred checkboxes. The cap bounds the
 * scan rather than the record: everything after it is simply not read for
 * references, which is a smaller loss than an unbounded regular expression over
 * untrusted input.
 */
export const MAX_REFERENCE_SCAN_CHARACTERS = 64 * 1024;

export interface ClosingReference {
  /** The keyword as written, lowercased. */
  readonly keyword: string;
  /** `owner/repo` when the reference names one, otherwise absent. */
  readonly project?: string;
  readonly number: number;
  /** The matched text, so evidence can quote what it read. */
  readonly text: string;
}

/**
 * `fixes #12`, `Closes owner/repo#34`, `resolved GH-7`.
 *
 * Deliberately *not* matching a bare `#12`: a mention is not a resolution, and
 * treating one as the other is how a compliance report starts claiming work was
 * done. The keyword must precede the reference, separated only by spaces or a
 * colon — which is what GitHub itself requires.
 */
const CLOSING = new RegExp(
  String.raw`\b(${CLOSING_KEYWORDS.join('|')})\b\s*:?\s+(?:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#|GH-|#)(\d+)\b`,
  'giu',
);

/** Every closing reference in a body, deduplicated, in order of appearance. */
export function findClosingReferences(body: string | undefined): readonly ClosingReference[] {
  if (body === undefined || body.length === 0) return [];
  const scanned = body.length > MAX_REFERENCE_SCAN_CHARACTERS
    ? body.slice(0, MAX_REFERENCE_SCAN_CHARACTERS)
    : body;

  const found: ClosingReference[] = [];
  const seen = new Set<string>();
  for (const match of scanned.matchAll(CLOSING)) {
    const [text, keyword, project, digits] = match;
    if (keyword === undefined || digits === undefined) continue;
    const number = Number(digits);
    // A reference to issue 0 is not a reference; `Number` would accept it.
    if (!Number.isInteger(number) || number <= 0) continue;
    const key = `${project ?? ''}#${String(number)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      keyword: keyword.toLowerCase(),
      ...(project === undefined ? {} : { project }),
      number,
      text,
    });
  }
  return found;
}
