# Ferret Functional Epic Registry

**Status: APPROVED**  
**Registry Version: 3.0**  
**Effective: 2026-08-31**

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
- **EPIC-013 — Provider Registry & Discovery** — P0 — VALIDATED ([evidence](validation/EPIC-013-VALIDATION.md))
- **EPIC-014 — Provider Lifecycle & Health** — P1 — VALIDATED ([spec](EPIC-014-Provider-Lifecycle-And-Health.md), [evidence](validation/EPIC-014-VALIDATION.md))
- **EPIC-015 — Provider Configuration & Secrets** — P0 — VALIDATED ([spec](EPIC-015-Provider-Configuration-And-Secrets.md), [evidence](validation/EPIC-015-VALIDATION.md))
- **EPIC-016 — Provider Conformance Testing** — P0 — VALIDATED ([spec](EPIC-016-Provider-Conformance-Testing.md), [evidence](validation/EPIC-016-VALIDATION.md))

### Source Discovery & Git

- **EPIC-017 — Local Repository Discovery** — P0 — VALIDATED ([spec](EPIC-017-Local-Repository-Discovery.md), [evidence](validation/EPIC-017-VALIDATION.md))
- **EPIC-018 — Branch & Worktree Discovery** — P0 — VALIDATED ([spec](EPIC-018-Branch-Worktree-Discovery.md), [evidence](validation/EPIC-018-VALIDATION.md))
- **EPIC-019 — Git History Ingestion** — P0 — VALIDATED ([spec](EPIC-019-Git-History-Ingestion.md), [evidence](validation/EPIC-019-020-VALIDATION.md))
- **EPIC-020 — Commit & Reference Modeling** — P0 — VALIDATED ([spec](EPIC-020-Commit-Reference-Modeling.md), [evidence](validation/EPIC-019-020-VALIDATION.md))
- **EPIC-021 — GitHub Provider** — P1 — VALIDATED ([spec](EPIC-021-GitHub-Provider.md), [evidence](validation/EPIC-021-VALIDATION.md))

### File Intelligence

- **EPIC-022 — File Discovery** — P0 — VALIDATED ([spec](EPIC-022-023-File-Discovery-Identity.md), [evidence](validation/EPIC-022-023-VALIDATION.md))
- **EPIC-023 — File Identity & Content Hashing** — P0 — VALIDATED ([spec](EPIC-022-023-File-Discovery-Identity.md), [evidence](validation/EPIC-022-023-VALIDATION.md))
- **EPIC-024 — Parser Framework** — P0 — VALIDATED ([spec](EPIC-024-Parser-Framework.md), [evidence](validation/EPIC-024-VALIDATION.md))
- **EPIC-025 — Code File Parsing** — P0 — VALIDATED ([spec](EPIC-025-Code-File-Parsing.md), [evidence](validation/EPIC-025-VALIDATION.md))
- **EPIC-026 — PDF Intelligence** — P1 — VALIDATED ([spec](EPIC-026-PDF-Intelligence.md), [evidence](validation/EPIC-026-VALIDATION.md))
- **EPIC-027 — Office Document Intelligence** — P1 — VALIDATED ([spec](EPIC-027-Office-Document-Intelligence.md), [evidence](validation/EPIC-027-VALIDATION.md))
- **EPIC-028 — Spreadsheet Intelligence** — P1 — VALIDATED ([spec](EPIC-028-Spreadsheet-Intelligence.md), [evidence](validation/EPIC-028-VALIDATION.md))
- **EPIC-029 — Text & Markdown Intelligence** — P1 — VALIDATED ([spec](EPIC-029-Text-And-Markdown-Intelligence.md), [evidence](validation/EPIC-029-VALIDATION.md))
- **EPIC-030 — File Structure & Metadata** — P0 — VALIDATED ([spec](EPIC-030-File-Structure-And-Metadata.md), [evidence](validation/EPIC-030-VALIDATION.md))
- **EPIC-031 — Incremental Indexing** — P0 — VALIDATED ([spec](EPIC-031-Incremental-Indexing.md), [evidence](validation/EPIC-031-VALIDATION.md))
- **EPIC-032 — Index Lifecycle & Tombstones** — P0 — VALIDATED ([spec](EPIC-032-Index-Lifecycle-And-Tombstones.md), [evidence](validation/EPIC-032-VALIDATION.md))
- **EPIC-108 — Content Indexing Integration** — P0 — VALIDATED ([spec](EPIC-108-Content-Indexing-Integration.md), [evidence](validation/EPIC-108-VALIDATION.md))

