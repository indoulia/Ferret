# Ferret Functional Epic Registry

**Status: APPROVED**  
**Registry Version: 3.0**  
**Effective: 2026-08-30**

## Purpose

This registry is the authoritative delivery map for Ferret. Strategic Domains organize the product; **Functional Epics are the unit of implementation, testing, validation, and completion**.

An Epic is intentionally small enough to have a coherent outcome, independently testable acceptance criteria, and a meaningful Definition of Done. There is no fixed target number of Epics.

## Lifecycle

`PROPOSED → REVIEWED → APPROVED → READY → IN_PROGRESS → BLOCKED → IMPLEMENTED → VALIDATING → VALIDATED → DONE`

## Epic rules

- Every Functional Epic has one coherent capability outcome.
- Every Epic has explicit scope and non-scope.
- Every Epic has dependencies and objective acceptance criteria.
- Tests are part of the Epic, not follow-up work.
- An Epic cannot be DONE on code existence alone.
- Material scope expansion creates or updates an Epic explicitly.
- Do not split capabilities artificially merely to increase Epic count.
- Do not combine unrelated capabilities merely to reduce Epic count.
- Provider-specific work remains behind provider contracts.
- Governance is authoritative over Epic implementation.

## Approved strategic domains

1. Foundation & Runtime
2. Configuration & Provisioning
3. Canonical Knowledge Model
4. Provider Platform
5. Source Discovery & Git
6. File Intelligence
7. Code Intelligence
8. Engineering Context
9. Session & Agent Memory
10. Evidence & Provenance
11. Knowledge Graph & Relationships
12. Search & Retrieval
13. Context Compilation
14. AI Control Plane & MCP
15. External Project Knowledge
16. Synchronization & Reconciliation
17. Security & Authorization
18. Storage & Data Lifecycle
19. Reliability & Operations
20. Evaluation & Quality
21. Distribution & Developer Experience

## Approved functional Epic catalog

### Foundation & Runtime

- **EPIC-001 — Core Runtime & Package** — P0 — VALIDATED ([evidence](validation/EPIC-001-VALIDATION.md))
- **EPIC-002 — Database Bootstrap & Migrations** — P0 — VALIDATED ([evidence](validation/EPIC-002-VALIDATION.md))
- **EPIC-003 — Configuration Engine** — P0 — VALIDATED ([evidence](validation/EPIC-003-VALIDATION.md))
- **EPIC-004 — Runtime Health & Diagnostics** — P0 — VALIDATED ([evidence](validation/EPIC-004-VALIDATION.md))
- **EPIC-005 — Technology Evaluation & Selection** — P0 — DONE ([decisions](../TECHNOLOGY-DECISIONS.md))

### Canonical Knowledge Model

- **EPIC-006 — Canonical Entity Model** — P0 — VALIDATED ([evidence](validation/EPIC-006-VALIDATION.md))
- **EPIC-007 — Relationship & Temporal Model** — P0 — VALIDATED ([evidence](validation/EPIC-007-VALIDATION.md))
- **EPIC-008 — Evidence & Provenance Model** — P0 — VALIDATED ([evidence](validation/EPIC-008-VALIDATION.md))
- **EPIC-009 — Identity & Scope Model** — P0 — VALIDATED ([evidence](validation/EPIC-009-VALIDATION.md))
- **EPIC-010 — Schema Versioning & Compatibility** — P0 — VALIDATED ([evidence](validation/EPIC-010-VALIDATION.md))

### Provider Platform

- **EPIC-011 — Provider Contracts** — P0 — VALIDATED ([spec](EPIC-011-Provider-Contracts.md), [evidence](validation/EPIC-011-VALIDATION.md))
- **EPIC-012 — Provider SDK** — P0 — VALIDATED ([spec](EPIC-012-Provider-SDK.md), [evidence](validation/EPIC-012-VALIDATION.md))
- **EPIC-013 — Provider Registry & Discovery** — P0
- **EPIC-014 — Provider Lifecycle & Health** — P1
- **EPIC-015 — Provider Configuration & Secrets** — P0
- **EPIC-016 — Provider Conformance Testing** — P0

