# EPIC-088 — Retention & Exclusion Policies · Validation Evidence

**Assessed against:** working tree on top of `2317bee`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17 + pgvector for every anti-join; the built
CLI as a child process for the confirmation and the audit trail; real filesystem
journals.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 no target deletes nothing, reports what could go | **MET** | `prune-cli.test.ts` "reports every target and deletes nothing when none is named", and "deletes nothing for --yes with no target named" |
| AC-2 a named target without `--yes` deletes nothing | **MET** | `prune-cli.test.ts` "deletes nothing when a target is named without --yes" — `wouldDelete: true`, row count unchanged |
| AC-3 `--blobs --yes` deletes only unreferenced blobs | **MET** | `retention.test.ts` "deletes only the blob no file version references" |
| AC-4 a referenced blob is never deleted | **MET** | "keeps a referenced blob even when it is the only one left" |
| AC-5 a rotated journal above the kept count goes, the live one does not | **MET** | `retention.test.ts` (unit) "deletes the orphans and keeps the live journal and the kept copies"; "never deletes the live journal, whatever the kept count" at keep 0 |
| AC-6 superseded evidence older than the age is deleted | **MET** | integration "deletes a superseded record older than the age"; `prune-cli.test.ts` "says an age is required rather than choosing one" for the refusal |
| AC-7 superseded evidence younger than the age is kept | **MET** | "keeps a superseded record younger than the age" |
| AC-8 current evidence is never deleted, whatever the age | **MET** | "never deletes current evidence, whatever the age" — backdated 3 650 days, age 0 |
| AC-9 a tombstone is never deleted, and there is no flag | **MET** | integration "deletes no blob a tombstoned file version still names"; unit "has no target for a tombstone, and no way to name one"; `prune --help` carries no such flag |
| AC-10 the plan reports rows per target in both modes | **MET** | unit "reports the same counts in both modes"; integration "deletes nothing without apply, and reports the same counts" |
| AC-11 a failure on one target does not prevent another | **MET** | integration "reports a failing target and still runs the others" — `content_blob` renamed out from under the sweep; blobs `failure` set, evidence unaffected |
| AC-12 one audit event per target, count and no row contents | **MET** | `prune-cli.test.ts` "records one event" (`prune.blobs`, `reason` matching `^\d+ row\(s\)$`) and "writes no row content into the trail" |
| AC-13 running twice reclaims nothing the second time | **MET** | integration and CLI, both "reclaims nothing the second time" |
| AC-14 every remaining file version still resolves its content | **MET** | "leaves every remaining file version able to resolve its content" — a dangling-reference count of 0 asserted in SQL after the prune |
| AC-15 no cursor or watermark is ever deleted | **MET** | unit "has no target for a cursor or a watermark" — §16's finding as a test |

Fifteen of fifteen MET. `npm run verify` green: 137 files, 2 893 passed,
3 skipped.

## Found while implementing

**A spent sync cursor is not a distinguishable target, so it was dropped.**
EPIC-075 §4 defers cursor pruning here, and the spec carried it as a fourth
target until the schema was read: `CURSOR_ARTIFACT_KIND` is `'index'`
(`src/storage/cursors.ts:44`), which is the same `derived_artifact` kind a
**watermark** uses. A delete keyed on that kind could remove the watermark that
makes incremental indexing work, and an anti-join on `scope_id` cannot separate
the two. Dropped rather than shipped with a narrower filter that would be one
schema change away from deleting the wrong row; recorded in §16, and asserted as
AC-15 so a later author who adds the target has to confront the reason. The fix
is a distinguishing column or kind, which is EPIC-075's schema to change.
Cursors are a handful of rows, so nothing about it is urgent.

**A superseded record can still be the answer to a question, and the cascade
hides it.** `evidence_derivation` declares `onDelete: 'cascade'` on **both**
columns, so deleting a superseded record silently deletes the edges where it was
the *source* — and a `current` record derived from it then has no provenance.
That is EPIC-046's `derivedFrom` chain and exactly what §8.3 exists to protect,
so the evidence target carries two guards rather than one: `state =
'superseded'` **and** no derivation edge to a `current` or `conflicting` record.
Not in the specification, because the cascade is not visible from the Epic
statement; the integration test "keeps a superseded record a current record was
derived from" is the one that would have caught its absence.

