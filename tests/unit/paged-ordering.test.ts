import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A query that pages must order totally — EPIC-118.
 *
 * `OFFSET` only means anything against a fixed order. `ORDER BY e.kind,
 * e.source_id` is not one: nothing constrains that pair to be unique, and one
 * kind ties in practice — a `code_symbol`'s source id is the symbol's name, so
 * every name declared in two files is a tie, and Ferret's own index holds 178
 * such groups. PostgreSQL is then free to order tied rows differently between
 * two executions of the same query, and a row that moves across a page boundary
 * is returned twice or skipped entirely.
 *
 * **Source-level rather than behavioural, and deliberately so.** The reordering
 * is latitude the planner *has*, not behaviour it always exhibits: on a small
 * table it returns insertion order and a behavioural test passes with the
 * tiebreak removed. That was measured rather than assumed — reverting `e.id`
 * left the paging suite green. A test that passes either way is not a control,
 * so this asserts the property that actually guarantees the invariant: the
 * paged query names a unique column last.
 *
 * On the precedent of `mcp-destructive-tools.test.ts` and `boundaries.test.ts`,
 * both of which check how a thing is written for the same reason.
 */

const RETRIEVAL = fileURLToPath(new URL('../../src/storage/retrieval.ts', import.meta.url));

/**
 * The `ORDER BY ... LIMIT ... OFFSET` of every paged query in the file.
 *
 * Found by reading the source rather than listed here, so a second paged query
 * added later is covered on the day it is written rather than the day someone
 * remembers this file.
 */
function pagedOrderings(): string[] {
  const source = readFileSync(RETRIEVAL, 'utf8');
  const orderings: string[] = [];
  // Each `ORDER BY` up to the end of its statement, kept only when an OFFSET
  // follows — an unpaged query has no page boundary for a tie to fall across.
  for (const match of source.matchAll(/ORDER BY ([^\n]*)\n\s*(LIMIT[^\n]*)\n/g)) {
    const [, columns, bounds] = match;
    if (columns === undefined || bounds === undefined) continue;
    if (!bounds.includes('OFFSET')) continue;
    orderings.push(columns.trim());
  }
  return orderings;
}

describe('a paged query orders totally', () => {
  it('finds the paged queries it is meant to check', () => {
    // Guards the control itself. A regex that silently matched nothing would
    // make every assertion below vacuously true, and this file would read as
    // green while checking no query at all.
    expect(pagedOrderings().length).toBeGreaterThan(0);
  });

  it('breaks every tie on the primary key', () => {
    for (const ordering of pagedOrderings()) {
      // `e.id` is the entity table's primary key, so an ordering ending in it
      // is total by construction — no two rows can compare equal.
      expect(ordering, `paged query orders by "${ordering}", which ties`).toMatch(/\be\.id\s*$/);
    }
  });
});
