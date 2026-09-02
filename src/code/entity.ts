import { z } from 'zod';

import { EntityKind } from '../domain/kinds.js';
import { entityKindDefinition, registerEntityKind } from '../domain/entity.js';
import { registerRelationshipType } from '../domain/relationship.js';

import {
  CODE_SYMBOL_KIND,
  DEFAULT_SYMBOL_SOURCE_SYSTEM,
  symbolScope,
  symbolSourceId,
  type CodeSymbolContext,
} from './identity.js';
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
  registerCodeSymbolRelationships();
}

/**
 * A file declares a symbol; a symbol references a symbol — EPIC-035 §8.5.
 *
 * **Registered here rather than added to `domain/relationship.ts`'s built-in
 * table.** `code_symbol` is a registered kind, not one the core ships, so a
 * built-in type naming it would put `domain/` in the position of naming a kind
 * it does not have — the boundary EPIC-006 drew when it made kinds registrable.
 * EPIC-108 recorded that no approved criterion had yet given these edges an
 * owner; EPIC-035 is the owner, and this is where they belong.
 *
 * Neither is `exclusiveFrom`: a file declares many symbols, and a symbol
 * references many.
 *
 * Registered beside the kind rather than in a separate call, so a composition
 * that has symbols always has the edges they need — the two cannot be wired
 * half-way.
 */
function registerCodeSymbolRelationships(): void {
  registerRelationshipType(FILE_DECLARES_SYMBOL, {
    fromKinds: [EntityKind.FILE],
    toKinds: [CODE_SYMBOL_KIND],
  });
  registerRelationshipType(SYMBOL_REFERENCES_SYMBOL, {
    fromKinds: [CODE_SYMBOL_KIND],
    toKinds: [CODE_SYMBOL_KIND],
  });
  registerRelationshipType(FILE_REFERENCES_SYMBOL, {
    fromKinds: [EntityKind.FILE],
    toKinds: [CODE_SYMBOL_KIND],
  });
}

/** A file declares this symbol — EPIC-035. */
export const FILE_DECLARES_SYMBOL = 'file_declares_symbol';

/**
 * This symbol uses that one — EPIC-035.
 *
 * The edge that answers "where is this used", by inbound traversal. A top-level
 * reference has no declaring symbol to be the source, so §8.2 attributes it to
 * the file through {@link FILE_REFERENCES_SYMBOL} instead of dropping it.
 */
export const SYMBOL_REFERENCES_SYMBOL = 'symbol_references_symbol';

/**
 * A file's top-level code uses this symbol — EPIC-035 §8.2.
 *
 * Separate from {@link SYMBOL_REFERENCES_SYMBOL} rather than reusing it with a
 * file at the source end: the endpoint kinds are what make an edge type mean
 * something, and one type accepting either kind would make "which symbol calls
 * this" unanswerable at exactly the point it matters. A top-level call is still
 * a use, so it gets an edge rather than being dropped.
 */
export const FILE_REFERENCES_SYMBOL = 'file_references_symbol';

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

/**
 * The entity input for a symbol.
 *
 * The key parts here **must** be the ones `codeSymbolId` hashes, or the entity
 * `createEntity` derives would have a different id from the symbol it came
 * from. That is not a cosmetic mismatch: EPIC-034 reconciles a file by
 * comparing stored ids against the ids of the symbols it was just given, so a
 * divergence retires every symbol on every run — which is exactly how it
 * failed the first time it was written.
 *
 * `codeSymbolEntityId` below is the guard: it derives the id the same way and
 * a test asserts the two agree.
 */
export function codeSymbolEntityInput(
  symbol: CodeSymbol,
  context: CodeSymbolContext,
): {
  kind: string;
  source: { system: string; id: string; scope: string };
  attributes: Record<string, unknown>;
} {
  return {
    kind: CODE_SYMBOL_KIND,
    source: {
      system: context.sourceSystem ?? DEFAULT_SYMBOL_SOURCE_SYSTEM,
      id: symbolSourceId(symbol.qualifiedName, symbol.overload),
      scope: symbolScope(context),
    },
    attributes: codeSymbolAttributesFrom(symbol, context.path),
  };
}
