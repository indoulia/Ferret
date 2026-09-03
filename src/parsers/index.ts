/**
 * Ferret's own parsers — EPIC-025 onward.
 *
 * Published as `@indoulia/ferret/parsers`, never from the package root. A
 * grammar is several megabytes of WASM, and the core must be installable and
 * importable without any of it; `boundaries.test.ts` proves nothing reachable
 * from `@indoulia/ferret` imports `web-tree-sitter`.
 */

export {
  CODE_PARSER_ID,
  CODE_PARSER_LANGUAGES,
  CODE_PARSER_VERSION,
  MAX_SEGMENTS,
  CodeParserProvider,
  createCodeParserProvider,
  type CodeParserOptions,
} from './code/provider.js';

export {
  CODE_LANGUAGES,
  CODE_MEDIA_TYPES,
  DeclarationKind,
  REQUIRED_GRAMMARS,
  languageFor,
  type LanguageSpec,
} from './code/languages.js';

export {
  grammarSearchPaths,
  loadGrammarBytes,
  type GrammarIdentity,
} from './code/grammars.js';

// EPIC-029. Documents, without a grammar: 206 of Ferret's own files are
// Markdown, and they are where most of its recorded knowledge lives.
export {
  TEXT_FALLBACK_MEDIA_TYPES,
  TEXT_NATIVE_MEDIA_TYPES,
  TEXT_PARSER_ID,
  TEXT_PARSER_VERSION,
  TextParserProvider,
  createTextParserProvider,
} from './text/provider.js';

export { MAX_MARKDOWN_SEGMENTS, parseMarkdown, type MarkdownParse } from './text/markdown.js';

// EPIC-026. PDFs, where a page is the locator and a line is not — see §8.1.
export {
  PDF_MEDIA_TYPE,
  PDF_PARSER_ID,
  PDF_PARSER_VERSION,
  PdfParserProvider,
  createPdfParserProvider,
  type PdfParserOptions,
} from './pdf/provider.js';

export {
  MAX_PDF_CHARACTERS,
  MAX_PDF_PAGES,
  PDF_SECURITY_SETTINGS,
  PdfReadError,
  PdfRefusal,
  pdfLibraryIdentity,
  readPdf,
  type PdfExtraction,
  type PdfProperties,
} from './pdf/document.js';

// EPIC-027. Word documents, whose unit is a paragraph — see §8.2.
export {
  DOCX_MEDIA_TYPE,
  DOCX_PARSER_ID,
  DOCX_PARSER_VERSION,
  DocxParserProvider,
  createDocxParserProvider,
  type DocxParserOptions,
} from './office/provider.js';

export {
  DOCX_IMAGE_POLICY,
  DocxReadError,
  MAX_DOCX_BLOCKS,
  MAX_DOCX_CHARACTERS,
  MAX_DOCX_MESSAGES,
  docxLibraryIdentity,
  readDocx,
  type DocxExtraction,
} from './office/document.js';

export { BlockKind, plainText, readBlocks, type HtmlBlock } from './office/html.js';
