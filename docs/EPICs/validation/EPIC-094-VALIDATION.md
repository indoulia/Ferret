# EPIC-094 — Index Integrity & Recovery · Validation Evidence

**Assessed against:** working tree on top of `a996b4a`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, real `git`, and Ferret's own index (3 140 entities, 2 704 relationships, 1 338 observations, 541 derived artefacts).

## What this Epic found

Governance §13 asks that a corrupt or stale index be *detectable and recoverable
without requiring the user to become a database administrator*. Detection did
not exist: `content_hash` had been stored on every entity and relationship since
EPIC-006 and EPIC-007 and **nothing had ever recomputed it from a stored row**.

Building the check that does found two defects in shipped, VALIDATED code, and
one false start of its own. All three are worth more than the feature.

### Defect 1 — the content hash was not a function of the value

A commit's `sourceObservedAt` arrived from Git as `2026-09-01T21:33:28+05:30`
and was hashed in that spelling. The column is a `timestamptz`, so it reads back
as `2026-09-01T16:03:28.000Z`. **The same instant, different bytes** — so the
hash could never be recomputed from the row it describes.

`contentHash`'s own doc comment already promised that "two encodings of the same
content hash identically". For strings and objects that was true; for instants
it was false, and nothing had noticed because nothing had ever tried.

Fixed by `canonicalInstant`, applied to the hash inputs of entities,
relationships and evidence — and **not** to canonical keys or ids, which are
stored identifiers that renormalising would re-point.

### Defect 2 — evidence hashed itself twice, in two places

`createEvidence` built its own copy of the immutable field list and hashed that;
`integrityHashOf` built the same list again to verify it. Two implementations of
one hash, thirty lines apart. They had already drifted: every observation
carrying a non-UTC `observedAt` was unverifiable, and EPIC-008's integrity check
had therefore never worked for those records. Nobody knew, because that check
had **no production caller** — which is the gap this Epic exists to close.

`createEvidence` now calls `integrityHashOf`. One definition, used twice.
Verified against a live database: an observation written with `+05:30`, with
`Z`, and with no `observedAt` at all now all verify.

### The false start, recorded because it is the point

The first working sweep reported **2 651 findings on a clean index**. None was a
corruption:

| reported | count | actually |
| --- | --- | --- |
| `schema-invalid` on `code_symbol` | 1 811 | the kind was not registered *in the verifying process* |
| `stale-artifact` on `content-index` | 540 | producer version is a *parser identity*, not a Ferret version |
| the rest | 300 | Defects 1 and 2 above |

A checker that reports corruption where there is none is worse than no checker,
because it is believed once and ignored thereafter. Each cause was traced before
anything was written down, and the sweep is conservative where it cannot decide:
artefacts it cannot judge are counted as **unassessable** rather than reported
(§8 — a check that cannot run says `unknown`, never `ok`).

## Measured, on Ferret's own index

| stage | findings |
| --- | --- |
| first sweep | 2 651 |
| after the two false-positive classes were fixed | 299 |
| after `ferret verify --repair --yes` | **166** |

The repair rewrote **133 commits** whose hashes predated Defect 1's fix. The
remaining 166 are rows that cannot be re-derived, and each was traced rather
than assumed:

- **135 observations** written before Defect 2's fix. Evidence is append-only by
  design, so an old record keeps its original hash for ever.
- **14 `file` rows, all `lifecycle: deleted`** — verified by query. The source no
  longer contains them, so there is nothing to re-read.
- **16 relationships** to those files and to departed worktrees.
- **1 commit** not reachable from the indexed revision.

