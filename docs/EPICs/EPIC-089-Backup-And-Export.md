# EPIC-089 — Backup & Export

**Status: VALIDATED | Priority: P1 | Domain: Storage & Data Lifecycle**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Storage & Data Lifecycle;
> only the specification is new.

## 1. Objective

Get everything Ferret knows out of the database and into a document a different
Ferret can read — and say plainly which half of "backup" this is not.

## 2. Value

Five records name this Epic as the answer to "what if the database is gone":

- **`Architecture/COMPATIBILITY.md` §7** — "Backup and restore, which is the
  real recovery path for a downgrade → **EPIC-089**." A downgrade is the case
  that has no other answer: a migration runs forward, and there is no `down`.
- **EPIC-094 §4** — backup and export are named "the real recovery path", with
  its own recovery explicitly narrower: "recovery here means re-deriving from a
  source Ferret can still read".
- **EPIC-069 §4** — "Undo, rollback, or a restore point. EPIC-089/090."
- **EPIC-086 §4** and **EPIC-081 §4** — the store, and the configuration file.
- **EPIC-088 §16** — a tombstone has no retention story, and the honest fix is
  *export-then-truncate*, which needs this Epic.

So the only recovery Ferret has today is re-indexing, which works exactly when
every source is still reachable and is worthless when one is not. A repository
that was deleted upstream is what Ferret was indexing history for.

## 3. Scope

- **`ferret export`** — one NDJSON document, schema-version stamped, covering
  entities, relationships, evidence, derivation edges and content blobs.
- **Scoped export** — one repository, or everything.
- **A manifest** naming the schema version and the Ferret version so EPIC-090
  can refuse a document before reading it, and a **trailer** naming the counts
  and the row digest — §8.2.
- **Naming the configuration file**, which §8.4 records is already a portable
  document — EPIC-081 §4.
- **Saying what a backup is** — §8.1, and it is `pg_dump`.

## 4. Non-scope

- **Wrapping `pg_dump` or `pg_restore`.** §8.1. EPIC-088 §4 set the precedent
  for the same reason: "Dropping the database — that is `dropdb`, and Ferret does
  not wrap it."
- **Import.** EPIC-090, deliberately a separate Epic: a format that is written
  and read by the same code is a format nobody has validated.
- **Scheduling an export.** EPIC-078 owns periodic work. **Declined there,
  2026-09-03:** this Epic's document is everything Ferret knows, in cleartext,
  in one file, so writing one on a timer decides where that file lives and who
  can read it — a data-exposure decision an operator makes deliberately.
- **A configuration exporter.** §8.4 — the file already is one.
- **Encryption of the export.** §16 — a document Ferret writes in cleartext is
  the same exposure the database already has, and inventing a key-management
  story here would be inventing one badly.
- **Incremental or differential export.** §16.

## 5. Inputs

Every table EPIC-086 owns, read through the stores rather than by raw select so
the permission scope travels with the rows.

## 6. Outputs

`src/storage/export.ts`, `ferret export`, and an NDJSON document with a manifest
as its first line.

## 7. Dependencies

EPIC-086 (the store), EPIC-087 (blobs), EPIC-008/046/047 (evidence and its
chains), EPIC-058/083 (the permission scope an export must not widen),
EPIC-081 (credentials), EPIC-085 (the audit event).

## 8. Contracts

### 8.1 A backup is `pg_dump`, and Ferret says so rather than wrapping it

The two words are not synonyms and conflating them is what makes a backup
strategy fail when it is needed:

- A **backup** is a point-in-time copy restorable into the *same* schema
  version. `pg_dump` does that correctly, handles types Ferret does not model,
  and is maintained by people who work on PostgreSQL. Ferret wrapping it would
  add a version-matching failure mode and subtract nothing.
- An **export** is a document a *different* version can read. `pg_dump` cannot
  be that: a dump of schema 12 restored into schema 11 fails, which is exactly
  the downgrade `COMPATIBILITY.md` §7 points here for.

So `ferret export` builds the second, and `ferret status` prints the `pg_dump`
command for the first — the honest division, and the one that keeps Ferret out
of the business of being a backup tool.

### 8.2 The manifest is the first line; the digest is the last

Line one carries only what is knowable *before* the rows — the entity schema
version, the Ferret version, the instant, the scope, the table order. EPIC-090
reads it and refuses a document whose schema version it cannot import, rather
than discovering the mismatch half way through a restore.

