import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **Every branch that can return a row applies the scope filter.**
 *
 * The shape of defect #87: the evidence branch of `search` selected
 * `permission_scope` onto the hit and never consulted it, so a protected
 * observation's content was matched by a query and returned verbatim. EPIC-058
 * had tested permission filtering; the branch that skipped it was a branch
 * nobody had enumerated.
 *
 * Two branches have been added since — content (EPIC-087) and the abbreviated
 * object id — and each was a chance to repeat it. This file makes adding a
 * third a failing build rather than a review someone has to remember to do.
 *
 * Structural, deliberately. The behavioural proof lives in
 * `tests/integration/retrieval/permission.test.ts` against a real database,
 * where it belongs; what cannot be proved there is that *no branch was missed*,
 * because a missing branch returns rows the test never thought to ask for.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));
const source = readFileSync(resolve(SRC, 'storage/retrieval.ts'), 'utf8');

/**
 * The union arms of `RetrievalStore.search`, read from the source.
 *
 * A branch is a `const <name>Matches` — the convention every one of them
 * already follows, and the reason the convention is worth keeping. Matched on
 * the *name* rather than on what follows it: `objectIdMatches` is guarded by a
 * ternary before its template literal, and a pattern that insisted on
 * `= sql\`` skipped it — which is the enumeration failing open on the exact
 * kind of branch this file exists to catch.
 */
function branches(): string[] {
  return [...source.matchAll(/const (\w+Matches)\s*=/g)].map((match) => match[1] ?? '');
}

/** The text of one branch, from its declaration to the end of its statement. */
function bodyOf(name: string): string {
  const start = source.indexOf(`const ${name} =`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const close = source.indexOf('`;', source.indexOf('sql`', start) + 4);
  return source.slice(start, close);
}

describe('every search branch is scope-filtered — AC-7', () => {
  it('finds the branches at all', () => {
    // Failing closed. A refactor that renamed the convention would otherwise
    // leave this file asserting a property of the empty set.
    const found = branches();

    expect(found.length).toBeGreaterThanOrEqual(4);
    process.stderr.write(`[EPIC-100] search branches: ${found.join(', ')}\n`);
  });

  it('applies scopePredicate in each one', () => {
    for (const name of branches()) {
      expect(bodyOf(name), `${name} can return rows without applying the repository scope filter`).toContain(
        'scopePredicate(access)',
      );
    }
  });

  it('consults permission_scope wherever it selects one', () => {
    // Defect #87 exactly: selecting the column is not consulting it. A branch
    // that mentions `permission_scope` must also pass it to the predicate.
    for (const name of branches()) {
      const body = bodyOf(name);
      if (!body.includes('permission_scope')) continue;

      expect(body, `${name} selects permission_scope without filtering on it`).toContain('permissionPredicate(');
    }
  });

  it('keeps the predicates themselves reachable', () => {
    // Both helpers must exist and be used somewhere; a rename that broke the
    // string match above would otherwise read as compliance.
    expect(source).toContain('function scopePredicate(');
    expect(source).toContain('function permissionPredicate(');
  });
});

describe('the withheld count discloses nothing — EPIC-058 AC-5', () => {
  it('counts protected rows without selecting their content', () => {
    // A count that read the rows to count them would defeat the filter it
    // reports on. The property is stated in `#countProtected`'s own comment;
    // this asserts the code still matches it.
    // The *definition*, not the first call site — the slice below is meaningless
    // if it lands on the caller.
    const start = source.indexOf('async #countProtected(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  }', start));

    expect(body).toContain('count(');
    // No statement, no attributes, no path: the query selects a number.
    expect(body).not.toMatch(/ev\.statement/);
    expect(body).not.toMatch(/e\.attributes/);
  });
});

/**
 * **Ranking cannot widen a result set — EPIC-056 §11, AC-11.**
 *
 * Reranking was the first thing added to the read path that reorders and *drops*
 * rows after the query has run, which makes the order of two calls a security
 * property: filter, then rank. Reversed, a hit the caller may not see could
 * occupy one of the `limit` places, or a part of a file could be folded into a
 * container outside the caller's scope.
 *
 * Structural for the same reason as the block above: the behavioural proof is in
 * `tests/integration/retrieval/permission.test.ts`, and what cannot be proved
 * there is that nobody later moved the two lines.
 */
describe('ranking runs after authorization, and can only ever narrow — EPIC-056', () => {
  it('filters before it ranks', () => {
    const filter = source.indexOf('visibleEntities(candidates');
    const ranked = source.indexOf('rank(permitted');

    expect(filter).toBeGreaterThan(-1);
    expect(ranked).toBeGreaterThan(-1);
    expect(filter).toBeLessThan(ranked);
  });

  it('gives the ranker no way to read a row it was not handed', () => {
    // Pure and core: it takes candidate hits and returns candidate hits. A
    // ranker that could query could rank something authorization never saw.
    const ranker = readFileSync(resolve(SRC, 'retrieval/rank.ts'), 'utf8');

    expect(ranker).not.toMatch(/from '\.\.\/storage/);
    expect(ranker).not.toMatch(/\bsql`/);
    expect(ranker).not.toMatch(/\bawait\b/);
  });

  it('keeps the freshness ordering just as unable to read anything — EPIC-057', () => {
    // Standing decides where a hit ranks, so it is on the same footing as the
    // ranker it feeds. It reads two fields already on the hit and nothing else.
    const freshness = readFileSync(resolve(SRC, 'retrieval/freshness.ts'), 'utf8');

    expect(freshness).not.toMatch(/from '\.\.\/storage/);
    expect(freshness).not.toMatch(/\bsql`/);
    expect(freshness).not.toMatch(/\bawait\b/);
  });

  it('gives the explanation nothing to read either, and no content to quote — EPIC-063', () => {
    // An explanation is composed of Ferret's own structural fields. If it could
    // read, it could describe a row authorization never saw; if it quoted
    // content, it would need EPIC-084 containment and could carry an injected
    // instruction. Neither is possible, and this is the structural half of
    // saying so — AC-13 is the behavioural half.
    const explain = readFileSync(resolve(SRC, 'retrieval/explain.ts'), 'utf8');

    expect(explain).not.toMatch(/from '\.\.\/storage/);
    expect(explain).not.toMatch(/\bsql`/);
    expect(explain).not.toMatch(/\bawait\b/);
    // The three fields that are content. An explanation names them; it never
    // reads their values.
    expect(explain).not.toMatch(/\.highlight\b/);
    expect(explain).not.toMatch(/\.attributes\b/);
    expect(explain).not.toMatch(/\.statement\b/);
  });
});