### Source Discovery & Git

- **EPIC-017 — Local Repository Discovery** — P0 — VALIDATED ([spec](EPIC-017-Local-Repository-Discovery.md), [evidence](validation/EPIC-017-VALIDATION.md))
- **EPIC-018 — Branch & Worktree Discovery** — P0 — VALIDATED ([spec](EPIC-018-Branch-Worktree-Discovery.md), [evidence](validation/EPIC-018-VALIDATION.md))
- **EPIC-019 — Git History Ingestion** — P0
- **EPIC-020 — Commit & Reference Modeling** — P0
- **EPIC-021 — GitHub Provider** — P1

### File Intelligence

- **EPIC-022 — File Discovery** — P0
- **EPIC-023 — File Identity & Content Hashing** — P0
- **EPIC-024 — Parser Framework** — P0
- **EPIC-025 — Code File Parsing** — P0
- **EPIC-026 — PDF Intelligence** — P1
- **EPIC-027 — Office Document Intelligence** — P1
- **EPIC-028 — Spreadsheet Intelligence** — P1
- **EPIC-029 — Text & Markdown Intelligence** — P1
- **EPIC-030 — File Structure & Metadata** — P0
- **EPIC-031 — Incremental Indexing** — P0
- **EPIC-032 — Index Lifecycle & Tombstones** — P0

### Code Intelligence

- **EPIC-033 — AST Model** — P0
- **EPIC-034 — Symbol Index** — P0
- **EPIC-035 — Reference & Relationship Index** — P1

### Engineering Context

- **EPIC-036 — Developer Identity** — P0
- **EPIC-037 — Repository Context** — P0
- **EPIC-038 — Worktree Context** — P0

### Session & Agent Memory

- **EPIC-039 — Session Model** — P0
- **EPIC-040 — Session Capture** — P0
- **EPIC-041 — Durable Checkpoints** — P0
- **EPIC-042 — Decision & Engineering Memory** — P1
- **EPIC-043 — Session Recovery** — P1

### Evidence & Provenance

- **EPIC-044 — Evidence Store** — P0
- **EPIC-045 — Source Authority** — P0
- **EPIC-046 — Confidence & Completeness** — P1
- **EPIC-047 — Conflict Detection** — P1
- **EPIC-048 — Answer Traceability** — P0

### Knowledge Graph & Relationships

- **EPIC-049 — Relationship Storage** — P0
- **EPIC-050 — Relationship Traversal** — P1
- **EPIC-051 — Cross-Source Entity Resolution** — P1

### Search & Retrieval

- **EPIC-052 — Exact Structured Retrieval** — P0
- **EPIC-053 — Full-Text Retrieval** — P0
- **EPIC-054 — Semantic Retrieval** — P1
- **EPIC-055 — Hybrid Query Planner** — P0
- **EPIC-056 — Ranking & Reranking** — P1
- **EPIC-057 — Freshness & Authority Ranking** — P1
- **EPIC-058 — Permission-Aware Retrieval** — P0

### Context Compilation

- **EPIC-059 — Context Packs** — P0
- **EPIC-060 — Answer Packs** — P0
- **EPIC-061 — Token Budgeting** — P0
- **EPIC-062 — Evidence Selection** — P0
- **EPIC-063 — Query Explanation** — P1

### AI Control Plane & MCP

- **EPIC-064 — MCP Server** — P0
- **EPIC-065 — MCP Knowledge Tools** — P0
- **EPIC-066 — MCP Configuration Tools** — P0
- **EPIC-067 — MCP Provider Administration** — P1
- **EPIC-068 — AI Authorization Model** — P0
- **EPIC-069 — Destructive Operation Confirmation** — P0
- **EPIC-070 — AI Client Capability Discovery** — P1

### External Project Knowledge

