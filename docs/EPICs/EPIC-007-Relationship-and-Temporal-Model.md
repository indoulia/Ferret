# EPIC-007 — Relationship & Temporal Model

**Status: APPROVED | Priority: P0**

## Objective
Represent typed relationships and historical validity so Ferret can answer how repositories, branches, worktrees, files, commits, PRs, issues, releases, developers, and sessions relate over time.

## Scope
Typed directed relationships; relationship metadata; observed-at/valid-at timestamps; lifecycle events; historical state; relationship versioning; traversal-safe identifiers.

## Non-scope
Dedicated graph database; retrieval ranking; external provider implementation.

## Acceptance criteria
- Relationships are typed, queryable, and source-traceable.
- Historical relationships can coexist with current relationships.
- Relationship updates are idempotent.
- Branch and worktree relationships remain distinct.
- Relationships can connect entities from different providers.
- Temporal queries can distinguish observed time from indexed time.

## Tests
Create/update/delete/tombstone; duplicate events; out-of-order events; historical queries; cross-source relationships; concurrent updates.

## Definition of Done
Schema, invariants, traversal primitives, temporal semantics, and automated tests are documented and validated.