### Code Intelligence

- **EPIC-033 — AST Model** — P0 — VALIDATED ([spec](EPIC-033-AST-Model.md), [evidence](validation/EPIC-033-VALIDATION.md))
- **EPIC-034 — Symbol Index** — P0 — VALIDATED ([spec](EPIC-034-Symbol-Index.md), [evidence](validation/EPIC-034-VALIDATION.md))
- **EPIC-035 — Reference & Relationship Index** — P1 — VALIDATED ([spec](EPIC-035-Reference-And-Relationship-Index.md), [evidence](validation/EPIC-035-VALIDATION.md))

### Engineering Context

- **EPIC-036 — Developer Identity** — P0 — VALIDATED ([spec](EPIC-036-Developer-Identity.md), [evidence](validation/EPIC-036-VALIDATION.md))
- **EPIC-037 — Repository Context** — P0 — VALIDATED ([spec](EPIC-037-038-Repository-And-Worktree-Context.md), [evidence](validation/EPIC-037-038-VALIDATION.md))
- **EPIC-038 — Worktree Context** — P0 — VALIDATED ([spec](EPIC-037-038-Repository-And-Worktree-Context.md), [evidence](validation/EPIC-037-038-VALIDATION.md))

### Session & Agent Memory

**P0 focus:** persistent AI-session memory is now a release-critical capability. Ferret must preserve useful AI context across session boundaries, make session state and durable checkpoints first-class, extract decisions and engineering knowledge from captured context, and support recovery/continuation without forcing the AI to rediscover prior work or consume the original session's full token budget. The raw session remains evidence; derived memory remains traceable to that evidence. AI-client-specific capture remains provider/adapter based so Claude is first, not exclusive.

- **EPIC-039 — Session Model** — P0 — VALIDATED ([evidence](validation/EPIC-039-VALIDATION.md))
- **EPIC-040 — Session Capture** — P0 — VALIDATED ([evidence](validation/EPIC-040-VALIDATION.md))
- **EPIC-041 — Durable Checkpoints** — P0 — VALIDATED ([evidence](validation/EPIC-041-VALIDATION.md))
- **EPIC-042 — Decision & Engineering Memory** — P0 — VALIDATED ([spec](EPIC-042-Decision-And-Engineering-Memory.md), [evidence](validation/EPIC-042-VALIDATION.md))
- **EPIC-043 — Session Recovery** — P0 — VALIDATED ([spec](EPIC-043-Session-Recovery.md), [evidence](validation/EPIC-043-VALIDATION.md))
- **EPIC-109 — Session & Memory Persistence** — P0 — VALIDATED ([spec](EPIC-109-Session-And-Memory-Persistence.md), [evidence](validation/EPIC-109-VALIDATION.md))
- **EPIC-110 — Session Command Surface** — P0 — VALIDATED ([spec](EPIC-110-Session-Command-Surface.md), [evidence](validation/EPIC-110-VALIDATION.md))
- **EPIC-111 — Session Recall Over MCP** — P0 — VALIDATED ([spec](EPIC-111-Session-Recall-Over-MCP.md), [evidence](validation/EPIC-111-VALIDATION.md))
- **EPIC-112 — Session Retention & Redaction** — P0 — VALIDATED ([spec](EPIC-112-Session-Retention-And-Redaction.md), [evidence](validation/EPIC-112-VALIDATION.md))
- **EPIC-116 — Session Export Fidelity** — P1 — VALIDATED ([spec](EPIC-116-Session-Export-Fidelity.md), [evidence](validation/EPIC-116-VALIDATION.md))
- **EPIC-117 — Recording a Session over MCP** — P1 — VALIDATED ([spec](EPIC-117-Recording-Over-MCP.md), [evidence](validation/EPIC-117-VALIDATION.md))

### Evidence & Provenance

