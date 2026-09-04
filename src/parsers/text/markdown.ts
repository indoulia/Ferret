import { SegmentKind, type ContentSegment, type OutlineNode, type ParseWarning } from '../../providers/contracts/parser.js';

/**
 * Markdown structure, from the syntax and nothing else — EPIC-029.
 *
 * 206 of Ferret's own files are Markdown, and they are where most of its
 * recorded knowledge lives: every Epic specification, every validation record,
 * every architecture decision. Until this, a document was retrievable only as a
 * whole file — EPIC-059 could put one in a context pack and not quote the
 * section that answered the question.
 *
 * **No grammar.** `src/parsers/index.ts` records why the code parser's WASM is
 * confined: "a grammar is several megabytes of WASM, and the core must be
 * installable and importable without any of it". Markdown's structure is
 * line-oriented, so a scanner over lines is deterministic, auditable in one
 * file, and costs nothing to install. Adding `tree-sitter-markdown` would double
 * the grammar payload to recognise `##`.
 *
 * What that costs, stated rather than hidden: **no inline parsing**. Emphasis,
 * links and inline code stay in the text of the segment they belong to.
 * EPIC-029 §16 raises the document link graph as the next increment.
 */

/** How many segments one document will ever produce. */
export const MAX_MARKDOWN_SEGMENTS = 2000;

