# Batch 2 — Small self-contained blockers (F-30, F-29, F-17, F-16)

**Status: IMPLEMENTED, re-audited** · Base `0407618` · Branch `forensic/post-roadmap-audit` · 2026-09-03

> Not merged, not pushed to `main`, not deployed. No Epic status changed, no Epic created,
> no work started on Batch 3.

## 1. What was wrong

Four unrelated defects in four subsystems, each of which falsified a claim its own Epic
makes in prose.

- **F-30 (P1-A)** — `ferret export --backup-command` and the `ferret upgrade` plan
  interpolated `FERRET_DATABASE_URL` verbatim into a printed `pg_dump` line. A PostgreSQL
  URL conventionally carries the password, so it went to stdout inside an `ok: true`
  envelope at exit 0. EPIC-106 §11 says "No credential appears in the plan".
- **F-29 (P1-A)** — the importer interpolated column names *taken from the document* into
  SQL as quoted identifiers, with no escaping and no check that the schema has such a
  column. EPIC-090 §11 says every row goes through the same validation an observation
  does; neither `createEntity` nor `createRelationship` appears in the file.
- **F-17 (P1-A)** — export ran a redactor over each assembled JSON *line*. That redactor
  fails closed on size, replacing its **whole input** with a sentence, so a large enough
  row stopped being JSON — and the digest was computed over the replacement, so the
  trailer verified a document `ferret import` refuses as damaged.
- **F-16 (P1-A)** — `ferret init` migrated before it installed pgvector, so the
  conditional migration `0008` took its "not installed" branch and was recorded as
  applied. `ferret.embedding` was never created, the schema reported 12 of 12 with
  nothing pending, and forward-only migrations meant no later run could correct it.

## 2. What changed

| Finding | File | Change |
| --- | --- | --- |
| F-30 | `src/storage/export.ts` | `backupCommandFor` redacts through the existing `redactString`, covering both call sites. Host, port and database survive; `pg_dump` reads the password from `PGPASSWORD`/`~/.pgpass` as it always did. |
| F-29 | `src/storage/export.ts`, `src/storage/import.ts` | `columnFacts` now also returns `known` — every column the target's catalogue has. `#row` refuses a row naming a column outside it, **before** any statement is built. Identifiers are additionally quoted with `"` doubled. |
| F-17 | `src/storage/export.ts` | Redaction moved from the assembled line to each **string value**, walking objects and arrays (`jsonb` columns hold both). The framing can no longer be what a fail-closed replacement replaces. |
| F-16 | `src/storage/provider.ts`, `src/cli/commands/init.ts`, `src/storage/migrator.ts`, `src/storage/migrations/0013_embedding_repair.sql` | The provider provisions extensions **before** migrating, when the caller asks; `ferret init` asks, and `--check` and `--no-extensions` still mean what they meant. A repair migration creates the table on installations already in the broken state. |

Deliberate choices worth naming:

- **F-29 refuses rather than drops.** Silently discarding an unknown column would turn a
  hostile or mismatched document into a partial restore that reports success — the same
  class of defect in the opposite direction.
- **F-29 keeps both defences.** The allowlist decides *whether* a name may be used; the
  escaping decides *how* it is written. They fail differently, so an allowlist that later
  gained a hole would still meet an escape that holds.
- **F-17 keeps the second line of defence.** Removing export-time redaction entirely was
  the other option and would also have closed F-44. It was not taken: `attributes`,
  `metadata` and `statement` are `jsonb` written by several producers, and the claim
  "everything is already redacted on the way in" is one this batch cannot prove. Per-value
  redaction keeps the control and cannot corrupt the document. **F-44 therefore remains
  open** — export still rewrites an indexed value while `content_hash` stays as it was.
- **F-16 does not provision on every start.** `CREATE EXTENSION` needs a privilege an
  everyday connection has no reason to hold, so provisioning happens only when a caller
  asks, and `ferret init` is the request to provision.

## 3. Evidence

Each fixture was written first and observed to fail against `0407618`.

**F-30** — `tests/unit/export.test.ts`:
```
× never prints the password the URL carries — F-30
    expected 'pg_dump --format=custom --schema=ferr…' not to contain 'hunter2'
```

