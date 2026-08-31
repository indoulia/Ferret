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
