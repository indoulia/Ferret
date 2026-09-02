# EPIC-034 — Symbol Index: validation evidence

**Status: VALIDATED** · no new table and no new dependency. One migration, four
partial indexes, and a store built on the EPIC-002 entity store.

## What the Epic does

`SymbolStore.indexFileSymbols` writes a file's EPIC-033 symbols as canonical
`code_symbol` entities and then reconciles: symbols the file no longer declares
are tombstoned, and symbols it declares again are reinstated.
`findSymbols` answers by exact name, qualified name, kind, file and name prefix,
in a deterministic order.

## Acceptance criteria

Rows are `tests/integration/code/symbol-index.test.ts`, against real
PostgreSQL 17 + pgvector, unless stated.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 stored and readable by file | PASS | `stores a file's symbols and reads them back` — three symbols, correct order, `lifecycle: active` |
| AC-2 unchanged re-index changes nothing | PASS | `changes nothing when the file is re-indexed unchanged` — `unchanged: 1`, everything else zero |
| AC-3 removed symbol tombstoned, not deleted | PASS | `tombstones a symbol the file no longer declares` — gone from lookups, present with `lifecycle: deleted` under `includeDeleted` |
| AC-4 reinstated when it returns | PASS | `reinstates a symbol that comes back` — `reinstated: 1`, `unchanged: 2` |
| AC-5 reconciliation confined to the file | PASS | `confines reconciliation to the file it indexed` — the second file is emptied, the first is untouched |
| AC-6 exact name across files, stable order | PASS | `finds every declaration of a name across files, in a stable order` — the same query twice is `toStrictEqual` |
| AC-7 qualified name, kind and file filter and combine | PASS | `filters by qualified name, by kind and by file, and combines them` — the same name as both a class method and a top-level function, separated only by the combination |
| AC-8 prefix matches the start, not mid-name | PASS | `matches a prefix at the start of a name and nowhere else` — `doResolve` excluded |
| AC-9 limit honoured and bounded | PASS | `honours and bounds a limit` — 3 returned, and a 100,000 request capped at `MAX_LIMIT` |
| AC-10 every lookup uses an index | PASS | four `EXPLAIN` cases with `enable_seqscan = off`, asserting no `Seq Scan on entity` for exact name, qualified name, path and prefix |
| AC-11 SQL and LIKE metacharacters are literal | PASS | `treats SQL and LIKE metacharacters as literal text` — a name containing `'; DROP TABLE entity; --` round-trips, `pre%fix` matches itself and not `preXfix`, and the table survives; plus a unit assertion on `escapeLikePrefix` |
| AC-12 core reaches the index through a port | PASS | `tests/unit/boundaries.test.ts` — the code graph contains no `storage/` module; `SymbolIndexPort` lives in `src/code/index-port.ts` and `SymbolStore` satisfies it structurally |

## The defect this Epic's tests caught

The first implementation built the entity from `{ system: 'ferret', id:
qualifiedName#N }` while `codeSymbolId` hashed `{ system: 'git', id:
qualifiedName }` — the two derivations were three files apart and quietly
disagreed. Reconciliation compares stored ids against the ids of the symbols it
was just handed, so **every symbol was tombstoned on every run**, and ten of the
fifteen tests failed at once.

The fix is structural rather than a corrected constant: `src/code/identity.ts`
now owns the key shape, and both `codeSymbolId` and `codeSymbolEntityInput`
derive from it. A unit test — `the id an entity derives is the symbol's id` —
asserts the two agree for a plain symbol, an overload and a nested method, so
the fast suite catches a recurrence rather than the database suite.

Two smaller ones, both found by running against a real server:

**A bare `${array}` in a Drizzle template is not an array.** The template
expands a JavaScript array into one placeholder per element, producing
`ANY(($1, $2, $3)::uuid[])` — a row constructor — and failing outright on an
empty list, which is exactly the "this file now declares nothing" case.
`sql.param` binds it as one value.

**An unchanged upsert cannot lift a tombstone.** A function deleted and later
restored is byte-identical, so the entity store correctly reports it
`unchanged` and never touches `lifecycle`. Reconciliation therefore runs in both
directions, and `reinstated` is counted separately from `updated` because
nothing about the content changed.

