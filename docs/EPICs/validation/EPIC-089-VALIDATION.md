# EPIC-089 — Backup & Export · Validation Evidence

**Assessed against:** working tree on top of `9e2cbae`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17 + pgvector for the row reads and the scope
closure; the built CLI as a child process for the document, the grant and the
audit trail.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 manifest first, trailer last | **MET** | `export.test.ts` (unit) "writes the manifest first and the trailer last"; `export-cli.test.ts` through a real file |
| AC-2 manifest names the versions, trailer the counts and digest | **MET** | unit "names the versions in the manifest and the counts in the trailer" |
| AC-3 every table, every column | **MET** | integration "exports entities, relationships, evidence and blobs", and "carries every column the schema declares" — compared against `information_schema.columns` |
| AC-4 `--scope` exports one repository | **MET** | integration "exports one repository and what it contains" — the closure reaches `file_version` two hops down and stops at the other repository |
| AC-5 `permission_scope` survives | **MET** | integration "exports permission_scope rather than stripping it" |
| AC-6 refused without the `READ` grant | **MET** | `cli-authorization.test.ts` "refuses to export when configuration withholds read", with the granting control beside it |
| AC-7 a tombstone is exported | **MET** | integration "exports a deleted entity with its lifecycle intact", and again inside a scope |
| AC-8 `omitted_reason` beside a null body | **MET** | integration "exports omitted_reason beside a null body" |
| AC-9 the configuration file needs no exporter | **MET** | `export-cli.test.ts` "keeps the configuration secret as a reference" — through `config set`, asserting the stored file holds `{"$secret": {"env": …}}` and not the value resolution just produced |
| AC-10 the digest is sensitive to rows and not to the manifest | **MET** | unit "changes when a row changes", "does not change when only the manifest does"; integration and CLI both recompute it |
| AC-11 an empty index is a valid document | **MET** | unit "exports an empty index as a valid document" (two lines, every table named with a zero); CLI over a freshly `init`ed database |
| AC-12 streamed, not assembled | **MET** | unit "writes each row before reading the next page" — the sink/query interleaving asserted directly, so a collect-then-write implementation fails |
| AC-13 one audit event, count and no row contents | **MET** | `export-cli.test.ts` "records one audit event naming the row count"; "exports no secret-shaped value into the document" |
| AC-14 the `pg_dump` command is named | **MET** | CLI "names the pg_dump command and the configuration file, and needs no database" — run without a database URL |
| AC-15 nothing wraps `pg_dump` or `pg_restore` | **MET** | unit "spawns no process — the command is printed, not run" (asserted over the module source); CLI over `--help` |
| AC-16 a truncated document is detectable | **MET** | unit "reads a truncated document as having no trailer" — and the rows that did arrive stay readable |
| AC-17 a row written during an export does not appear in it | **MET** | integration "does not include a row written while the export was running" — a real insert from the sink callback, mid-document |

Seventeen of seventeen MET. `npm run verify` green: 140 files, 2 932 passed,
3 skipped.

## Found while implementing

**§8.2 changed before implementation, not after.** The manifest as first drafted
carried the counts *and* the digest. A digest over the rows cannot be computed
before the rows, so that forces either buffering the whole document or scanning
the index twice — for a header value **no importer can check before reading the
rows anyway**. Split into a manifest (versions, instant, scope, table order) and
a trailer (counts, total, digest), one pass, nothing buffered. AC-1/AC-2/AC-10
were restated and AC-16 added for the truncation case the split makes
detectable. Recorded because the artefact that changed is the specification.

**EPIC-081 §4's configuration export is closed with nothing built.** That Epic
already made the file a portable document: a secret is stored as a *reference*
(`{"$secret": {"env": "FERRET_PG_PASSWORD"}}`), resolved once at configuration
resolution, and the file carries its own `version` envelope. A document Ferret
wrote could contain nothing the file does not, so copying it *is* the export —
§8.1's reasoning a second time. The Epic's contribution is naming the path
beside the `pg_dump` command so an operator takes both halves.

**`config set` resolves a reference before storing it**, and refuses one it
cannot — found when the first fixture wrote an unresolvable reference and `init`
exited 3. That is EPIC-081 working correctly, and it strengthens §8.4: an
unresolvable reference can never reach the file, so a copied configuration
always points somewhere that existed when it was written.

**`source_scope` is `text`, not `uuid`.** The closure query cast its parameter
to `uuid[]` and PostgreSQL refused it: `operator does not exist: text = uuid`.
The column holds a *parent's id* for a file or a version and a repository
**path** for a repository, so it cannot be typed narrower — and the array has to
match the column, not the ids' shape.

