# EPIC-052 & EPIC-053 — Validation Evidence

**Epics:** EPIC-052 — Exact Structured Retrieval; EPIC-053 — Full-Text Retrieval
**Branch:** `feat/epic-052-053-retrieval`
**Recorded:** 2026-08-31

> **Specification note.** Neither Epic had a specification file. Both were
> written first, to the approved standard, as one document because the value of
> each is largely that it is *not* the other. **The acceptance criteria below are
> ones this work authored.**

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Entities found exactly by kind, scope, attribute, external id | **PASS** | `retrieval.test.ts` → "finds every entity of a kind", "finds an entity by an exact attribute" (exactly one result), "finds the files identified within one repository". |
| AC-2 | An exact filter matching nothing returns nothing | **PASS** | "returns nothing rather than everything for a filter that matches nothing". |
| AC-3 | Traversal in either direction, or both | **PASS** | "finds what a repository contains", "finds what points at a file", "follows both directions when the question has none". |
| AC-4 | Traversal answers as of an instant, half-open | **PASS** | "answers as of an instant, not only as of now", "excludes an interval that ended exactly at the instant asked about". |
| AC-5 | Full-text finds entities by names, paths and messages, with stemming | **PASS** | "finds a commit by words from its message", "stems, so a search for one form finds another", "finds a file by words from its path". |
| AC-6 | Searches evidence as well as entities, and says which | **PASS** | "searches evidence statements, not only entity names", "can be told to search entities only". |
| AC-7 | Ordered by relevance, with a highlight | **PASS** | "orders by relevance and says where each hit came from" (monotonic scores asserted), "shows why something matched". |
| AC-8 | Malformed query syntax never throws | **PASS** | "does not crash on syntax a person might type" — six inputs that `to_tsquery` would reject. |
| AC-9 | Every result set bounded | **PASS** | "never returns more than the maximum"; `boundedLimit` unit cases. |
| AC-10 | Search text and attribute names are data, never SQL | **PASS** | "treats an attribute name as data, not as SQL", "treats search text as data, not as SQL" — each asserts the table still exists afterwards. |

**10 / 10 PASS.**

---

## 2. Tests

`npm run verify` — **1,180 passed, 3 skipped** across 47 files against live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` — 0.
31 new cases, all against a repository built by real `git` and indexed by the
real indexer.

---

## 3. The defect this Epic found in the last one

### 60 of 61 commits held nothing but a SHA

Confirmed by SQL against Ferret's own dogfood index:

```
 with_message | without_message | total
--------------+-----------------+-------
            1 |              60 |    61
```

`git log` returns commits newest first. Commit B is emitted in full, then its
parent A is emitted as a **placeholder** so the `commit_parent_of_commit` edge
has an endpoint. The loop then reaches A and emits it properly — and
`emitHistory`'s deduplicating `add()` returned the existing placeholder and threw
the full record away.

Every commit that is a parent of a newer one therefore lost its message, its
author, its dates and its tree. **Nothing failed.** The graph had exactly the
right shape and was almost entirely empty, which is the worst way for it to be
wrong: every structural assertion in nineteen Epics of tests still passed,
because every one of them checked shape.

Found by writing a *search* test — "find a commit by words from its message" —
which is the first test in the project that asserted **content** rather than
structure.

Fixed by distinguishing a placeholder from a record read from the source: a
placeholder fills a gap and is displaced the moment the real one arrives.
Covered by a new indexing test that counts how many commits have a message,
which is the assertion that was missing.

---

## 4. Two more things the tests corrected

**Raw queries do not run Drizzle's column parsers.** Timestamps arrive as
strings, not `Date`, so thirteen tests failed with
`row.valid_from.toISOString is not a function`. It looked like thirteen bugs and
was one — and it only showed for commits and relationships, because a file entity
has no `source_observed_at`.

**A hyphenated fragment does not match a path, and cannot.** `retry-policy`
parses as a *phrase* query — `'retry-polici' <-> 'retri' <-> 'polici'` — which no
lexing of `src/retry-policy.ts` satisfies. My assertion assumed otherwise. The
natural queries (`retry policy`, `connection`) all work, because the migration
indexes a separated copy of every path; the hyphenated case is asserted as the
current behaviour so the day it changes is a decision rather than an accident.
Owner: **EPIC-055**.

---

## 5. Security

| Concern | Handling | Test |
| --- | --- | --- |
| Injection through search text | Every value bound. Nothing in `retrieval.ts` is concatenated into SQL. | "treats search text as data, not as SQL" — asserts the table still exists |
| Injection through an **attribute name** | The key is a bind parameter too — a field nobody thinks of as user input. | "treats an attribute name as data, not as SQL" |
| An unbounded query as free work for an attacker | 1,024-character limit on search text. | "refuses an empty or oversized query" |
| An unbounded result set filling a context window | `DEFAULT_LIMIT` 50, `MAX_LIMIT` 500, enforced regardless of what is asked. | "never returns more than the maximum" |
| A malformed query crashing the search | `websearch_to_tsquery` never throws, unlike the alternatives. | "does not crash on syntax a person might type" |

---

## 6. Performance

| Measurement | Observed | Budget |
| --- | --- | --- |
| 50 full-text searches | ~0.3 s | 20 s |

This query is on the hot path of every AI-client question, so a regression to a
sequential scan shows here.

---

## 7. Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **A hyphenated fragment does not match a path.** | `retry policy` works, `retry-policy` does not. Deciding when to use exact matching instead of full text is a planner decision. | **EPIC-055** |
| **`ts_rank` is comparable within one result set and nowhere else.** | It is a function of document and query, not a probability. Treating it as one across queries is how a meaningless threshold gets hard-coded. | **EPIC-056** |
| Only `english` is configured. | Stemming is wrong for identifiers and for other languages. | **EPIC-055**, **EPIC-030** |
| A search hit carries no external ids and no provenance chain. | Both are a second query per hit, which would turn a page of fifty into a hundred round trips. `getEntity` and `EvidenceStore` answer them properly. | — |
| No permission filtering. | Everything indexed is returnable. | **EPIC-058** |
| No semantic retrieval, and no planner choosing between modes. | pgvector is provisioned and unused. | **EPIC-054**, **EPIC-055** |
| `findEntities` pages by offset. | O(offset) on a large result set, and the same trade-off EPIC-019 made. | **EPIC-055** |