- **EPIC-044 — Evidence Store** — P0 — VALIDATED ([spec](EPIC-044-045-Evidence-Store-And-Source-Authority.md), [evidence](validation/EPIC-044-045-VALIDATION.md))
- **EPIC-045 — Source Authority** — P0 — VALIDATED ([spec](EPIC-044-045-Evidence-Store-And-Source-Authority.md), [evidence](validation/EPIC-044-045-VALIDATION.md))
- **EPIC-046 — Confidence & Completeness** — P1 — VALIDATED ([spec](EPIC-046-Confidence-And-Completeness.md), [evidence](validation/EPIC-046-VALIDATION.md))
- **EPIC-047 — Conflict Detection** — P1 — VALIDATED ([spec](EPIC-047-Conflict-Detection.md), [evidence](validation/EPIC-047-VALIDATION.md))
- **EPIC-048 — Answer Traceability** — P0 — VALIDATED ([spec](EPIC-048-Answer-Traceability.md), [evidence](validation/EPIC-048-VALIDATION.md))

### Knowledge Graph & Relationships

- **EPIC-049 — Relationship Storage** — P0 — VALIDATED ([spec](EPIC-049-Relationship-Storage.md), [evidence](validation/EPIC-049-VALIDATION.md))
- **EPIC-050 — Relationship Traversal** — P1 — VALIDATED ([spec](EPIC-050-Relationship-Traversal.md), [evidence](validation/EPIC-050-VALIDATION.md))
- **EPIC-051 — Cross-Source Entity Resolution** — P1 — VALIDATED ([spec](EPIC-051-Cross-Source-Entity-Resolution.md), [evidence](validation/EPIC-051-VALIDATION.md))

### Search & Retrieval

- **EPIC-052 — Exact Structured Retrieval** — P0 — VALIDATED ([spec](EPIC-052-053-Retrieval.md), [evidence](validation/EPIC-052-053-VALIDATION.md))
- **EPIC-053 — Full-Text Retrieval** — P0 — VALIDATED ([spec](EPIC-052-053-Retrieval.md), [evidence](validation/EPIC-052-053-VALIDATION.md))
- **EPIC-054 — Semantic Retrieval** — P1 — VALIDATED ([spec](EPIC-054-055-Semantic-And-Planner.md), [evidence](validation/EPIC-054-055-VALIDATION.md))
- **EPIC-055 — Hybrid Query Planner** — P0 — VALIDATED ([spec](EPIC-054-055-Semantic-And-Planner.md), [evidence](validation/EPIC-054-055-VALIDATION.md))
- **EPIC-056 — Ranking & Reranking** — P1 — VALIDATED ([spec](EPIC-056-Ranking-And-Reranking.md), [evidence](validation/EPIC-056-VALIDATION.md))
- **EPIC-057 — Freshness & Authority Ranking** — P1 — VALIDATED ([spec](EPIC-057-Freshness-And-Authority-Ranking.md), [evidence](validation/EPIC-057-VALIDATION.md))
- **EPIC-058 — Permission-Aware Retrieval** — P0 — VALIDATED ([spec](EPIC-058-Permission-Aware-Retrieval.md), [evidence](validation/EPIC-058-VALIDATION.md))

### Context Compilation

- **EPIC-059 — Context Packs** — P0 — VALIDATED ([spec](EPIC-059-061-064-065-Context-And-MCP.md), [evidence](validation/EPIC-059-061-064-065-VALIDATION.md))
- **EPIC-060 — Answer Packs** — P0 — VALIDATED ([spec](EPIC-060-Answer-Packs.md), [evidence](validation/EPIC-060-VALIDATION.md))
- **EPIC-061 — Token Budgeting** — P0 — VALIDATED ([spec](EPIC-059-061-064-065-Context-And-MCP.md), [evidence](validation/EPIC-059-061-064-065-VALIDATION.md))
- **EPIC-062 — Evidence Selection** — P0 — VALIDATED ([spec](EPIC-062-Evidence-Selection.md), [evidence](validation/EPIC-062-VALIDATION.md))
- **EPIC-063 — Query Explanation** — P1 — VALIDATED ([spec](EPIC-063-Query-Explanation.md), [evidence](validation/EPIC-063-VALIDATION.md))

### AI Control Plane & MCP

