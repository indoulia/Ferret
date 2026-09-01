# EPIC-062 — Evidence Selection · Validation Evidence

**Assessed against:** working tree on top of `5e5fe5c`
**Date:** 2026-09-01
**Specification:** [`../EPIC-062-Evidence-Selection.md`](../EPIC-062-Evidence-Selection.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

The specification was written as the first part of this change, from the registry
entry and Governance §18, §6, §7, §12 and §15 — the practice recorded in the
registry's *Specification files* section. Every criterion names the record it was
derived from, so a reviewer can check the derivation rather than take it on trust.

Ordering rules are demonstrated by unit tests, deliberately: `selectEvidence` is
pure, and Governance §18 asks Ferret to *explain* its choice — an explanation
that cannot be reproduced from its inputs alone is not one. Composition and the
store projection are demonstrated against a real PostgreSQL. The pack path is
additionally demonstrated over **real stdio against a real index**, because a
component that exists and is never wired reports success while doing nothing.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** Higher authority cited ahead of more recent lower authority | **MET** | `evidence-selection.test.ts` — *"prefers the authoritative record over the recent one"*: a rank-20 `ASSERTED` record from 2026-09-01 orders behind a rank-100 `SYSTEM_OF_RECORD` record from 2026-01-01. Also through the pack: *"cites the authoritative current record rather than the newest one"*. |
| **AC-2** Non-`current` never cited ahead of `current` for the same subject | **MET** | `evidence-selection.test.ts` — *"prefers a believed record over a more authoritative replaced one"*: a superseded `SYSTEM_OF_RECORD` record orders behind a current `PARSED` one. Demonstrated over a real store in `evidence-store.test.ts` — *"cites the current record and accounts for the replaced one"*, where the replaced record is the authoritative one. |
| **AC-3** A cited record names its authority and its state | **MET** | `evidence-selection.test.ts` — *"names the authority and the state of every cited record"* asserts `parsed authority`, `state stale`, `confidence 0.50`. Confirmed in production: `[observed by ferret.source.git, observed authority, state current]`. |
| **AC-4** Exclusion causes distinguish bound, field-covered and not-current | **MET** | `evidence-selection.test.ts` — *"distinguishes the three reasons a record is not cited"* asserts all three causes present in one selection, and that the `not-current` reason names the actual state (`state superseded`) and the fact a current record covers. Over a real store in `evidence-store.test.ts`. |
| **AC-5** Included and excluded partition the candidates | **MET** | `evidence-selection.test.ts` — *"partitions the candidates"*: 13 candidates chosen so all three exclusion paths and the reserve top-up are exercised; the union of ids is asserted set-equal to the input and free of duplicates. |
| **AC-6** Ordering is total | **MET** | `evidence-selection.test.ts` — *"selects identically however the candidates arrive"*: two records identical in every ranked field select in the same order forward and reversed, resolved by record id. |
| **AC-7** One field cannot consume the whole bound | **MET** | `evidence-selection.test.ts` — *"does not let one fact consume the whole bound"*: 9 records on `message` plus one each on `author` and `paths`; both of the latter are cited. A companion test asserts the complementary rule — with only one fact on record, all five slots go to it rather than being wasted by the cap. |
| **AC-8** A truncated candidate window is stated | **MET** | `evidence-selection.test.ts` — *"reports a truncated candidate window"*. The pack asks for `EVIDENCE_CANDIDATE_WINDOW + 1` so "exactly the window" and "more than the window" are distinguishable; `context-pack.test.ts` — *"asks for more candidates than it will cite"* asserts the requested limit. |
| **AC-9** A disputed fact is reported and nothing excluded for being in one | **MET** | `evidence-selection.test.ts` — *"reports a disputed fact and excludes nothing for being in one"*: both sides cited, `disputedFields: ['author']`, `excluded: []`. A companion test covers a record the store itself marked `conflicting`. Over a real store in `evidence-store.test.ts` — *"reports a fact the store marked conflicting"*. |
| **AC-10** Pack `omitted` names the causes, not only a count | **MET** | `context-pack.test.ts` — *"names the cause of every omission at pack level"* asserts a `TruncationReason.SELECTION` entry whose detail says Ferret "no longer believes them". Confirmed in production, where the trimmed item's lost evidence is reported as `token-budget` rather than as a ranking decision. |
| **AC-11** Unassessed authority is not ordered below a known-weak one | **MET** | `evidence-selection.test.ts` — *"does not rank an unassessed authority below a known-weak one"*: `UNKNOWN` orders between `DERIVED` and `ASSERTED`, and the reason says `unassessed authority`. The same reasoning is tested for an unread state. |
| **AC-12** Selection performs no I/O and consults no clock | **MET** | `selectEvidence` is a module-level function whose only imports are `EvidenceState`, `SourceAuthority`, `isUnknownAuthority`, `detectConflicts` and the `CanonicalEvidence`/`StatedEvidence` types. `evidence-selection.test.ts` runs the whole suite with no store, no fake and no fake timers — there is nothing to stub because there is nothing to reach. |
| **AC-13** No evidence yields an empty selection, not an error | **MET** | `evidence-selection.test.ts` — *"holds no evidence and says so, rather than failing"*: `selected`, `excluded` and `disputedFields` all empty, `windowTruncated` false. |
| **AC-14** The rendered pack states what each item rests on and what it left out | **MET** | `context-pack.test.ts` — *"states per item what it rests on and what it left out"* asserts `system-of-record authority`, `state current`, `not cited:` and the exclusion sentence in `renderPack` output. |

**Summary: 14 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite: **84 files, 1980
passed, 3 skipped**, including the database suites against a real PostgreSQL
(`pgvector/pgvector:pg17`). New: `tests/unit/evidence-selection.test.ts` (23
tests), 5 tests added to `tests/unit/context-pack.test.ts`, 3 to
`tests/integration/domain/evidence-store.test.ts`.

`ferret_context_pack` reached over **real stdio** against a real index of
Ferret's own repository — `entities 1029 new`, `evidence 568 recorded`:

```
ITEMS: 3 | BUDGET: 3620 of 4000

- branch dfcc1ef9-5f2c-8374-8aba-f65211fb30cc
  why: matched branch attributes
  cited: attributes.headCommit [observed by ferret.source.git, observed authority, state current]
  windowTruncated: false

- commit 87fade08-2e76-8535-baf6-4d9be01861e5
  why: matched commit attributes (trimmed to fit)
  not cited: token-budget — cited by the selection, then dropped when this result was shortened to fit

OMITTED:
  token-budget x1: 1 observation(s) not cited — the result carrying them was shortened to fit the token budget
  content-trimmed x1: 1 result(s) had their longest values shortened to fit
  token-budget x1: 1 result(s) did not fit in 4000 estimated tokens
```

Two things this demonstrates that no test could. The selection is reached by the
**actual CLI composition** — `createMcpServer` builds the pack builder, and a
selection nothing calls explains nothing. And `observed authority, state current`
is EPIC-045's stored rank and EPIC-008's stored state arriving together at an
answer through the whole stack, which is the gap the Epic was written to close:
before this, `preferredEvidence` had no caller outside `src/domain/` and
`CanonicalEvidence` carried no state at all.

The trimmed item is the honesty case worth reading twice. Its evidence is
reported as lost to `token-budget`, not as ranked out. The selection chose that
record; the budget took it afterwards. Collapsing the two would attribute to
Ferret a ranking decision it never made.

## 4. Where the evidence is weaker than the criterion

**Production cannot exercise the bound, the field cap, or a non-`current`
exclusion.** Measured on the index above, Ferret's own repository yields at most
**2 evidence rows per subject and 568 rows all in state `current`**:

```
subject_id                             count  distinct fields
162fed2e-7d79-83d2-8384-571f0d142eab       2                2
01f35352-9405-81cd-9173-0a481bf67e99       1                1

state    count
current    568
```

So AC-2, AC-4 and AC-7 are demonstrated against a real store in
`evidence-store.test.ts` — where superseding is done by `EvidenceStore.supersede`
rather than constructed — and against constructed candidates in the unit suite,
but **not** against evidence a live index happened to produce. That is a property
of what Ferret indexes today, not of the selection: the states exist and are
written by EPIC-031/032 when re-indexing observes a change, and a single full
index of a repository has nothing to supersede yet. Recorded here so the
distinction is on the record rather than inferred.

**Permission scopes are threaded, not enforced.** `forSubjectWithState` accepts
`permittedScopes` and the store filters on it, exactly as `forSubject` does, and
the pack path supplies none. EPIC-058 owns that decision and §4 of the
specification excludes it. This Epic neither widens nor narrows what was already
reachable.

**Conflict is detected within the candidate window.** `disputedFieldsOf` reuses
EPIC-008's `detectConflicts` over the records fetched rather than issuing a
second query, so a disagreement whose other side falls outside the window is not
reported. `windowTruncated` is what tells a reader that is possible. The
alternative — a `conflictsFor` round trip per item — was rejected against §13's
one-query-per-item constraint.

## 5. Changes outside the Epic

Two, both required by it and neither changing another Epic's acceptance criteria:

- `src/domain/evidence.ts` gains the `StatedEvidence` pair. It lives in the
  domain rather than in the store or the consumer because both need it and
  neither owns it, and putting it in `src/context/` would have made
  `src/storage/` import from the core.
- `src/storage/evidence.ts` gains `forSubjectWithState`, a read projection over
  columns the existing `select()` already fetched and discarded. `forSubject` is
  unchanged in behaviour; its query body moved to a private helper both methods
  share. EPIC-044's tests pass unchanged.

## 6. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 14 MET |
| Unit tests | Yes — 23 new, all criteria covered |
| Integration tests | Yes — real PostgreSQL |
| Failure and boundary cases | Yes — unrecognised state, off-scale authority, missing `observedAt`/`confidence`, no field, zero bound |
| Security implications | Yes — metadata-only ordering; a hostile statement is ordered by its metadata alone, asserted in test |
| Observability | Yes — the account travels with the pack; `renderPack` states it |
| Documentation | Specification and this document |
| Governance | §18, §6, §7, §12, §15, §5 |
| Dependencies validated | EPIC-008, 044, 045, 048, 059, 061 |
| Known blockers | None |
