/**
 * Links from one page to another, found in a page's body — EPIC-123.
 *
 * Confluence's v2 API does not report a page's outbound links. They exist only
 * inside the body, so finding them means reading it — which is exactly what
 * `src/project/references.ts` does to turn `Fixes #12` into an edge, and this
 * is deliberately the same shape: a bounded scan, a fixed set of patterns, a
 * deduplicated result, and no HTML parser.
 *
 * **The body is untrusted content a stranger wrote.** Nothing here executes it,
 * resolves it, or fetches anything it names. A match produces an *id or a
 * title*, and what that turns into is the connector's decision one layer up.
 */

/**
 * Characters of a body scanned for links.
 *
 * A Confluence page can be megabytes of exported HTML, and a regular expression
 * over all of it, per page, is the difference between a pass that finishes and
 * one that does not. The same ceiling and the same reason as
 * `MAX_REFERENCE_SCAN_CHARACTERS`: a link that appears only after 200 KB of a
 * single page is not the link anybody is looking for.
 */
export const MAX_BODY_SCAN_CHARACTERS = 200_000;

/** How a link named its target. Both are reported; neither is resolved here. */
export const PageReferenceKind = {
  /** A page id, from a URL. Unambiguous. */
  ID: 'id',
  /** A page title, from a storage-format macro. Unique only within a space. */
  TITLE: 'title',
} as const;

export type PageReferenceKind = (typeof PageReferenceKind)[keyof typeof PageReferenceKind];

export interface PageReference {
  readonly kind: PageReferenceKind;
  /** The page id, or the page title, according to `kind`. */
  readonly target: string;
  /** The space key, when the reference named one. */
  readonly space?: string;
}

/**
 * `/wiki/spaces/DEV/pages/12345/Some+Title`, and the `/pages/12345` short form.
 *
 * The id is the only part worth keeping: a title in a URL is a slug that
 * changes when the page is renamed, and the id does not.
 */
const PAGE_URL = /\/(?:wiki\/)?(?:spaces\/([A-Za-z0-9._~-]+)\/)?pages\/(\d{2,})/g;

/**
 * `<ac:link><ri:page ri:content-title="Other Page" ri:space-key="DEV"/></ac:link>`
 *
 * Storage format names a page by *title*, not by id, which is why
 * {@link PageReferenceKind} has two members. Matching the `ri:page` element
 * directly rather than parsing the document: the attributes are the whole of
 * the fact, and an XML parser for two attributes would be a dependency and a
 * new class of failure on malformed input.
 */
const RI_PAGE = /<ri:page\b[^>]*?\bri:content-title="([^"]{1,255})"([^>]*)>/g;
const RI_SPACE = /\bri:space-key="([^"]{1,255})"/;

/**
 * Every distinct page this body links to.
 *
 * Order is the order of first appearance, which makes the result deterministic
 * for a given body — the property repeated ingestion depends on.
 */
export function findPageReferences(body: string | undefined): readonly PageReference[] {
  if (body === undefined || body.length === 0) return [];
  const scanned =
    body.length > MAX_BODY_SCAN_CHARACTERS ? body.slice(0, MAX_BODY_SCAN_CHARACTERS) : body;

  const found: PageReference[] = [];
  const seen = new Set<string>();

  const add = (reference: PageReference): void => {
    const key = `${reference.kind}:${reference.space ?? ''}:${reference.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(reference);
  };

  for (const match of scanned.matchAll(PAGE_URL)) {
    const [, space, id] = match;
    if (id === undefined) continue;
    add({
      kind: PageReferenceKind.ID,
      target: id,
      ...(space === undefined ? {} : { space }),
    });
  }

  for (const match of scanned.matchAll(RI_PAGE)) {
    const [, title, rest] = match;
    if (title === undefined || title.trim() === '') continue;
    const space = rest === undefined ? null : RI_SPACE.exec(rest);
    add({
      kind: PageReferenceKind.TITLE,
      target: decodeEntities(title),
      ...(space?.[1] === undefined ? {} : { space: space[1] }),
    });
  }

  return found;
}

/**
 * The five entities XML requires, and nothing else.
 *
 * A title arrives escaped because it lives in an attribute. Decoding the five
 * predefined entities is exact; a general HTML entity table would be a table to
 * maintain for titles that do not contain them.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
