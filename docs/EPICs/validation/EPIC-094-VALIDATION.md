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
