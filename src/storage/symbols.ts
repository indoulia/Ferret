import { sql } from 'drizzle-orm';

import {
  CODE_SYMBOL_KIND,
  codeSymbolEntityInput,
  registerCodeSymbolKind,
  symbolScope,
  type CodeSymbol,
  type IndexedSymbol,
  type SymbolIndexPort,
  type SymbolIndexReport,
  type SymbolQuery,
} from '../code/index.js';
import { LifecycleState } from '../domain/index.js';
import { boundedLimit } from '../retrieval/index.js';

import { classifyDatabaseError } from './connection.js';
import { EntityStore, UpsertOutcome, type FerretDatabase } from './entities.js';

/**
 * Storing and finding the symbols a file declares — EPIC-034.
 *
 * **No new table.** A symbol *is* a canonical entity: EPIC-033 registers
 * `code_symbol` and EPIC-006 already answers identity, lifecycle, provenance
 * and tombstones for every one of them. A dedicated table would be a second
 * place for all of that to live and drift. Governance §5 is explicit about
 * this, and the cost of the decision is paid in indexes (migration 0010) rather
 * than in schema.
 *
 * The half that is easy to forget is reconciliation. A symbol deleted from a
 * file must stop being an answer, and the failure when it does not is silent:
 * the answer looks right and points at a line that has moved or gone.
 */

