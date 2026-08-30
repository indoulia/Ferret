# Ferret Functional Epics

**Status: APPROVED**  
**Registry Version: 2.0**  
**Effective: 2026-08-30**

## Purpose

This registry defines the implementation-level Epics for Ferret. The former 12 broad entries are strategic domains, not implementation Epics. Implementation Epics are deliberately smaller functional capabilities so that each can be independently planned, implemented, tested, validated, tracked, and completed.

## Definition of an Epic

One Epic represents one independently meaningful capability with a bounded objective, explicit non-scope, dependencies, acceptance criteria, test expectations, and Definition of Done.

An Epic must be large enough to deliver meaningful value and small enough to reach `DONE` without hiding unrelated unfinished work.

## Lifecycle

`PROPOSED → REVIEWED → APPROVED → READY → IN PROGRESS → BLOCKED/IMPLEMENTED → VALIDATING → VALIDATED → DONE`

## Approved functional Epics

### Foundation & Runtime
- **EPIC-001 — Core Runtime & Package** — P0 — installable Ferret runtime and package boundary.
- **EPIC-002 — Database Bootstrap & Migrations** — P0 — automatic schema provisioning and safe migrations.
- **EPIC-003 — Configuration Engine** — P0 — minimal configuration, precedence, persistence, and validation.
- **EPIC-004 — Runtime Health & Diagnostics** — P0 — status, doctor, structured errors, and operational diagnostics.

### Canonical Knowledge
- **EPIC-005 — Canonical Entity Model** — P0 — provider-neutral entities and identifiers.
- **EPIC-006 — Relationships & Temporal Model** — P0 — typed relationships and historical state.
- **EPIC-007 — Evidence & Provenance Model** — P0 — source evidence, provenance, authority, and derivation.
- **EPIC-008 — Identity & Scope Model** — P0 — developers, agents, repositories, worktrees, and scopes.

### Provider Platform
- **EPIC-009 — Provider SDK & Contracts** — P0 — stable provider interfaces and conformance contracts.
- **EPIC-010 — Provider Registry & Lifecycle** — P0 — discovery, enablement, health, compatibility, and isolation.
- **EPIC-011 — Provider Configuration & Secrets** — P0 — secure, AI-manageable provider configuration.

### Source Discovery & Git
- **EPIC-012 — Local Repository Discovery** — P0 — automatic repository and worktree discovery.
- **EPIC-013 — Git History Provider** — P0 — commits, branches, tags, and historical Git state.
- **EPIC-014 — GitHub Provider** — P1 — repositories, PRs, reviews, issues, releases, and relationships.

### File Intelligence
- **EPIC-015 — File Discovery & Identity** — P0 — file identity, metadata, hashes, and lifecycle.
- **EPIC-016 — Parser Framework** — P0 — pluggable parser selection and normalized extraction.
- **EPIC-017 — Code Intelligence** — P0 — AST/symbol-aware code indexing using mature tooling.
- **EPIC-018 — Document Intelligence** — P1 — PDF, DOCX, Markdown, and text structure/provenance.
- **EPIC-019 — Spreadsheet Intelligence** — P1 — XLSX/CSV structure, sheets, tables, cells, and formulas.
- **EPIC-020 — Incremental Indexing & Deduplication** — P0 — hash-based incremental processing and idempotency.
- **EPIC-021 — Index Lifecycle & Recovery** — P1 — tombstones, rebuilds, parser versions, and integrity recovery.

### Engineering Context
- **EPIC-022 — Session Capture** — P0 — durable AI session state and activity context.
- **EPIC-023 — Checkpoints & Session Recovery** — P0 — resumable work context without transcript replay.
- **EPIC-024 — Decisions & Engineering Memory** — P1 — durable decisions, assumptions, problems, and solutions.

### Retrieval & Context
- **EPIC-025 — Query Understanding & Entity Resolution** — P0 — turn natural language into structured retrieval intent.
- **EPIC-026 — Hybrid Search** — P0 — structured, full-text, semantic, and relationship retrieval.
- **EPIC-027 — Ranking, Freshness & Authority** — P0 — evidence-aware ranking and conflict handling.
- **EPIC-028 — Context Pack Compiler** — P0 — compact token-efficient context for AI clients.
- **EPIC-029 — Evidence-backed Answer Support** — P0 — provenance, confidence, completeness, and explainability.

### AI Control Plane
- **EPIC-030 — MCP Server & Capability Discovery** — P0 — standard AI interface and self-description.
- **EPIC-031 — AI Configuration Control Plane** — P0 — configuration and administration through AI.
- **EPIC-032 — AI Authorization & Confirmation** — P0 — permission classes and destructive-operation safeguards.

### External Project Knowledge
- **EPIC-033 — Jira Provider** — P1 — issues, comments, status history, releases, and relationships.
- **EPIC-034 — External Provider Framework Extensions** — P2 — patterns enabling Slack, CI/CD, PM, and future systems.

### Reliability, Security & Quality
- **EPIC-035 — Synchronization & Reconciliation** — P1 — cursors, retries, event processing, and convergence.
- **EPIC-036 — Security & Secret Protection** — P0 — access boundaries, secret exclusion, and prompt-injection resistance.
- **EPIC-037 — Observability & Audit** — P1 — logs, metrics, tracing, provider state, and auditability.
- **EPIC-038 — Evaluation & Quality Gates** — P0 — golden datasets, parser fixtures, retrieval metrics, and release gates.

### Distribution
- **EPIC-039 — NPM Distribution & Upgrade** — P1 — global installation, upgrades, compatibility, and packaging.
- **EPIC-040 — AI Client Onboarding** — P1 — generated MCP/client instructions and zero-friction onboarding.

## Strategic domains

The old broad categories remain useful as architecture domains, but they are no longer implementation tracking units. The functional Epics above may cross domain boundaries only through explicit contracts.

## Dependency baseline

The primary dependency direction is:

**001/002/003 → 005/006/007/008 → 009/010/011 → 012/013/015/016 → 017/018/019/020/021 → 022/023/024 → 025/026/027/028/029 → 030/031/032 → 014/033/034/035/036/037/038 → 039/040**

This is a dependency guide, not a prohibition on parallel work.

## Epic Definition of Done

An Epic is `DONE` only when:

- scope is implemented;
- all acceptance criteria are satisfied;
- unit/integration tests exist where applicable;
- failure and boundary cases are tested;
- security implications are tested;
- observability is adequate;
- documentation is updated;
- governance is satisfied;
- dependencies are validated;
- no known blocker remains;
- validation evidence is recorded.

## Scope discipline

Do not expand an approved Epic silently. If a capability becomes independently valuable or independently testable, create a new Epic. Do not create artificial Epics merely to inflate tracking granularity.

## Approval

**APPROVED.** Registry v2.0 supersedes the previous 12-entry implementation registry. The previous entries remain useful as strategic domains but are no longer the unit of implementation tracking.