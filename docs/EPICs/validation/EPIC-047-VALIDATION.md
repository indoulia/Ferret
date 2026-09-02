# EPIC-047 — Conflict Detection · Validation Evidence

**Assessed against:** working tree on top of `fb81752`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17 for the store; Ferret's own 597-file index
for the before-and-after measurement.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-047 — Conflict Detection — P1" — and from the eight
> Epics that deferred to it.

## The measurement

Taken on Ferret's own index **before** writing the specification, which is what
turned a plausible Epic into a precise one:

| | conflict groups | single-source | cross-source | records involved |
| --- | --- | --- | --- | --- |
| before | 2 | 2 | 0 | 22 |
| **after** | **0** | — | 0 | — |

Both groups were `branch.attributes.headCommit`, and the second had **twenty
current records for one branch**. A branch's head moves with every commit; each
observation was a new row and **nothing had ever called
`EvidenceStore.supersede`**, so `ferret_why` on `main` reported a twenty-way
conflict about where `main` points. It was not a conflict at all.

The after figure is taken through the product's own code path — `conflictsFor`
over every subject with differing current statements — rather than from SQL:

```
subjects with differing statements: 2
conflict groups conflictsFor reports: 0
```

State distribution after a re-index: **1620 current, 20 superseded**. The twenty
is the branch-head history collapsing, which is the defect resolving itself in
the one place it was measurable.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 two sources disagreeing is one group | **MET** | `tests/unit/evidence.test.ts` "still reports two different sources disagreeing", and "reports a group where two sources agree and a third differs" — the group carries all three, because which side is wrong is what detection must not decide |
| AC-1a supersession covers a conflicting record | **MET** | integration "marks every member of a genuine group conflicting, and clears it" — the clearing half only passes because supersession includes `conflicting`; it failed before that fix |
| AC-2 one source restating is not a group | **MET** | "does not report one source restating a field", and "does not report twenty restatements from one source" |
| AC-3 prior record superseded | **MET** | integration "supersedes the prior reading when the same source restates a field", asserting `superseded_by` points at the new record |
| AC-4 superseded record unchanged and verifiable | **MET** | "leaves the superseded record verifiable and unchanged" — `verify()` passes and the integrity hash is identical |
| AC-5 identical statement supersedes nothing | **MET** | "supersedes nothing when the statement is identical" |
| AC-6 never superseded by itself | **MET** | same test — the deduplicated record is still `current` |
| AC-7 cross-source supersedes nothing | **MET** | "supersedes nothing across source systems" |
| AC-8 twenty moves leave one current | **MET** | "leaves one current record after a branch head moves twenty times" — 1 current, 19 superseded, and the survivor is the last recorded |
| AC-9 every member marked | **MET** | "marks every member of a genuine group conflicting, and clears it" |
| AC-10 cleared when the group ends | **MET** | same test — the source comes to agree and both records return to `current` |
| AC-11 superseded and stale untouched | **MET** | "never changes a superseded or stale record" |
| AC-12 nothing deleted | **MET** | the clearing test asserts the disagreeing record is `superseded`, not gone, and still readable by `get` |
| AC-13 an index run maintains the state | **MET** | `RepositoryIndexer` reconciles the subjects it recorded new evidence about and reports `conflicts: { subjects, groups }`; `undefined` when the writer cannot reconcile, which is not the same as finding nothing |
| AC-14 zero on Ferret's own index | **MET** | measured above, through `conflictsFor` |
| AC-15 EPIC-062's branch reachable | **MET** | its AC-9 test now constructs a genuine two-source dispute and passes; the state the branch reads is now written by something |

Sixteen of sixteen MET.

## Found while implementing — a defect in this Epic's own first cut

**`conflicting` is a sub-state of `current`, not a sibling.** The first
implementation superseded only records in state `current`. A test caught what
that means: a source that came to agree left its *own* disagreeing record marked
`conflicting` for ever, because supersession skipped it — and reconciliation
could then never clear the group, since detection still saw the stale
disagreement. Anything acting on "the source's present position" has to include
`conflicting`, and the predicate now does, with the reason recorded at the line.

That is the same class of error EPIC-094 recorded and §8.3 was written to avoid:
a state that can be set and not cleared accumulates until an operator stops
reading it. It very nearly shipped inside the Epic whose whole point is clearing.

## Three test fixtures were corrected, and no acceptance criterion was changed

EPIC-060's AC-7 and AC-13 and EPIC-062's AC-9 fixtures built a "disputed fact"
from two records sharing one source system. Under §8.1 that is a restatement, so
the fixtures stopped producing a dispute and three tests failed.

**The criteria are unchanged and were not reinterpreted.** Both say a disputed
fact must be reported; neither says what makes a fact disputed, and EPIC-047 is
the Epic the registry gives that question to — both documents name it explicitly
in their own non-scope. The fixtures now use two source systems, which is what
they meant, and both Epics assert exactly what they asserted before.

## Tests

- **Unit** — `tests/unit/evidence.test.ts`, 5 tests added: the single-source
  restatement, the twenty-fold restatement, the genuine two-source case, the
  three-source group where two agree, and a subject-level disagreement with no
  field. The five pre-existing conflict tests passed **unchanged**, because they
  had always used two different source systems — which is a fair sign the
  distinction §8.1 draws is the natural one.
- **Integration (real PostgreSQL)** —
  `tests/integration/domain/evidence-store.test.ts`, 8 tests on a database of
  their own, so twenty rows of branch-head history do not leak into a count
  written before this Epic existed.
- **Regression** — `npm run verify` green: 129 files, 2699 passed, 3 skipped.

## Limitations, recorded

- **Supersession applies going forward and does not backfill.** Two records
  written before this change still share a subject and field on Ferret's own
  index — both head-commit readings for one branch, recorded the day before —
  and will stay `current` until that source restates that field. `conflictsFor`
  reports nothing for them because §8.1 excludes single-source groups, so the
  residue is invisible to a caller; it is recorded here because the raw table
  still shows it. Same shape as EPIC-045's "already-indexed evidence keeps
  authority 0. Nothing back-fills; re-indexing fixes it, there is no migration."
- **Ferret has one source provider, so a genuine conflict cannot occur yet.**
  AC-1 and AC-9 are proved by construction; AC-14's figure is a **reduction of
  false positives**, not a demonstration of true ones. The first real
  cross-source conflict arrives with EPIC-021 or EPIC-071, into a mechanism that
  already works and is already tested.
- **Cross-session decision conflicts are not delivered.** EPIC-042 §4 names this
  Epic for them; they concern engineering memory rather than evidence and need
  session comparison nothing builds. The registry does not determine an owner.
- **A superseded record's dependents are not revisited.** Evidence derived from a
  record that has since been superseded keeps its own confidence and state.
  EPIC-046's propagation runs at emission and does not re-run; re-deriving a
  chain is a capability no Epic owns.
- **Git supplies no `observed_at` for a branch listing**, which is why §8.2
  orders by recording. If a provider later supplies observation times the two
  orderings could disagree, and preferring the observed one would be a change to
  this contract rather than a quiet improvement.
