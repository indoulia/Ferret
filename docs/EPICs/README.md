# Ferret Epics

**Status: APPROVED**  
**Registry Version: 1.0**  
**Effective: 2026-08-30**

This directory is the implementation roadmap for Ferret. Epics are outcome-oriented bodies of work. An Epic is not approved merely because its idea is desirable; its scope, boundaries, acceptance criteria, dependencies, and governance alignment must be explicit.

## Epic lifecycle

`PROPOSED → REVIEWED → APPROVED → IN PROGRESS → VALIDATED → DONE`

An approved Epic is authorized for implementation, subject to the governance rules in `docs/Governance/README.md`.

## Initial approved epics

| ID | Epic | Status | Outcome |
|---|---|---|---|
| EPIC-001 | Foundation & Bootstrap | APPROVED | Installable, lightweight Ferret core with automatic initialization and migration |
| EPIC-002 | Canonical Knowledge Model | APPROVED | Stable model for entities, evidence, files, context, relationships, and time |
| EPIC-003 | Provider Platform | APPROVED | Versioned plug-and-play provider SDK and registry |
| EPIC-004 | File Intelligence & Indexing | APPROVED | First-class, incremental, structured indexing of code and documents |
| EPIC-005 | Engineering Context & Sessions | APPROVED | Persistent repositories, worktrees, developers, agents, sessions, checkpoints, and decisions |
| EPIC-006 | Retrieval & Context Engine | APPROVED | Hybrid, evidence-backed retrieval and token-efficient Context Packs |
| EPIC-007 | AI Control Plane & MCP | APPROVED | AI-operated administration and knowledge access, starting with Claude Code |
| EPIC-008 | Source Integrations | APPROVED | Git/GitHub/Jira and future systems connected without core coupling |
| EPIC-009 | Security, Provenance & Trust | APPROVED | Permission-aware, auditable, evidence-backed knowledge |
| EPIC-010 | Reliability, Sync & Operations | APPROVED | Automatic synchronization, reconciliation, health, recovery, and observability |
| EPIC-011 | Evaluation & Quality Gates | APPROVED | Golden datasets and measurable retrieval/parser/provider quality |
| EPIC-012 | Distribution & Developer Experience | APPROVED | NPM-first installation and near-zero-config daily experience |

## Dependency direction

The broad implementation dependency is:

**EPIC-001 → EPIC-002 → EPIC-003 → EPIC-004/005 → EPIC-006 → EPIC-007/008/009/010 → EPIC-011/012**

Some work may proceed in parallel once its contract dependencies exist.

## Epic rules

- Epics must not violate approved governance.
- Epics define outcomes; implementation details belong in design/issue-level work unless they are architectural constraints.
- Cross-Epic contracts must be explicit.
- Provider additions must not require unrelated core modifications.
- Every Epic must have objective acceptance criteria.
- Completion requires evidence from automated tests or other stated validation.
- Scope expansion requires an explicit Epic update rather than silent addition of work.