- **EPIC-064 — MCP Server** — P0 — VALIDATED ([spec](EPIC-059-061-064-065-Context-And-MCP.md), [evidence](validation/EPIC-059-061-064-065-VALIDATION.md))
- **EPIC-065 — MCP Knowledge Tools** — P0 — VALIDATED ([spec](EPIC-059-061-064-065-Context-And-MCP.md), [evidence](validation/EPIC-059-061-064-065-VALIDATION.md))
- **EPIC-066 — MCP Configuration Tools** — P0 — VALIDATED ([spec](EPIC-066-MCP-Configuration-Tools.md), [evidence](validation/EPIC-066-VALIDATION.md))
- **EPIC-067 — MCP Provider Administration** — P1 — VALIDATED ([spec](EPIC-067-MCP-Provider-Administration.md), [evidence](validation/EPIC-067-VALIDATION.md))
- **EPIC-068 — AI Authorization Model** — P0 — VALIDATED ([spec](EPIC-068-AI-Authorization-Model.md), [evidence](validation/EPIC-068-VALIDATION.md))
- **EPIC-069 — Destructive Operation Confirmation** — P0 — VALIDATED ([spec](EPIC-069-Destructive-Operation-Confirmation.md), [evidence](validation/EPIC-069-VALIDATION.md))
- **EPIC-070 — AI Client Capability Discovery** — P1 — VALIDATED ([spec](EPIC-070-AI-Client-Capability-Discovery.md), [evidence](validation/EPIC-070-VALIDATION.md))

### External Project Knowledge

- **EPIC-071 — Jira Provider** — P1 — VALIDATED ([spec](EPIC-071-Jira-Provider.md), [evidence](validation/EPIC-071-VALIDATION.md))
- **EPIC-072 — Pull Request & Review Modeling** — P1 — VALIDATED ([spec](EPIC-072-Pull-Request-And-Review-Modeling.md), [evidence](validation/EPIC-072-VALIDATION.md))
- **EPIC-073 — Release & Deployment Modeling** — P1 — VALIDATED ([spec](EPIC-073-Release-And-Deployment-Modeling.md), [evidence](validation/EPIC-073-VALIDATION.md))
- **EPIC-074 — External Provider Extension Framework** — P2 — VALIDATED ([spec](EPIC-074-External-Provider-Extension-Framework.md), [evidence](validation/EPIC-074-VALIDATION.md))

### Synchronization & Reconciliation

- **EPIC-075 — Sync Cursor Management** — P0 — VALIDATED ([spec](EPIC-075-Sync-Cursor-Management.md), [evidence](validation/EPIC-075-VALIDATION.md))
- **EPIC-076 — Incremental Source Synchronization** — P0 — VALIDATED ([spec](EPIC-076-Incremental-Source-Synchronization.md), [evidence](validation/EPIC-076-VALIDATION.md))
- **EPIC-077 — Event & Webhook Ingestion** — P1 — VALIDATED ([spec](EPIC-077-Event-And-Webhook-Ingestion.md), [evidence](validation/EPIC-077-VALIDATION.md))
- **EPIC-078 — Periodic Reconciliation** — P1 — VALIDATED ([spec](EPIC-078-Periodic-Reconciliation.md), [evidence](validation/EPIC-078-VALIDATION.md))
- **EPIC-079 — Retry & Backoff** — P0 — VALIDATED ([spec](EPIC-079-Retry-And-Backoff.md), [evidence](validation/EPIC-079-VALIDATION.md))
- **EPIC-080 — Idempotent Ingestion** — P0 — VALIDATED ([spec](EPIC-080-Idempotent-Ingestion.md), [evidence](validation/EPIC-080-VALIDATION.md))
- **EPIC-113 — Provider Sync Transport (`ferret sync`)** — P1 — VALIDATED ([spec](EPIC-113-Provider-Sync-Transport.md), [evidence](validation/EPIC-113-VALIDATION.md))
- **EPIC-119 — Universal Source Connector Contract** — P1 — VALIDATED ([spec](EPIC-119-Universal-Source-Connector-Contract.md), [evidence](validation/EPIC-119-VALIDATION.md))

### Security & Authorization

