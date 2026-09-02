# EPIC-087 — Architecture Decisions

Decisions taken while closing the P0 validation gaps against deduplicated
content storage, with the reasoning that produced them. Recorded per Governance
§22 so a later reader can tell a considered choice from an accident.

---

## D1 — Issue #98 belongs to EPIC-056, and EPIC-087 AC-11 is therefore blocked on P1

**Context.** EPIC-087 AC-11 asks for `text-authentication` recall above zero
**and** mean precision@10 strictly above the recorded 0.32 baseline, with labels
unchanged. The first half is met at recall 1.00. The second is not, and the
number has not moved:

```
[EPIC-098] measured=6 meanPrecisionAtK=0.2639 meanRecall=0.9167
           meanReciprocalRank=0.5972 meanNdcg=0.6698 falsePositives=0
[EPIC-098] text-refund  "refund"  reached: code_symbol, file, commit, file_version
[EPIC-098] text-invoice "invoice" reached: file, code_symbol, code_symbol, commit, commit, file_version
```

Re-measured 2026-09-02 on `5293434` against real PostgreSQL, unchanged from the
figure EPIC-087 recorded. The cause is
[issue #98](https://github.com/indoulia/Ferret/issues/98): `code_symbol`
entities enter general full-text search and outrank the files that declare them.
That issue left its owner open between **EPIC-034** and **EPIC-056**.

**Decision.** Issue #98 is owned by **EPIC-056 — Ranking & Reranking**, which is
**P1**. EPIC-087 AC-11 stays **NOT MET** and is not restated.

**Why.** The existing Epic boundaries already answer this, in writing, and
neither candidate had to be interpreted:

- **EPIC-034 §4 (Non-scope)** — "ranking. This Epic returns matches in a defined
  order; **EPIC-056 ranks**."
- **EPIC-052/053 §4 (Non-scope)** — "Ranking that is comparable across queries —
  **EPIC-056**."

Both P0 Epics that could plausibly hold the defect disclaim it and name the same
successor. Nothing was decided here that the specifications had not already
decided.

The measurement agrees with the boundary. Between issue #98's configurations A
(content indexing off) and B (on, no bodies stored), **recall is identical at
0.7500** while mean RR falls from 0.5556 to 0.3111. Nothing new is found and
nothing is lost; what changes is the order. A defect that moves ordering and
leaves recall untouched is a ranking defect by definition.

**Explicitly not done.** The other shape issue #98 floated — excluding
`code_symbol` from the untyped text branch, reached instead through
`findSymbols` or a kind filter — was rejected on two grounds. It would narrow
what EPIC-053 was validated as delivering ("full-text search over entity
attributes and evidence statements, ranked"), which is a governance change to a
VALIDATED P0 Epic rather than a defect fix. And it is the wrong fix on the
issue's own evidence: a symbol hit for `refund` is a legitimate result, so
removing a true positive to correct an ordering problem trades precision for
recall in the direction nobody asked for.

**What this leaves open, and for whom.** AC-11 is a P0 Epic's criterion whose
remedy is P1 work. That is a governance position, not a technical one, and this
record does not take it. The options are:

1. EPIC-087 remains `IMPLEMENTED` until EPIC-056 lands — accurate, and leaves a
   P0 Epic un-validated for as long as a P1 Epic is unscheduled.
2. EPIC-056 is promoted to P0, because a P0 acceptance criterion depends on it.
3. Governance restates AC-11 — for instance as the B→C comparison it was written
   to express, or against nDCG.

EPIC-087's own record already put those three on the table and declined to
choose: "All three are defensible; choosing one to make this Epic pass is not."
That still holds. What is new is that the *owner* is settled, so option 2 is now
a concrete decision about one named Epic rather than an open question.

---

## D2 — The `unassessable` bucket is not a place to put a control that could answer

**Context.** EPIC-094 AC-7 required a derived artefact of *any* kind to be
judged for staleness, and `content-index` artefacts were counted `unassessable`
because judging one needs a composed parser the read-only sweep does not have.

**Decision.** The sweep takes a `ProducerIdentityResolver` from its caller.
`unassessable` remains, and now means "nothing was composed that could answer"
rather than "this kind cannot be answered".

**Why.** `boundaries.test.ts` asserts `src/storage/`'s external package set
exactly, so importing `ParserFramework` into the sweep would drag
`web-tree-sitter` into the storage graph and fail that check. The caller already
holds a parser — `ferret verify --content` composes one — so the sweep asks a
question instead of growing a dependency.

The direction of the failure is the part worth recording. A resolver that
returns `undefined` leaves the row `unassessable`, never stale. Reporting an
artefact stale because nothing could judge it is what produced "584 of 585
indexed scopes were built by a different Ferret" on a completely healthy index,
and an operator who has seen that once stops reading the output.

---

## Addendum to D1 — 2026-09-02, after EPIC-056

D1's assignment held and its open question closed without any of the three
options being exercised. EPIC-056 — Ranking & Reranking was specified and
implemented **at P1**, and EPIC-087 AC-11 was met as written: mean p@10 0.3611
against the 0.32 baseline, `text-authentication` recall 1.00, labels unchanged,
`falsePositives` 0.

The two claims D1 made are worth marking as confirmed, because both were
inferences from written non-scope rather than measurements:

- **The owner.** The fix that moved the number is entirely a ranking change — a
  symbol and a file version credited to the file that contains them — and it
  needed no change to EPIC-034's symbol index or to EPIC-052/053's query
  branches. The boundary both Epics had written down was the right one.
- **The diagnosis.** "A defect that moves ordering and leaves recall untouched is
  a ranking defect by definition." Recall is **identical** at 0.9167 either side
  of the fix, exactly as it was identical either side of the regression.

D1's "explicitly not done" also survives: symbols were not excluded from the
untyped text branch. `kinds: ['code_symbol']` still returns symbol rows, and a
symbol whose file is not in the candidate pool is still returned on its own
relevance — EPIC-056 §8.4 records that as a contract rather than a coincidence.

Evidence: `docs/EPICs/validation/EPIC-056-VALIDATION.md`.
