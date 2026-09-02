# EPIC-057 — Freshness & Authority Ranking

**Status: APPROVED | Priority: P1 | Domain: Search & Retrieval**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Search & Retrieval, where it
> has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Rank a retrieval result by whether what it says still holds, not only by how
well its text matches — and say which it was.

## 2. Value — what is missing, in writing

Governance §11 requires retrieval to be "evidence-aware, permission-aware,
**freshness-aware**, and explainable". Three of the four are delivered and
validated. The fourth is not, and five Epics have written down what they left
for this one:

- **EPIC-044/045 §4** — "freshness and staleness ranking — EPIC-057".
- **EPIC-045's validation, Limitations** — "**Freshness is not in the ordering.**
  `preferredEvidence` breaks an authority tie with confidence and then recency,
  and a highly authoritative stale record still beats a fresh weak one. That is
  EPIC-057."
- **EPIC-062 §4** — "Ranking or reranking search results — EPIC-056/057.
  Selection here is *within* one item's evidence, never across items."
- **EPIC-056 §4** — "Nothing here reads `observed_at`, `authority`, or lifecycle
  to move an order."
- **EPIC-006 §D-007** — `first_indexed_at` and `last_indexed_at` are separate
  columns specifically because "it is how staleness is measured (EPIC-057)".

So today a search answers "where is the retry policy" with a file **deleted six
months ago** ranked above the live one, if the deleted one's text matches
slightly better. Nothing in the read path consults `lifecycle` at all. EPIC-032
records the tombstone and retrieval ignores it.

## 3. Scope

- **Standing**: a band per hit derived from the recorded `lifecycle`, ordered by
  what that state says about whether the thing still exists.
- **Search ordering across items**: standing first, then EPIC-056's relevance,
  then authority, then recency — replacing EPIC-056's `kind → sourceId → id`
  tail, which was a determinism device and never a judgement.
- **Explanation**: the standing and, when it moved a hit, the reason, on the
  hit's rank breakdown. Governance §18 asks Ferret to explain why evidence was
  "considered stale"; this is that sentence for a search hit.
- **The supersession rule in `preferredEvidence`**: one source speaking twice is
  not two sources disagreeing. Closes the EPIC-045 limitation quoted above.
- **One definition of "unassessed authority"**, shared rather than duplicated.

## 4. Non-scope

- **Detecting staleness.** EPIC-031/032 set `lifecycle`, EPIC-094 sweeps derived
  artefacts, EPIC-062 reads evidence `state`. This Epic *honours* those verdicts
  and produces none of its own.
- **Assigning authority ranks — EPIC-045**, validated. Consumed here, never set.
- **Selection within one item's evidence — EPIC-062**, validated. That Epic
  established state-before-authority and this Epic does not restate it across a
  different axis; §8.4 reuses its helpers rather than copying its ordering.
- **Computing confidence — EPIC-046.** Read as a tiebreak where it already is.
- **Resolving conflicts — EPIC-047.** A conflict is reported, never decided.
  §8.4's supersession rule is deliberately *not* conflict resolution: it applies
  only where one source system restated the same field.
- **Relevance itself — EPIC-056.** Its score is an input here, unaltered.
- **A decay curve.** No half-life, no time constant, no "recent means within N
  days". §8.2 records why this is a contract and not an omission.
- **Ranking contributors or ownership — EPIC-036 §4** names this Epic for "any
  measure of who owns a file". Not delivered here; the registry entry is about
  freshness and authority, not attribution.

## 5. Inputs

- `entity.lifecycle` — already on every hit.
- `entity.sourceObservedAt` — when the *source* says the object last changed,
  already on `CanonicalEntity`.
- `evidence.authority` for an evidence-sourced hit, carried on the candidate row
  so ranking does not have to read the record it may then discard.
- EPIC-056's combined relevance.

## 6. Outputs

- `src/retrieval/freshness.ts` — `standing`, `describeStanding`, core and pure.
- `RankBreakdown` gains `standing` and `why`.
- `SourceAuthority` gains `UNASSESSED_AUTHORITY` and `effectiveAuthority`, moved
  from EPIC-062's module so there is one definition.
- No schema change; no new table, column or index.

## 7. Dependencies

- **EPIC-056** — the relevance this orders around, and the pipeline it extends.
  One ranking path, not two.
- **EPIC-032** — sets the `lifecycle` this reads.
- **EPIC-045** — the authority scale and `isUnknownAuthority`.
- **EPIC-062** — the precedent for a banded ordering, and the helpers reused.
- **EPIC-098** — the harness that proves this costs no retrieval quality.

## 8. Contracts

### 8.1 Standing is a band, ordered by what the state says

```
active       0    observed to exist at the source
unknown     20    referenced but never observed — unassessed
deleted     40    observed to have been removed
superseded  50    replaced by another entity, which is the answer instead
```

Spaced by tens so a rank can be inserted later without renumbering — the reason
`SourceAuthority` and EPIC-062's `BELIEVABILITY` are spaced that way, and the
same three orderings as that scale for the same reasons:

