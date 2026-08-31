# EPIC-054 — Semantic Retrieval · EPIC-055 — Hybrid Query Planner

**Status: APPROVED | Priority: EPIC-054 P1, EPIC-055 P0**

Specified together because the interesting part is the seam: what the planner
does when semantic retrieval is absent, which is the default.

## 1. Objective

Route a question to the strategies that can answer it, combine their results,
and report what was not used.

## 2. Governing constraint

`TECHNOLOGY-DECISIONS.md` §6: no embedding vendor is mandatory; embeddings are
"optional augmentation, not the foundation of deterministic retrieval". Hence
EPIC-055 is P0 and EPIC-054 P1 — the planner must be good with exact and
full-text alone.

Two things are forbidden:

- **A fake embedding.** A hash has the right shape and encodes no meaning;
  semantic search on it returns confident noise (Governance §6).
- **Silent degradation.** A plan that could not run a strategy says so.

## 3. Problem

`ferret_search` sends everything to full-text. Measured on Ferret's own index:

| Query | Before |
| --- | --- |
| `b9559ab` (abbreviated object id) | 0 — FTS matches whole lexemes |
| `how are deleted files tombstoned` | 0 — FTS ANDs every term |
| `tombstone` | 1 |

The more context a person gave, the worse the answer.

## 4. Scope

**EPIC-054** — `EmbeddingSource` contract under the existing `embedding`
capability; pgvector storage keyed by subject and model; nearest-neighbour query
with a distance bound; unavailability reported with a reason.

**EPIC-055** — classify a question; run applicable strategies concurrently; fuse
by rank; report the plan; wire behind `ferret_search`.

## 5. Non-scope

Shipping an embedding vendor. Reranking (EPIC-056). Freshness weighting
(EPIC-057). Permission filtering (EPIC-058). Chunking (EPIC-024–030).

## 6. Contracts

**Classification is syntactic.** Object id, path, entity id, prose — each
decidable by reading the string, so routing is deterministic and explainable.
Asking a model would be better at the margins and would make retrieval
non-deterministic and dependent on the provider that may not exist.

**Fusion is Reciprocal Rank Fusion**, `k = 60`. `ts_rank` and cosine distance
share no scale, so normalising and adding them produces a number with no
meaning. RRF uses only rank, which every strategy has. `k` is the value from the
original TREC work, untuned — tuning it against one corpus would make it a claim
Ferret cannot support.

**An exact hit is not fused.** A caller asking for `b9559ab` is not helped by
the commit ranked above three documents mentioning it.

**Relaxation is a fallback, not a default.** A prose query matching nothing is
retried for any term. When every term matches, that is the better answer.

**pgvector stays optional.** EPIC-002 decided it; migration 8 is conditional, so
an installation without the extension still starts.

## 7. Acceptance criteria

- **AC-1** Abbreviated object id → exact lookup, commit returned first.
- **AC-2** Path → exact lookup.
- **AC-3** Prose → ranked retrieval.
- **AC-4** No embedding provider → plan runs, semantic reported unavailable with a reason.
- **AC-5** A result found by two strategies outranks one found by one.
- **AC-6** The plan reports strategies attempted, skipped, and why.
- **AC-7** Fusion is order-independent.
- **AC-8** Vectors stored, retrieved by nearest neighbour, bounded by distance.
- **AC-9** Vectors from a different model are never compared.
- **AC-10** Wrong dimensions and non-finite values rejected at the boundary.
- **AC-11** `ferret_search` uses the planner and reports the plan.
- **AC-12** A failing strategy does not fail the query.
- **AC-13** A prose query matching nothing is widened, and the widening reported.

## 8. Test requirements

- Unit: classification, RRF including order-independence by permuting inputs.
- Integration against real PostgreSQL: vector storage, dimension rejection,
  distance bounds, model isolation.
- AC-12 proved by making a strategy fail, not by asserting a flag.
- **The test embedding provider is not semantic and must be labelled so.** It
  proves plumbing; it proves nothing about relevance.

## 9. Security

- Classification patterns are anchored, non-backtracking, over length-capped input.
- Vector length checked against declared dimensions before it reaches a query.
- Provider failures go through EPIC-009's serializer — the one path a credential
  must not take.

## 10. Observability

`retrieval.plan` events carry the classification, strategies attempted, counts,
and each skip with its reason.

## 11. Definition of Done

All acceptance criteria pass against real infrastructure; `npm run verify`
green; `npm run dogfood` still agrees with the repository; limitations recorded.

## 12. Governance

§2 (syntactic classification over a model), §4 (no mandated vendor), §6 (no fake
embeddings, no silent degradation), §17, §21.