- **EPIC-081 — Credential Isolation** — P0 — VALIDATED ([spec](EPIC-081-Credential-Isolation.md), [evidence](validation/EPIC-081-VALIDATION.md))
- **EPIC-082 — Secret Detection & Exclusion** — P0 — VALIDATED ([spec](EPIC-082-Secret-Detection.md), [evidence](validation/EPIC-082-VALIDATION.md))
- **EPIC-083 — Authorization Enforcement** — P0 — VALIDATED ([spec](EPIC-083-Authorization-Enforcement.md), [evidence](validation/EPIC-083-VALIDATION.md))
- **EPIC-084 — Prompt-Injection Resistance** — P0 — VALIDATED ([spec](EPIC-084-Prompt-Injection-Resistance.md), [evidence](validation/EPIC-084-VALIDATION.md))
- **EPIC-085 — Audit Events** — P1 — VALIDATED ([spec](EPIC-085-Audit-Events.md), [evidence](validation/EPIC-085-VALIDATION.md))

### Storage & Data Lifecycle

- **EPIC-086 — PostgreSQL Storage Layer** — P0 — VALIDATED ([spec](EPIC-086-PostgreSQL-Storage-Layer.md), [evidence](validation/EPIC-086-VALIDATION.md))
- **EPIC-087 — Deduplicated Content Storage** — P0 — VALIDATED ([spec](EPIC-087-Deduplicated-Content-Storage.md), [evidence](validation/EPIC-087-VALIDATION.md))
- **EPIC-088 — Retention & Exclusion Policies** — P1 — VALIDATED ([spec](EPIC-088-Retention-And-Exclusion-Policies.md), [evidence](validation/EPIC-088-VALIDATION.md))
- **EPIC-089 — Backup & Export** — P1 — VALIDATED ([spec](EPIC-089-Backup-And-Export.md), [evidence](validation/EPIC-089-VALIDATION.md))
- **EPIC-090 — Data Import & Recovery** — P1 — VALIDATED ([spec](EPIC-090-Data-Import-And-Recovery.md), [evidence](validation/EPIC-090-VALIDATION.md))
- **EPIC-114 — PostgreSQL Version Coverage** — P1 — VALIDATED ([spec](EPIC-114-PostgreSQL-Version-Coverage.md), [evidence](validation/EPIC-114-VALIDATION.md))

### Reliability & Operations

- **EPIC-091 — Structured Logging** — P0 — VALIDATED ([spec](EPIC-091-Structured-Logging.md), [evidence](validation/EPIC-091-VALIDATION.md))
- **EPIC-092 — Metrics & Tracing** — P1 — VALIDATED ([spec](EPIC-092-Metrics-And-Tracing.md), [evidence](validation/EPIC-092-VALIDATION.md))
- **EPIC-093 — Provider Failure Isolation** — P0 — VALIDATED ([spec](EPIC-093-Provider-Failure-Isolation.md), [evidence](validation/EPIC-093-VALIDATION.md))
- **EPIC-094 — Index Integrity & Recovery** — P0 — VALIDATED ([spec](EPIC-094-Index-Integrity-And-Recovery.md), [evidence](validation/EPIC-094-VALIDATION.md))
- **EPIC-095 — Operational Diagnostics** — P0 — VALIDATED ([spec](EPIC-095-Operational-Diagnostics.md), [evidence](validation/EPIC-095-VALIDATION.md))

### Evaluation & Quality

- **EPIC-096 — Golden Evaluation Dataset** — P0 — VALIDATED ([spec](EPIC-096-Golden-Evaluation-Dataset.md), [evidence](validation/EPIC-096-VALIDATION.md))
- **EPIC-097 — Parser Quality Harness** — P0 — VALIDATED ([spec](EPIC-097-Parser-Quality-Harness.md), [evidence](validation/EPIC-097-VALIDATION.md))
- **EPIC-098 — Retrieval Quality Harness** — P0 — VALIDATED ([spec](EPIC-098-Retrieval-Quality-Harness.md), [evidence](validation/EPIC-098-VALIDATION.md))
- **EPIC-099 — Provider Conformance Harness** — P0 — VALIDATED ([spec](EPIC-099-Provider-Conformance-Harness.md), [evidence](validation/EPIC-099-VALIDATION.md))
- **EPIC-100 — Security Regression Suite** — P0 — VALIDATED ([spec](EPIC-100-Security-Regression-Suite.md), [evidence](validation/EPIC-100-VALIDATION.md))
- **EPIC-101 — Performance & Scale Benchmarks** — P1 — VALIDATED ([spec](EPIC-101-Performance-And-Scale-Benchmarks.md), [evidence](validation/EPIC-101-VALIDATION.md))
- **EPIC-118 — Ferret Self-Dogfood** — P1 — VALIDATED ([spec](EPIC-118-Ferret-Self-Dogfood.md), [evidence](validation/EPIC-118-VALIDATION.md))

