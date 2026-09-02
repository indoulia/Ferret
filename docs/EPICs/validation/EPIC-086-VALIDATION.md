# EPIC-086 — PostgreSQL Storage Layer · Validation Evidence

**Assessed against:** working tree on top of `a150839`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, freshly migrated per run.

## What this Epic added, and what was already there

The storage provider was built, conformance-tested against a real server, and
used by every command that touches data. EPIC-002 owns bootstrap, migrations,
locking and version tracking, and is VALIDATED. This Epic did not rebuild any
of it.

What was missing was a check that Ferret's **two descriptions of its physical
schema agree**. It defines the schema twice, deliberately:

- hand-written SQL migrations, so the DDL a reviewer reads is the DDL
  PostgreSQL executes (EPIC-002's choice, and a good one);
- Drizzle table definitions, so the query layer can type itself.

Both are right. Nothing compared them, and the failure is silent in the
direction that matters: a Drizzle column the database does not have fails at
runtime, on the query that needs it, in whichever command reaches it first.

**Twice in this session an index was written into a Drizzle table definition
that no migration created.** Both were caught by reading the diff — which is the
control this Epic replaces with a test.

```
[EPIC-086] 9 declared tables, 12 in the migrated schema
[EPIC-086] 96 columns compared
```

## What the check found on its first run

Both of my hand-written assumptions were wrong, in opposite directions:

**`schema_migration_failures` exists and I did not know about it.** It is
created by `bookkeeping.ts` with `CREATE TABLE IF NOT EXISTS`, not by any
migration — and the reason is a good one: *it records migrations that failed*,
so a table depending on a migration having succeeded could not record the case
it exists for. Legitimate, and now written down where the next reader will find
it.

**`embedding` does not exist** in a freshly migrated database. Migration `0008`
creates it only when `to_regtype('vector')` resolves, because pgvector is
optional. My exemption claimed it was always present; the check disagreed. The
list now carries a `conditional` flag so an absence that is legitimate is
distinguishable from a stale exemption — which is the same distinction the whole
Epic is about.

Neither is a defect. Both were invisible, and an invisible fact about the schema
is one the next person has to rediscover.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 every declared table exists | MET | 9 of 9 against a freshly migrated database |
| AC-2 every declared column exists with matching nullability | MET | 96 columns compared |
| AC-3 every schema table is declared or explained | MET | 4 raw-SQL-only tables, each with a reason; an undeclared one fails naming itself |
| AC-4 enumerated from both sides, fails closed | MET | floors on both lists, so an empty side cannot report green |
| AC-5 a reason is required and non-trivial | MET | length-checked at 60 characters |
| AC-6 a failure names table and column | MET | the assertion message carries both, plus the Drizzle property name |
| AC-7 encryption at rest, stated | MET | see below |
| AC-8 no schema change | MET | no migration added, altered or removed; the diff is a test, a spec and a validation record |

## AC-7 — encryption at rest, stated rather than assumed

**Not delivered, and largely not Ferret's to deliver.** EPIC-081 §4 parked
"encrypting the database or its contents at rest" here, and the honest answer
is:

- **Encryption of the database** is a PostgreSQL deployment concern — filesystem
  or volume encryption, or a managed provider's at-rest encryption. Ferret
  connects to a server it does not provision, so it cannot encrypt one and
  should not claim to.
- **Encryption of contents within the database** — application-level encryption
  of `attributes`, `statement` or `text_content` — would defeat the full-text
  search those columns exist for. EPIC-087's generated `tsvector` and
  EPIC-053's `search_vector` are computed by PostgreSQL over the plaintext; an
  encrypted column is not searchable, which would trade the product's central
  capability for a protection the deployment already offers.
- **What Ferret does control is what reaches the database**: EPIC-082 excludes
  secret-bearing paths at ingestion, EPIC-087 redacts a body before it is
  stored, and EPIC-081 confines the credential Ferret itself holds.

Restated in EPIC-081's evidence rather than left as an open item here.

## Two design decisions this Epic holds, recorded

**Attributes are `jsonb`, not typed columns** (`Checkpoints/EPIC-006.md:132`).
Kinds are extensible — `registerEntityKind` lets a provider add one without a
core change (EPIC-006 AC-4) — and a typed column per attribute would make every
new kind a migration. The cost is paid in indexes: migration `0007`'s generated
`tsvector` and `0010`'s partial indexes on `attributes->>'name'` exist because
the column is untyped. That trade is EPIC-006's and is not reversed here.

**Three tables sit outside the query layer on purpose**, now with reasons in the
test rather than in nobody's head: the migration ledger, its failure log, and
bootstrap metadata all belong to components that must work *before or despite*
the schema the query layer types itself against.

## Verification

`npm run verify` green: 121 files, 2 532 passed, 3 skipped. New:
`tests/integration/storage/schema-agreement.test.ts` (5 checks).

## Raised, not absorbed

- **Types are not compared, deliberately.** `text` versus `varchar`,
  `timestamptz` versus `timestamp with time zone`, and Drizzle's own aliases
  would make a type-level check fail on vocabulary rather than on drift, and a
  check people learn to ignore is worse than none. Names and nullability catch
  the mistakes actually made: a column that does not exist, and one that is
  unexpectedly required. **Indexes and constraints are also not compared** —
  which is exactly the drift I hit twice this session, so this is the gap most
  worth closing next.
- **`DRIZZLE_TABLES` is a hand-written list**, because Drizzle exposes no
  registry of declared tables. It is bounded by the other direction: a table
  added to a migration and forgotten here fails AC-3. A table added to Drizzle
  and forgotten in the list is *not* caught, which is the residual hole and is
  smaller than the one it replaces.
- **No disagreement was found between the two descriptions.** §16 said one would
  be filed rather than fixed; there was none to file. What was found was
  undocumented, not wrong.
