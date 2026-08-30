# Ferret Technology Decisions

**Status: APPROVED**  
**Version: 1.0**  
**Effective: 2026-08-30**

This document records the technology-selection framework for Ferret. Architectural principles are approved; individual implementation technologies marked EVALUATE remain subject to evidence-based selection before implementation.

## 1. Frozen technology direction

- **Distribution:** NPM-first.
- **Primary runtime candidate:** Node.js LTS.
- **Primary language candidate:** TypeScript.
- **Primary persistence:** PostgreSQL.
- **Vector search:** pgvector where semantic search is required.
- **Full-text search:** PostgreSQL FTS initially.
- **AI protocol:** MCP using the established official SDK.
- **Code parsing direction:** Tree-sitter and other mature language tooling where appropriate.
- **Document parsing:** mature existing libraries/providers; no custom PDF/Office parsers.
- **Observability:** OpenTelemetry-compatible architecture.
- **Testing direction:** Vitest plus real PostgreSQL integration tests using Testcontainers or an equivalent mature approach.
- **Logging direction:** structured logging using a mature implementation such as Pino.

## 2. TypeScript vs Python — decision framework

**Decision: EVALUATE before implementation; TypeScript is the current default, not a permanent commitment.**

Ferret must optimize for total product weight, installation simplicity, ecosystem maturity, parser availability, MCP/client integration, filesystem/Git integration, startup/runtime behavior, memory footprint, developer experience, and operational simplicity—not language preference.

### TypeScript advantages

- native NPM/global installation model;
- excellent fit for an MCP server and AI tooling ecosystem;
- strong filesystem, Git, API, and CLI ecosystem;
- single runtime for CLI and MCP;
- strong type system and shared types across contracts;
- straightforward distribution as a single NPM product.

### Python advantages

- exceptionally strong document/data/ML ecosystem;
- mature parsing and scientific tooling;
- excellent ecosystem for future extraction, NLP, OCR, and model workloads;
- potentially simpler implementation for some indexing/data-processing tasks.

### Python risks for Ferret

- Python environment/distribution can complicate a globally installed cross-platform product;
- dependency/native-package management can increase provisioning complexity;
- shipping a consistently lightweight standalone runtime may require additional packaging decisions;
- using Python for CLI/MCP while separately managing Node tooling could increase rather than reduce system complexity.

### Required benchmark before locking the language

Build a representative spike for both candidates covering:

1. cold startup time;
2. idle memory;
3. CLI package/install size;
4. MCP server startup and tool latency;
5. PostgreSQL throughput;
6. filesystem scanning;
7. Git operations;
8. representative PDF/DOCX/XLSX parsing;
9. Tree-sitter integration;
10. concurrent indexing;
11. failure/retry behavior;
12. packaging on Windows, Linux, and macOS;
13. developer implementation complexity;
14. dependency/native-library friction.

The winner must be selected from measurements and ecosystem evidence. A mixed-language architecture is allowed only when it produces a clear measured benefit without violating lightweight operation or provider boundaries.

## 3. Query/data access layer — EVALUATE

Evaluate mature type-safe SQL approaches, initially including Drizzle and Kysely. Select based on migration quality, PostgreSQL feature coverage, query expressiveness, runtime overhead, type safety, operational simplicity, and long-term maintainability.

Avoid introducing an abstraction that hides important PostgreSQL behavior needed by the knowledge engine.

## 4. Parser selection — EVALUATE per capability

For each supported file type, evaluate existing mature libraries before implementation. Selection criteria include correctness, maintenance health, licensing, performance, malformed-input behavior, structure preservation, provenance support, and native dependency burden.

Ferret owns normalization, provenance, versioning, indexing, and canonical representation—not reimplementation of mature parser internals.

## 5. Git implementation — EVALUATE

Evaluate an established Git library versus invoking the installed Git executable. Consider correctness, platform behavior, repository feature coverage, performance, security, authentication boundaries, and installation assumptions.

## 6. Embeddings — PROVIDER ABSTRACTION

No embedding vendor is mandatory. The embedding interface must support hosted and local implementations. Embeddings are optional augmentation, not the foundation of deterministic retrieval.

## 7. Object storage — OPTIONAL

Start with PostgreSQL-backed metadata and the simplest practical content strategy. Introduce an S3-compatible storage provider only when file size, scale, backup, or operational evidence justifies it.

## 8. Queue/cache/search/graph infrastructure — DEFERRED

No external queue, cache, dedicated search engine, vector database, or graph database is mandatory initially.

Potential future providers may include Redis, OpenSearch, dedicated vector stores, graph stores, or managed queues, but each requires a measured justification and must not become a prerequisite for normal installation without governance approval.

## 9. Selection rule

For every technology decision:

1. Prefer an established standard.
2. Prefer a mature maintained implementation.
3. Prefer fewer operational dependencies.
4. Prefer the solution that keeps installation simple.
5. Benchmark where the decision materially affects performance or reliability.
6. Record rejected alternatives and the reason.
7. Revisit only when new evidence or requirements justify change.

**No technology is selected merely because it is fashionable, familiar, or theoretically scalable.**