**An id set is one parameter, not one per id.** `embeddings.ts` builds
`ANY(ARRAY[$1, $2, …])`, which binds a parameter per element — and PostgreSQL
caps a statement at 65 535 of them, so a scope containing more entities than
that would fail to export at all. `string_to_array($1, ',')::uuid[]` binds one
parameter whatever the size. Safe because every value is an entity id: a UUID is
hex and dashes, so a comma cannot occur inside one, and a scope that is not a
UUID fails the cast rather than being silently mis-split.

**The architecture-boundary gate refused the export from the core entry point,
correctly.** `readExportDocument` is a pure function — JSON and a hash, no
database — so re-exporting it from `src/index.ts` looked free. It is not:
`export.ts` sits beside `ExportService`, which imports Drizzle and `pg`, so the
re-export pulled both into the core entry point and `boundaries.test.ts` failed
five ways at once ("does not import anything matching drizzle", "postgres", "is
not reachable from the core entry point"). EPIC-013's rule holds — the core must
not name a concrete provider — so the symbols live on the `./storage` subpath
only, and the test imports them from there. Found by the gate, which is what the
gate is for.

**A test fake was asserting how a query is spelled.** The first unit fake
matched the table name inside the stringified SQL chunks, and passed or failed
depending on which chunk objects happened to have a useful `toString` — three
tests failed non-deterministically on identical input. Replaced with a
positional fake: the service issues one query per table in `EXPORT_TABLES`
order, so the Nth call is the Nth table. The product was never wrong; the fixture
was, and it is recorded because a flaky fake reads exactly like a flaky product.

## Decisions worth recording

**A backup is `pg_dump`, and Ferret prints the command.** Governance §5 at its
sharpest: the right amount of backup code to write is none. A wrapper would add
a version-matching failure mode and subtract nothing, and EPIC-088 §4 set the
precedent — "dropping the database is `dropdb`, and Ferret does not wrap it".
`--backup-command` needs no database, because an operator asking what the backup
command is should not need a reachable one to be told.

**An edge with one end outside a scope is dropped, not exported dangling.**
EPIC-090 would have to refuse a relationship whose other end is absent, and a
document that cannot be imported is not an export. Tested directly.

**A tombstone is payload.** AC-7, and the inverse of EPIC-088 §8.4: that Epic
refuses to delete the record that a deletion happened, and this one refuses to
omit it. "What did it contain" is a question the export has to be able to answer
or the export is not a recovery path.

**`SELECT *`, deliberately.** A column list would have to be maintained beside
every migration, and the failure mode is silent: a new column simply would not
be in the document. The integration test compares the exported keys against
`information_schema.columns`, so the guarantee is checked rather than remembered.

**The whole document is one snapshot, and that was a correction.** The first
implementation read the tables one after another, and the limitation was written
down honestly: a concurrent index run landing between two of them yields a
document with an `evidence` row whose subject is absent — which EPIC-090 would
have to refuse, making the export not a recovery path. Recording a limitation
that a `repeatable read` transaction fixes in six lines is the wrong trade, so
§8.6a and AC-17 were added and the limitation became a *cost* instead: the
transaction stays open for the length of the export.

**An export is audited even though reads are not.** EPIC-085 §4 recorded that
auditing every read would produce a log rather than an audit trail. A bulk read
of everything Ferret knows is the deliberate exception, and the test asserts the
exception is actually taken rather than assumed.

## Limitations, recorded

- **Import is EPIC-090's, so this format is not yet validated by a reader
  written against it.** AC-3 round-trips through a reader in *this* Epic, which
  is weaker — the writer and the reader share an author.
- **The export is not encrypted.** It is cleartext, and it is everything Ferret
  knows in one file. Saying so is the contract; a key-management story invented
  here would be one nobody reviewed.
- **No incremental export.** Every run writes everything in scope.
- **A scope's id set is held in memory.** One `uuid` string per entity in the
  closure — a few hundred kilobytes for a repository the size of Ferret's own.
  Bounded by entity count, not by row count, which is the smaller of the two.
- **A restore into a different major version is not tested**; that needs two
  versions installed, which is EPIC-106's environment.
- **The snapshot holds a transaction open** for the length of the export, which
  on a busy install delays vacuum of anything the export can still see. The
  alternative — the state this Epic shipped with until §8.6a was added — is a
  document that may not import at all, so the trade is deliberate.
