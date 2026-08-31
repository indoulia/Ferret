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
  codeSymbolAttributes,
  codeSymbolAttributesFrom,
  codeSymbolEntityInput,
  registerCodeSymbolKind,
} from './entity.js';