`unassessable`: 540 content artefacts, reported as such.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 altered entity reported with id, kind, canonical key | MET | `integrity.test.ts`, corrupted by direct SQL |
| AC-2 the same for a relationship | MET | metadata altered by direct SQL |
| AC-3 a re-pointed id is reported | MET | id replaced by direct SQL |
| AC-4 a tampered observation is found by the sweep | MET | not only by a per-id `verify` a caller must already suspect |
| AC-5 installation-wide, bounded, states what it did not examine | MET | `complete`, `truncated`, `cursor`, resumption asserted; `verifyAll`'s silent 1 000-row cap (issue #95) now reports `total` and `complete` |
| AC-6 an unfinished run is detectable and distinct from "nothing indexed" | MET | run journal; probe reports it *before* the "nothing indexed" branch, which is the case it exists to correct |
| AC-7 a stale artefact of any kind is reported | **PARTIAL** | schema-version staleness is checked for every kind; producer-version staleness only for `ferret.indexer`, because `content-index` records a parser identity. The rest are counted `unassessable` — see Raised |
| AC-8 `index-integrity` reports findings, and `unknown` when it cannot run | MET | unfinished runs surfaced; `ok` now says "no skew and no unfinished run", not "the index is correct" |
| AC-9 a clean installation yields nothing, twice | MET | and a freshly CLI-indexed repository verifies clean end to end |
| AC-10 every remediation names a Ferret command | MET | asserted per finding: contains `ferret `, contains no SQL verb and no table name |
| AC-11 repair re-derives; nothing edits a hash | MET (writes) / **PARTIAL** (effect) | the sweep is structurally read-only and the repair command touches no hash column, both asserted over the source. Re-derivation fixes a stale hash — 133 commits — and does **not** fix an entity altered in place; issue #101 |
| AC-12 repair is idempotent | MET | two repairs leave the same findings |
| AC-13 an interrupted repair leaves the index no worse | PENDING | not exercised; a repair is an ordinary index run and inherits EPIC-031 AC-6, which is asserted there |
| AC-14 verify without repairing; repair scopeable | MET | `--repair` is opt-in, `--scope` restricts the sweep |
| AC-15 a repair is confirmed before it runs | MET | `--repair` alone reports what it *would* do and changes nothing; `--yes` proceeds |
| AC-16 detection re-run after repair | MET | the command's response carries the *post-repair* sweep, not a claim that it tried |
| AC-17 integrity reads name `UNRESTRICTED_READ` | MET | in `verifyAll`, where a scoped-read parameter exists. `EvidenceStore.get` takes none — EPIC-008's checkpoint is explicit that an internal caller omitting it is correct |

## What only a real database could prove

Every corruption fixture is direct SQL, the bar EPIC-008 set. A mocked store
would have asserted that a mock was called, and the defect this Epic exists to
catch — *nothing recomputed the hash from a stored row* — is exactly the kind a
mock cannot see. Both hashing defects were found by running the sweep against a
real index, not by reading the code.

## Verification

`npm run verify` green: 110 files, 2 404 passed, 3 skipped. New suites:
`tests/integration/storage/integrity.test.ts` (17, real PostgreSQL),
`tests/integration/storage/verify-cli.test.ts` (12, real PostgreSQL and `git`).

Dogfooding: `ferret verify` runs against Ferret's own index through the CLI, and
its output is the measurement table above.

## Raised, not absorbed

- **AC-7 is partial, and the residue is named.** A `content-index` artefact
  records the parser's identity as its producer version — measured:
  `ferret.parser.code@1.0.0+wts0.25.10+typescript@14/8515…`, or the literal
  `none`. Judging those needs EPIC-010's `validateArtifact` with a *composed
  parser* in hand, which a read-only sweep does not have; EPIC-108's re-parse
  gate already validates them on the path that does. They are counted
  `unassessable` rather than reported clean.
