# EPIC-086 — PostgreSQL Storage Layer

**Status: APPROVED | Priority: P0 | Domain: Storage & Data Lifecycle**

> **Specification note.** EPIC-002 owns *bootstrap and migrations* — connection
> handling, schema creation, versioned migrations, locking, policy, version
> tracking — and is VALIDATED. This Epic owns the **storage provider and the
> physical design decisions it holds**, which four documents park here by name:
> `Architecture/RUNTIME.md:168` (the `storage` capability),
> `Checkpoints/EPIC-006.md:132` (jsonb rather than typed columns),
> `Architecture/EPIC-006-DECISIONS.md:81`, and EPIC-081 §4 (encryption at rest).
>
> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Most of it is delivered; §2 says what is not.

## 1. Objective

Keep the physical schema honest: one description of what the database contains,
checked against the database, rather than two descriptions that can disagree.

## 2. Problem, measured

The storage provider is built, conformance-tested against a real server, and
used by every command that touches data. What is not established is that its
**two descriptions of the schema agree**.

Ferret defines its physical schema twice, deliberately and for good reasons:

- **Hand-written SQL migrations** (`src/storage/migrations/*.sql`) are the
  truth. EPIC-002 chose them so "the DDL a reviewer reads is byte-for-byte the
  DDL PostgreSQL executes".
- **Drizzle table definitions** (`src/storage/schema/*.ts`) are what the query
  layer types itself against.

Measured on `a150839`: the migrations create **11** tables and Drizzle declares
**9**. `instance` and `embedding` are absent from Drizzle — both for real
reasons, neither of them written down. A reader cannot tell a deliberate
omission from a forgotten one.

**Nothing checks the two agree**, and the failure is silent in the direction
that matters: a Drizzle column that does not exist in the database fails at
runtime, on the query that needs it, in whichever command reached it first.
Four per-store tests read `information_schema.columns` for their own table,
which is four hand-written checks over a set nobody enumerates.

This is not theoretical. Twice in one session an index was written into a
Drizzle table definition that no migration created — caught both times by a
person reading the diff, which is the control this Epic exists to replace.

**What is already right, and is not this Epic's to redo.** Connection and pool
configuration, error classification, conflict retry (EPIC-079), the migration
lock and its diagnosis (EPIC-002, EPIC-095), the capability declaration and
conformance (EPIC-016, EPIC-099), and credential handling (EPIC-081).

## 3. Scope

1. **An enumerated schema agreement check**: every Drizzle table exists in a
   migrated database, with the columns it declares, and the nullability it
   declares.
2. **Every migrated table is accounted for** — declared in Drizzle, or declared
   raw-SQL-only with a reason.
3. **The physical design decisions this Epic holds, written down**: why
   attributes are `jsonb`, why `embedding` and `instance` are not in Drizzle.
4. **Encryption at rest, assessed rather than assumed** — stated as delivered,
   deferred, or out of Ferret's hands, with the reason.

## 4. Non-scope

- **Bootstrap, migrations, locking, policy, version tracking** — EPIC-002,
  VALIDATED. This Epic reads the migrations; it does not own them.
- **Changing the physical schema.** No column, index or table is added, removed
  or retyped. If the check finds a disagreement, the fix belongs to whichever
  Epic introduced it.
- **Introducing typed columns for attributes.** `Checkpoints/EPIC-006.md:132`
  parks the *decision* here; this Epic records the reasoning and does not
  reverse a choice EPIC-006 made deliberately.
- **Query performance, indexes and plans** — EPIC-101. **Delivered
  2026-09-03:** every index is enumerated from `pg_indexes` and eleven now have
  a plan assertion at a scale where the index is genuinely the cheaper plan,
  with the remaining 27 reported rather than implied. Nothing here drops an
  index — that is a migration, and a migration written to satisfy a benchmark is
  a schema change nobody reviewed on its merits.
- **Backup, export, import** — EPIC-089, EPIC-090.
- **Retention** — EPIC-088.
- **A second storage backend.** The capability exists so one is possible; none
  is built here.

## 5. Inputs

`src/storage/schema/*.ts`; `src/storage/migrations/*.sql`; `migrate` and the
migration source (EPIC-002); `information_schema`; the enumeration pattern from
EPIC-100.

## 6. Outputs

- A schema agreement test, enumerated from both sides.
- A declared list of raw-SQL-only tables, with reasons.
- The design decisions recorded in this Epic's validation evidence.

## 7. Dependencies

EPIC-002 (VALIDATED), EPIC-005 (the technology decision), EPIC-006, EPIC-007,
EPIC-008 — all VALIDATED. This Epic changes no acceptance criterion of any.

## 8. Contracts

### The migration is the truth; Drizzle must match it

Where they disagree, the migration is right and the table definition is wrong,
because the migration is what the database actually ran. The check is therefore
*from Drizzle to the database*, not the reverse.

### A table absent from Drizzle is declared, not merely absent

`embedding` uses pgvector's `vector` type, which Drizzle has no representation
for; `instance` is bootstrap metadata written before the query layer exists.
Both are legitimate. Neither is legible without being written down, and an
undeclared absence is indistinguishable from an oversight.

### The check runs against a migrated database, not against parsed SQL

Parsing DDL to compare it to a table definition would be a third description of
the schema, with its own bugs. Applying the migrations and asking the database
what it has is the only comparison that cannot be wrong about itself.

## 9. Acceptance criteria

- **AC-1** Every Drizzle table exists in a freshly migrated database.
- **AC-2** Every column a Drizzle table declares exists on that table, with
  matching nullability.
- **AC-3** Every table in the migrated schema is either declared in Drizzle or
  listed as raw-SQL-only with a reason; a new table is neither and fails.
- **AC-4** The enumeration reads both sides from the source and fails when
  either is empty.
- **AC-5** A reason for a raw-SQL-only table is required and non-trivial.
- **AC-6** The check names the table and column when it fails, so a
  disagreement is actionable without reading the test.
- **AC-7** Encryption at rest is stated — delivered, deferred, or outside
  Ferret's control — with its reasoning, and the EPIC-081 record is discharged
  or restated.
- **AC-8** No physical schema change is made by this Epic.

## 10. Test requirements

Integration against a real, freshly migrated PostgreSQL. Both directions
enumerated. Column comparison by name and nullability; **not** by type, which
would compare Drizzle's type vocabulary to PostgreSQL's and fail on synonyms
rather than on drift.

## 11. Security requirements

The check reads `information_schema` on Ferret's own database and reports table
and column names. It reads no row, and reports no value.

## 12. Observability

The check reports how many tables and columns it compared, so a passing run
states its scope rather than merely its verdict.

## 13. Performance constraints

One migrated database and a handful of catalogue queries.

## 14. Definition of Done

Acceptance criteria satisfied; `npm run verify` green; a validation document
carrying the design decisions; the registry updated; the parked records
discharged or restated.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — the database already knows its own schema;
  asking it beats parsing DDL.
- **§6** — a declared absence rather than an unexplained one.
- **§22** — a measurable check in place of a reviewer's attention.

## 16. Raised, not absorbed

- **This Epic may find a real disagreement.** If it does, it is filed against
  whichever Epic introduced it, and the check is not relaxed to make it pass.
- **Type comparison is deliberately out.** `text` versus `varchar`, `timestamptz`
  versus `timestamp with time zone`, and Drizzle's own aliases would make a
  type-level check fail on vocabulary rather than on drift, and a check people
  learn to ignore is worse than none. Names and nullability catch the mistakes
  actually made — a column that does not exist, and one that is unexpectedly
  required.