The counts and the digest are the **last** line, and that is not a style
choice. A digest over the rows cannot be computed before the rows, so a manifest
carrying one forces either buffering the whole export or scanning the index
twice — and an importer cannot check a digest before reading the rows either
way, so a header digest buys nothing for the cost of a second pass. A truncated
export is then detectable by the trailer's absence, which is the failure a
header digest was meant to catch.

### 8.3 An export carries the permission scope, and never widens it

Rows go out with `permission_scope` intact, and an export runs under the same
`READ` grant a search does. An export that stripped the scope would be the
widest possible information disclosure — every row Ferret holds, in one file,
with the thing that limited who could see it removed.

### 8.4 An export carries no credential, and the configuration needs no exporter

**The configuration file is already the export.** EPIC-081 stores a secret as a
*reference* — `{"$secret": {"env": "FERRET_PG_PASSWORD"}}` — and resolves it
once at configuration resolution, so the file on disk holds where the secret is
and never what it is. A document Ferret would write could contain nothing the
file does not already contain, so exporting the configuration is `cp`, and
Ferret does not wrap that either — §8.1's reasoning, a second time.

What this Epic adds is naming the file, beside the `pg_dump` command, so an
operator taking a backup takes both halves.

For the index export, EPIC-091's redactor runs over each assembled line as the
second line of defence, the way EPIC-085 §8.3 does. The first line of defence
is that a reference is stored as a reference: there is nothing to resolve on the
way out.

### 8.5 Content is exported as content, and the omission reason travels

A blob's `text_content` is a body, and `omitted_reason` is the record of why
there is none. Both go, because a document with the bodies silently missing
would import into an index that looks complete and answers nothing —
EPIC-087 §8.6's `NULL`-with-a-reason rule, applied to the wire format.

### 8.6 An export is streamed, not assembled

NDJSON one row at a time, so exporting an index larger than memory is a slow
operation rather than an impossible one. The digest is computed as rows go past.

### 8.6a The whole document is one snapshot

Every table is read inside one `repeatable read`, `read only` transaction.
Without it the tables are read one after another and a concurrent index run can
land between two of them, producing a document with an `evidence` row whose
subject is absent — which EPIC-090 would have to refuse. A consistent *document*
is not the same as a consistent *point in time*, and only the second is a
recovery path.

### 8.7 An export is an audit event

EPIC-085's trail: one event naming the scope and the counts. A bulk read of
everything Ferret knows is the read most worth recording — and EPIC-085 §4
recorded that reads are otherwise *not* audited, so this is the deliberate
exception rather than a drift from it.

## 9. Acceptance criteria

- **AC-1** `ferret export` writes NDJSON whose first line is the manifest and
  whose last line is the trailer.
- **AC-2** The manifest names the entity schema version and the Ferret version;
  the trailer names the per-table counts, the row total and a digest.
- **AC-3** Entities, relationships, evidence, derivation edges and blobs all
  appear, and a round trip through the reader finds every row.
- **AC-4** `--scope <repositoryId>` exports one repository and nothing else.
- **AC-5** A row's `permission_scope` survives the export.
- **AC-6** An export refuses to run without the `READ` grant.
- **AC-7** A tombstoned entity is exported — history is the payload.
- **AC-8** A blob's `omitted_reason` travels beside a `NULL` body.
- **AC-9** The stored configuration file holds a secret reference and never a
  resolved value, so no configuration exporter is needed — §8.4, as a test. The
  file is named beside the `pg_dump` command.
- **AC-10** The digest changes when a row changes and not otherwise, and a
  reader recomputing it over the rows gets the trailer's value.
- **AC-11** An export of an empty index is a valid document — manifest and
  trailer, zero counts, no row lines.
- **AC-16** A truncated document is detectable: the trailer is absent.
- **AC-17** A row written *during* an export does not appear in it — §8.6a.
- **AC-12** Export is streamed: memory does not scale with row count.
- **AC-13** One audit event names the scope and the counts, and no row contents.
- **AC-14** `ferret status` names the `pg_dump` command for a true backup.
- **AC-15** No command wraps `pg_dump` or `pg_restore` — §8.1, as a test.

## 10. Test requirements

**Unit** — the manifest and trailer shapes; the digest's sensitivity; the
reader's recomputation; the streaming writer over a fake database.

**Integration (real PostgreSQL)** — AC-3 to AC-8, AC-10 and AC-17 against a
live schema; an export of Ferret's own index.

**Security** — AC-5, AC-6, AC-9, AC-13.

**Failure** — an unwritable destination; an export interrupted half way.

**Regression** — EPIC-087's and EPIC-047's suites unchanged.