**The blob delete re-checks the anti-join inside the transaction.** The plan
lists hashes and the delete could have used that list, but an index run
concurrent with the prune may write a `file_version` for one of them between the
two statements — and deleting by list would then remove content a live row
points at. The predicate is repeated in the `DELETE`, so the reported count is
what was actually reclaimed rather than what was planned.

**The journal target has a real orphan case, which is why it survived.**
EPIC-085's rotation removes exactly `keepFiles + 1` per rotation. That bounds
growth at a *fixed* setting, and orphans everything above it when the setting
drops: an install that kept ten copies and now keeps two never touches `.4`
again. Those files are what this deletes, and the live journal — which carries
no rotation suffix — is not a candidate at any keep count, including zero.

**EPIC-069's "no destructive CLI command" is now superseded, and stays
unreconciled.** Its §4 declined a CLI confirmation adapter on the grounds that
"no command takes `--force` or `--yes`". `verify --repair --yes` made that stale
and `ferret prune --yes` is the second, and **neither uses EPIC-069's gate** —
its confirmation is a round trip, and the CLI has no channel for one. So the two
surfaces differ deliberately: MCP confirms with a token, the CLI confirms with a
flag. Struck with a dated note on EPIC-069 rather than reconciled here; a future
Epic that wants one shape for both has to choose which surface changes.

## Decisions worth recording

**`--yes` alone deletes nothing.** The flag is a confirmation, not a target: a
caller who typed it without naming what to reclaim asked to delete nothing in
particular. Tested as AC-1 rather than left to the reader, because the opposite
reading — "yes to everything" — is the one that loses data.

**The age has no default.** §8.3 refuses to choose one, and the refusal returns
before any query is issued (the unit suite proves that with a service whose
database throws on contact). "How long is the history worth keeping" is the
caller's judgement, and a default of 90 days would be Ferret asserting an answer
it has no evidence for — Governance §6.

**One transaction per target.** A failing target reports its failure and the
target beside it still runs, which is the failure isolation EPIC-093 asks for at
the grain the report can describe. The journal target is a filesystem sweep and
runs outside any transaction, which is the same reason stated the other way
round.

**`--dry-run` is not a flag, it is the default.** There is nothing to type to
get a plan; there is something to type to get a deletion. The two modes differ
in exactly one respect — whether the rows are still there afterwards — and both
print the same report.

## Raised, not fixed

**The reproducible-tarball gate failed once and passed twice on the same tree**
— `packaging.test.ts` "is reproducible — packing twice yields byte-identical
tarballs", once during a full `verify`, then green in isolation and green again
on an immediately following full run of the identical tree. Both packs use
`--ignore-scripts`, so neither rebuilds, and nothing in `tests/` writes into the
repository's `dist/`; the cause is **not established** and is recorded as such
rather than attributed. The structural exposure is that the test packs the live
working tree while 136 other files run against it. Filed as
[#130](https://github.com/indoulia/Ferret/issues/130) with two candidate fixes,
neither belonging to this Epic. Not related to this change set — the failing
assertion covers `dist/` reproducibility, and this Epic adds three modules and
three test files.

## Limitations, recorded

- **A tombstone still has no retention story.** §8.4 refuses to delete one, so
  an index of a repository with a million deleted files grows without bound in
  that one dimension. The honest fix is export-then-truncate, which needs
  EPIC-089 as well as this Epic.
- **Cursors and watermarks are not prunable**, for the reason above. EPIC-075
  owns the schema change that would make them distinguishable.
- **Excluded content is still stored.** EPIC-058 hides it; "everything matching
  this exclusion" is a selector this Epic does not build.
- **The database is not vacuumed.** Deleted rows free space to PostgreSQL, not
  to the filesystem, until it decides otherwise. Saying so is more useful than
  wrapping `VACUUM` and implying Ferret manages storage.
- **No schedule, and no configured policy.** A retention rule in a config file
  runs where nobody is watching. EPIC-078 owns periodic work and would have to
  decide separately whether a scheduled delete is ever acceptable; this Epic's
  position is that it is not, yet.
- **Blob bytes are counted, evidence rows are not.** A row's on-disk cost
  depends on TOAST and index overhead, and reporting a number derived from
  `octet_length` alone would be a guess presented as a measurement.
