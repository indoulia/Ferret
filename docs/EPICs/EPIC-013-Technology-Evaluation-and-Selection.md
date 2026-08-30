# EPIC-013 — Technology Evaluation & Selection

**Status: APPROVED**  
**Priority: P0**  
**Strategic Domain: Foundation & Architecture**

## Objective

Select the implementation technologies that materially affect Ferret's runtime weight, correctness, maintainability, portability, and operational simplicity using evidence rather than preference.

## Scope

Evaluate TypeScript/Node.js versus Python as the primary implementation stack and resolve the remaining material technology choices, including:

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

## TypeScript vs Python

TypeScript/Node.js is the current default candidate because it aligns naturally with NPM distribution, MCP, filesystem/Git tooling, and a single CLI/MCP runtime. Python remains a first-class candidate because of its document, data, OCR, and ML ecosystem.

The choice is not final until a representative spike measures cold start, idle memory, package size, MCP latency, PostgreSQL throughput, filesystem scanning, Git operations, document parsing, concurrency, failure handling, and cross-platform packaging.

## Mandatory reuse rule

Existing mature implementations must be evaluated before custom code is written. Ferret must not build its own PDF, Office, CSV, Git protocol, cryptographic, telemetry, or MCP implementation when an appropriate maintained implementation exists.

## Acceptance criteria

1. Each material technology decision has documented alternatives.
2. TypeScript and Python have comparable benchmark results for the representative workload.
3. Parser candidates are evaluated on correctness, structure preservation, provenance, malformed input, licensing, maintenance, performance, and native dependencies.
4. Data-access candidates are evaluated against required PostgreSQL behavior.
5. MCP uses an established SDK rather than a custom protocol implementation.
6. Queue, cache, search, graph, and object-storage infrastructure is not introduced without measured justification.
7. Final decisions are recorded in `docs/TECHNOLOGY-DECISIONS.md`.
8. The selected stack supports the zero/minimal-configuration product requirement.

## Definition of Done

- benchmark/spike results committed;
- decisions documented;
- rejected alternatives documented;
- licensing checked;
- dependency footprint reviewed;
- cross-platform packaging validated;
- governance compliance verified.
