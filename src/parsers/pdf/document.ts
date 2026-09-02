import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * The `pdfjs` binding — EPIC-026.
 *
 * Everything that knows what a PDF is lives here; `provider.ts` knows only the
 * parser contract. The split is EPIC-025's: a library upgrade should touch one
 * file, and the security configuration should be one object a test can read.
 */

/** How many pages are read before the parser stops — EPIC-026 §8.6. */
export const MAX_PDF_PAGES = 1_000;

/** How many extracted characters are kept — EPIC-026 §8.6. */
export const MAX_PDF_CHARACTERS = 1_000_000;

/**
 * The mandatory configuration — EPIC-026 §8.3, TECHNOLOGY-DECISIONS §4.
 *
 * Exported so AC-10 asserts the values rather than trusting a comment.
 * `isEvalSupported: false` remediates GHSA-hq66-cqwq-w95j (arbitrary JavaScript
 * execution on opening a malicious PDF) and is a requirement, not a default.
 */
export const PDF_SECURITY_SETTINGS = Object.freeze({
  isEvalSupported: false,
  enableXfa: false,
  useSystemFonts: false,
  disableFontFace: true,
  useWorkerFetch: false,
});

/** Why a PDF could not be read at all. The parser throws these; §8.5, §8.9. */
export const PdfRefusal = {
  /** Password-protected. Not attempted — §8.5. */
  ENCRYPTED: 'encrypted',
  /** Not a PDF, or damaged past the point `pdfjs` can open it. */
  MALFORMED: 'malformed',
} as const;

export type PdfRefusal = (typeof PdfRefusal)[keyof typeof PdfRefusal];

export class PdfReadError extends Error {
  readonly reason: PdfRefusal;

  constructor(reason: PdfRefusal, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'PdfReadError';
    this.reason = reason;
  }
}

export interface PdfPage {
  /** 1-based. This is what a segment's span reports under `spanUnit: page`. */
  readonly page: number;
  readonly text: string;
}

export interface PdfBookmark {
  readonly title: string;
  /** 1-based, resolved through `getPageIndex`. */
  readonly page: number;
  readonly children: readonly PdfBookmark[];
}

export interface PdfProperties {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
  readonly creationDate?: string;
  readonly modificationDate?: string;
  readonly pdfVersion?: string;
}

export interface PdfExtraction {
  readonly pageCount: number;
  readonly pages: readonly PdfPage[];
  readonly bookmarks: readonly PdfBookmark[];
  readonly properties: PdfProperties;
  /** Any page produced a character. False is the scanned-PDF answer — §8.4. */
  readonly hasTextLayer: boolean;
  /** A page cap or a character cap was reached — §8.6. */
  readonly truncated: boolean;
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}

export interface PdfReadOptions {
  readonly maxPages?: number;
  readonly maxCharacters?: number;
  readonly signal?: AbortSignal;
}

/**
 * Where the font and CMap data live, as `file:` URLs.
 *
 * Resolved from the installed package rather than bundled: the data is 2.3 MB
 * and already on disk. Supplied because a standard-14 or CJK-encoded document
 * needs the glyph map to extract *correct* text — without it `pdfjs` warns and
 * falls back, which is a silent correctness loss rather than a failure.
 */
function assetRoot(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('pdfjs-dist/package.json').replace(/package\.json$/u, '');
}

let cachedAssets: { standardFontDataUrl: string; cMapUrl: string } | undefined;

function assets(): { standardFontDataUrl: string; cMapUrl: string } {
  cachedAssets ??= {
    standardFontDataUrl: pathToFileURL(`${assetRoot()}standard_fonts/`).href,
    cMapUrl: pathToFileURL(`${assetRoot()}cmaps/`).href,
  };
  return cachedAssets;
}

/**
 * What produced an extraction, beyond the parser's own version — §AC-11.
 *
 * `pdfjs`'s version and build hash, the way the code parser names its grammar.
 * A constant read off the module: no parse, because EPIC-108's gate asks this
 * before deciding whether to read a file at all.
 */
export function pdfLibraryIdentity(): string {
  return `pdfjs-dist@${pdfjs.version}+${pdfjs.build}`;
}

function isPasswordException(error: unknown): boolean {
  return error instanceof Error && error.name === 'PasswordException';
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function propertiesOf(info: unknown): PdfProperties {
  const record: Record<string, unknown> =
    typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : {};
  return {
    ...(textOf(record['Title']) === undefined ? {} : { title: textOf(record['Title']) }),
    ...(textOf(record['Author']) === undefined ? {} : { author: textOf(record['Author']) }),
    ...(textOf(record['Subject']) === undefined ? {} : { subject: textOf(record['Subject']) }),
    ...(textOf(record['Keywords']) === undefined ? {} : { keywords: textOf(record['Keywords']) }),
    ...(textOf(record['Creator']) === undefined ? {} : { creator: textOf(record['Creator']) }),
    ...(textOf(record['Producer']) === undefined ? {} : { producer: textOf(record['Producer']) }),
    ...(textOf(record['CreationDate']) === undefined
      ? {}
      : { creationDate: textOf(record['CreationDate']) }),
    ...(textOf(record['ModDate']) === undefined
      ? {}
      : { modificationDate: textOf(record['ModDate']) }),
    ...(textOf(record['PDFFormatVersion']) === undefined
      ? {}
      : { pdfVersion: textOf(record['PDFFormatVersion']) }),
  };
}

/** One page's text, in the order `pdfjs` reports it — §4 declines to reorder. */
function pageText(items: readonly unknown[]): string {
  let text = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as { str?: unknown; hasEOL?: unknown };
    // A `TextMarkedContent` item carries structure, not characters.
    if (typeof entry.str !== 'string') continue;
    text += entry.str;
    if (entry.hasEOL === true) text += '\n';
  }
  return text;
}