interface SymbolRow {
  [column: string]: unknown;
  id: string;
  lifecycle: string;
  source_scope: string | null;
  attributes: Record<string, unknown>;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toIndexedSymbol(row: SymbolRow): IndexedSymbol {
  const attributes = row.attributes;
  const documentation = attributes['documentation'];
  const parentId = attributes['parentId'];
  const modifiers = attributes['modifiers'];

  return {
    id: row.id,
    kind: stringOf(attributes['symbolKind']) as IndexedSymbol['kind'],
    name: stringOf(attributes['name']),
    qualifiedName: stringOf(attributes['qualifiedName']),
    parentId: typeof parentId === 'string' ? parentId : undefined,
    span: {
      startByte: numberOf(attributes['startByte']),
      endByte: numberOf(attributes['endByte']),
      startLine: numberOf(attributes['startLine'], 1),
      endLine: numberOf(attributes['endLine'], 1),
    },
    signature: stringOf(attributes['signature']),
    modifiers: Array.isArray(modifiers) ? modifiers.filter((m): m is string => typeof m === 'string') : [],
    documentation: typeof documentation === 'string' ? documentation : undefined,
    overload: numberOf(attributes['overload']),
    declaredKind: stringOf(attributes['declaredKind']),
    path: stringOf(attributes['path']),
    scope: row.source_scope ?? undefined,
    lifecycle: row.lifecycle,
  };
}

/**
 * Escapes the `LIKE` metacharacters in a prefix.
 *
 * A symbol name comes from a repository Ferret did not write. An unescaped `%`
 * is both a correctness bug — the name stops matching itself — and a way to
 * turn one prefix lookup into a scan of the whole index.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class SymbolStore implements SymbolIndexPort {
  readonly #db: FerretDatabase;
  readonly #entities: EntityStore;

  constructor(db: FerretDatabase) {
    // The kind has to exist before an entity of it can be created, and a
    // composition root that reached for the store without registering it would
    // fail on the first write rather than at construction.
    registerCodeSymbolKind();
    this.#db = db;
    this.#entities = new EntityStore(db);
  }

  /**
   * Writes a file's symbols, then retires what the file no longer declares.
   *
   * The upserts run first so that a symbol which merely *moved* within the file
   * is already current when reconciliation looks for strays — otherwise it
   * would be tombstoned and immediately revived, and every re-index would churn
   * its lifecycle.
   */
  async indexFileSymbols(
    context: { readonly scope: string; readonly path: string },
    symbols: readonly CodeSymbol[],
    now: Date = new Date(),
  ): Promise<SymbolIndexReport> {
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const symbol of symbols) {
      // Built by the shared helper, so the entity's derived id is the symbol's
      // id. Reconciliation below compares stored ids against these; two
      // derivations of the same key would retire every symbol on every run.
      const result = await this.#entities.upsert(
        { ...codeSymbolEntityInput(symbol, context), lifecycle: LifecycleState.ACTIVE },
        now,
      );
      if (result.outcome === UpsertOutcome.CREATED) created += 1;
      else if (result.outcome === UpsertOutcome.UPDATED) updated += 1;
      else unchanged += 1;
    }

    const { tombstoned, reinstated } = await this.#reconcile(context, symbols, now);
    return { path: context.path, created, updated, unchanged, tombstoned, reinstated };
  }

  /**
   * Tombstones symbols recorded for this file that it no longer declares.
   *
   * A tombstone, not a delete — EPIC-032's rule, unchanged. "When did this
   * function disappear, and what did it look like" is a question Ferret exists
   * to answer, and deleting the row destroys the answer along with the symbol.
   */
  async #reconcile(
    context: { readonly scope: string; readonly path: string },
    symbols: readonly CodeSymbol[],
    now: Date,
  ): Promise<{ tombstoned: number; reinstated: number }> {
    // `sql.param` rather than a bare `${keep}`: the template expands a plain
    // JavaScript array into one placeholder per element, which produces
    // `ANY(($1, $2, $3)::uuid[])` — a row constructor, not an array — and fails
    // outright on an empty list.
    const keep = sql.param(symbols.map((symbol) => symbol.id));
    const fileScope = symbolScope(context);
    try {
      const retired = await this.#db.execute<{ id: string }>(sql`
        UPDATE "ferret"."entity"
           SET lifecycle = ${LifecycleState.DELETED}, last_indexed_at = ${now}
         WHERE kind = ${CODE_SYMBOL_KIND}
           AND source_scope = ${fileScope}
           AND lifecycle <> ${LifecycleState.DELETED}
           AND NOT (id = ANY(${keep}::uuid[]))
        RETURNING id
      `);

      // The other direction, and it is not symmetrical by accident: a function
      // deleted and later restored is byte-identical, so the upsert above
      // reports it `unchanged` and never touches the tombstone. Without this,
      // a symbol that came back would stay deleted for ever.
      const revived = await this.#db.execute<{ id: string }>(sql`
        UPDATE "ferret"."entity"
           SET lifecycle = ${LifecycleState.ACTIVE}, last_indexed_at = ${now}
         WHERE kind = ${CODE_SYMBOL_KIND}
           AND source_scope = ${fileScope}
           AND lifecycle = ${LifecycleState.DELETED}
           AND id = ANY(${keep}::uuid[])
        RETURNING id
      `);

      return { tombstoned: retired.rows.length, reinstated: revived.rows.length };
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.symbol.reconcile');
    }
  }

  /**
   * Finds symbols.
   *
   * Ordered by path then start line, always. The same query twice returns the
   * same list, which is what makes this Epic's output testable and its limit
   * meaningful; relevance ordering is EPIC-056's and deliberately absent.
   */
  async findSymbols(query: SymbolQuery): Promise<readonly IndexedSymbol[]> {
    const limit = boundedLimit(query.limit);
    const conditions = [sql`kind = ${CODE_SYMBOL_KIND}`];

    if (query.includeDeleted !== true) {
      conditions.push(sql`lifecycle <> ${LifecycleState.DELETED}`);
    }
    if (query.scope !== undefined && query.path !== undefined) {
      // Both together address one file exactly, which is how the scope index is
      // shaped and the only form that avoids a scan.
      conditions.push(sql`source_scope = ${symbolScope({ scope: query.scope, path: query.path })}`);
    } else if (query.scope !== undefined) {
      conditions.push(sql`source_scope LIKE ${`${escapeLikePrefix(query.scope)}:%`} ESCAPE '\\'`);
    } else if (query.path !== undefined) {
      conditions.push(sql`attributes->>'path' = ${query.path}`);
    }
    if (query.name !== undefined) {
      conditions.push(sql`attributes->>'name' = ${query.name}`);
    }
    if (query.qualifiedName !== undefined) {
      conditions.push(sql`attributes->>'qualifiedName' = ${query.qualifiedName}`);
    }
    if (query.namePrefix !== undefined) {
      conditions.push(
        sql`attributes->>'name' LIKE ${`${escapeLikePrefix(query.namePrefix)}%`} ESCAPE '\\'`,
      );
    }
    if (query.kind !== undefined) {
      conditions.push(sql`attributes->>'symbolKind' = ${query.kind}`);
    }

    const where = conditions.reduce((left, right) => sql`${left} AND ${right}`);
    try {
      const result = await this.#db.execute<SymbolRow>(sql`
        SELECT id, lifecycle, source_scope, attributes
          FROM "ferret"."entity"
         WHERE ${where}
         ORDER BY attributes->>'path', (attributes->>'startLine')::int, attributes->>'qualifiedName'
         LIMIT ${limit}
      `);
      return result.rows.map(toIndexedSymbol);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.symbol.find');
    }
  }
}
