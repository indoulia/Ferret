import type { CodeSymbol, CodeSymbolKind } from './symbols.js';

/**
 * What the core needs from a symbol index, expressed as a port.
 *
 * The same reason `indexing/ports.ts` exists: deciding *what* to look up has
 * nothing to do with PostgreSQL, and an import of the storage module here would
 * put a database dependency in the core and make Governance §4's central claim
 * false at the first place it mattered.
 *
 * The EPIC-034 store satisfies this structurally, without knowing this file
 * exists, and the architecture test proves the core still reaches no `storage/`
 * module.
 */

export interface SymbolQuery {
  /** The entity a file is identified within — usually a repository id. */
  readonly scope?: string;
  /** Repository-relative path of the declaring file. */
  readonly path?: string;
  /** Exact match on the declared name. */
  readonly name?: string;
  /** Exact match on the full path of enclosing scopes, e.g. `Box.width`. */
  readonly qualifiedName?: string;
  /**
   * Match on the start of the name.
   *
   * Separate from `name` and never implied by it: a prefix scan is a different
   * cost from an equality lookup, and a caller should choose it rather than
   * discover it.
   */
  readonly namePrefix?: string;
  readonly kind?: CodeSymbolKind;
  /**
   * Include symbols that have been tombstoned.
   *
   * Off by default, because a deleted symbol is not an answer to "where is this
   * defined". On for the question EPIC-032 exists to keep answerable: "when did
   * this disappear".
   */
  readonly includeDeleted?: boolean;
  readonly limit?: number;
}

/** A stored symbol, with the lifecycle the index recorded for it. */
export interface IndexedSymbol extends CodeSymbol {
  readonly path: string;
  readonly scope: string | undefined;
  readonly lifecycle: string;
}

/** What one file's indexing did. */
export interface SymbolIndexReport {
  readonly path: string;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /**
   * Symbols recorded for this file that the current content no longer declares.
   *
   * Counted rather than merely done, so a re-index that quietly retired a
   * hundred definitions is visible rather than inferred.
   */
  readonly tombstoned: number;
  /**
   * Symbols that were tombstoned by an earlier run and this file declares
   * again.
   *
   * Counted separately from `updated` because the content did not change — a
   * function deleted and restored is byte-identical, so an upsert reports it
   * unchanged and would leave the tombstone in place. Reconciliation is what
   * makes the record match the file, and it has to work in both directions.
   */
  readonly reinstated: number;
}

export interface SymbolIndexPort {
  /**
   * Writes a file's symbols and reconciles what was there before.
   *
   * Reconciliation is scoped to the file, because that is the unit that was
   * re-read. Anything wider would retire symbols in files this run never
   * looked at.
   */
  indexFileSymbols(
    context: { readonly scope: string; readonly path: string },
    symbols: readonly CodeSymbol[],
    now?: Date,
  ): Promise<SymbolIndexReport>;

  findSymbols(query: SymbolQuery): Promise<readonly IndexedSymbol[]>;
}
