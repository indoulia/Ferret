# EPIC-088 — Retention & Exclusion Policies

**Status: VALIDATED | Priority: P1 | Domain: Storage & Data Lifecycle**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Storage & Data Lifecycle;
> only the specification is new.

## 1. Objective

Be the one place Ferret deletes anything — asked for explicitly, planned before
it happens, and never taking the answer to a question with it.

## 2. Value

Seven Epics defer deletion here, and two of them say why it may not happen
anywhere else:

- **EPIC-006 §D-009** — "Actual deletion, if it is ever wanted, must be
  requested explicitly and belongs to EPIC-088", and §159: "EPIC-088 owns
  retention, which is where genuine deletion must be asked for explicitly."
- **EPIC-058 §4** and **EPIC-083 §4** — "Exclusion hides; it never erases."
- **EPIC-008's checkpoint** — "Evidence is never pruned → EPIC-088."
- **EPIC-087 §4** — "Retention, eviction and unreferenced-blob collection. A
  blob outlives the last file version that referenced it, deliberately."
- **EPIC-075 §4** — cursors, which §16 records as not deliverable here.
  **EPIC-085 §4** — the audit journal's retention policy. **EPIC-086 §4** —
  storage retention generally.

So Ferret grows and never shrinks. On its own repository a re-index leaves
content blobs no `file_version` points at, and there is no way to reclaim one
short of dropping the database — which is the operation that also destroys the
answers.

## 3. Scope

- **`ferret prune`**: a plan, then a confirmed deletion.
- **Three targets**, each with a rule that makes deletion safe (§8.3):
  unreferenced content blobs, rotated audit journals, and superseded evidence
  past an explicit age.
- **A default that deletes nothing** — §8.1.
- **Reporting what *would* go**, always, before anything does.

## 4. Non-scope

- **Automatic or scheduled pruning.** §8.1. EPIC-078 owns periodic work, and a
  schedule that deletes is a schedule that deletes something somebody needed.
- **Deleting a tombstoned entity.** §8.4 — this is the sharp one, and the answer
  is no.
- **Deleting *excluded* content.** EPIC-058 and EPIC-083 both say exclusion
  hides. A caller who wants excluded content gone names it as a retention
  target; the exclusion itself never deletes.
- **A retention *schedule* in configuration.** §16: a policy nobody can see run
  is a policy nobody can audit.
- **Dropping the database** — that is `dropdb`, and Ferret does not wrap it.
- **Deleting a repository's entire index.** A caller who wants that has
  `ferret init` and an empty database.

## 5. Inputs

`content_blob` and the `file_version` entities that reference it; EPIC-085's
rotated journals; `evidence` with `state = 'superseded'` and its `recorded_at`.

## 6. Outputs

`src/storage/retention.ts` — the plan and the deletion. `ferret prune`, with
`--dry-run` by default. No schema change; no migration.

## 7. Dependencies

EPIC-069 (the confirmation shape), EPIC-086 (the store), EPIC-087 (blobs),
EPIC-047 (which records `superseded`), EPIC-085 (the journals).

## 8. Contracts

### 8.1 Nothing is deleted unless it is asked for, by name

`ferret prune` with no target reports what *could* be reclaimed and deletes
nothing. Each target is named by a flag, and deletion needs `--yes` — the shape
`ferret verify --repair` already uses, and for the reason it records: "the
confirmation is an explicit flag rather than a prompt that would hang in a
pipe", because Ferret is run by an AI client as often as by a person.

There is **no automatic pruning and no schedule**. Governance §6 forbids
silently rewriting evidence, and a scheduled delete is the silent version of
this Epic.

### 8.2 A plan is produced before, and reported after

The plan names each target, how many rows match, and how many bytes it would
reclaim. Reported whether or not the deletion runs, so `--dry-run` and the real
thing differ in one respect only: whether the rows are still there afterwards.

### 8.3 A target qualifies only when it answers no question

The rule every target must pass, and the reason each one passes it:

- **An unreferenced content blob** — no `file_version` carries its hash. It is
  bytes nothing points at, so no question reaches it. Note EPIC-087's warning:
  a blob "outlives the last file version that referenced it, deliberately: that
  is what makes it deduplicated storage rather than a cache" — so this is
  *reclamation after the fact*, never eviction while a reference exists.
- **A rotated audit journal** — EPIC-085 already bounds the count; this deletes
  the files that bound has already orphaned.
- **Superseded evidence past an explicit age** — `state = 'superseded'` means
  EPIC-047 recorded that something replaced it, and the replacement carries the
  current answer. The age must be given: there is no default, because "how long
  is the history worth keeping" is the caller's judgement and not Ferret's.

### 8.4 A tombstone is never deleted, and that is the point

The one target this Epic refuses. EPIC-006 §D-009 states the reason and it is
not a preference: "what happened to this file, when was it deleted, what did it
contain — are precisely the questions Ferret indexes history to answer. Erasing
the row would erase the answer along with the file."

A `deleted` entity is *the record that a deletion happened*. Pruning it makes
Ferret unable to distinguish a file that never existed from one that was removed,
which is the distinction EPIC-032 exists to maintain. A caller who genuinely
wants that has an empty database and a fresh index.

The same logic protects **current** evidence: only `superseded` qualifies, and
only past an age the caller names.

### 8.5 Deletion is one transaction per target, and reports what it did