### Distribution & Developer Experience

- **EPIC-102 — NPM Distribution** — P0 — VALIDATED ([spec](EPIC-102-103-104-Distribution.md), [evidence](validation/EPIC-102-103-104-VALIDATION.md))
- **EPIC-103 — Global CLI** — P0 — VALIDATED ([spec](EPIC-102-103-104-Distribution.md), [evidence](validation/EPIC-102-103-104-VALIDATION.md))
- **EPIC-104 — AI Client Onboarding** — P0 — VALIDATED ([spec](EPIC-102-103-104-Distribution.md), [evidence](validation/EPIC-102-103-104-VALIDATION.md))
- **EPIC-105 — Cross-Platform Packaging** — P1 — VALIDATED ([spec](EPIC-105-Cross-Platform-Packaging.md), [evidence](validation/EPIC-105-VALIDATION.md))
- **EPIC-106 — Upgrade & Migration UX** — P1 — VALIDATED ([spec](EPIC-106-Upgrade-And-Migration-UX.md), [evidence](validation/EPIC-106-VALIDATION.md))
- **EPIC-107 — Docker Distribution** — P2 — VALIDATED ([spec](EPIC-107-Docker-Distribution.md), [evidence](validation/EPIC-107-VALIDATION.md))
- **EPIC-115 — macOS Packaging Validation** — P2 — CLOSED — coverage DEFERRED by owner decision ([spec](EPIC-115-macOS-Packaging-Validation.md), [evidence](validation/EPIC-115-VALIDATION.md))

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

This registry update explicitly elevates Session & Agent Memory to release-critical P0 focus; no separate Claude-specific Epic is introduced because client-specific capture belongs behind the provider/adapter boundary.

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

## P0 closure pass — 2026-09-02

Assessed against `5293434`, then closed. Every P0 Epic was classified from its
own acceptance-criteria table rather than from its registry status line, by
sweeping every AC row in all 66 validation documents. Where the two disagreed,
the AC table won.

**76 P0 Epics: 75 VALIDATED or DONE, 1 IMPLEMENTED.**

Eight acceptance criteria were open. Six were closed by implementation or by
evidence already on record; one criterion remains, and it is blocked on a P1
Epic rather than on work anybody has declined to do.

| Epic | AC | was | now |
| --- | --- | --- | --- |
| EPIC-032 | AC-7 reference lifecycle | NOT APPLICABLE — a declared scope item that did not ship, in a row reading `VALIDATED` | **MET** — branches retired from a complete enumeration; a bounded one retires nothing |
| EPIC-048 | AC-11 permitted scopes | PARTIAL | **MET** — closed by EPIC-058 §6; dated addendum, original row intact |
| EPIC-080 | AC-5 a second index writes no row | PARTIAL | **MET** — closed by EPIC-076 AC-1; dated addendum, original row intact |
| EPIC-094 | AC-7 stale artefact of any kind | PARTIAL | **MET** — `SweepOptions.producerIdentity`, a port because `src/storage/` may not import a parser |
| EPIC-094 | AC-11 repair supersedes | PARTIAL (effect) | **MET** — issue #101's recorded cause was wrong; the real one is `upsert`'s hash short-circuit |
| EPIC-094 | AC-13 interrupted repair | PENDING | **MET** — the watermark half did inherit from EPIC-031 AC-6; the `markStale` residue did not |
| EPIC-100 | AC-8 no unreachable control | NOT MET | **MET** — transitive reachability over the declared control surface; found one on its first run |
| EPIC-087 | AC-11 p@10 above 0.32 | NOT MET | **NOT MET** — re-measured unchanged at 0.2639; see below |

**No acceptance criterion was changed, reinterpreted or restated.** Two were
closed by evidence a later Epic had already produced and nobody had gone back to
record — the mirror of EPIC-076's finding, one document further on.

### Where the earlier records were wrong, and it matters

