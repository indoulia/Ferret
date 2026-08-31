/**
 * Code intelligence — what a file declares, in Ferret's vocabulary.
 *
 * Core logic: mapping a parser's outline onto a canonical model has nothing to
 * do with any grammar, and this module reaches no parser. `boundaries.test.ts`
 * proves it, which is what keeps a grammar upgrade from changing what a
 * consumer switches on.
 */

export {
  CODE_MODIFIERS,
  CODE_SYMBOL_KINDS,
  CodeSymbolKind,
  MAX_SIGNATURE_LENGTH,
  buildCodeSymbols,
  codeSymbolId,
  codeSymbolKindOf,
  codeSymbolTree,
  type CodeSymbol,
  type CodeSymbolContext,
  type CodeSymbolNode,
} from './symbols.js';

export {
  CODE_SYMBOL_KIND,
  codeSymbolAttributes,
  codeSymbolAttributesFrom,
  registerCodeSymbolKind,
} from './entity.js';
