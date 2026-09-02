import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  OutlineKind,
  ParserSupport,
  SegmentKind,
  SpanUnit,
  type ContentSegment,
  type ContentParser,
  type ContentSpan,
  type OutlineNode,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
} from '../../providers/contracts/parser.js';
import { ProviderKind, type Provider } from '../../providers/contract.js';
import { BaseProvider } from '../../providers/sdk/base.js';
import type { ProviderOperationContext } from '../../providers/sdk/operation.js';

import {
  pdfLibraryIdentity,
  readPdf,
  type PdfBookmark,
  type PdfProperties,
} from './document.js';

/**
 * PDFs — EPIC-026.
 *
 * The only parser whose unit is not a line. §8.1 makes that explicit through
 * `spanUnit` rather than leaving a consumer to read page numbers as lines, and
 * §8.2 explains why the byte range is the file's: `pdfjs` cannot say where on
 * disk a page's glyphs came from, and inventing an offset would produce exactly
 * the unquotable evidence `validate()` exists to stop.
 */

export const PDF_PARSER_ID = 'ferret.parser.pdf';
export const PDF_PARSER_VERSION = '1.0.0';
export const PDF_MEDIA_TYPE = 'application/pdf';

export interface PdfParserOptions {
  /** Overridden only by a test that needs to reach the bound — §8.6. */
  readonly maxPages?: number;
  readonly maxCharacters?: number;
}

export class PdfParserProvider extends BaseProvider implements Provider, ContentParser {
  readonly id = PDF_PARSER_ID;
  readonly kind = ProviderKind.PARSER;
  readonly description = 'PDF text, bookmarks and document properties, by page';
  readonly capabilities = [
    { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
  ];

  readonly parserId = PDF_PARSER_ID;
  readonly parserVersion = PDF_PARSER_VERSION;

  readonly #maxPages: number | undefined;
  readonly #maxCharacters: number | undefined;

  constructor(options: PdfParserOptions = {}) {
    super();
    this.#maxPages = options.maxPages;
    this.#maxCharacters = options.maxCharacters;
  }

  /**
   * One media type, and no fallback.
   *
   * A PDF is a container format with its own scripting engine; claiming
   * anything by guess would run that machinery over bytes nobody said were a
   * PDF. `detect.ts` matches `%PDF-` and that is the only claim made here.
   */
  supports(target: ParseTarget): ParserSupport {
    return target.mediaType === PDF_MEDIA_TYPE ? ParserSupport.NATIVE : ParserSupport.NONE;
  }

  /** The library build, so EPIC-031 re-extracts when it moves — AC-11. */
  producerIdentity(): Promise<string> {
    return Promise.resolve(`${this.parserVersion}+${pdfLibraryIdentity()}`);
  }

  async parse(request: ParseRequest, context: ProviderOperationContext): Promise<ParseOutput> {
    context.signal.throwIfAborted();

    const extraction = await readPdf(request.bytes, {
      ...(this.#maxPages === undefined ? {} : { maxPages: this.#maxPages }),
      ...(this.#maxCharacters === undefined ? {} : { maxCharacters: this.#maxCharacters }),
      signal: context.signal,
    });

    const size = request.target.sizeBytes;
    const segments: ContentSegment[] = [];

    const properties = describeProperties(extraction.properties);
    if (properties !== undefined) {
      segments.push({
        kind: SegmentKind.METADATA,
        text: properties,
        // Page 1: the properties are the document's, and a locator has to point
        // somewhere a reader can open. Labelled, so it is not read as content.
        span: pageSpan(1, size),
        label: 'Document properties',
      });
    }

    for (const page of extraction.pages) {
      segments.push({
        kind: SegmentKind.TEXT,
        text: page.text,
        span: pageSpan(page.page, size),
        label: `Page ${String(page.page)}`,
      });
    }

    return {
      segments,
      outline: extraction.bookmarks.map((bookmark) => outlineOf(bookmark, size)),
      // §8.9, for EPIC-029 §8.4's reason: a bookmark is a section, and
      // `buildCodeSymbols` must never see one.
      outlineKind: OutlineKind.DOCUMENT,
      // §8.1. The one field that stops a page being read as a line.
      spanUnit: SpanUnit.PAGE,
      attributes: {
        language: 'pdf',
        pageCount: extraction.pageCount,
        // §8.4. The scanned-PDF answer, countable without re-reading the file.
        hasTextLayer: extraction.hasTextLayer,
        bookmarkCount: extraction.bookmarks.length,
        ...extraction.properties,
      },
      warnings: extraction.warnings,
      truncated: extraction.truncated,
    };
  }
}

/**
 * A page, as a span.
 *
 * §8.2: the byte range is the whole file, which is true, and the page is in the
 * line fields under the unit the output declares. A `sizeBytes` of zero would
 * make `endByte` zero, which `validate()` accepts and which is the honest span
 * for a file with no bytes.
 */
function pageSpan(page: number, sizeBytes: number): ContentSpan {
  return { startByte: 0, endByte: Math.max(sizeBytes, 0), startLine: page, endLine: page };
}

function outlineOf(bookmark: PdfBookmark, sizeBytes: number): OutlineNode {
  return {
    title: bookmark.title,
    kind: 'section',
    span: pageSpan(bookmark.page, sizeBytes),
    children: bookmark.children.map((child) => outlineOf(child, sizeBytes)),
  };
}

const PROPERTY_LABELS: readonly (readonly [keyof PdfProperties, string])[] = Object.freeze([
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
  ['creationDate', 'Created'],
  ['modificationDate', 'Modified'],
  // No `pdfVersion`: `pdfjs` reports one for every document, so including it
  // would make this segment unconditional — a "Document properties" block on a
  // document that declares none. It stays an attribute, where it is a fact
  // about the container rather than content to retrieve. Found by test — §17.
]);

/** The properties as text, or nothing when the document declares none. */
function describeProperties(properties: PdfProperties): string | undefined {
  const lines: string[] = [];
  for (const [key, label] of PROPERTY_LABELS) {
    const value = properties[key];
    if (value !== undefined) lines.push(`${label}: ${value}`);
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** A fresh provider, for a runtime to register. */
export function createPdfParserProvider(options: PdfParserOptions = {}): PdfParserProvider {
  return new PdfParserProvider(options);
}
