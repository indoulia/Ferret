# EPIC-005 — Technology Evaluation & Selection

**Status: APPROVED | Priority: P0**  
**Strategic Domain: Foundation & Runtime**

## Objective
Select the implementation technologies that materially affect Ferret's runtime weight, correctness, maintainability, portability, and operational simplicity using measurable evidence rather than preference, with special focus on TypeScript/Node.js versus Python.

## Scope
Benchmark language/runtime candidates; evaluate package size, startup, memory, MCP integration, filesystem scanning, Git, PostgreSQL, representative PDF/DOCX/XLSX parsing, concurrency, cross-platform packaging, dependency friction, licensing, maintenance, and developer complexity.

Resolve the remaining material technology choices, including:

- SQL/data-access layer;
- code parsing;
- PDF parsing;
- DOCX parsing;
- XLSX parsing;
- CSV parsing;
- Git integration;
- embedding providers/interfaces;
- object storage strategy;
- background job strategy;
- caching strategy;
- observability implementation;
- MCP SDK/version;
- monorepo/package tooling.

## Non-scope
Implementation of Ferret itself. This Epic produces benchmark and evaluation artifacts plus recorded decisions, not product features. Foundation Epics (EPIC-001 onward) implement against the selected stack.

## Decision principle
TypeScript/Node.js is the current default candidate because it aligns naturally with NPM distribution, MCP, filesystem/Git tooling, and a single CLI/MCP runtime. Python remains a first-class candidate because of its document, data, OCR, and ML ecosystem. Neither is permanently frozen until evidence is reviewed.

The choice is not final until a representative spike measures cold start, idle memory, package size, MCP latency, PostgreSQL throughput, filesystem scanning, Git operations, document parsing, concurrency, failure handling, and cross-platform packaging.

## Mandatory reuse rule
Existing mature implementations must be evaluated before custom code is written. Ferret must not build its own PDF, Office, CSV, Git protocol, cryptographic, telemetry, or MCP implementation when an appropriate maintained implementation exists.

## Acceptance criteria
- Comparable TypeScript and Python spikes exist.
- Startup, idle memory, install/package footprint, MCP latency, PostgreSQL throughput, filesystem performance, Git operations, parsing, concurrency, and packaging are measured.
- Material libraries are evaluated for correctness, maintenance, licensing, security, performance, and native dependencies.
- Each material technology decision has documented alternatives.
- Parser candidates are evaluated on correctness, structure preservation, provenance, malformed input, licensing, maintenance, performance, and native dependencies.
- Data-access candidates are evaluated against required PostgreSQL behavior.
- MCP uses an established SDK rather than a custom protocol implementation.
- Rejected alternatives and reasons are documented.
- The final choice preserves the minimal-configuration requirement.
- No unnecessary queue/cache/search/graph infrastructure is introduced without measured justification.
- Final decisions are recorded in `docs/TECHNOLOGY-DECISIONS.md`.

## Tests/validation
Repeatable benchmark harness; representative corpus; clean-machine install; Windows/Linux/macOS packaging validation where applicable.

## Definition of Done
- benchmark/spike results committed;
- evidence reviewed;
- final technologies recorded in `docs/TECHNOLOGY-DECISIONS.md`;
- rejected alternatives documented;
- licensing checked;
- dependency footprint reviewed;
- cross-platform packaging validated;
- governance alignment confirmed.

## Governance alignment
Governance §5 (Reuse Before Reinvent), §14 (Lightweight Infrastructure), §21 (Versioning and Reproducibility), §22 (Change Management); AI Development Rules §4 (Search Before Building), §5 (No Reinvention), §6 (Evidence-Driven Decisions), §16 (Dependency Discipline).
