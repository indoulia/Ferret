# EPIC-054 / EPIC-055 — validation evidence

**Status: VALIDATED** · real PostgreSQL 17 + pgvector 0.8.6, real `git`.

## Measured effect

`ferret_search` against Ferret's own index:

| Query | Before | After |
| --- | --- | --- |
| `b9559ab` | 0 | 1 — the right commit, via exact lookup |
| `src/storage/lifecycle.ts` | ranked guesses | exact lookup |
| `how are deleted files tombstoned` | 0 | the EPIC-032 commit, ranked first |
| `what did we decide about connection pooling` | 0 | 5 |

Cause of the 0s: `websearch_to_tsquery` ANDs every term, so more context gave
worse answers; and FTS matches whole lexemes, so no abbreviation matched a SHA.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 object id → exact | PASS | `answers an exact question exactly` |
| AC-2 path → exact | PASS | `recognises a path` |
| AC-3 prose → ranked | PASS | `classify` unit tests |
| AC-4 no provider → unavailable with reason | PASS | `reports semantic retrieval as unavailable rather than empty` |
| AC-5 two strategies outrank one | PASS | `ranks a result found by two strategies above one` |
| AC-6 plan reports skips | PASS | `records each strategy once` |
| AC-7 fusion order-independent | PASS | `gives the same ranking whichever strategy finishes first` |
| AC-8 vectors stored / nearest / bounded | PASS | `returns neighbours in distance order`, `excludes vectors beyond the distance bound` |
| AC-9 models never compared | PASS | `never compares vectors from different models` |
| AC-10 dimension + non-finite rejected | PASS | `refuses a vector of the wrong dimension`, `refuses a vector containing a value that is not finite` |
| AC-11 `ferret_search` reports the plan | PASS | live MCP output above |
| AC-12 failing strategy does not fail query | PASS | `does not fail the query when a strategy fails`; also hit for real during development when the relaxed SQL was malformed — the query still returned and the plan carried the reason |
| AC-13 widening reported | PASS | `widens a prose question that matched nothing` |

## Limitations

- **No embedding provider ships.** TECHNOLOGY-DECISIONS §6. The test provider is
  a fixed lookup table: it proves plumbing, not relevance. No evidence here
  claims semantic quality.
- **No vector index.** One is needed per dimension and the dimension is unknown
  until a provider declares it. Sequential scan until then.
- **Relaxed ranking is weak.** OR-matching ranks by `ts_rank`, not by how many
  distinct terms matched. EPIC-056 owns ranking.
- **pgvector optional.** Migration 8 is conditional; without the extension the
  table is absent and semantic retrieval reports itself unavailable.

## Suite

`53 files, 1304 passed, 3 skipped`. `npm audit`: 0. `npm run dogfood`: agrees
with the repository on every check.
