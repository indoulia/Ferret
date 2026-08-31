import { canonicalId, canonicalKey } from '../domain/identity.js';

/**
 * How a symbol is identified, in one place.
 *
 * Separated from both `symbols.ts` and `entity.ts` because both need it and
 * neither may import the other. That is not a module-layout preference: the key
 * parts below are what `codeSymbolId` hashes *and* what `createEntity` hashes,
 * and if the two ever computed them differently the entity's id would differ
 * from the symbol's. EPIC-034 reconciles a file by comparing stored ids against
 * the ids of the symbols it was just handed, so a divergence retires every
 * symbol on every run — which is exactly how it failed the first time it was
 * written, with the two derivations three files apart.
 */

/** The canonical entity kind a symbol becomes. */
export const CODE_SYMBOL_KIND = 'code_symbol';

/** The system a symbol is attributed to when a context does not say. */
export const DEFAULT_SYMBOL_SOURCE_SYSTEM = 'git';

export interface CodeSymbolContext {
  /** Repository-relative path of the file these symbols were declared in. */
  readonly path: string;
  /**
   * The entity the file is identified within — EPIC-006's scope.
   *
   * Usually the repository's canonical id. Two repositories containing the same
   * file must not produce the same symbol ids.
   */
  readonly scope: string;
  /** The system the content came from. Defaults to `git`. */
  readonly sourceSystem?: string;
}

/** The scope a symbol is identified within: the file, inside its repository. */
export function symbolScope(context: CodeSymbolContext): string {
  return `${context.scope}:${context.path}`;
}

/**
 * The source id: the qualified name, with an ordinal only when it needs one.
 *
 * No suffix for the first declaration, so the common case reads as the name
 * itself in every diagnostic that prints a canonical key.
 */
export function symbolSourceId(qualifiedName: string, overload: number): string {
  return overload === 0 ? qualifiedName : `${qualifiedName}#${String(overload)}`;
}

/**
 * The stable identifier for a symbol.
 *
 * `canonicalId` over the same key shape EPIC-006 uses for everything else, so a
 * symbol id is derived rather than assigned and two runs over unchanged content
 * agree. A rename produces a different id, which is correct: it is a different
 * symbol, and the graph — not the identifier — is what tracks that it replaced
 * the old one.
 */
export function codeSymbolId(
  context: CodeSymbolContext,
  qualifiedName: string,
  overload: number,
): string {
  return canonicalId(
    canonicalKey({
      kind: CODE_SYMBOL_KIND,
      sourceSystem: context.sourceSystem ?? DEFAULT_SYMBOL_SOURCE_SYSTEM,
      // The file, within the repository. A qualified name is unique in a file
      // and nowhere else.
      scope: symbolScope(context),
      sourceId: symbolSourceId(qualifiedName, overload),
    }),
  );
}