- **EPIC-094 AC-11 / issue #101.** The filed cause blamed the `ifAbsent`
  placeholder mechanism. It is innocent. `EntityStore.upsert` returns
  `unchanged` when the recomputed hash equals the stored one, and an alteration
  made outside Ferret leaves `content_hash` intact — so re-derivation never
  reached the placeholder decision. The repository case #101 called "the one row
  a re-index will never rewrite" now repairs, with `ifAbsent` untouched.
- **EPIC-032 AC-7.** Deferred on the reasoning that retiring a ref by absence
  would apply a weaker standard than files get. The criterion's own wording
  resolves it — absence is not evidence *in a partial read*, and for a ref a
  complete enumeration is the only observation Git will ever produce, which the
  specification's §3.4 already said. What was actually missing was a completeness
  signal: the provider returned one and `IndexableSource.listBranches` discarded
  it.
- **Issue #109.** The flaky query-plan test passed only while PostgreSQL lacked
  statistics — on 74 rows a sequential scan is genuinely cheaper. A false
  negative, so no `npm run verify` cited by any P0 record was green *because* of
  it. Now deterministic, and it fails if the index is dropped, which it did not
  before.

### EPIC-087 AC-11 — the one criterion still open

Re-measured on `5293434` against real PostgreSQL: mean p@10 **0.2639** against a
0.32 baseline, recall 0.9167, RR 0.5972, nDCG 0.6698, falsePositives 0.
`text-authentication` recall is 1.00, so the criterion's first half holds and its
second does not. Unmoved from what EPIC-087 recorded.

