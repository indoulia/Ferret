import { z } from 'zod';

import { entityKindDefinition, registerEntityKind } from '../domain/entity.js';

import { CODE_SYMBOL_KINDS, CODE_MODIFIERS, type CodeSymbol } from './symbols.js';

/**
 * `code_symbol` as a canonical entity kind.
 *
 * Registered rather than added to `EntityKind`, which is exactly what EPIC-006
 * AC-4 built `registerEntityKind` for: a new kind must not require a change to
 * the core entity model. The envelope is untouched, so `ENTITY_SCHEMA` stays at
 * version 1.
 *
 * Storage and lookup are EPIC-034. This is only the shape a symbol takes when
 * it becomes an entity.
 */

export const CODE_SYMBOL_KIND = 'code_symbol';

export const codeSymbolAttributes = z
  .object({
    name: z.string().min(1),
    /** The path of enclosing scopes. Unique within a file. */
    qualifiedName: z.string().min(1),
    symbolKind: z.enum(CODE_SYMBOL_KINDS),
    /** Repository-relative path of the declaring file. */
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    startByte: z.number().int().nonnegative(),
    endByte: z.number().int().nonnegative(),
    signature: z.string().optional(),
    modifiers: z.array(z.enum(CODE_MODIFIERS as [string, ...string[]])).optional(),
    documentation: z.string().optional(),
    /** 0 for the first declaration of a qualified name, 1 for the next. */
    overload: z.number().int().nonnegative().optional(),
    /**
     * The parser's own word for this.
     *
     * Kept so that a symbol landing on `unknown` can be diagnosed without
     * re-parsing: the gap is in the mapping, and this says what is missing.
     */
    declaredKind: z.string().min(1).optional(),
    /** The enclosing symbol, when there is one. */
    parentId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Registers the kind, once.
 *
 * Idempotent because more than one entry point may compose the code model, and
 * `registerEntityKind` throws on a duplicate — correctly, since a silent second
 * registration with a different schema would be a real defect.
 */
export function registerCodeSymbolKind(): void {
  if (entityKindDefinition(CODE_SYMBOL_KIND) !== undefined) return;
  registerEntityKind(CODE_SYMBOL_KIND, codeSymbolAttributes);
}

/** The attributes a symbol contributes to its entity. */
export function codeSymbolAttributesFrom(
  symbol: CodeSymbol,
  path: string,
): Record<string, unknown> {
  return {
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    symbolKind: symbol.kind,
    path,
    startLine: symbol.span.startLine,
    endLine: symbol.span.endLine,
    startByte: symbol.span.startByte,
    endByte: symbol.span.endByte,
    signature: symbol.signature,
    modifiers: [...symbol.modifiers],
    overload: symbol.overload,
    declaredKind: symbol.declaredKind,
    ...(symbol.documentation === undefined ? {} : { documentation: symbol.documentation }),
    ...(symbol.parentId === undefined ? {} : { parentId: symbol.parentId }),
  };
}
