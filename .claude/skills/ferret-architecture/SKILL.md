---
name: ferret-architecture
description: Navigate Ferret architecture, Epic ownership, provider contracts, boundaries, evidence, and dependency rules before making design or implementation decisions.
---

# Ferret Architecture

Use this skill before architecture changes, cross-cutting fixes, new capabilities, or uncertain ownership.

## Authoritative order

1. Current code and runtime behavior
2. Validated contracts and acceptance criteria
3. Approved Epic specification and registry
4. Historical evidence and older design notes
5. Hypotheses and proposed future behavior

When these disagree, do not silently reconcile them. Record the discrepancy and determine the owner.

## Ownership rules

- Every capability has one coherent Epic owner.
- Material scope expansion creates or updates an Epic explicitly.
- Provider-specific behavior remains behind provider contracts.
- Reuse validated primitives before adding new mechanisms.
- Do not move behavior across architectural boundaries merely to simplify implementation.
- A limitation discovered by an Epic remains a limitation unless an approved Epic owns its resolution.

## Boundary discipline

Before changing imports, public APIs, provider interfaces, storage contracts, or indexing layers:

1. Find the existing boundary test.
2. Identify what it protects and which Epic established it.
3. Preserve existing assertions unless the approved scope explicitly authorizes an amendment.
4. If an amendment is necessary, add the narrowest possible allowance and a positive test proving the intended path is actually used.

## Evidence discipline

Distinguish:
- implementation existence
- unit-test evidence
- integration evidence
- live runtime evidence
- independent corroboration

Never treat one layer as proof of another.

## Design checkpoint

Before writing code, state:
- owner Epic
- existing contracts reused
- boundary constraints
- dependencies
- non-scope
- smallest design that satisfies the approved criteria

If any of these cannot be established from the repository, stop and investigate rather than inventing architecture.
