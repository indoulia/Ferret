# EPIC-052 — Exact Structured Retrieval · EPIC-053 — Full-Text Retrieval

**Status: APPROVED | Priority: P0 (both)**

> **Specification note.** Two registry entries, one document, because the value
> of each is largely that it is *not* the other. Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entries and Governance §6, §9 and §12.

## 1. Objective

Answer questions against the stored graph: exactly where there is a right
answer, and by relevance where there is not.

## 2. Value

Ferret can index. Until it can answer, nothing downstream exists — every context
pack, every MCP tool, every ranking Epic is shaped by what retrieval can return.

The decision that matters most is keeping the two kinds of question **apart**.

**Exact** (EPIC-052) is deterministic. *Which files does this repository
contain*, *what did this worktree have checked out on Tuesday*, *which commits
touched this path* — each has a right answer, the same one every time. Returning
a relevance-ordered approximation would be worse than returning nothing, because
a caller cannot tell the difference between "these are the files" and "these are
probably the files".

**Full-text** (EPIC-053) is a guess with a score, for the things a person
half-remembers: *where did we discuss timeouts*. Its results are ordered because
there is no single right one.

Conflating them is how a system starts returning plausible answers to precise
questions — and an AI client cannot tell that it happened.

## 3. Scope

- Exact entity lookup by kind, source, scope, attribute and external identifier.
- Relationship traversal, in either direction, **as of an instant**.
- Full-text search over entity attributes and evidence statements, ranked, with
  a highlight showing why each hit matched.
- Bounds: a default and a maximum on every result set.

## 4. Non-scope

- Semantic retrieval — EPIC-054.
- Deciding *which* retrieval to use for a question — EPIC-055.
- Ranking that is comparable across queries — EPIC-056.
- Permission filtering — EPIC-058.
- Assembling results into a context window — EPIC-059.

## 5. Inputs

The graph EPIC-031 writes; PostgreSQL FTS, which TECHNOLOGY-DECISIONS §3
selected over a separate search engine.

## 6. Outputs

- `src/retrieval/` — the query shapes and `RetrievalPort`, in the **core**.
- `src/storage/retrieval.ts` — the implementation.
- Migration 0007 — generated `tsvector` columns and their GIN indexes.

## 7. Dependencies

EPIC-002, EPIC-006–008, EPIC-031.

## 8. Contracts

### The query shapes are core; answering them is not

Ferret must be able to *express* a question without knowing what answers it
(Governance §4). `RetrievalPort` is implemented by the storage provider today.

### A stored `tsvector`, not an expression index

Ranking needs the vector itself — `ts_rank` takes one — so an expression index
would recompute it for every row it ranks.

### A curated field list, and a separated copy of every path

A generated column must be IMMUTABLE, which rules out `jsonb_each_text`. The
fields indexed are the ones people search by: what a thing is called, where it
lives, what someone said about it.

Paths are indexed **twice**: raw, and with `/-_.` translated to spaces.
PostgreSQL lexes `src/retry-policy.ts` as a *single* token of type `file`, so
without the second form no query a person would type finds a file at all.

### `websearch_to_tsquery`, not `plainto_tsquery`

It understands quoted phrases, `or`, and `-exclusion` — what a person types
without being told a syntax — and, unlike `to_tsquery` and `plainto_tsquery`, it
never throws on malformed input. A search box that a stray parenthesis can crash
is a search box that will be.

### Every value is a bind parameter

Including attribute **names**. A search term arrives from an AI client, and a
query built by concatenation is an injection with a very short path from the
outside world.

## 9. Acceptance criteria

- **AC-1** Entities are found exactly by kind, scope, attribute and external id.
- **AC-2** An exact filter that matches nothing returns nothing.
- **AC-3** Traversal follows relationships in either direction, or both.
- **AC-4** Traversal answers **as of an instant**, using half-open intervals.
- **AC-5** Full-text search finds entities by words from their names, paths and
  messages, with stemming.
- **AC-6** It searches evidence statements as well as entity attributes, and says
  which a hit came from.
- **AC-7** Results are ordered by relevance and carry a highlight.
- **AC-8** Malformed query syntax never throws.
- **AC-9** Every result set is bounded; an oversized request is capped.
- **AC-10** Search text and attribute names are data, never SQL.

## 10. Test requirements

Against a repository built by real `git` and indexed by the real indexer — a
hand-seeded database would prove only the seeding. Plus: injection attempts,
malformed syntax, bounds, and a performance ceiling on the search that sits on
the hot path of every AI-client question.

## 11. Security requirements

Search text is bounded at 1,024 characters — parsing an unbounded query is work
an attacker gets for free. Every value, including attribute names, is bound.
Results carry no more than the caller asked for.

## 12. Observability

A hit says whether it came from an entity or from evidence, and carries the
matched text with the query terms marked. A score with no visible reason is a
number a person has to take on trust.

## 13. Performance constraints

Fifty full-text searches under 20 s. A regression to a sequential scan shows
there immediately.

## 14. Definition of Done

Both retrieval modes implemented, the migration applied, criteria evidenced.

## 15. Governance alignment

- **§6 Evidence** — an exact question gets an exact answer or none.
- **§9 Context** — traversal is temporal, because *when* is half of every
  question Ferret exists to answer.
- **§12 Security** — §11.
- **§17 Performance** — §13.