The cause is [#98](https://github.com/indoulia/Ferret/issues/98), whose owner is
now settled: **EPIC-056 — Ranking & Reranking**, on the written non-scope of both
candidates. EPIC-034 §4 — "ranking. This Epic returns matches in a defined order;
EPIC-056 ranks." EPIC-052/053 §4 — "Ranking that is comparable across queries —
EPIC-056." The measurement agrees: recall is identical either side of the
regression while RR nearly halves, and a defect that moves ordering without
moving recall is a ranking defect. Recorded with its evidence in
`docs/Architecture/EPIC-087-DECISIONS.md` §D1.

EPIC-056 is **P1**. So a P0 criterion is blocked on P1 work, which is a
governance position this pass does not take. The options remain the three
EPIC-087 itself put on the table — leave EPIC-087 `IMPLEMENTED`, promote
EPIC-056 to P0, or restate AC-11 — with the difference that promoting is now a
decision about one named Epic rather than an open question.

### Addendum — EPIC-087 AC-11 is closed, and by the option this pass named third

**2026-09-02, after EPIC-056 — Ranking & Reranking.** The pass above is left as
written; this records what happened next rather than revising it.

The closure pass left one criterion open and said the choice was between three
options: leave EPIC-087 `IMPLEMENTED`, promote EPIC-056 to P0, or restate AC-11.
None was taken. EPIC-056 was specified and implemented at **P1**, on the priority
the registry has always given it, and AC-11 closed on its own terms:

| | mean p@10 | mean recall | mean RR | mean nDCG |
| --- | --- | --- | --- | --- |
| `5293434` | 0.2639 | 0.9167 | 0.5972 | 0.6698 |
| with EPIC-056 | **0.3611** | **0.9167** | **0.6806** | **0.7313** |

Labels unchanged, `falsePositives` still 0, `text-authentication` recall 1.00. So
AC-11 is **MET** with no restatement, EPIC-087 moves to **VALIDATED**, and the
governance position this pass declined to take was not needed. Issue
[#98](https://github.com/indoulia/Ferret/issues/98) is closed by the same
measurement, and its ownership — settled in
`docs/Architecture/EPIC-087-DECISIONS.md` §D1 — held.

**76 P0 Epics: 76 VALIDATED or DONE.**

The general lesson is the one EPIC-076 and this pass had already found twice: a
P0 criterion blocked on P1 work is not necessarily a priority problem. Here it
was one Epic of scoped work whose absence three other Epics had each written down
and named.

### Registry hygiene

Nine limitation rows across four documents parked live work on EPIC-032, which is
closed and never had that scope; EPIC-076 added a tenth. Owners were struck
rather than overwritten and corrected from each row's own reasoning — four to a
determinable owner, two to none as accepted design decisions, three left
`unassigned` because the registry does not determine one. None is P0.
Tracked in [#117](https://github.com/indoulia/Ferret/issues/117).

## Catalog reconciliation — 2026-09-05

Four Epics reached `main` without a catalog entry and without a validation
record. EPIC-109, EPIC-110, EPIC-111 and EPIC-112 were specified, implemented,
reviewed and merged in [#156](https://github.com/indoulia/Ferret/pull/156),
[#157](https://github.com/indoulia/Ferret/pull/157),
[#158](https://github.com/indoulia/Ferret/pull/158) and
[#159](https://github.com/indoulia/Ferret/pull/159); the registry knew nothing
about any of them, so the authoritative delivery map was silent on the whole of
the Session & Agent Memory persistence work.

**They are added above rather than introduced.** They were approved by the
governance that reviewed and merged them; what was missing is the record, not the
approval. The four entries and the four validation documents together close the
Definition of Done's last clause — *validation evidence is recorded* — which was
the one clause unmet on all four.

Two facts are recorded rather than tidied away:

- The validation documents were written **after** the merges, not alongside them.
  [Specification files](#specification-files) says the specification and the work
  are authored together, and each validation document states that plainly. For
  these four it is not true, and each says so at the top. The evidence in them is
  measured on the merged tree, not reconstructed.
- Nothing about the four Epics' status changed here. Each was `VALIDATED` on the
  evidence that existed at merge; this pass recorded that evidence in the form
  the registry requires, and re-ran every cited suite to confirm it still holds.

Continuing work, and what is blocked, is tracked in
[ROADMAP.md](ROADMAP.md) rather than here: the registry maps delivery, and the
roadmap maps what has not been decided.

### Addendum — the queue's own five, and a test that refuses the next one

Five more Epics reached `main` without a catalog entry: EPIC-113, EPIC-114,
EPIC-115, EPIC-116 and EPIC-117, merged in
[#163](https://github.com/indoulia/Ferret/pull/163),
[#166](https://github.com/indoulia/Ferret/pull/166),
[#167](https://github.com/indoulia/Ferret/pull/167),
[#164](https://github.com/indoulia/Ferret/pull/164) and
[#165](https://github.com/indoulia/Ferret/pull/165). They are added above.

**The gap is narrower than the four above it.** Each of the five was specified
first and carries a validation record written with the work, and
[ROADMAP.md](ROADMAP.md) recorded every one of them as delivered. Only the
catalog row was missing — so the Definition of Done was met and the delivery map
still did not say so. Nothing here changes a status: EPIC-113, EPIC-114,
EPIC-116 and EPIC-117 were `VALIDATED` on their own evidence, and EPIC-115 is
`CLOSED` with macOS coverage `DEFERRED` by the owner decision of 2026-09-05,
which this pass does not revisit.

Two things the entries changed, and neither is a status:

**EPIC-115 is the first row in this catalog that is not `VALIDATED` or `DONE`,
and adding it found a reader that could not have read it.** The sweep in
`tests/unit/limitation-owners.test.ts` reads a row's status to decide whether an
Epic can still take new work. It did not know the word `CLOSED`, so it would
have taken the one closed Epic here for an open one — and it read the *whole*
file, so a paragraph below the catalog that opens `- **EPIC-094 AC-11 / issue
#101.**` was taken for a row and overwrote EPIC-094's real status. EPIC-032 and
EPIC-118 were shadowed the same way. Both faults are one parser now
(`tests/helpers/registry.ts`): it reads the catalog section only, and it knows
`CLOSED`. The pinned count of limitations parked on a closed Epic moved 67 → 68,
its first upward move, and no new stale limitation appeared — EPIC-094 became
closed again, which revealed the third owner of a row already parked twice.

**EPIC-118 added its own row in its own pull request**
([#173](https://github.com/indoulia/Ferret/pull/173)), which is the routine the
five missed and the four before them missed. That routine is now checked rather
than remembered: `tests/unit/registry-catalog.test.ts` fails when an Epic has a
specification or a validation record and no row here. It permits the reverse — a
row with no file is the order of work [Specification files](#specification-files)
describes, and a file with no row is a delivery this map does not show.

## Approval

**APPROVED.** Registry v3.0 supersedes previous Epic registries. The catalog is intentionally functional rather than fixed-size; additional Epics may be introduced through normal governance when a capability warrants independent tracking.
