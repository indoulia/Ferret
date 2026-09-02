import { describe, expect, it } from 'vitest';

import { OutlineKind, ParserFramework, ParserSupport, SegmentKind } from '../../src/index.js';
import {
  MAX_PDF_CHARACTERS,
  MAX_PDF_PAGES,
  PDF_MEDIA_TYPE,
  PDF_PARSER_ID,
  PDF_SECURITY_SETTINGS,
  createPdfParserProvider,
  createTextParserProvider,
  pdfLibraryIdentity,
  readPdf,
} from '../../src/parsers/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import { buildEncryptedPdf, buildMalformedPdf, buildPdf } from '../support/pdf-fixtures.js';
import type { ParseOutcome, ParsedContent } from '../../src/index.js';

/**
 * EPIC-026. PDFs, and the one field that keeps a page from being read as a line.
 *
 * Every case goes through `ParserFramework` rather than calling the provider
 * directly, because AC-4 *is* the framework's `validate` accepting the output:
 * a span past the end of the content is the failure this parser is most likely
 * to produce, and asserting it here would only assert what the parser believes.
 */

const parser = createPdfParserProvider();
const framework = new ParserFramework({ parsers: [parser] });

async function parse(bytes: Uint8Array, path = 'doc.pdf'): Promise<ParseOutcome> {
  return framework.parse({ path, bytes }, createTestOperationContext());
}

