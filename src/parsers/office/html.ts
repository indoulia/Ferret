/**
 * `mammoth`'s HTML, as blocks — EPIC-027 §8.4.
 *
 * Not an HTML parser. `mammoth` emits a fixed vocabulary into a string Ferret
 * asked it for, and a general parser would be a dependency added to read output
 * this repository generated. The tokeniser recognises the block elements the
 * parser cares about; anything else contributes its text, because dropping is
 * how a converter silently loses a paragraph.
 */

export const BlockKind = {
  HEADING: 'heading',
  PARAGRAPH: 'paragraph',
  LIST_ITEM: 'list-item',
  TABLE: 'table',
} as const;

export type BlockKind = (typeof BlockKind)[keyof typeof BlockKind];

export interface HtmlBlock {
  readonly kind: BlockKind;
  readonly text: string;
  /** 1 to 6 for a heading, `undefined` otherwise. */
  readonly level?: number;
}

/** `<h1>`…`<h6>`, `<p>`, `<li>`, `<table>` — the blocks, in document order. */
const BLOCK = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gu;

/**
 * Blocks, in order.
 *
 * A `<p>` inside a `<td>` is not a block of its own: the table swallows it, and
 * the regex above is applied to the *remainder* after tables are taken out, so
 * a cell's paragraphs cannot appear twice. That ordering is the only subtlety
 * here and it is why tables are extracted first.
 */
export function readBlocks(html: string): readonly HtmlBlock[] {
  const blocks: { index: number; block: HtmlBlock }[] = [];

  // Tables first, and the region each occupied is blanked so the block scan
  // below cannot also see the paragraphs inside its cells.
  let remainder = html;
  for (const match of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gu)) {
    const [whole, body] = match;
    if (body === undefined || match.index === undefined) continue;
    blocks.push({ index: match.index, block: { kind: BlockKind.TABLE, text: tableText(body) } });
    remainder = remainder.replace(whole, ' '.repeat(whole.length));
  }

  for (const match of remainder.matchAll(BLOCK)) {
    const [, tag, body] = match;
    if (tag === undefined || body === undefined || match.index === undefined) continue;
    if (tag === 'table') continue;
    const text = plainText(body);
    if (text.length === 0) continue;
    blocks.push({
      index: match.index,
      block:
        tag === 'li'
          ? { kind: BlockKind.LIST_ITEM, text }
          : tag === 'p'
            ? { kind: BlockKind.PARAGRAPH, text }
            : { kind: BlockKind.HEADING, text, level: Number(tag.slice(1)) },
    });
  }

  return blocks.sort((one, two) => one.index - two.index).map((entry) => entry.block);
}

/** Cells joined with tabs, rows with newlines — §8.8. */
function tableText(body: string): string {
  const rows: string[] = [];
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gu)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gu)) {
      cells.push(plainText(cell[1] ?? ''));
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

/** Tags removed, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
  return decodeEntities(html.replaceAll(/<[^>]*>/gu, '')).replaceAll(/\s+/gu, ' ').trim();
}

/**
 * The five entities `mammoth` produces.
 *
 * Deliberately not a general decoder: a table of every named entity would be
 * claiming to read HTML from anywhere, and this reads HTML from one generator.
 * `&amp;` is applied last, so `&amp;lt;` decodes to `&lt;` rather than to `<`.
 */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}
