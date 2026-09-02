# EPIC-056 — Ranking & Reranking

**Status: APPROVED | Priority: P1 | Domain: Search & Retrieval**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Search & Retrieval, where it
> has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Order retrieval results by a relevance score that means the same thing in every
query, and rerank a candidate pool larger than the answer so the order is a
choice rather than whatever the first page happened to contain.

## 2. Value — the problem, measured

Three P0 Epics disclaim ranking and name this one:

- **EPIC-034 §4** — "ranking. This Epic returns matches in a defined order;
  EPIC-056 ranks."
- **EPIC-052/053 §4** — "Ranking that is comparable across queries — EPIC-056."
- **`src/retrieval/query.ts`** on `SearchHit.score` — "Comparable within one
  result set and nowhere else … EPIC-056 owns ranking that can be compared."

The gap is measured. [Issue #98](https://github.com/indoulia/Ferret/issues/98)
recorded that turning on content indexing left recall identical at 0.7500 while
mean reciprocal rank fell from 0.5556 to 0.3111: nothing new was found, nothing
was lost, and the order got worse. `docs/Architecture/EPIC-087-DECISIONS.md` §D1
assigned that defect here on both candidates' written non-scope, and re-measured
it unchanged on `5293434`:

```
[EPIC-098] measured=6 meanPrecisionAtK=0.2639 meanRecall=0.9167
           meanReciprocalRank=0.5972 meanNdcg=0.6698 falsePositives=0
[EPIC-098] text-refund  "refund"  reached: code_symbol, file, commit, file_version
[EPIC-098] text-invoice "invoice" reached: file, code_symbol, code_symbol, commit, commit, file_version
```

Read the second line as a person would. `refund` returned four things, and three
of them are the same thing: the file `src/billing/refund.ts`, one symbol declared
inside it, and one version of it. A ranking that treats those as three competing
answers spends three of ten slots saying one thing, and puts the part above the
whole.

## 3. Scope

- A **comparable relevance** in `[0, 1)` on every ranked hit, normalised at the
  source rather than by post-hoc rescaling of one result set.
- **Candidate overfetch**: the ranked path retrieves a pool larger than the
  caller's limit, so reranking has something to reorder.
- **Rerank by subsumption**: a hit on a *constituent* of an entity — a symbol a
  file declares, a version of a file — is credited to that entity when both are
  in the pool, and is not returned as a competing row.
- **Combination of independent matches**: an entity matched by its name, by its
  body, and by a symbol it declares scores above one matched a single way, by a
  formula with no tuned constant.
- **A rank breakdown** on each hit: the components that produced the score and
  what was folded into it.
- Determinism: the same pool and the same query produce the same order.

## 4. Non-scope

- **Freshness and authority ranking — EPIC-057.** Nothing here reads
  `observed_at`, `authority`, or lifecycle to move an order. A ranking that
  preferred recent things would be that Epic's scope arriving early and
  untested.
- **Evidence confidence and completeness — EPIC-046.** Same reason.
- **Which strategies run — EPIC-055.** The planner decides that and fuses
  strategy lists by rank (`fuse`, RRF). This Epic ranks *within* the text
  strategy, which is what the harness measures and what issue #98 is about.
- **Semantic similarity — EPIC-054.** No embedding is consulted.
- **Query explanation as a product surface — EPIC-063.** The breakdown here is a
  field on a hit, not an explanation feature.
- **Excluding any kind from retrieval.** See §8.4; EPIC-087 §D1 rejected that
  shape and this Epic does not reintroduce it.
- **Changing a golden label.** EPIC-096 owns labels; §16 records the one place
  they are known to understate the corpus.

## 5. Inputs

- The candidate rows the text branch produces (`src/storage/retrieval.ts`):
  entity, evidence and content matches, each with a `ts_rank`.
- `kind`, `source_scope`, `id` and `attributes->>'path'` on each candidate —
  everything §8.2 needs to resolve a container, already selected.
- The caller's `limit`, through `boundedLimit`.

## 6. Outputs

- `SearchHit.score` becomes the comparable score, and `SearchHit.ranking`
  carries its breakdown.
- `src/retrieval/rank.ts` — the ranking function, core and pure.
- No schema change; no new table, column or index.

## 7. Dependencies

- **EPIC-052/053** — the candidate rows and `ts_rank`.
- **EPIC-034** — `code_symbol` entities and the scope convention §8.2 relies on.
- **EPIC-087** — `file_version` content hits.
- **EPIC-058** — every candidate has already passed the permission and scope
  predicates before ranking sees it. Ranking never widens a result set.
- **EPIC-096/098** — the labels and the harness this Epic is measured by.

## 8. Contracts

### 8.1 A score means the same thing in every query

`ts_rank(vector, query)` is unbounded above and is a function of the document
*and* the query, so 0.09 in one search and 0.09 in another are unrelated
quantities. Every branch now ranks with PostgreSQL's normalisation flag `32`,
which returns `rank / (rank + 1)` — a monotone map onto `[0, 1)`. Order within
one query is unchanged by construction; what changes is that the number can be
compared, thresholded and combined.

Normalisation `1` (divide by the logarithm of document length) is deliberately
**not** applied. It would rank a long file below a short symbol name for the same
term, and a file's body being long is not evidence that the file is less
relevant.

### 8.2 A constituent is credited to what contains it

Two kinds are constituents of an entity a person names, and each resolves to its
container from columns already selected:

| constituent | container key it publishes | container that claims it |
| --- | --- | --- |
| `file_version` | `source_scope` | the entity whose `id` equals it |
| `code_symbol` | `source_scope` | the `file` whose `` `${source_scope}:${path}` `` equals it |

The second row is why `symbolScope` (`src/code/identity.ts`) is
`` `${scope}:${path}` `` and not a foreign key: EPIC-034 identifies a symbol
within its file by path, and the join is therefore a string equality over the
pool rather than a query. Nothing is fetched to rank.

When the container is in the pool, the constituent's relevance is contributed to
it (§8.3) and the constituent row is folded — its id appears in
`ranking.subsumed`. When the container is **not** in the pool, the constituent
stands as its own hit and ranks on its own relevance. That is the invariant that
makes this a ranking change and not a filter: **no hit is ever removed from a
result set it would otherwise have been alone in.**

### 8.3 Independent matches combine, and nothing corroborates itself

An entity may be reached several ways at once: its name matches, its body
matches, a symbol it declares matches. Those are independent observations that it
is the answer, so they combine by probabilistic or:

```
score = 1 - Π (1 - relevanceᵢ)
```

for one relevance per **distinct contributor**, taking the maximum within each.
The formula has no tuned constant, is monotone in every input, stays in `[0, 1)`
so §8.1 still holds, and cannot exceed 1 however many contributors there are.

"One per distinct contributor" is the whole safeguard, and it is the reason
`fuse` gives for keeping evidence rows apart: "an entity with twenty evidence
records would otherwise dominate by corroborating itself." Twenty evidence hits
on one entity contribute the best one, once. Two symbols in one file contribute
one relevance each, because they are two different pieces of the file matching —
which is what the file being about the term looks like.

### 8.4 What this Epic does not do to `code_symbol`

Issue #98 floated excluding symbols from the untyped text branch. EPIC-087 §D1
rejected it as a governance change to a VALIDATED P0 Epic and as the wrong fix,
"removing a true positive to correct an ordering problem". This specification
does not reintroduce it under another name:

- A symbol hit is still produced by the query, still passes the permission
  predicate, and still ranks.
- A symbol whose file is not in the pool is returned.
- `kinds: ['code_symbol']` returns symbol rows exactly as before, because a
  filtered pool contains no files for them to fold into.

What changes is that when Ferret has both the whole and the part, it answers with
the whole and says which part matched.

### 8.5 One row per entity in a ranked answer

After folding, rows that resolve to the same entity are one hit — the
best-scoring one, with its evidence and highlight retained, and the others'
relevances contributed under §8.3. Today's `DISTINCT ON (id, evidence_id)` states
the same intent one step short of it: "A commit found both by its object id and
by its message is one hit with the better score, not the same commit listed
twice." A ranked answer is an ordering of things, not of observations about them.

### 8.6 Ranking is deterministic and total

Ties break on `kind` then `source_id` then `id`, so a pool ranks identically on
every run and across processes. An exact-identifier hit keeps the fixed relevance
the object-id branch gives it and therefore stays above every ranked hit, which
`src/storage/retrieval.ts` already justifies: "an exact identifier prefix is not
a guess about relevance, it is the thing that was asked for."

### 8.7 Overfetch is bounded

The pool is `min(limit × OVERFETCH, MAX_LIMIT)` rows. Overfetching is what makes
reranking able to change an answer rather than reorder a fixed page, and the
bound is what stops a `limit=500` query from reading the table. `MAX_LIMIT`
already exists for this reason.

## 9. Acceptance criteria

- **AC-1** Every ranked hit's `score` lies in `[0, 1)`, and an exact-identifier
  hit's is `1.0`.
- **AC-2** Ranking a pool twice produces the identical order, including ties.
- **AC-3** A `code_symbol` whose declaring `file` is in the pool is not returned
  as a separate hit; the file is returned and lists the symbol id in
  `ranking.subsumed`.
- **AC-4** A `file_version` whose `file` is in the pool folds the same way.
- **AC-5** A `code_symbol` whose file is **not** in the pool is returned
  unchanged, with its own relevance.
- **AC-6** A search filtered to `kinds: ['code_symbol']` returns symbol hits.
- **AC-7** An entity reached by name *and* body scores strictly above the same
  entity reached by either alone.
- **AC-8** Twenty evidence hits on one entity contribute one relevance; the
  entity does not outrank a better-matching entity by repetition alone.
- **AC-9** A ranked answer contains no entity twice.
- **AC-10** The text branch fetches more than `limit` candidates and returns
  exactly `limit`.
- **AC-11** Ranking never returns an entity the unranked path would not have
  returned: for every pool, the ranked output's entity set is a subset of the
  pool's.
- **AC-12** The golden-dataset harness reports mean precision@10 **strictly
  greater than 0.32** with labels unchanged, and `falsePositives` still 0.
- **AC-13** Mean reciprocal rank and mean nDCG are both strictly greater than the
  0.5972 and 0.6698 recorded on `5293434`.
- **AC-14** Recall does not fall: mean recall ≥ 0.9167.
- **AC-15** `text-refund` returns `src/billing/refund.ts` at rank 1.

## 10. Test requirements

**Unit** — the whole of §8 against hand-built pools: the `[0,1)` bound, noisy-or
arithmetic against a worked example, container resolution for both constituent
kinds, the unfolded constituent, tie determinism, the subset invariant, the
twenty-evidence case, overfetch arithmetic at `limit = 1` and `limit = MAX_LIMIT`.

**Integration (real PostgreSQL)** — AC-3 through AC-6, AC-9, AC-10 and AC-15
against a live index; the normalisation flag proven by a score below 1.

**Retrieval quality** — AC-12, AC-13 and AC-14 through EPIC-098's harness, with
the figure recorded before and after.

**Security** — a folded constituent must not carry a highlight the caller could
not otherwise see: the fold contributes a *relevance*, and the highlight shown is
the surviving hit's own. Tested with a scoped file version.

**Failure** — a pool containing a constituent whose `source_scope` is null,
malformed, or points at a missing entity ranks it as its own hit rather than
throwing.

## 11. Security requirements

Ranking runs **after** EPIC-058's predicates and reads only rows that already
passed them, so it cannot widen a result set — AC-11 is that property as a test.
The one new disclosure risk is the fold: crediting a constituent's relevance to
its container tells the caller "something inside this scored well". Both rows are
inside the caller's scope by the time ranking sees them, so this discloses
nothing across a boundary; the constituent's *text* is never moved onto the
surviving hit, which is what §10 tests.

## 12. Observability

The rank breakdown on each hit is the observability: `relevance`, the
contributing sources, and the folded ids. No new log line, no new metric — the
planner already logs strategy outcomes and the breakdown travels with the answer,
which Governance §18 prefers to a number in a log nobody correlates.

## 13. Performance constraints

Ranking is `O(pool)` with one pass to index containers and one to fold, over a
pool bounded by §8.7. The added database cost is the overfetch: `limit ×
OVERFETCH` rows through the same query plan, with no new join and no new index.
The golden run must not regress in wall-clock beyond the overfetch factor.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 satisfied with evidence recorded in
`validation/EPIC-056-VALIDATION.md`; unit, integration, quality, security and
failure tests present and passing; `npm run verify` green; the registry entry
updated; issue #98 closed with the measurement that closes it.

## 15. Governance alignment

- **§11 Retrieval** — "explainable". §8.3's formula and §12's breakdown are how a
  score can be explained rather than asserted.
- **§18 Provenance and Explainability** — the fold is recorded on the hit, so an
  answer can say which part of a file matched.
- **§19 Testing and Quality** — ranking is named there as something a golden
  dataset must measure. AC-12 to AC-14 are that measurement, and the Epic is not
  DONE on unit tests alone.
- **§2 Simplicity** — one formula and no tuned weight. A table of per-kind
  multipliers would have been the obvious implementation and would have needed a
  defence for every number in it.
- **§5 Reuse Before Reinvent** — `boundedLimit`, `MAX_LIMIT`, `symbolScope` and
  the existing candidate query are reused; nothing new is stored.

## 16. Raised, not absorbed

- **The golden labels understate the corpus.** Issue #98 recorded that
  `text-authentication` returns `login.ts`, `README.md` and
  `docs/architecture.md`, and the latter two do discuss authentication while the
  label names one file. That caps precision below what retrieval deserves. It is
  EPIC-096's decision and is not touched here; AC-12 is written to be met against
  the labels as they stand.
- **EPIC-087 AC-11.** If AC-12 passes, the criterion EPIC-087 left NOT MET has
  its remedy. Recording that is an addendum to EPIC-087's validation, not a
  rewrite of it, and whether EPIC-087 becomes VALIDATED is a governance call this
  Epic reports rather than takes.
- **`fuse` still combines strategy lists by rank.** RRF is correct there because
  a semantic score and a lexical one share no scale even after §8.1 — one is a
  cosine distance. Making the two comparable would be EPIC-054's scope, and is
  not claimed.
