# EPIC-046 — Confidence & Completeness · Validation Evidence

**Assessed against:** working tree on top of `2ebd206`
**Date:** 2026-09-02
**Environment:** unit coverage over the domain functions and the emission seam;
no database required, because nothing here reads or writes one.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-046 — Confidence & Completeness — P1" — and from the
> ten records across nine Epics that named it.

## What was actually broken

The same shape EPIC-045 found, twice over. `confidence` is the **tiebreak under
authority** in both orderings — `preferredEvidence` and EPIC-062's `compare` —
and nothing ever set it, so both fell straight through to recency. `completeness`
defaulted to `unknown` on every record ever written, while the signals that would
set it were computed and discarded: `OMITTED_REASONS` from a content read, and
the `complete` flag on the enumerations EPIC-032 AC-7's safety property rests on.

## The decision the Epic turns on

**Confidence is not derived from `method`, and the obvious implementation was the
wrong one.** A table keyed on `EvidenceMethod` mirroring `AUTHORITY_BY_METHOD` is
what this Epic looked like from the outside. It would have restated authority on
a second scale — and `domain/authority.ts` already records what such a number
becomes: "a continuous score invites tuning, and a tuned authority number is
indistinguishable from a fudge by the time it reaches an answer." Two orderings
consulting authority *and then* a decimal restatement of authority have one
signal and two chances to look rigorous about it.

So confidence comes from the **specific rule**. The distinction is already
load-bearing in this codebase: `SAME_ADDRESS` (0.95) and
`SAME_NAME_AND_LOCAL_PART` (0.5) are both `inferred`, and one number for
`inferred` would throw away the only thing EPIC-009 measured. AC-2 asserts the
negative claim rather than trusting it.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 bands equal the values already chosen | **MET** | `tests/unit/confidence.test.ts` asserts each band against the table that chose it, **and** asserts both tables whole against their literals — so a band that drifted would fail twice |
| AC-2 no confidence derived from method | **MET** | "exposes no mapping from a method to a confidence" — every `EvidenceMethod` value checked absent from the scale, plus the two `inferred` rules asserted still distinct |
| AC-3 no rule means unassessed | **MET** | "leaves confidence unassessed when no rule determined one" |
| AC-4 minimum of the chain | **MET** | "takes the minimum of the chain" |
| AC-5 any unassessed input makes it unassessed | **MET** | "is unassessed when any input is unassessed", and again through the emitter |
| AC-6 empty chain is unassessed | **MET** | "is unassessed for an empty chain" — not certain |
| AC-7 propagated at emission | **MET** | "gives a conclusion the confidence of its chain" over a real `BatchEmitter` |
| AC-8 producer's own value kept | **MET** | "keeps a confidence the producer supplied" |
| AC-9 unknown chain id does not throw | **MET** | "leaves a conclusion unassessed when the chain cannot be followed" |
| AC-10 signals map to partial/complete | **MET** | each of the four omission reasons, both enumeration states, and a clean read |
| AC-11 only absence maps to unknown | **MET** | "leaves an absent signal unknown, never partial" |
| AC-12 unassessed distinguished from zero | **MET** | "distinguishes undefined from zero" |
| AC-13 zero survives a round trip | **MET** | "round-trips a zero confidence without losing it" |
| AC-14 the tiebreak now discriminates | **MET** | "discriminates on confidence where authority ties", plus "still prefers authority over confidence" so the fix did not promote it above EPIC-045's decision |
| AC-15 EPIC-009's and EPIC-042's tests unchanged | **MET** | `git-identity.test.ts` (40) and the session suites pass with the tables pointing at named bands |

Fifteen of fifteen MET.

## Tests

- **Unit** — `tests/unit/confidence.test.ts`, 26 tests, including one that
  rebuilds a propagated record with `createEvidence` and asserts the id and
  integrity hash match. That is the mistake this seam could not be allowed to
  make: a record's id is derived from its fields, so setting confidence *after*
  `createEvidence` would produce a record whose id no longer matched its content.
  Propagation therefore happens on the input, before construction.
- **Regression** — `npm run verify` green: 129 files, 2686 passed, 3 skipped.

## What actually changed in the product

- `src/domain/confidence.ts` — five named bands, `derivedConfidence`,
  `completenessOf`, `isUnassessedConfidence`.
- `RULE_CONFIDENCE` and `ORIGIN_CONFIDENCE` now reference the named bands. **No
  value changed**; both tables are asserted whole against their literals.
- `BatchEmitter#inherit` — propagation through `derivedFrom`, on the input.
- **One real call site.** `GitSourceProvider` now emits `RULE_CONFIDENCE[MAILMAP]`
  on the evidence it records when `.mailmap` rewrote an address. That is the
  first confidence Ferret writes, and it comes from a rule rather than a method,
  which is §8.1 in one line of production code rather than only in a library.

## Limitations, recorded

- **Most evidence stays unassessed, and that is the correct outcome.** Git
  observation has no rule and needs none: what a commit contains is not a
  probabilistic claim. The Epics that will populate this field are the inferring
  ones — EPIC-035, EPIC-047, EPIC-051 — and all three are unbuilt.
- **Nothing calibrates the bands against outcomes.** EPIC-097 measures parse
  quality per language and EPIC-098 measures retrieval; neither feeds back into a
  per-record confidence, and a loop that did would need an owner. The bands are a
  considered starting set — the same thing EPIC-045's validation said of the
  authority ranks.
- **`completeness` has the functions and not yet a producer.** `completenessOf`
  is exported and tested against every signal the codebase records, and no
  shipping emitter calls it: the signals live in the content store and the
  indexer, and threading one into an evidence emission is a change to those
  call sites rather than to this seam. Recorded as the honest state — the field
  can now be set correctly, and today it is still `unknown` on most records.
- **EPIC-009's alias confidence is still unset.** `createIdentityAlias` takes it
  from its caller and no shipping producer creates an alias; `propose.ts` computes
  proposals with confidence and nothing turns a proposal into a stored alias. That
  is EPIC-051's shape of work, not this Epic's.
- **EPIC-007's inferred-relationship gap is closed only in part.** The *evidence*
  for an inferred relationship can now carry a rule's confidence; the
  relationship row has no confidence column, and adding one is a schema change
  §4 declines. A consumer reads the evidence.