- **EPIC-071 — Jira Provider** — P1
- **EPIC-072 — Pull Request & Review Modeling** — P1
- **EPIC-073 — Release & Deployment Modeling** — P1
- **EPIC-074 — External Provider Extension Framework** — P2

### Synchronization & Reconciliation

- **EPIC-075 — Sync Cursor Management** — P0
- **EPIC-076 — Incremental Source Synchronization** — P0
- **EPIC-077 — Event & Webhook Ingestion** — P1
- **EPIC-078 — Periodic Reconciliation** — P1
- **EPIC-079 — Retry & Backoff** — P0
- **EPIC-080 — Idempotent Ingestion** — P0

### Security & Authorization

- **EPIC-081 — Credential Isolation** — P0
- **EPIC-082 — Secret Detection & Exclusion** — P0
- **EPIC-083 — Authorization Enforcement** — P0
- **EPIC-084 — Prompt-Injection Resistance** — P0
- **EPIC-085 — Audit Events** — P1

### Storage & Data Lifecycle

- **EPIC-086 — PostgreSQL Storage Layer** — P0
- **EPIC-087 — Deduplicated Content Storage** — P0
- **EPIC-088 — Retention & Exclusion Policies** — P1
- **EPIC-089 — Backup & Export** — P1
- **EPIC-090 — Data Import & Recovery** — P1

### Reliability & Operations

- **EPIC-091 — Structured Logging** — P0
- **EPIC-092 — Metrics & Tracing** — P1
- **EPIC-093 — Provider Failure Isolation** — P0
- **EPIC-094 — Index Integrity & Recovery** — P0
- **EPIC-095 — Operational Diagnostics** — P0

### Evaluation & Quality

- **EPIC-096 — Golden Evaluation Dataset** — P0
- **EPIC-097 — Parser Quality Harness** — P0
- **EPIC-098 — Retrieval Quality Harness** — P0
- **EPIC-099 — Provider Conformance Harness** — P0
- **EPIC-100 — Security Regression Suite** — P0
- **EPIC-101 — Performance & Scale Benchmarks** — P1

### Distribution & Developer Experience

- **EPIC-102 — NPM Distribution** — P0
- **EPIC-103 — Global CLI** — P0
- **EPIC-104 — AI Client Onboarding** — P0
- **EPIC-105 — Cross-Platform Packaging** — P1
- **EPIC-106 — Upgrade & Migration UX** — P1
- **EPIC-107 — Docker Distribution** — P2

## Dependency baseline

The broad delivery direction is:

**Foundation → Configuration → Technology Evaluation → Canonical Model → Provider Platform → Source/File/Context → Indexing → Retrieval → Context Compilation → MCP → External Providers → Security/Reliability/Quality → Distribution.**

Individual Epics may proceed in parallel when their contracts and dependencies permit.

## Specification files

Epics 001–010 were specified before implementation. Epics 011 onward are approved
here by name, domain and priority; **each one's specification is written to the
[Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) as the first part of
its own change**, from this registry entry and the governance documents, and is
reviewed in that Epic's pull request alongside the implementation.

This is recorded because it means an Epic's acceptance criteria and the work that
satisfies them are authored together. Each validation document states it plainly.
Scope is drawn from the registry entry and the approved governance rules; a
specification that would expand scope beyond what this registry approved is a
governance change and must be raised rather than written.

## Epic Definition of Done

An Epic is `DONE` only when:

- scope is implemented;
- all acceptance criteria are satisfied;
- applicable unit/integration tests exist and pass;
- failure and boundary cases are tested;
- security implications are addressed;
- observability is adequate;
- documentation is updated;
- governance is satisfied;
- dependencies are validated;
- no known blocker remains;
- validation evidence is recorded.

## Approval

**APPROVED.** Registry v3.0 supersedes previous Epic registries. The catalog is intentionally functional rather than fixed-size; additional Epics may be introduced through normal governance when a capability warrants independent tracking.