interface OutlineEntry {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: unknown;
}

/**
 * A bookmark's page, or `undefined` when the destination does not resolve.
 *
 * Dropped rather than guessed — §8.9. A named destination is a lookup, an
 * explicit one is a ref, and a broken one is neither.
 */
async function bookmarkPage(
  document: pdfjs.PDFDocumentProxy,
  dest: unknown,
): Promise<number | undefined> {
  try {
    const explicit: unknown = typeof dest === 'string' ? await document.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined;
    const index = await document.getPageIndex(explicit[0] as Parameters<typeof document.getPageIndex>[0]);
    return index + 1;
  } catch {
    return undefined;
  }
}

async function bookmarksOf(
  document: pdfjs.PDFDocumentProxy,
  entries: readonly OutlineEntry[],
  warnings: { code: string; detail: string }[],
): Promise<PdfBookmark[]> {
  const bookmarks: PdfBookmark[] = [];
  for (const entry of entries) {
    const title = textOf(entry.title);
    if (title === undefined) continue;
    const page = await bookmarkPage(document, entry.dest);
    if (page === undefined) {
      warnings.push({ code: 'unresolved-bookmark', detail: `"${title}" points nowhere readable.` });
      continue;
    }
    const children = Array.isArray(entry.items)
      ? await bookmarksOf(document, entry.items as readonly OutlineEntry[], warnings)
      : [];
    bookmarks.push({ title, page, children });
  }
  return bookmarks;
}

/**
 * Read a PDF.
 *
 * The bytes are **copied** first — §8.7. `pdfjs` detaches the buffer it is
 * given, and `ParseRequest.bytes` belongs to the framework's content stage,
 * which still holds it after the parse returns. Measured, not assumed.
 */
export async function readPdf(
  bytes: Uint8Array,
  options: PdfReadOptions = {},
): Promise<PdfExtraction> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const maxCharacters = options.maxCharacters ?? MAX_PDF_CHARACTERS;
  const warnings: { code: string; detail: string }[] = [];

  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    ...PDF_SECURITY_SETTINGS,
    ...assets(),
    cMapPacked: true,
    // `pdfjs` writes its own warnings to the console. Ferret's logger is the
    // only place a parse should speak from, and §8.4 already reports the one
    // condition worth hearing about.
    verbosity: 0,
  });

  try {
    let document: pdfjs.PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      // §8.5: encrypted is refused before any page is read, and it is a
      // different answer from damaged — one needs a password, one needs a file.
      if (isPasswordException(error)) {
        throw new PdfReadError(PdfRefusal.ENCRYPTED, 'The document is password-protected.');
      }
      throw new PdfReadError(
        PdfRefusal.MALFORMED,
        error instanceof Error ? error.message : String(error),
      );
    }

    const pageCount = document.numPages;
    const pages: PdfPage[] = [];
    let characters = 0;
    let truncated = false;

    for (let number = 1; number <= pageCount; number += 1) {
      options.signal?.throwIfAborted();
      if (number > maxPages) {
        truncated = true;
        warnings.push({
          code: 'page-limit',
          detail: `Stopped after ${String(maxPages)} of ${String(pageCount)} pages.`,
        });
        break;
      }

      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = pageText(content.items);
        if (characters + text.length > maxCharacters) {
          truncated = true;
          warnings.push({
            code: 'character-limit',
            detail: `Stopped at ${String(maxCharacters)} characters, on page ${String(number)}.`,
          });
          break;
        }
        characters += text.length;
        if (text.trim().length > 0) pages.push({ page: number, text });
      } finally {
        // §13. `pdfjs` caches per page; a long document that never releases is
        // the memory profile this parser is bounded to avoid.
        page.cleanup();
      }
    }

    const metadata = await document.getMetadata();
    const outline: unknown = await document.getOutline();
    const bookmarks = Array.isArray(outline)
      ? await bookmarksOf(document, outline as readonly OutlineEntry[], warnings)
      : [];

    const hasTextLayer = pages.length > 0;
    if (!hasTextLayer && pageCount > 0) {
      warnings.push({
        code: 'no-text-layer',
        detail: `${String(pageCount)} page(s) carry no extractable text. Reading it needs OCR, which Ferret does not do.`,
      });
    }

    return {
      pageCount,
      pages,
      bookmarks,
      properties: propertiesOf(metadata.info),
      hasTextLayer,
      truncated,
      warnings,
    };
  } finally {
    // §8.8. `document.destroy` does not exist; the loading task owns the
    // worker and the transferred buffer, and it is what has to be released.
    await task.destroy();
  }
}