- **`unknown` sits between**, not last. "Ferret has a reference to it but has not
  observed it directly" is unassessed, not disbelieved. Ranking it below a thing
  known to be deleted would be manufacturing a claim, which Governance §6
  forbids — the identical argument EPIC-045 made for `UNKNOWN` authority and
  EPIC-062 made for an unread state.
- **`superseded` is worst**, below `deleted`: a superseded entity's replacement
  is retrievable, so returning the old one is wrong in a way that returning a
  deleted one — where there is nothing else to return — is not.
- **An unrecognised lifecycle is unassessed**, never an error. Entities come from
  providers, and a ranking that throws on an unexpected value takes the whole
  answer with it.

### 8.2 There is no decay curve, and that is the contract

Freshness enters as an **ordering over recorded facts**, never as a weight on
relevance. No half-life is chosen, because there is no principled one: a
constant would have to be either invented or tuned, and `domain/authority.ts`
already states what happens then — "a continuous score invites tuning, and a
tuned authority number is indistinguishable from a fudge by the time it reaches
an answer." The same sentence is true of a freshness multiplier.

So a file untouched for three years is **not** demoted for its age. Age is not
evidence that something stopped being true, and Ferret does not have a second
opinion about a file the source still reports as present. What *is* evidence is
`lifecycle`, which a source observation set.

Recency does appear — as the **last** ordering key before identity (§8.3), where
it separates hits that are otherwise indistinguishable. That is a tiebreak, and
a tiebreak needs no scale.

### 8.3 The ordering, in full

```
standing asc  →  relevance desc  →  authority desc  →  recency desc
              →  kind asc  →  sourceId asc  →  id asc
```

**Standing outranks relevance**, and it is the only thing that does. A
tombstoned file that matches perfectly is still the wrong answer while a live one
matches at all — that is the defect in §2 and it cannot be fixed by a tiebreak.
Relevance outranks everything below it, because a highly authoritative hit that
barely matches is not what was asked for; authority and recency act where
relevance has already tied, which after EPIC-056's probabilistic or is common —
the golden run has three files at 0.0797.

An exact-identifier hit keeps its fixed relevance of `1.0` and so stays above
every ranked hit *within its standing band*, which is the intended reading of
EPIC-056 §8.6: "the thing that was asked for" is the live thing.

`kind → sourceId → id` remains, unchanged, as the determinism tail. EPIC-056
AC-2 still holds.

### 8.4 One source speaking twice is not two sources disagreeing

`preferredEvidence` sorted by authority, then confidence, then recency. So a
`system-of-record` observation from January outranked the *same system's*
observation of the *same field* in September — the case EPIC-045 recorded as a
limitation.

The rule: where two records share a `sourceSystem` **and** a `field`, the one
with the later `observedAt` supersedes the earlier, before authority is
consulted. Where they do not, authority decides exactly as before.

This is narrow on purpose. It is not conflict resolution (EPIC-047): two systems
disagreeing still tie on authority and still surface as a conflict. It is the
observation that a source restating a fact is that source's current position, and
treating its own older statement as a rival is a modelling error rather than a
policy choice.