Per target rather than one for everything, so a failure on blobs does not roll
back a cursor sweep that succeeded — the failure isolation EPIC-093 asks for,
applied at the grain the report can describe. Every deletion is counted, and a
target that failed says so rather than being absent from the report.

### 8.6 An audit event is emitted, because this is the destructive one

EPIC-085 landed the trail; this is the Epic that most needs it. Each target's
deletion emits one `AuditOutcome.PERMITTED` event naming the target and the
count — never a row's contents. A prune that nobody can see afterwards is the
operation an operator most needs to see.

## 9. Acceptance criteria

- **AC-1** `prune` with no target deletes nothing and reports what could go.
- **AC-2** `prune --blobs` without `--yes` deletes nothing and says what it
  would.
- **AC-3** `prune --blobs --yes` deletes only blobs no `file_version`
  references.
- **AC-4** A referenced blob is never deleted, even when every other blob is.
- **AC-5** A rotated journal beyond the kept count is deleted; the live one is
  not.
- **AC-6** Superseded evidence older than the given age is deleted.
- **AC-7** Superseded evidence *younger* than the age is kept.
- **AC-8** **Current** evidence is never deleted, whatever the age.
- **AC-9** A tombstoned entity is never deleted, and there is no flag for it.
- **AC-10** The plan reports rows per target, in both modes.
- **AC-11** A failure on one target does not prevent another, and is reported.
- **AC-12** Every deletion emits one audit event naming the target and the
  count, and no row contents.
- **AC-13** Running `prune --yes` twice reclaims nothing the second time.
- **AC-14** After pruning blobs, every remaining `file_version` still resolves
  its content — the invariant that makes AC-3 safe.
- **AC-15** No cursor or watermark artifact is ever deleted — §16's finding, as
  a test.

## 10. Test requirements

**Unit** — the qualifying rule per target over hand-built rows; the age
boundary; the refusal to touch current evidence.

**Integration (real PostgreSQL)** — AC-3 to AC-9, AC-14 and AC-15 against a
live schema; AC-12 with one target failing.

**Security** — AC-13, and that no row content appears in the audit event.

**Failure** — a target whose table is empty; an age of zero; a database that
rejects the delete.

**Regression** — EPIC-087's and EPIC-047's suites unchanged.

## 11. Security requirements

An audit event names the target and the count and no content (§8.6, AC-13).
Pruning cannot be reached without the destructive path, so the same
confirmation and permission controls that guard a repair guard this.

## 12. Observability

The plan is the observability, in both modes. An operator who ran `--dry-run`
and an operator who ran `--yes` read the same report.

## 13. Performance constraints

One anti-join per target, on indexes that already exist —
`entity_file_version_content_hash_idx` for blobs, `evidence_state_idx` for
evidence. No new index.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 with evidence in
`validation/EPIC-088-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-008's "evidence is never pruned" and EPIC-087's unreferenced-blob
gap struck with dated notes.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.4 refuses to delete the record that a
  deletion happened, and §8.3 requires the caller to name an age rather than
  Ferret inventing one.
- **§10 Time and History** — history is the answer, so a tombstone stays.
- **§12 Security** — §8.6's trail, and the destructive path's existing controls.
- **§5 Reuse Before Reinvent** — `verify --repair`'s `--yes` shape, EPIC-085's
  writer, existing indexes.

## 16. Raised, not absorbed

- **No schedule, and no configured policy.** A retention rule in a config file
  runs where nobody is watching; EPIC-078 owns periodic work and would need to
  decide, separately, whether a scheduled delete is ever acceptable. This Epic's
  position is that it is not, yet.
- **A tombstone has no retention story at all.** §8.4 refuses to delete one, so
  an index of a repository with a million deleted files grows without bound in
  that one dimension. The honest fix is an *export-then-truncate* — EPIC-089
  owns export — and it needs both Epics.
- **A spent sync cursor is not a distinguishable target.** EPIC-075 defers
  cursor pruning here, and it cannot be done safely: `CURSOR_ARTIFACT_KIND` is
  `'index'`, which is the same `derived_artifact` kind a **watermark** uses. A
  delete keyed on that kind could remove the watermark that makes incremental
  indexing work, and an anti-join on `scope_id` cannot tell the two apart.
  Found while implementing; the fix is a distinguishing column or kind, which is
  EPIC-075's schema to change. Cursors are a handful of rows, so nothing is
  urgent about it.
- **Excluded content is still stored.** EPIC-058 hides it; a caller who wants it
  gone has no target here, because "everything matching this exclusion" is a
  selector this Epic does not build.
- **The database is not vacuumed.** Deleted rows free space to PostgreSQL, not
  to the filesystem, until it decides otherwise. Saying so is more useful than
  wrapping `VACUUM` and implying Ferret manages storage.

## 17. Recorded during implementation

**Superseded evidence carries two guards, not one.**
`evidence_derivation` declares `onDelete: 'cascade'` on **both** columns, so
deleting a superseded record silently removes the edges where it was the
*source* — leaving a `current` record derived from it with no provenance. That
is EPIC-046's `derivedFrom` chain and precisely what §8.3 protects, so the
target requires `state = 'superseded'` **and** no derivation edge to a `current`
or `conflicting` record. Not visible from the Epic statement; the cascade is.

**The blob delete repeats its predicate inside the transaction.** An index run
concurrent with the prune may write a `file_version` for a hash the plan listed,
and deleting by list would remove content a live row now points at.

Full evidence in [validation](validation/EPIC-088-VALIDATION.md).