async function parsed(bytes: Uint8Array, path = 'doc.pdf'): Promise<ParsedContent> {
  const outcome = await parse(bytes, path);
  if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

function warningCodes(outcome: ParsedContent): readonly string[] {
  return outcome.warnings.map((warning) => warning.code);
}

const TWO_PAGES = buildPdf({
  pages: ['Hello from page one.', 'Second page text here.'],
  title: 'Ferret Probe',
  author: 'EPIC-026',
});

describe('PDF parser — claims', () => {
  it('claims application/pdf natively and nothing else — AC-1', () => {
    const target = {
      path: 'a.pdf',
      mediaType: PDF_MEDIA_TYPE,
      binary: true,
      sizeBytes: 10,
    };
    expect(parser.supports(target)).toBe(ParserSupport.NATIVE);
    expect(parser.supports({ ...target, mediaType: 'text/markdown' })).toBe(ParserSupport.NONE);
    expect(parser.supports({ ...target, mediaType: 'text/plain' })).toBe(ParserSupport.NONE);
    // No fallback: running a PDF container's machinery over bytes nobody said
    // were a PDF is the one thing this parser must never volunteer for.
    expect(parser.supports({ ...target, mediaType: 'application/octet-stream' })).toBe(
      ParserSupport.NONE,
    );
  });

  it('names the library build without parsing — AC-11', async () => {
    // No target: unlike the code parser, whose identity is the grammar for
    // *that* language, a PDF's producer is the library and nothing else.
    const identity = await parser.producerIdentity();
    expect(identity).toContain('pdfjs-dist@');
    expect(identity).toMatch(/^\d+\.\d+\.\d+\+pdfjs-dist@\d+\.\d+\.\d+\+[0-9a-f]+$/u);
    expect(pdfLibraryIdentity()).toContain('pdfjs-dist@');
  });
});

describe('PDF parser — extraction', () => {
  it('yields one segment per page, in order — AC-2', async () => {
    const outcome = await parsed(TWO_PAGES);
    const pages = outcome.segments.filter((segment) => segment.kind === SegmentKind.TEXT);
    expect(pages.map((segment) => segment.label)).toStrictEqual(['Page 1', 'Page 2']);
    expect(pages[0]?.text).toContain('Hello from page one.');
    expect(pages[1]?.text).toContain('Second page text here.');
  });

  it('declares its span unit, and the lines are pages — AC-3', async () => {
    const outcome = await parsed(TWO_PAGES);
    expect(outcome.spanUnit).toBe('page');
    const pages = outcome.segments.filter((segment) => segment.kind === SegmentKind.TEXT);
    expect(pages.map((segment) => segment.span.startLine)).toStrictEqual([1, 2]);
    expect(pages.map((segment) => segment.span.endLine)).toStrictEqual([1, 2]);
  });

  it('keeps every span inside the file — AC-4', async () => {
    // `parsed` throws on `invalid-result`, which is what `validate` returns for
    // a span past the end; asserting the bounds too makes the reason legible.
    const outcome = await parsed(TWO_PAGES);
    for (const segment of outcome.segments) {
      expect(segment.span.startByte).toBe(0);
      expect(segment.span.endByte).toBe(TWO_PAGES.byteLength);
      expect(segment.span.startLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports document properties as a segment and as attributes — AC-5', async () => {
    const outcome = await parsed(TWO_PAGES);
    const metadata = outcome.segments.find((segment) => segment.kind === SegmentKind.METADATA);
    expect(metadata?.label).toBe('Document properties');
    expect(metadata?.text).toContain('Title: Ferret Probe');
    expect(metadata?.text).toContain('Author: EPIC-026');
    expect(outcome.attributes['title']).toBe('Ferret Probe');
    expect(outcome.attributes['author']).toBe('EPIC-026');
    expect(outcome.attributes['pageCount']).toBe(2);
    expect(outcome.attributes['hasTextLayer']).toBe(true);
  });

  it('omits the properties segment when the document declares none', async () => {
    const outcome = await parsed(buildPdf({ pages: ['Only text.'] }));
    expect(outcome.segments.map((segment) => segment.kind)).toStrictEqual([SegmentKind.TEXT]);
  });

  it('turns bookmarks into a document outline with page spans — AC-6', async () => {
    const outcome = await parsed(
      buildPdf({
        pages: ['One.', 'Two.', 'Three.'],
        bookmarks: [
          { title: 'Introduction', page: 1 },
          { title: 'Findings', page: 3 },
        ],
      }),
    );
    expect(outcome.outlineKind).toBe(OutlineKind.DOCUMENT);
    expect(outcome.outline.map((node) => node.title)).toStrictEqual(['Introduction', 'Findings']);
    expect(outcome.outline.map((node) => node.span.startLine)).toStrictEqual([1, 3]);
    expect(outcome.outline.every((node) => node.kind === 'section')).toBe(true);
  });

  it('has an empty outline when there are no bookmarks — §8.9', async () => {
    const outcome = await parsed(TWO_PAGES);
    expect(outcome.outline).toStrictEqual([]);
    expect(outcome.attributes['bookmarkCount']).toBe(0);
  });
});

describe('PDF parser — refusals', () => {
  it('reports a missing text layer rather than an empty document — AC-7', async () => {
    // Two pages, neither with a content stream: a scan, structurally.
    const outcome = await parsed(buildPdf({ pages: ['', ''] }));
    expect(outcome.attributes['hasTextLayer']).toBe(false);
    expect(outcome.attributes['pageCount']).toBe(2);
    expect(warningCodes(outcome)).toContain('no-text-layer');
    expect(outcome.warnings.find((warning) => warning.code === 'no-text-layer')?.detail).toContain(
      'OCR',
    );
    // Not a failure. The page count is the fact that makes the gap countable.
    expect(outcome.parsed).toBe(true);
  });

  it('declines an encrypted document without reading a page — AC-8', async () => {
    const outcome = await parse(buildEncryptedPdf());
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    expect(outcome.detail).toContain('encrypted');
    expect(outcome.parserId).toBe(PDF_PARSER_ID);
  });

  it('fails malformed bytes with the reason, not a crash — AC-9', async () => {
    const outcome = await parse(buildMalformedPdf());
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    expect(outcome.detail).toContain('malformed');
  });

  it('distinguishes encrypted from malformed', async () => {
    const encrypted = await parse(buildEncryptedPdf());
    const malformed = await parse(buildMalformedPdf());
    expect(encrypted.parsed || malformed.parsed).toBe(false);
    if (encrypted.parsed || malformed.parsed) return;
    // One needs a password and one needs a file. Collapsing them into
    // "unreadable" would make the actionable half unactionable.
    expect(encrypted.detail).not.toStrictEqual(malformed.detail);
  });
});

describe('PDF parser — security', () => {
  it('passes the mandated configuration — AC-10', () => {
    // TECHNOLOGY-DECISIONS §4 and GHSA-hq66-cqwq-w95j. A requirement that lived
    // only in a comment would be one refactor away from gone.
    expect(PDF_SECURITY_SETTINGS.isEvalSupported).toBe(false);
    expect(PDF_SECURITY_SETTINGS.enableXfa).toBe(false);
    expect(PDF_SECURITY_SETTINGS.useSystemFonts).toBe(false);
    expect(PDF_SECURITY_SETTINGS.disableFontFace).toBe(true);
    expect(PDF_SECURITY_SETTINGS.useWorkerFetch).toBe(false);
  });

  it('freezes the configuration, so a caller cannot relax it', () => {
    expect(Object.isFrozen(PDF_SECURITY_SETTINGS)).toBe(true);
  });

  it('does not detach the caller-owned buffer — AC-12', async () => {
    // `pdfjs` transfers the array it is handed. `ParseRequest.bytes` belongs to
    // the content stage, which still holds it after the parse returns.
    const bytes = buildPdf({ pages: ['Held by the caller.'] });
    const size = bytes.byteLength;
    await parsed(bytes);
    expect(bytes.byteLength).toBe(size);
    expect(bytes[0]).toBe(0x25);
  });
});

describe('PDF parser — bounds', () => {
  it('stops at the page cap and says so — AC-13', async () => {
    const bounded = new ParserFramework({ parsers: [createPdfParserProvider({ maxPages: 2 })] });
    const outcome = await bounded.parse(
      { path: 'long.pdf', bytes: buildPdf({ pages: ['One.', 'Two.', 'Three.', 'Four.'] }) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(warningCodes(outcome)).toContain('page-limit');
    expect(outcome.segments.filter((segment) => segment.kind === SegmentKind.TEXT)).toHaveLength(2);
    // The page count is the document's, not the number read: "4 pages, 2 read"
    // is the honest pair, and reporting 2 would hide the bound.
    expect(outcome.attributes['pageCount']).toBe(4);
  });

  it('stops at the character cap and says so — AC-13', async () => {
    const bounded = new ParserFramework({
      parsers: [createPdfParserProvider({ maxCharacters: 10 })],
    });
    const outcome = await bounded.parse(
      { path: 'wide.pdf', bytes: buildPdf({ pages: ['A short line.', 'Another short line.'] }) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(warningCodes(outcome)).toContain('character-limit');
  });

  it('declares bounds a reader can reason about', () => {
    expect(MAX_PDF_PAGES).toBe(1_000);
    expect(MAX_PDF_CHARACTERS).toBe(1_000_000);
  });
});

describe('PDF parser — the contract it widened', () => {
  it('leaves a parser that declares no unit reporting lines — AC-15', async () => {
    // The whole argument for `spanUnit` is that absent means the old meaning.
    // If adding it had changed what the text parser reports, every consumer
    // would have had to be revisited, and EPIC-029's precedent would not hold.
    const text = new ParserFramework({ parsers: [createTextParserProvider()] });
    const outcome = await text.parse(
      { path: 'notes.md', bytes: new TextEncoder().encode('# Title\n\nBody.\n') },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.spanUnit).toBeUndefined();
    expect(outcome.segments[0]?.span.startLine).toBe(1);
  });

  it('refuses a unit the contract does not name', async () => {
    // `validate` sees a parser's output as untrusted. An unrecognised unit is
    // worse than an absent one: a consumer would read the default meaning off a
    // field that was trying to say otherwise.
    const rogue = {
      parserId: 'test.rogue',
      parserVersion: '1.0.0',
      supports: () => ParserSupport.NATIVE,
      parse: () => ({
        segments: [
          {
            kind: SegmentKind.TEXT,
            text: 'x',
            span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 },
          },
        ],
        spanUnit: 'furlong' as never,
      }),
    };
    const outcome = await new ParserFramework({ parsers: [rogue] }).parse(
      { path: 'a.txt', bytes: new TextEncoder().encode('x') },
      createTestOperationContext(),
    );
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('invalid-result');
    expect(outcome.detail).toContain('furlong');
  });
});

describe('PDF parser — the loading task', () => {
  it('releases the task on the failure path too — AC-16', async () => {
    // A leaked task holds a worker and the transferred buffer. There is no
    // handle to assert on, so the observable is that repeated failures and
    // successes interleave without the process degrading or a handle leaking.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(readPdf(buildEncryptedPdf())).rejects.toThrow(/encrypted/u);
      await expect(readPdf(buildMalformedPdf())).rejects.toThrow(/malformed/u);
      const extraction = await readPdf(buildPdf({ pages: ['Still working.'] }));
      expect(extraction.hasTextLayer).toBe(true);
    }
  });
});