- **AC-11's effect is partial — issue #101.** Repair fixes a stale hash and does
  not fix an entity altered in place. The repository case is traced: every stage
  emits the repository entity as a relationship endpoint, so it is written
  `ifAbsent` (issue #48's protection), making it the one row a re-index will
  never rewrite. Two tests assert the limitation so it cannot regress silently.
- **Rows written before this Epic cannot all be repaired.** Entities and
  relationships are, by re-derivation. Evidence is not, by design — append-only
  means an old record keeps its hash for ever. An installation indexed before
  this change will report those observations until they age out of relevance,
  and the finding's wording says both possible causes rather than asserting
  tampering.
- **`staleArtifacts` still has no production caller.** `markStale` now does — it
  runs before a repair re-derives — which discharges half of EPIC-010's recorded
  gap ("the marking exists, the rebuild does not"). Enumerating stale artefacts
  through `staleArtifacts` rather than through the sweep's own query is a
  tidying this Epic did not need.
- **The unfinished-run threshold is two hours, and is age, not liveness.** The
  database cannot be asked whether a process is alive. Two hours is longer than
  any run Ferret has been measured performing; a long-running index on a very
  large repository would be reported while still working, which is a false
  positive this Epic accepts in exchange for detecting a dead one at all.

---

## Addendum — 2026-09-02

**AC-7, AC-11 and AC-13 are now MET. Nothing above is rewritten.** The rows and
the §Raised paragraphs record what was demonstrated when this Epic was assessed,
and one of them turns out to have recorded the wrong cause — which is worth
keeping visible rather than correcting in place.

### AC-7 — a stale artefact of any kind

Was PARTIAL: schema-version staleness checked for every kind, producer-version
staleness only for `ferret.indexer`, everything else counted `unassessable`
because "judging those needs EPIC-010's `validateArtifact` with a *composed
parser* in hand, which a read-only sweep does not have."

That reasoning was right about the sweep and wrong about the options. The sweep
does not need to compose a parser — it needs to *ask something that has one*.
`SweepOptions.producerIdentity` is that seam, and `contentProducerIdentity` in
`src/indexing/content.ts` is the implementation; `ferret verify --content`
composes it.

Two things made it cheaper than the original note assumed:

- **The target is already stored.** A content artefact's `metadata.structure`
  carries `path`, `mediaType`, `binary` and `sizeBytes` — everything
  `ParserFramework.producerVersion` needs. No join back to the file is required,
  which matters because `contentScopeId` is a hash of the path rather than a
  reference to an entity.
- **The seam had to be a port anyway.** `boundaries.test.ts` asserts
  `src/storage/`'s external package set exactly, so importing `ParserFramework`
  into the sweep would drag `web-tree-sitter` into the storage graph and fail
  that check. Recorded as D2 in `docs/Architecture/EPIC-087-DECISIONS.md`.

`unassessable` survives and now means something narrower: *nothing was composed
that could answer*, rather than *this kind cannot be answered*. A resolver that
returns `undefined` leaves the row unassessable and **never** stale — asserted
directly, because the failure this area exists to avoid is over-reporting:
comparing a parser identity to `VERSION` once reported all 540 content artefacts
stale on a freshly built index, and an operator who sees that once stops reading
the output.

Evidence — `tests/integration/storage/integrity.test.ts`, six cases:

| case | asserts |
| --- | --- |
| *counts a content artefact unassessable when nothing can judge it* | no resolver, so `unassessable > 0` and no stale finding |
| *reports a content artefact built by a superseded parser* | resolver disagrees, so one `STALE_ARTIFACT` naming the stored identity, `unassessable === 0` |
| *leaves a current content artefact alone* | resolver agrees, so no finding |
| *does not report stale on the strength of not knowing* | resolver returns `undefined`, so unassessable and **not** stale |
| *agrees with what the content stage writes for an unparsed file* | resolver answers the literal `none`, matching `record` — otherwise every unparsed file reports stale for ever |
| *says nothing about an artefact whose metadata carries no structure* | fails closed to `undefined` |

`ferret verify` now composes the parser for **detection**, not only for a repair.
Previously `discovery` was gated on `options.repair && options.content`; AC-7 is a
detection criterion, so `--content` alone is enough. A run without `--content`
still reports content artefacts unassessable, which is the honest degradation.

### AC-11 — the effect half, and issue #101's cause was wrong

Was MET for writes and PARTIAL for effect: "Repair fixes a stale hash and does
not fix an entity altered in place." Issue #101 traced the repository case to the
placeholder mechanism — every stage emits the repository entity as a
relationship endpoint, placeholders are written `{ ifAbsent: true }` (issue #48),
"making it the one row a re-index will never rewrite."

**That cause is wrong, and the placeholder mechanism is innocent.** The real one
is in `EntityStore.upsert`:

```ts
if (existing.contentHash === canonical.contentHash) { /* unchanged */ }
```

An alteration made outside Ferret changes `attributes` and leaves `content_hash`
alone. So the recomputed hash equals the stored one, the short-circuit returns
before anything is written, and the row is declared unchanged for ever.
Re-derivation never reached the placeholder decision at all — it never got past
this comparison. Which is why `--full` did not help, and why the `commit` case
issue #101 left untraced has the identical cause.

The fix is the shape issue #101 itself proposed: an explicit "this is a
re-derivation, overwrite what you find" flag. `EntityStore.upsert` takes
`{ rederive: true }`, `IndexOptions.rederive` threads it, and `verify --repair`
sets it.

Three things it deliberately is not:

- **Not an `UPDATE` against `content_hash`.** The row is rewritten in full from
  what the source says, hash included, which is what derivation means. AC-11's
  structural assertions over the source still forbid a hash edit and still pass.
- **Not `full`.** `full` says which commits to read. Widening its effect would
  change what `ferret index --full` writes, which is EPIC-031's measured
  behaviour, in order to close EPIC-094's criterion.
- **Not a way past `ifAbsent`.** The placeholder branch returns first, so a
  gap-filler still cannot regress a record read in full. Issue #48's protection
  is asserted intact — *"still lets a placeholder decline to overwrite"* in
  `tests/integration/domain/entity-store.test.ts`.

Evidence: the two tests in `tests/integration/storage/verify-cli.test.ts` that
asserted the limitation now assert the repair, **including the repository case** —
*"repairs a corrupted repository entity"* takes findings to 0. Both were
rewritten rather than deleted, so the record of what changed is in the diff.
Three unit cases in `entity-store.test.ts` cover the option itself: it rewrites a
tampered row, it loses to `ifAbsent`, and a second re-derivation writes nothing
new (AC-12).

### AC-13 — an interrupted repair

Was PENDING: "not exercised; a repair is an ordinary index run and inherits
EPIC-031 AC-6." Half true, and the half that is not is why this needed a test.

The watermark half does inherit, and it is now confirmed in source rather than
argued: `#writeWatermark` runs only after every stage succeeds, so a run that
dies part way advances nothing. But a repair does something an ordinary run does
not — `verify.ts` calls `markStale` **before** re-deriving, so an interruption
between the two leaves artefacts marked stale and not rebuilt. EPIC-031 AC-6 says
nothing about that residue.

`tests/integration/storage/repair-interrupt.test.ts` composes the repair sequence
as `verify.ts` composes it and interrupts it at a known stage boundary — the
provider aborts once history has been read, so stage 1's writes have landed and
the watermark has not. A timer would have made the outcome depend on machine
speed, which is the defect EPIC-076 fixed in its own AC-2 test.

| case | asserts |
| --- | --- |
| *leaves the index no worse … advances no watermark* | findings after are no more than before; every watermark row identical, metadata included |
| *leaves the stale marking truthful rather than misleading* | `markStale` touched no current artefact; it sets `state` and `last_checked_at` only, and the sweep judges from `producer_version` and `schema_version`, never `state` — so the residue can neither manufacture a finding nor hide one |
| *completes when it is run again* | the next run earns its watermark and the index is still repairable — an index left "no worse" that could not then be repaired would satisfy the letter of AC-13 and leave an operator with no way out |

"No worse", not "unchanged", and that is deliberate: a partial re-derivation may
legitimately fix rows on its way past, and forbidding that would forbid the
repair from making progress at all.

### Raised, not absorbed

- **Issue #101's recorded cause should be corrected where it is filed.** The
  diagnosis sent a reader to `ifAbsent` and to EPIC-031's placeholder decision,
  neither of which was involved. A wrong cause in a filed issue is the same class
  of defect as EPIC-076's stale limitation rows, one step earlier.
- **`rederive` is a sharp tool on the hottest write path.** It is off by default,
  reachable only from `verify --repair`, and its cost when off is a boolean
  check. The alternative considered — having `upsert` recompute the stored row's
  hash to detect internal inconsistency — would make every ordinary write pay
  for a repair-time property.
- **The repair path still composes the indexer without `cursors`**, so it writes
  its watermark through EPIC-075's fallback while `ferret index` writes through
  `SyncCursorStore`. Traced and **not** a defect: `CURSOR_ARTIFACT_KIND` and
  `INDEX_ARTIFACT_KIND` are both `'index'` and the metadata matches, so the paths
  are equivalent in effect. It is the "two paths to keep in step" EPIC-075 warned
  about, now with a real second caller, and worth tidying when something else
  touches that composition.
- **`staleArtifacts` still has no production caller.** Unchanged by this work,
  and it is the reason EPIC-100 AC-8's invariant covers declared control modules
  rather than every port method: a general port sweep fails on this row today.
