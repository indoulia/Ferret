# EPIC-006 — Canonical Entity Model

**Status: VALIDATED | Priority: P0**

Evidence: [`validation/EPIC-006-VALIDATION.md`](validation/EPIC-006-VALIDATION.md) · Decisions: [`../Architecture/EPIC-006-DECISIONS.md`](../Architecture/EPIC-006-DECISIONS.md) · Checkpoint: [`../Checkpoints/EPIC-006.md`](../Checkpoints/EPIC-006.md)

## Objective
Define the provider-neutral durable entity model that represents Ferret's knowledge without coupling core logic to GitHub, Jira, files, or any future source.

## Scope
Stable IDs; entity types; source identity; external identifiers; lifecycle state; metadata; canonicalization; extensibility; schema validation.

Core entities must support at minimum repositories, branches, worktrees, developers, agents, sessions, files, file versions, commits, pull requests, reviews, issues, releases, deployments, documents, and evidence.

## Non-scope
Search ranking, parser implementation, provider APIs, and AI answer generation.

## Acceptance criteria
- Every supported source object can map to a canonical entity.
- Canonical IDs remain stable across repeated ingestion.
- External IDs remain traceable to their source.
- Entity extensions do not require core redesign.
- Unknown/unsupported source fields can be retained without corrupting the canonical model.
- Schema validation rejects invalid canonical entities.

## Tests
Entity creation; duplicate identity; external ID mapping; unknown fields; invalid entities; schema version compatibility.

## Definition of Done
Canonical schema documented and versioned; representative source mappings validated; persistence tests pass.
