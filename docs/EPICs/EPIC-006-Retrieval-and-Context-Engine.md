# EPIC-006 — Retrieval & Context Engine

**Status: APPROVED**  
**Priority: P0**  
**Owner: Retrieval**

## Objective

Provide accurate, token-efficient, evidence-backed answers by combining structured lookup, full-text search, semantic retrieval, relationship traversal, freshness, scope, and provenance.

## Outcome

An AI client can ask complex engineering questions and receive a compact Context Pack or Answer Pack containing the most relevant facts and supporting evidence rather than a large unfiltered data dump.

## Scope

- query parsing and intent detection;
- entity resolution;
- deterministic lookup;
- full-text retrieval;
- semantic retrieval;
- relationship/graph traversal;
- ranking and reranking;
- freshness and authority weighting;
- scope and permission filtering;
- evidence selection;
- context budgeting;
- Context Pack generation;
- Answer Pack generation;
- confidence and completeness;
- query explanation.

## Core retrieval rule

When the requested fact is structurally represented, deterministic retrieval should be preferred over semantic similarity. Semantic retrieval is an augmentation and discovery mechanism, not the sole source of truth.

## Acceptance criteria

1. Structured questions resolve through direct relationships when available.
2. Natural-language questions can combine multiple retrieval strategies.
3. Results respect configured scope and permissions before evidence is exposed.
4. Current/fresh evidence is appropriately favored over stale evidence.
5. The system can report partial, conflicting, stale, unavailable, and unknown states.
6. Context Packs respect a configurable token budget.
7. Answers can identify supporting evidence and why it was selected.
8. Retrieval quality is measured against a golden evaluation set.
9. Query planning does not require traversing live source systems when indexed evidence is sufficient.

## Non-scope

This Epic does not own source ingestion or parser implementation.
