/**
 * Code intelligence — what a file declares, in Ferret's vocabulary.
 *
 * Core logic: mapping a parser's outline onto a canonical model has nothing to
 * do with any grammar, and this module reaches no parser. `boundaries.test.ts`
 * proves it, which is what keeps a grammar upgrade from changing what a
 * consumer switches on.
 */

export {
  CODE_SYMBOL_KIND,
  DEFAULT_SYMBOL_SOURCE_SYSTEM,
  codeSymbolId,
  symbolScope,
  symbolSourceId,
  type CodeSymbolContext,
} from './identity.js';

export {
  CODE_MODIFIERS,
  CODE_SYMBOL_KINDS,
  CodeSymbolKind,
  MAX_SIGNATURE_LENGTH,
  buildCodeSymbols,
  codeSymbolKindOf,
  codeSymbolTree,
  type CodeSymbol,
  type CodeSymbolNode,
} from './symbols.js';

export type {
  IndexedSymbol,
  SymbolIndexPort,
  SymbolIndexReport,
  SymbolQuery,
} from './index-port.js';

export {
  FILE_DECLARES_SYMBOL,
  FILE_REFERENCES_SYMBOL,
  SYMBOL_REFERENCES_SYMBOL,
  codeSymbolAttributes,
  codeSymbolAttributesFrom,
  codeSymbolEntityInput,
  registerCodeSymbolKind,
} from './entity.js';

// EPIC-035. Name-based, unambiguous-only resolution: an ambiguous name resolves
// to nothing, because a wrong call graph reads as knowledge.
export {
  ResolutionRule,
  RULE_CONFIDENCE as REFERENCE_RULE_CONFIDENCE,
  UnresolvedReason,
  resolveReferences,
  type FileReferenceResolution,
  type ReferenceResolution,
  type ResolvedReference,
  type SymbolCandidate,
  type UnresolvedReference,
} from './references.js';
