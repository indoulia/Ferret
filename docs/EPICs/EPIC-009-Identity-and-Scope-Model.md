# EPIC-009 — Identity & Scope Model

**Status: VALIDATED | Priority: P0**

Evidence: [`validation/EPIC-009-VALIDATION.md`](validation/EPIC-009-VALIDATION.md) · Decisions: [`../Architecture/EPIC-009-DECISIONS.md`](../Architecture/EPIC-009-DECISIONS.md) · Checkpoint: [`../Checkpoints/EPIC-009.md`](../Checkpoints/EPIC-009.md)

## Objective
Represent developers, AI agents, repositories, worktrees, sessions, and configuration scopes independently and consistently across providers.

## Scope
Canonical identities; external identity mappings; developer/agent distinction; repository identity; branch identity; worktree identity; session scope; repository/session exclusions; identity reconciliation.

## Non-scope
Authentication provider implementation and AI authorization policy.

## Acceptance criteria
- Developers and AI agents are distinct identity classes.
- A worktree cannot be incorrectly treated as a branch.
- The same external identity can map to one canonical identity with auditable evidence.
- Repository and session scopes can be included/excluded independently.
- Identity collisions are detected rather than silently merged.
- Identity history is retained when mappings change.

## Tests
Identity creation; alias mapping; collisions; branch/worktree separation; scope filtering; changed identity; concurrent reconciliation.

## Definition of Done
Canonical identity and scope semantics are documented, persisted, tested, and usable by providers and retrieval.