**F-17 and F-29** — `tests/integration/storage/backup-fidelity.test.ts`, two real databases:
```
× writes a document the reader accepts, however large a row serializes — F-17
    FerretError: Row 3 is not JSON, so the document is damaged.
× restores the bytes it exported, rather than a sentence about them — F-17
× refuses a document naming a column the schema does not have — F-29
    expected { refusedByFerret: false, … } to strictly equal { refusedByFerret: true, … }
```

**F-16** — `tests/integration/storage/embedding-provisioning.test.ts`, real PostgreSQL:
```
× creates the embedding table on a fresh install — F-16
    expected { vector: true, embedding: false } to strictly equal { vector: true, embedding: true }
× does not report a complete schema over a table it did not create — F-16
    expected { complete: true, embedding: false } to strictly equal { complete: true, embedding: true }
```
The second is the sharpest statement of the defect: the schema reports itself complete
over a table the migration it counts as applied never created.

All fixtures pass after the change.

## 4. Re-audit

Two second-order defects were found in the fixes themselves, before either was declared
closed.

**The repair migration was spent by the state it was written to repair.** `0013` is
conditional on pgvector, exactly as `0008` is — so on an installation that migrates once
without the extension, the repair is recorded as applied having done nothing, and
forward-only migrations never revisit it. That is the original defect one level down.
Fixed by running the repair from `applyRepairs` at the one moment its precondition can
newly become true — immediately after provisioning — reading the SQL from the migration
file so there is exactly one definition of the table, reviewed as DDL.

**Per-value redaction would have corrupted a binary column.** Walking a `Buffer` with
`Object.entries` yields a map of numeric keys, so an export would have silently rewritten
the value it was copying. No column in the schema is `bytea` today — verified — so this
was latent rather than live, and it is now guarded: anything that is not a plain object,
array or string passes through untouched.

Other checks made on the fixes:

- **F-30** — the `$FERRET_DATABASE_URL` fallback and a passwordless URL both survive
  unchanged (the two existing assertions still pass); only userinfo is rewritten.
- **F-29** — the refusal is raised inside the per-table transaction and surfaces as that
  table's `failure`, so one bad document does not abort the others; the dry-run path reads
  the same catalogue, so `--check` refuses what `--apply` would refuse.
- **F-17** — output stays deterministic, so EPIC-089 AC-2's byte-identical repeat export
  still holds; `Date` values (every timestamp column) are passed through rather than
  walked.
- **F-16** — `--check` and `--no-extensions` provision nothing; a failed repair is logged
  and never fatal, because refusing to start over a repair would turn a recoverable state
  into an unusable one; the target schema version moves 12 → 13, and an older binary
  meeting a version-13 database still refuses with `E_SCHEMA_UNSUPPORTED` as before.

**A test was replaced rather than kept.** The first repair test drove `migrate()` twice
around a manual `CREATE EXTENSION`. `migrate` was never the provisioning path, so that
test asserted the behaviour of the wrong layer — it would have passed or failed for
reasons unrelated to anything an operator can do. It now drives `ferret init` through the
CLI, which is what an operator actually runs.

## 5. Suite

`npm run lint && npm run typecheck && npm run build && vitest run` on the branch, against
a real PostgreSQL container.

```
Test Files  1 failed | 166 passed (167)
     Tests  3366 passed | 41 skipped (3407)
  Duration  589.61s
```

**Zero failing tests.** The one failing *file* is `tests/integration/packaging.test.ts`,
whose `beforeAll` exceeded its 300 s hook timeout under full-suite contention and took its
34 assertions into the skip count with it. That is **F-73**, recorded by the forensic pass
and reproduced by it twice on this machine before any of this work existed. Run on its own
it passes — `34 passed (34)` — so it is contention, not a regression from this batch. It
remains open as a P2 verification-integrity finding and is deliberately not fixed here.

The whole `tests/integration/storage` suite — 26 files, 286 tests — passes on its own,
including `migrations`, `compatibility`, `schema-agreement`, `init-cli` and `upgrade-cli`,
which are the suites the new migration and the changed initialization order could break.

## 6. Not done in this batch

- **F-44** (export rewrites an indexed value while its `content_hash` does not change)
  remains open, for the reason given in §2.
- **F-45** (`EXPORT_TABLES` omits `ferret.embedding` and `ferret.instance`) becomes
  reachable now that the embedding table exists on fresh installs, and is still open.
- Recording *which branch* a conditional migration took — the general fix for the class
  F-16 belongs to — is not done; the repair mechanism covers the one instance.
- Every other blocker in `docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`.