## Design decisions worth recording

**No new table.** A symbol *is* a canonical entity. EPIC-006 already answers
identity, lifecycle, provenance and tombstones; a dedicated table would be a
second place for all of it to live and drift. Governance §5 is explicit, and the
cost is paid in indexes rather than in schema.

**Every index is partial on `kind = 'code_symbol'`.** A repository's symbols
outnumber its files by an order of magnitude, so an unpartitioned index on
`attributes->>'name'` would carry an entry for every entity that has a name —
repositories, branches, commits, developers — to answer a question only ever
asked about symbols.

**The prefix index uses `text_pattern_ops`.** `LIKE 'resolve%'` cannot use a
default collation-aware index. Without the operator class the prefix query is a
sequential scan that looks fine on a fixture of two hundred rows and is unusable
on a real repository — which is why AC-10 asserts the plan rather than the
result.

**Upserts run before reconciliation.** A symbol that merely moved within the
file is already current when reconciliation looks for strays; the other order
would tombstone and immediately revive it, churning the lifecycle on every
re-index.

**Reconciliation is scoped to the file.** That is the unit that was re-read.
Anything wider would retire symbols in files this run never looked at, which is
the failure mode EPIC-032 was written about.

**Order is by path then start line, never by relevance.** The same query twice
returns the same list, which is what makes a limit meaningful and the output
testable. Ranking is EPIC-056's and is deliberately absent.

**`LIKE` metacharacters are escaped in prefixes.** An unescaped `%` in a symbol
name is both a correctness bug — the name stops matching itself — and a way for
repository content to turn one indexed lookup into a scan.

## Limitations

- **Nothing calls this yet.** EPIC-033 builds symbols and EPIC-034 stores them;
  the indexer does not yet parse files, so no production path reaches either.
  Wiring belongs to the Epic that makes indexing read content.
- **No references.** "Where is this called" is EPIC-035. This Epic answers
  "where is this defined" and nothing else.
- **No ranking, no fuzzy matching.** Exact and prefix only; EPIC-054 and
  EPIC-056 own the rest.
- **`indexFileSymbols` is one upsert per symbol.** Each is its own transaction,
  so a failure part way leaves a partially indexed file — recoverable by
  re-indexing, but not atomic. A file with thousands of symbols pays a round
  trip per symbol.
- **Reconciliation is two statements outside the upsert transaction.** A crash
  between them leaves the tombstones applied and the reinstatements not, which a
  re-index corrects.
- **A prefix search has no minimum length.** `namePrefix: 'a'` will match a
  large fraction of an index; the limit bounds the result, not the scan.
- **Scope-only lookup uses `LIKE 'scope:%'`**, which the scope index supports
  only as a range scan. The exact-file form is the fast path and the one the
  tests assert.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 35 files, 982 passed.
`vitest run tests/integration/code`: 15 passed, real PostgreSQL.

## Addendum — 2026-09-02, after EPIC-035

**"No references" is closed.** The limitation above is left as written.

It read: "**No references.** 'Where is this called' is EPIC-035. This Epic
answers where a symbol is *defined*." That Epic has landed: references are
extracted from the parse that already happens, resolved where the answer is
unambiguous, and stored as `symbol_references_symbol` and
`file_references_symbol` edges — so "where is this used" is an inbound traversal
through the port that already traverses relationships.

**Issue #49 is closed with it.** Every indexed symbol now carries one `parsed`
evidence record naming the file, the producer and the producer version, with
authority `PARSED` (60) — so the ranking that issue called inert has something
to apply, and `derivedFrom` traces a resolution back to the declaration it
rests on.

What EPIC-035 refuses is worth knowing here, because it bounds what a caller
should read into the graph: a member call (`a.save()`) is not resolved across
files, an imported name is not resolved to a repository homonym, and an
ambiguous name is not resolved at all. Each refusal was forced by measuring the
alternative on Ferret's own code, where it produced confident nonsense —
`Map.has` reported as `ProviderRegistry.has`, Vitest's `describe` as
`ProviderRegistry.describe`.

Evidence: `docs/EPICs/validation/EPIC-035-VALIDATION.md`.
