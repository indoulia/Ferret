# EPIC-034 — Symbol Index

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-034-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §5, §6, §11, §13 and §22, following the Epic Specification
> Standard. Cross-file references and call graphs are EPIC-035 and are not
> implemented here.

## 1. Objective

Make the symbols a file declares findable — by name, by qualified name, by kind
and by file — and keep the index true to the file as it changes.

## 2. Value

EPIC-033 builds symbols in memory and they vanish when the process ends.
"Where is `resolveConfig` defined" is the single most common question asked of a
code assistant, and today Ferret answers it with a full-text search over file
contents that returns every call site ranked above the definition.

The second half matters as much. A symbol deleted from a file must stop being an
answer. Without reconciliation an index accumulates definitions that no longer
exist, and the failure is silent — the answer looks right and points at a line
that has moved or gone.

## 3. Scope

- storing EPIC-033 symbols as canonical `code_symbol` entities;
- reconciling a file's symbols on re-index: new ones added, changed ones
  updated, removed ones tombstoned;
- lookup by exact name, by qualified name, by kind, and by file;
- prefix lookup on name, for the "what is called something like this" question;
- a port so retrieval reaches the index without importing storage;
- database indexes that make each of those a lookup rather than a scan.

## 4. Non-scope

- references, call sites, call graphs and cross-file resolution — EPIC-035;
- ranking. This Epic returns matches in a defined order; EPIC-056 ranks.
- semantic or fuzzy matching — EPIC-054;
- building symbols, which is EPIC-033;
- reading or parsing files;
- a new table. Symbols are canonical entities and EPIC-002's store is where
  canonical entities live.

## 5. Inputs

- EPIC-033 `CodeSymbol` and the registered `code_symbol` entity kind;
- EPIC-002 `EntityStore`, and EPIC-032's tombstone semantics;
- EPIC-006 identity, which already makes a symbol's id stable.

## 6. Outputs

- `SymbolIndexPort`, the interface retrieval depends on;
- `SymbolStore`, the PostgreSQL implementation;
- `indexFileSymbols(...)`, which writes a file's symbols and reconciles;
- migration `0010`, the partial indexes that make lookup a lookup.

## 7. Dependencies

EPIC-002, EPIC-006, EPIC-032, EPIC-033.

## 8. Contracts

### No new table

A symbol *is* a canonical entity. A dedicated table would be a second place for
lifecycle, provenance and tombstones to live, and would need its own answer for
every question EPIC-006 has already answered. Governance §5 is explicit, and the
cost of the decision is paid in indexes rather than in schema.

### Reconciliation is per file

Indexing a file replaces the set of symbols recorded for that file: those still
present are upserted, those gone are tombstoned. Scoped to the file because that
is the unit that was re-read — reconciling wider would retire symbols in files
this run never looked at.

### A tombstone, not a delete

EPIC-032's rule, unchanged: a removed symbol is retained with
`lifecycle = 'deleted'`. "When did this function disappear, and what did it look
like" is a question Ferret exists to answer, and deleting the row destroys the
answer along with the symbol.

### Lookup is exact by default

Name and qualified-name lookups are equality. A prefix search is a separate,
explicit call, because a prefix scan over a large index is a different cost and
a caller should choose it.

### Deterministic order

Results are ordered by path then start line, so the same query twice returns the
same list. Relevance ordering is EPIC-056's; an arbitrary order would make this
Epic's output untestable and its pagination meaningless.

## 9. Acceptance criteria

- **AC-1** A file's symbols are stored and readable back by file.
- **AC-2** Re-indexing an unchanged file changes nothing — every symbol reports
  `unchanged`.
- **AC-3** A symbol removed from a file is tombstoned, not deleted, and stops
  appearing in lookups.
- **AC-4** A symbol reinstated in a later revision becomes active again, and is
  counted separately from an update, because its content did not change.
- **AC-5** Reconciliation is confined to the file indexed; symbols in other
  files are untouched.
- **AC-6** Lookup by exact name returns every declaration of that name across
  files, ordered deterministically.
- **AC-7** Lookup by qualified name, by kind and by file each filter correctly,
  and combine.
- **AC-8** Prefix lookup matches on a name's start and does not match mid-name.
- **AC-9** A limit is honoured and bounded, as everywhere else in retrieval.
- **AC-10** Every lookup uses an index rather than a sequential scan.
- **AC-11** A name containing SQL metacharacters is matched literally and
  changes no query.
- **AC-12** Retrieval reaches the index through a port; the core imports no
  storage module.

## 10. Test requirements

- index a file, read it back, re-index unchanged, assert `unchanged`;
- remove a symbol, assert the tombstone and its absence from lookups;
- reinstate it, assert it is active;
- two files, assert reconciliation touches only one;
- each lookup dimension and a combination;
- prefix matching, including a non-match mid-name;
- limit bounding;
- `EXPLAIN` on each lookup, asserting no sequential scan on the entity table;
- a symbol named with quotes, a percent sign and a backslash;
- an architecture test for the port boundary.

## 11. Security requirements

Symbol names come from repository content and are untrusted. Every value is a
bind parameter; nothing in this Epic concatenates a name into SQL. A prefix
search escapes `LIKE` metacharacters, so a name containing `%` matches
literally rather than becoming a wildcard — which is both a correctness bug and
a way to make one query scan an entire index.

## 12. Observability

Indexing returns counts of created, updated, unchanged, tombstoned and
reinstated symbols, so a re-index that quietly retired a hundred definitions is
visible rather than inferred.

## 13. Performance constraints

Each lookup dimension has a supporting index, asserted by `EXPLAIN` rather than
assumed. Indexing a file is one statement per symbol plus one reconciliation
query, inside a single transaction.

## 14. Definition of Done

Implementation, unit and database integration tests for every acceptance
criterion, migration, exports, documentation and validation evidence. No
reference resolution or ranking behaviour is claimed here.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — symbols are canonical entities; no second
  store, no second lifecycle.
- **§6 Evidence Before Inference** — a removed symbol is tombstoned, so its
  history survives.
- **§11 Retrieval** — exact structured lookup, ordered deterministically, with
  ranking left to the Epic that owns it.
- **§13 Reliability** — reconciliation is per file, so a partial index run
  cannot retire what it did not look at.
- **§22 Change Management** — stays within the approved Symbol Index capability.
