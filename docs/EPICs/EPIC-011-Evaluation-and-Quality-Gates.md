# EPIC-011 — Evaluation & Quality Gates

**Status: APPROVED**  
**Priority: P0**  
**Owner: Quality**

## Objective

Make Ferret's parsing, indexing, retrieval, provenance, security, and provider behavior measurable and regression-resistant.

## Outcome

The project can demonstrate quality with repeatable automated evidence rather than subjective claims of perfect retrieval or parsing.

## Scope

- golden datasets;
- representative engineering repositories and documents;
- retrieval question sets;
- expected entities/evidence;
- parser fixtures;
- provider conformance tests;
- permission tests;
- indexing/idempotency tests;
- migration tests;
- failure/recovery tests;
- ranking and retrieval metrics;
- regression gates.

## Acceptance criteria

1. A golden evaluation corpus exists for core engineering questions.
2. Retrieval tests verify expected evidence, not merely text similarity.
3. Parser fixtures cover representative supported file types.
4. Provider conformance tests run consistently across providers.
5. Permission tests prove protected evidence is not returned.
6. Incremental and idempotent indexing are regression-tested.
7. Schema migrations are tested from supported prior versions.
8. Retrieval regressions can block releases when defined thresholds are breached.
9. Test outputs are reproducible and attributable to relevant implementation/model versions.

## Quality principle

"No room for error" is treated as an engineering objective achieved through evidence, testing, explicit uncertainty, and controlled failure—not as an unsupported guarantee.