`preferredEvidence` also now ranks authority through `effectiveAuthority`, so
`UNKNOWN` is ordered as unassessed rather than as the weakest rank — which
`domain/authority.ts` has documented as the intent since EPIC-045
("deliberately *not* the lowest rank in meaning, even though it is the lowest
number") while this function sorted on the raw number. §17 records it as a defect
found rather than a decision taken.

### 8.5 Ranking still cannot widen a result set

Standing reorders and nothing else. No hit is dropped for its lifecycle: a
deleted file that matches is still returned, below the live ones, because it is
still an answer to "what used to be here" and EPIC-056 §8.2's invariant — that
ranking only ever reorders, folds and truncates what authorization allowed
through — is not weakened by this Epic. EPIC-056 AC-11 covers both.

## 9. Acceptance criteria

- **AC-1** A `deleted` entity ranks below every `active` hit in the same result,
  even when its relevance is strictly higher.
- **AC-2** A `superseded` entity ranks below a `deleted` one.
- **AC-3** An `unknown` lifecycle ranks below `active` and above `deleted`.
- **AC-4** An unrecognised lifecycle value ranks as unassessed and does not
  throw.
- **AC-5** Within one standing band, order is by relevance, and a lower-relevance
  hit never precedes a higher-relevance one.
- **AC-6** Two hits equal in standing and relevance are ordered by authority,
  with `UNKNOWN` treated as unassessed rather than weakest.
- **AC-7** Two hits equal in standing, relevance and authority are ordered by
  recency, newest first; a missing `sourceObservedAt` does not precede a present
  one.
- **AC-8** The order is total and deterministic: the same pool ranks identically
  however it arrives, ties included. EPIC-056 AC-2 continues to hold.
- **AC-9** A deleted hit is **returned**, not filtered — the result set is the
  same set, reordered.
- **AC-10** Each hit's breakdown names its standing, and a hit whose standing
  moved it says so in `why`.
- **AC-11** `preferredEvidence` prefers the later of two records from the same
  `sourceSystem` and `field` regardless of authority.
- **AC-12** `preferredEvidence` still prefers the more authoritative of two
  records from *different* source systems, and still returns `undefined` when
  two are genuinely indistinguishable and disagree.
- **AC-13** `preferredEvidence` orders `UNKNOWN` authority as unassessed, above
  `ASSERTED` and below `DERIVED`.
- **AC-14** EPIC-062's selection behaviour is unchanged: its own validated tests
  pass with the shared helper.
- **AC-15** Retrieval quality does not regress. The golden harness reports mean
  p@10 ≥ 0.3611, MRR ≥ 0.6806, nDCG ≥ 0.7313, recall ≥ 0.9167, `falsePositives`
  0 — EPIC-056's figures, since a live corpus has no tombstones to reorder.

## 10. Test requirements

**Unit** — every band and every ordering key against hand-built pools; the
unrecognised lifecycle; the deleted-outranks-nothing case (AC-9); totality by
ranking a reversed pool; the supersession rule and its three negatives (different
system, different field, missing `observedAt`); `effectiveAuthority` at each rank.

**Integration (real PostgreSQL)** — a tombstoned entity indexed, then searched:
returned, ranked below the live one, with `why` naming the reason. AC-15 through
EPIC-098's harness.

**Security** — the deleted hit must be subject to the same scope filter as any
other; standing is applied after authorization, which
`tests/security/retrieval-scope.test.ts` already asserts structurally for the
whole ranker.

**Failure** — a hit with no lifecycle, an unparseable `sourceObservedAt`, and an
authority outside the scale, none of which may throw.

**Regression** — EPIC-062's suite and EPIC-045's, unchanged, against the shared
helper.

## 11. Security requirements

Nothing here reads a row ranking was not handed, and nothing here returns a row
authorization excluded — EPIC-056 §11 and its structural test cover the whole
ranker, this Epic included. One new consideration: `why` is a *generated*
sentence naming a lifecycle and an authority rank, never source text, so it
cannot carry content across a permission boundary the way a highlight could.

## 12. Observability

`standing` and `why` on the rank breakdown, travelling with the answer. No new
log line and no new metric, for the reason EPIC-056 §12 gives: Governance §18
prefers an explanation the caller receives to a number in a log nobody
correlates.

## 13. Performance constraints

Standing is a map lookup per candidate over a pool EPIC-056 §8.7 already bounds,
and adds no query, no join and no column. `preferredEvidence` gains one grouping
pass over a list that is already sorted, so it stays `O(n log n)`.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 satisfied with evidence recorded in
`validation/EPIC-057-VALIDATION.md`; unit, integration, security, failure and
regression tests present and passing; `npm run verify` green; the registry entry
updated; EPIC-045's recorded limitation struck with a dated note rather than
edited away.

## 15. Governance alignment

- **§11 Retrieval** — "freshness-aware" is the word this Epic exists for, and
  the last of the four adjectives to be delivered.
- **§18 Provenance and Explainability** — "explain why evidence was … considered
  stale". §8.1 and `why` are that explanation.
- **§6 Evidence Before Inference** — §8.2 declines to infer that age means
  wrongness, and §8.1 declines to rank the unassessed as the disbelieved.
- **§5 Reuse Before Reinvent** — EPIC-062's `effectiveAuthority` is moved and
  shared, not copied; EPIC-056's pipeline is extended, not duplicated.
- **§2 Simplicity** — one comparator, one band table, no constants to tune.

## 16. Raised, not absorbed

- **A tombstone is not in the golden corpus.** AC-15 is therefore a
  no-regression check rather than a measurement of this Epic's effect, and the
  behavioural claims are proved by integration and unit tests. Adding a deleted
  file to EPIC-096's labelled corpus would measure freshness ranking properly and
  is that Epic's decision, not this one's.
- **`last_indexed_at` is not on `CanonicalEntity`.** EPIC-006 §D-007 separated it
  from `first_indexed_at` "because it is how staleness is measured (EPIC-057)",
  and it is genuinely the better freshness signal than `sourceObservedAt` for a
  source Ferret has stopped being able to reach. Exposing it is a change to
  EPIC-006's canonical envelope, so it is raised rather than taken; §8.2's
  ordering does not need it.
- **Per-field ownership is still not expressible.** EPIC-045 recorded that
  `systemOfRecord` is per provider, not per field, so §8.4's rule keys on
  `sourceSystem` and `field` together to stay inside what the model can say.

## 17. Recorded during implementation

- **`preferredEvidence` contradicted its own documentation.** It sorted on the
  raw authority number, so `UNKNOWN` ranked below `ASSERTED` — the opposite of
  what `SourceAuthority.UNKNOWN` had stated since EPIC-045. EPIC-062 had built
  `effectiveAuthority` for its own ordering and the two never met. §8.4 records
  the fix; `validation/EPIC-057-VALIDATION.md` records the finding.
- **`preferredEvidence` moved to `domain/authority.ts`.** Beside the scale it
  decides with, and forced as well as tidy: `authority.ts` imports
  `EvidenceMethod` from `evidence.ts`, so sharing the helper the other way would
  have been a module cycle that fails at load rather than at review. Same export
  name, no caller changed.
