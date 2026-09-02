# EPIC-090 — Data Import & Recovery · Validation Evidence

**Assessed against:** working tree on top of `3995f9f`
**Date:** 2026-09-02
**Environment:** **two** real PostgreSQL 17 + pgvector databases — export from
one, import into the other, export again — plus the built CLI as a child
process for the grant and the confirmation.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 a document imports into an empty database, counts match the trailer | **MET** | `import.test.ts` "writes every row, and the counts match the trailer" — every table's count read back from the target |
| AC-2 a round trip is lossless | **MET** | "is lossless: a second export digests identically" — the target's own export digests to the source's, through two databases |
| AC-3 a document with no trailer is refused | **MET** | `import.test.ts` (unit) "refuses a document with no trailer", and "refuses a manifest with nothing after it" |
| AC-4 a digest mismatch is refused | **MET** | unit "refuses a digest that does not match the rows", and "refuses a document whose row was edited, even by one character" |
| AC-5 an unknown format is refused by name | **MET** | unit "refuses an unknown kind by name" — the message carries the kind it found |
| AC-6 a newer schema version is refused, an older accepted | **MET** | unit "refuses a newer entity schema version" and "accepts an older entity schema version" |
| AC-7 the second import reports every row unchanged | **MET** | integration "reports every row unchanged the second time" — zero written, zero conflicting |
| AC-8 a differing row is `conflicting` and left alone | **MET** | integration "reports a genuine content-hash disagreement as conflicting" — a third database with a differing attribute; the row keeps its own value |
| AC-9 a `deleted` entity imports as `deleted` | **MET** | integration "imports a tombstone as a tombstone" |
| AC-10 a `superseded` observation imports as `superseded` | **MET** | integration "imports a superseded observation as superseded" |
| AC-11 an orphan is named and the rest completes | **MET** | integration "reports the row whose parent is absent rather than a constraint name" — the repository row removed from the document; the edge is orphaned, the files and blobs still land |
| AC-12 `import` without `--yes` writes nothing | **MET** | integration "reports what it would write and writes none of it" — the plan names every row, the target holds none |
| AC-13 refused without the `INDEX` permission | **MET** | `cli-authorization.test.ts` "refuses to import when configuration withholds index", with the granting control beside it |
| AC-14 one audit event names the document and the counts | **MET** | `src/cli/commands/import.ts` — a `CONFIGURATION` event carrying the document path and the written count |
| AC-15 an empty document imports as a no-op | **MET** | integration "imports an empty document as a no-op"; unit "reads a document with no rows" |
| AC-16 every imported `file_version` resolves its content | **MET** | integration "leaves every imported file version able to resolve its content" — a dangling-reference count of 0 asserted in SQL against the target |

Sixteen of sixteen MET. `npm run verify` green: 143 files, 2 966 passed,
3 skipped.

## Found while implementing — two defects in EPIC-089's format

This is the Epic's main result, and it is exactly what EPIC-089 §16 predicted
would be missing: *"a format validated only by its own writer is a format nobody
has validated."* Both defects made a document **unimportable**, and neither was
visible to a test written by the format's author.

**1. `search_vector` is a `GENERATED ALWAYS` column, and `SELECT *` exported
it.** Migrations `0007` and `0011` declare it — Drizzle has no representation
for a generated `tsvector`, which is why both migrations write raw SQL — so the
column exists in the catalogue and appears in `SELECT *`. Inserting one is
PostgreSQL `428C9`, so **no document EPIC-089 wrote could be imported at all.**
The failure was in every table that has one: `entity`, `evidence`,
`content_blob`.

The fix is on both sides and reads from the catalogue rather than a list, so a
generated column added by a later migration is handled without anyone
remembering: the export omits them, and the import drops them from a document
that already carries them. That second half matters — a document written before
this fix is still importable.