## 11. Security requirements

§8.3 and §8.4. An export is the largest read Ferret performs, so the grant, the
scope and the redactor all apply, and the trail records it.

## 12. Observability

Counts per table in the manifest and in the audit event, and a row count on
stderr as it streams.

## 13. Performance constraints

One pass per table, streamed, inside one snapshot transaction. No `ORDER BY`
beyond the primary key, so nothing sorts an index that does not fit in memory.
The snapshot holds a transaction open for the length of the export, which is the
cost of §8.6a and is stated rather than hidden.

## 14. Definition of Done

Scope implemented; AC-1 to AC-17 with evidence in
`validation/EPIC-089-VALIDATION.md`; `npm run verify` green; the registry
updated; `COMPATIBILITY.md` §7, EPIC-094 §4 and EPIC-088 §16 struck with dated
notes.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — §8.1 is this principle at its sharpest: the
  right amount of backup code to write is none.
- **§6 Evidence Before Inference** — the manifest states what was exported
  rather than leaving an importer to infer it.
- **§10 Time and History** — AC-7: a tombstone is payload, not noise.
- **§12 Security** — §8.3, §8.4, §8.7.

## 16. Raised, not absorbed

- **The export is not encrypted.** It is cleartext, and it is everything Ferret
  knows in one file. Saying so is the contract; a key-management story invented
  here would be one nobody reviewed.
- **No incremental export.** Every run writes everything in scope. An index
  large enough for that to hurt is an index with a cursor story, and EPIC-075
  owns cursors.
- **Import is EPIC-090's, and until it exists this Epic's output is unproven.**
  A format is validated by a reader written against it, not by the writer. AC-3
  round-trips through a reader in *this* Epic's tests, which is weaker.
  **Closed 2026-09-02 by [EPIC-090](EPIC-090-Data-Import-And-Recovery.md),** and
  it found two defects this Epic's own tests could not: `search_vector` is a
  `GENERATED ALWAYS` column that `SELECT *` put in the document, making *every*
  document unimportable (`428C9`); and a `jsonb` column holding a scalar needs
  JSON quoting, which `attributes` satisfied by accident and
  `evidence.statement` did not (`22P02`). Both fixed here; the round trip now
  runs through two databases.
- **A restore into a different major version is not tested here** — that needs
  two versions installed, which is EPIC-106's environment.
- **The snapshot holds a transaction open** for the length of the export, which
  on a busy install delays vacuum of anything the export can still see. The
  alternative is a document that may not import, so the trade is deliberate;
  §13 states the cost.

## 17. Recorded during implementation

**§8.2 changed before implementation, not after.** The manifest as first
drafted carried the counts and the digest, which forces a second full scan of
the index or buffering the whole document — for a header value no importer can
check before reading the rows anyway. Split into a manifest and a trailer, and
AC-1/AC-2/AC-10 restated to match, with AC-16 added for the truncation case the
split makes detectable. Recorded here because the specification is the artefact
that changed.

**§4 and §8.4 amended 2026-09-04 by owner decision — F-44 and F-45.** Two
things this specification left unsaid, both recorded and decided in
[EPIC-089-DECISIONS.md](../Architecture/EPIC-089-DECISIONS.md), which is
authoritative for the detail:

- **Added to §4 (Non-scope): `ferret.embedding` and `ferret.instance`.** §3's
  scope was a closed list that omitted both, so excluding them was always within
  contract — but §4 did not name them and §1 promises "everything Ferret knows",
  so a restore lost every vector and minted a fresh identity in silence. The
  manifest now declares what it does not carry, and the import repeats it.
  Vectors are regenerated by re-indexing with an embedding provider; none ships
  today, and the document says so rather than implying a command.
- **§8.4's redactor detects and gates; it does not rewrite.** §11 still holds —
  the redactor applies to an export, and it does, over every string value. What
  changed is the consequence: a match is reported in the trailer and printed,
  and `--strict` refuses. It no longer substitutes the value, because
  `content_hash` is derived from `attributes` and substitution left the hash
  describing a row that no longer existed — measured at five false integrity
  findings on a two-file index, and at EPIC-090 §8.7's scrub silently scrubbing
  nothing. EPIC-087 §8.2 ("never on the way out") and Governance §6 are the
  governing statements.

No acceptance criterion is withdrawn. AC-6 and AC-13 are unaffected — a test
citing them for a redaction property was mislabelled and is corrected.

Full evidence in [validation](validation/EPIC-089-VALIDATION.md).
