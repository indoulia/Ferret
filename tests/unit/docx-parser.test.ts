import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OutlineKind, ParserFramework, ParserSupport, SegmentKind } from '../../src/index.js';
import {
  DOCX_IMAGE_POLICY,
  DOCX_MEDIA_TYPE,
  DOCX_PARSER_ID,
  MAX_DOCX_BLOCKS,
  MAX_DOCX_MESSAGES,
  createDocxParserProvider,
  createTextParserProvider,
  docxLibraryIdentity,
  plainText,
  readBlocks,
} from '../../src/parsers/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import { buildDocx, buildMalformedDocx, buildZip } from '../support/ooxml-fixtures.js';
import type { ParseOutcome, ParsedContent } from '../../src/index.js';

/**
 * EPIC-027. Word documents, whose unit is neither a line nor a page.
 *
 * Through `ParserFramework` for EPIC-026's reason: AC-5 *is* `validate`
 * accepting the output, and asserting spans against the parser's own belief
 * would assert nothing.
 */

const parser = createDocxParserProvider();
const framework = new ParserFramework({ parsers: [parser] });

async function parse(bytes: Uint8Array, path = 'doc.docx'): Promise<ParseOutcome> {
  return framework.parse({ path, bytes }, createTestOperationContext());
}

async function parsed(bytes: Uint8Array, path = 'doc.docx'): Promise<ParsedContent> {
  const outcome = await parse(bytes, path);
  if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

const REVIEW = buildDocx({
  paragraphs: [
    { style: 'Heading1', text: 'Architecture Review' },
    { text: 'The first paragraph of prose.' },
    { style: 'Heading2', text: 'Findings' },
    { text: 'A second paragraph.' },
  ],
  table: [
    ['Name', 'Owner'],
    ['Ferret', 'Platform'],
  ],
});

describe('DOCX parser — claims', () => {
  it('claims WordprocessingML and nothing else — AC-1', () => {
    const target = { path: 'a.docx', mediaType: DOCX_MEDIA_TYPE, binary: true, sizeBytes: 10 };
    expect(parser.supports(target)).toBe(ParserSupport.NATIVE);
    // Every OOXML file is a ZIP. Claiming the container would put a spreadsheet
    // through a reader that refuses it one layer down, with a worse message.
    expect(parser.supports({ ...target, mediaType: 'application/zip' })).toBe(ParserSupport.NONE);
    expect(
      parser.supports({
        ...target,
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe(ParserSupport.NONE);
    expect(
      parser.supports({
        ...target,
        mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).toBe(ParserSupport.NONE);
  });

  it('names the library version without parsing — AC-11', async () => {
    const identity = await parser.producerIdentity();
    expect(identity).toMatch(/^\d+\.\d+\.\d+\+mammoth@\d+\.\d+\.\d+$/u);
    expect(docxLibraryIdentity()).toContain('mammoth@');
  });
});

describe('DOCX parser — extraction', () => {
  it('separates headings from paragraphs, in order — AC-2', async () => {
    const outcome = await parsed(REVIEW);
    const kinds = outcome.segments.map((segment) => segment.kind);
    expect(kinds.slice(0, 4)).toStrictEqual([
      SegmentKind.HEADING,
      SegmentKind.TEXT,
      SegmentKind.HEADING,
      SegmentKind.TEXT,
    ]);
    expect(outcome.segments[0]?.text).toBe('Architecture Review');
    expect(outcome.segments[1]?.text).toBe('The first paragraph of prose.');
    // `extractRawText` would have given the same characters and lost exactly
    // this: which of them were headings. §8.1.
    expect(outcome.attributes['headingCount']).toBe(2);
  });

  it('nests the outline by heading level — AC-3', async () => {
    const outcome = await parsed(REVIEW);
    expect(outcome.outlineKind).toBe(OutlineKind.DOCUMENT);
    expect(outcome.outline).toHaveLength(1);
    expect(outcome.outline[0]?.title).toBe('Architecture Review');
    expect(outcome.outline[0]?.children.map((node) => node.title)).toStrictEqual(['Findings']);
  });

  it('attaches a skipped level to the nearest shallower heading', async () => {
    // Word documents skip levels constantly. A synthetic `h2` would be a section
    // the author never wrote.
    const outcome = await parsed(
      buildDocx({
        paragraphs: [
          { style: 'Heading1', text: 'Top' },
          { style: 'Heading3', text: 'Deep' },
        ],
      }),
    );
    expect(outcome.outline[0]?.children.map((node) => node.title)).toStrictEqual(['Deep']);
  });

  it('declares a paragraph unit, and the spans are block indices — AC-4', async () => {
    const outcome = await parsed(REVIEW);
    expect(outcome.spanUnit).toBe('paragraph');
    expect(outcome.segments.map((segment) => segment.span.startLine)).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('keeps every span inside the file — AC-5', async () => {
    const outcome = await parsed(REVIEW);
    for (const segment of outcome.segments) {
      expect(segment.span.startByte).toBe(0);
      expect(segment.span.endByte).toBe(REVIEW.byteLength);
    }
  });

  it('keeps a table as a table — AC-6', async () => {
    const outcome = await parsed(REVIEW);
    const table = outcome.segments.find((segment) => segment.kind === SegmentKind.TABLE);
    // EPIC-026 §4 refused this for a PDF, where a grid is inference. Here the
    // author declared `w:tbl`, so the kind is a fact.
    expect(table?.text).toBe('Name\tOwner\nFerret\tPlatform');
    expect(outcome.attributes['tableCount']).toBe(1);
  });

  it('keeps a list item per segment — AC-7', async () => {
    const outcome = await parsed(
      buildDocx({
        paragraphs: [
          { style: 'ListParagraph', text: 'First item' },
          { style: 'ListParagraph', text: 'Second item' },
        ],
      }),
    );
    expect(outcome.segments.map((segment) => segment.text)).toStrictEqual([
      'First item',
      'Second item',
    ]);
  });

  it('does not emit a paragraph twice for one inside a table cell', async () => {
    // `mammoth` wraps every cell's content in `<p>`. Scanning blocks without
    // taking tables out first would report each cell as its own paragraph and
    // then again as part of the table.
    const outcome = await parsed(buildDocx({ paragraphs: [], table: [['Only', 'Cells']] }));
    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]?.kind).toBe(SegmentKind.TABLE);
  });
});

describe('DOCX parser — what was lost', () => {
  it('reports the library messages as warnings — AC-8', async () => {
    // The fixture references heading styles it does not define, which is what
    // `mammoth` warns about — and is exactly the class of message that must not
    // be discarded: a partial extraction has to look different from a complete
    // one.
    const outcome = await parsed(REVIEW);
    const messages = outcome.warnings.filter((warning) => warning.code === 'document-message');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.detail).toContain('style');
  });

  it('caps the messages rather than turning a result into a log — AC-8', async () => {
    const outcome = await parsed(
      buildDocx({
        paragraphs: Array.from({ length: MAX_DOCX_MESSAGES + 10 }, (_, index) => ({
          style: `Undefined${String(index)}`,
          text: `Paragraph ${String(index)}`,
        })),
      }),
    );
    const messages = outcome.warnings.filter((warning) => warning.code === 'document-message');
    expect(messages).toHaveLength(MAX_DOCX_MESSAGES);
    expect(outcome.warnings.some((warning) => warning.code === 'message-limit')).toBe(true);
  });
});

describe('DOCX parser — refusals', () => {
  it('refuses a ZIP that is not a document, with the library sentence — AC-9', async () => {
    const outcome = await parse(buildMalformedDocx());
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    // TECHNOLOGY-DECISIONS §4 selected `mammoth` for exactly this: python-docx
    // returns empty text here, and "empty" must not mean "unreadable".
    expect(outcome.detail).toContain('main document part');
    expect(outcome.parserId).toBe(DOCX_PARSER_ID);
  });

  it('fails on bytes that are not an archive at all — AC-10', async () => {
    const outcome = await parse(new TextEncoder().encode('not a zip'));
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    expect(outcome.detail.length).toBeGreaterThan(0);
  });

  it('fails on a document part that is not XML', async () => {
    const outcome = await parse(
      buildZip([
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'word/document.xml', content: 'this is not xml <<<' },
      ]),
    );
    expect(outcome.parsed).toBe(false);
  });
});

describe('DOCX parser — bounds and safety', () => {
  it('stops at the block cap and says so — AC-12', async () => {
    const bounded = new ParserFramework({ parsers: [createDocxParserProvider({ maxBlocks: 2 })] });
    const outcome = await bounded.parse(
      {
        path: 'long.docx',
        bytes: buildDocx({
          paragraphs: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }, { text: 'Four' }],
        }),
      },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(outcome.segments).toHaveLength(2);
    expect(outcome.warnings.some((warning) => warning.code === 'block-limit')).toBe(true);
  });

  it('stops at the character cap and says so — AC-12', async () => {
    const bounded = new ParserFramework({
      parsers: [createDocxParserProvider({ maxCharacters: 5 })],
    });
    const outcome = await bounded.parse(
      { path: 'wide.docx', bytes: buildDocx({ paragraphs: [{ text: 'A short paragraph.' }] }) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(outcome.warnings.some((warning) => warning.code === 'character-limit')).toBe(true);
  });

  it('declares bounds a reader can reason about', () => {
    expect(MAX_DOCX_BLOCKS).toBe(5_000);
    expect(MAX_DOCX_MESSAGES).toBe(25);
  });

  it('never lets an image become a data URI — AC-14', async () => {
    // `mammoth`'s default is `images.dataUri`: a 3 MB screenshot becomes 4 MB of
    // base64 in the output string, and the cost is paid before anything could
    // discard it. Asserted against the source, the way `boundaries.test.ts`
    // asserts what a graph imports: a behavioural test would need a document
    // with a real embedded image, and would still pass if the encoding happened
    // and the result were thrown away.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/parsers/office/document.ts', import.meta.url)),
      'utf8',
    );
    expect(DOCX_IMAGE_POLICY).toBe('drop');
    expect(source).toContain('convertImage: IMAGE_HANDLER');
    expect(source.replaceAll(/^\s*\*.*$/gmu, '')).not.toContain('images.dataUri');
    const outcome = await parsed(REVIEW);
    for (const segment of outcome.segments) expect(segment.text).not.toContain('base64');
  });
});

describe('DOCX parser — the tokeniser', () => {
  it('decodes only the entities mammoth produces, ampersand last', () => {
    // `&amp;lt;` is a literal `&lt;` in the document, not a `<`. Applying
    // `&amp;` first would turn one into the other.
    expect(plainText('a &amp;lt; b')).toBe('a &lt; b');
    expect(plainText('<p>x &lt; y &amp; z</p>')).toBe('x < y & z');
  });

  it('treats an unrecognised element as prose rather than dropping it', () => {
    // Dropping is how a converter silently loses a paragraph. §8.4.
    const blocks = readBlocks('<p>Kept <sup>2</sup> and <blockquote>quoted</blockquote></p>');
    expect(blocks[0]?.text).toContain('Kept');
    expect(blocks[0]?.text).toContain('2');
    expect(blocks[0]?.text).toContain('quoted');
  });

  it('reads headings, paragraphs, list items and tables', () => {
    const blocks = readBlocks('<h2>T</h2><p>P</p><ul><li>L</li></ul><table><tr><td>C</td></tr></table>');
    expect(blocks.map((block) => block.kind)).toStrictEqual([
      'heading',
      'paragraph',
      'list-item',
      'table',
    ]);
    expect(blocks[0]?.level).toBe(2);
  });
});

describe('DOCX parser — the contract it widened', () => {
  it('leaves a parser that declares no unit reporting lines — AC-15', async () => {
    const text = new ParserFramework({ parsers: [createTextParserProvider()] });
    const outcome = await text.parse(
      { path: 'notes.md', bytes: new TextEncoder().encode('# Title\n\nBody.\n') },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.spanUnit).toBeUndefined();
  });
});