const ATX = /^(#{1,6})\s+(.*)$/;
const SETEXT_UNDERLINE = /^(=+|-{2,})\s*$/;
const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*(\S*)/;
const TABLE_DELIMITER = /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FRONT_MATTER = /^---\s*$/;

export interface MarkdownParse {
  readonly segments: readonly ContentSegment[];
  readonly outline: readonly OutlineNode[];
  readonly warnings: readonly ParseWarning[];
  readonly headingCount: number;
  readonly truncated: boolean;
}

interface Line {
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly number: number;
}

/**
 * Splits into lines carrying their own byte offsets.
 *
 * Byte offsets rather than character indexes because a span is a claim about the
 * *original bytes* — EPIC-024's contract — and a document with an em dash in it
 * would otherwise report spans that do not name what they quote.
 */
function linesOf(text: string): readonly Line[] {
  const lines: Line[] = [];
  const encoder = new TextEncoder();
  let byte = 0;
  let number = 1;

  for (const line of text.split('\n')) {
    // F-22. Splitting a CRLF document on the LF leaves the CR at the end of
    // every line, and `.` matches it — so `# Title\r` matched ATX with the title
    // `Title\r`, the fence and list rules matched with trailing carriage
    // returns, and the `trim()` that would have hidden it runs only on the
    // title. Measured before this: an identical document parsed LF gave 2
    // headings and 1 outline node, parsed CRLF gave **0 and 0**. Every heading
    // in a CRLF Markdown file was silently reclassified as prose, which on a
    // Windows checkout is every Markdown file Ferret indexes — including its own
    // 206, where most of its recorded knowledge lives.
    //
    // The CR is stripped from the line's *content* and still counted in the
    // *offsets*: it is a real byte of the source, so the next line starts after
    // it, and `endByte` excludes it exactly as it excludes the LF. A span keeps
    // naming the bytes it quotes — EPIC-024's contract, and F-24's lesson.
    const carriageReturn = line.endsWith('\r');
    const raw = carriageReturn ? line.slice(0, -1) : line;
    const length = encoder.encode(raw).length;
    lines.push({ text: raw, startByte: byte, endByte: byte + length, number });
    // The line terminator the split consumed — one byte for LF, two for CRLF —
    // which the next line's start must clear.
    byte += length + (carriageReturn ? 2 : 1);
    number += 1;
  }
  return lines;
}

/** A heading's level, or `undefined` when the line is not one. */
function atxLevel(line: string): { readonly level: number; readonly title: string } | undefined {
  const match = ATX.exec(line);
  if (match === null) return undefined;
  const hashes = match[1] ?? '';
  // A trailing run of `#` is decoration in the syntax, not part of the title.
  const title = (match[2] ?? '').replace(/\s+#+\s*$/, '').trim();
  return { level: hashes.length, title };
}

export function parseMarkdown(text: string): MarkdownParse {
  const lines = linesOf(text);
  const segments: ContentSegment[] = [];
  const warnings: ParseWarning[] = [];
  let truncated = false;

  const push = (segment: ContentSegment): boolean => {
    if (segments.length >= MAX_MARKDOWN_SEGMENTS) {
      truncated = true;
      return false;
    }
    segments.push(segment);
    return true;
  };

  const span = (from: Line, to: Line) => ({
    startByte: from.startByte,
    endByte: to.endByte,
    startLine: from.number,
    endLine: to.number,
  });

  /** Headings in document order, with their level, for nesting afterwards. */
  const headings: { readonly level: number; readonly title: string; readonly line: Line }[] = [];
  /** Lines of the current prose run, flushed as one `TEXT` segment. */
  let prose: Line[] = [];

  const flushProse = (): void => {
    if (prose.length === 0) return;
    const from = prose[0];
    const to = prose[prose.length - 1];
    if (from !== undefined && to !== undefined) {
      const body = prose.map((one) => one.text).join('\n');
      // Whitespace-only runs are not prose. A blank line is a separator, and a
      // segment of nothing is a span that quotes nothing.
      if (body.trim().length > 0) {
        push({ kind: SegmentKind.TEXT, text: body, span: span(from, to) });
      }
    }
    prose = [];
  };

  let index = 0;

  // Front matter, and only at the very start — EPIC-029 §8.2. A `---` further
  // down is a thematic break or a setext underline, and treating it as document
  // properties would read prose as facts about the file.
  const first = lines[0];
  if (first !== undefined && FRONT_MATTER.test(first.text)) {
    let close = -1;
    for (let scan = 1; scan < lines.length; scan += 1) {
      if (FRONT_MATTER.test(lines[scan]?.text ?? '')) {
        close = scan;
        break;
      }
    }
    if (close > 0) {
      const to = lines[close];
      if (to !== undefined) {
        push({
          kind: SegmentKind.METADATA,
          label: 'front matter',
          text: lines.slice(1, close).map((one) => one.text).join('\n'),
          span: span(first, to),
        });
        index = close + 1;
      }
    }
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;

    // A fence, and its content is never scanned — EPIC-029 §8.2. A `#` inside a
    // fence is a comment in someone else's language, and a parser that read it
    // as a heading would invent a section from a code sample.
    const fence = FENCE.exec(line.text);
    if (fence !== null) {
      flushProse();
      const marker = fence[2] ?? '```';
      const info = fence[3] ?? '';
      let close = -1;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        const candidate = lines[scan]?.text ?? '';
        // Closed by at least as many of the same character, and nothing else on
        // the line — CommonMark's rule, and the one that keeps a fence inside a
        // fence from ending the outer one.
        if (new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${String(marker.length)},}\\s*$`).test(candidate)) {
          close = scan;
          break;
        }
      }

      const end = close === -1 ? lines.length - 1 : close;
      const to = lines[end];
      if (to !== undefined) {
        push({
          kind: SegmentKind.CODE,
          ...(info.length === 0 ? {} : { label: info }),
          text: lines.slice(index, end + 1).map((one) => one.text).join('\n'),
          span: span(line, to),
        });
      }
      if (close === -1) {
        // Ends at the file rather than silently swallowing it — and says so, so
        // a malformed document is diagnosable rather than mysteriously short.
        warnings.push({
          code: 'unterminated-fence',
          detail: `A code fence opened at line ${String(line.number)} was never closed.`,
        });
      }
      index = end;
      continue;
    }

    const atx = atxLevel(line.text);
    if (atx !== undefined) {
      flushProse();
      push({ kind: SegmentKind.HEADING, label: atx.title, text: line.text, span: span(line, line) });
      headings.push({ level: atx.level, title: atx.title, line });
      continue;
    }

    // A setext heading is the *previous* line, underlined. Recognised here
    // rather than by lookahead so a `---` that follows nothing is a thematic
    // break and not a heading with an empty title.
    const underline = SETEXT_UNDERLINE.exec(line.text);
    if (underline !== null && prose.length > 0) {
      const title = prose[prose.length - 1];
      if (title !== undefined && title.text.trim().length > 0) {
        // The run before the title is still prose; the title itself is not.
        prose = prose.slice(0, -1);
        flushProse();
        const level = (underline[1] ?? '=').startsWith('=') ? 1 : 2;
        push({
          kind: SegmentKind.HEADING,
          label: title.text.trim(),
          text: `${title.text}\n${line.text}`,
          span: span(title, line),
        });
        headings.push({ level, title: title.text.trim(), line: title });
        continue;
      }
    }

    // A table is a pipe row followed by a delimiter row. Recognised on the
    // delimiter because that is the line that distinguishes a table from a
    // paragraph that happens to contain a pipe.
    if (TABLE_DELIMITER.test(line.text) && prose.length > 0 && (prose[prose.length - 1]?.text ?? '').includes('|')) {
      const header = prose[prose.length - 1];
      prose = prose.slice(0, -1);
      flushProse();
      let end = index;
      for (let scan = index + 1; scan < lines.length; scan += 1) {
        if (!(lines[scan]?.text ?? '').includes('|')) break;
        end = scan;
      }
      const to = lines[end];
      if (header !== undefined && to !== undefined) {
        push({
          kind: SegmentKind.TABLE,
          text: lines.slice(lines.indexOf(header), end + 1).map((one) => one.text).join('\n'),
          span: span(header, to),
        });
      }
      index = end;
      continue;
    }

    if (line.text.trim().length === 0) {
      // A blank line ends a paragraph, which is what makes a run a paragraph
      // rather than the whole document.
      flushProse();
      continue;
    }
    prose.push(line);
  }
  flushProse();

  if (truncated) {
    warnings.push({
      code: 'segment-limit',
      detail: `Stopped at ${String(MAX_MARKDOWN_SEGMENTS)} segments.`,
    });
  }

  return {
    segments,
    outline: nest(headings),
    warnings,
    headingCount: headings.length,
    truncated,
  };
}

/**
 * Nests headings by level.
 *
 * A document that jumps from `#` to `###` nests the `###` under the `#` rather
 * than inventing the missing level — EPIC-029 §8.2. Real documents skip levels,
 * and a parser that refused them would produce no outline for the files most in
 * need of one.
 */
function nest(
  headings: readonly { readonly level: number; readonly title: string; readonly line: Line }[],
): readonly OutlineNode[] {
  const roots: OutlineNode[] = [];
  // Each entry is an open heading and the children array it accepts.
  const open: { readonly level: number; readonly children: OutlineNode[] }[] = [];

  for (const heading of headings) {
    const node: OutlineNode & { children: OutlineNode[] } = {
      title: heading.title,
      kind: 'section',
      span: {
        startByte: heading.line.startByte,
        endByte: heading.line.endByte,
        startLine: heading.line.number,
        endLine: heading.line.number,
      },
      children: [],
    };

    while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= heading.level) open.pop();
    const parent = open[open.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    open.push({ level: heading.level, children: node.children });
  }
  return roots;
}