**2. A `jsonb` column holding a scalar needs JSON quoting.** `attributes` holds
an object, which `JSON.stringify` handled correctly *by accident*;
`evidence.statement` is `jsonb` and can hold a bare string, and `typescript` is
not a valid JSON document while `"typescript"` is. PostgreSQL says `22P02`. Now
driven by the column's declared type from the same catalogue read, rather than
by `typeof value === 'object'`.

Both are recorded on EPIC-089 as a dated note against the §16 limitation this
Epic closes.

## Found while implementing — this Epic's own

**A foreign-key violation is not on the error object the `catch` receives.**
Drizzle wraps the driver's error, so `error.code === '23503'` was never true and
every orphaned row failed its whole *table* instead of being reported as one
row. The check now walks the `cause` chain. The symptom was misleading in the
worst way: the report said the table failed, which is a different diagnosis from
the one that is true.

**A savepoint per row, because one orphan otherwise poisons the transaction.**
PostgreSQL aborts a transaction on a constraint violation, so without a
savepoint the first orphan makes every row after it fail for a reason that is
not its own — and the report would name the wrong rows. AC-11 asks that the rest
of the import still complete, and this is what makes that true rather than
aspirational.

**The failure assertion has to come first.** The AC-1 test asserted the row
count before checking for a table failure, so the first run reported "expected 0
to be 8" and hid the `428C9` that explained it. Reordered, and worth recording:
a count assertion placed before a failure assertion converts a precise error
into a puzzle.

**EPIC-089's two test fixtures were corrected, and no acceptance criterion
changed.** Its integration test compared the exported column set against *every*
column `information_schema` declares for `entity`; it now compares against every
column with `is_generated <> 'ALWAYS'` and additionally asserts `search_vector`
is absent — a stronger statement than the original, and a fact about the product
rather than a concession to the test. Its unit fake answers one query per table
positionally, so the new catalogue read consumed the first table's page; the fake
now answers call zero as the catalogue and starts the tables after it.

## Decisions worth recording

**Scrubbing is export-then-import, and no filter is shipped.** EPIC-082 §4 and
EPIC-081 §4 both deferred "retroactive scrubbing of an index already written"
here. §8.7's answer is that no new mechanism is needed and building one would be
worse: an `UPDATE` that edits a body to remove a credential is what Governance
§6 forbids, and it leaves no record that anything was removed. `export | filter
| import` into a fresh database is auditable at every step — the document
before, the document after, and the filter that ran. EPIC-088 §16 reached the
same shape for tombstones, so this is that pattern's second caller. *Which*
strings are secret in an index already written is EPIC-082's question and its
answer is a scanner.

**A disagreement is reported, never adjudicated.** A row present with a
different content hash is `conflicting` and left alone, and there is no
`--overwrite`. Choosing a winner between two installations needs a policy nobody
has written, and offering a flag that picks one would be shipping that policy by
default.

**Rows are written in the manifest's table order, not the document's.** A
hand-concatenated document could interleave tables, and a child written before
its parent fails on the foreign key the order exists to prevent.

**`last_indexed_at` is excluded from the sameness comparison.** It records when
Ferret last *looked*; comparing it would make every import a conflict.

## Limitations, recorded

- **Merging two indexes is still not solved.** §8.4 reports and stops.
- **Two passes over the document**, which is the cost of EPIC-089's trailer —
  so importing from a pipe is not supported, only from a file.
- **An import does not verify against source.** A document exported from a
  compromised installation imports faithfully; `ferret verify` is the tool that
  would notice, afterwards.
- **The round trip proves the format, not the semantics.** AC-2 proves the bytes
  survive. That a re-imported index *answers the same questions* is a stronger
  claim, and EPIC-098's harness is where it would be measured.
- **A scoped export's orphans are reported, not resolved.** An edge whose other
  end is outside the scope is dropped by EPIC-089 and, where the document still
  carries one, named here. Neither Epic tries to fetch the missing parent.
