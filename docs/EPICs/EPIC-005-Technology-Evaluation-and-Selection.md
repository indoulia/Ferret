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

---

## Implementation evidence (2026-08-30)

**Status: IMPLEMENTED → VALIDATING.** Not DONE: two criteria are partially
satisfied and are listed explicitly below rather than glossed over.

Decisions recorded in `docs/TECHNOLOGY-DECISIONS.md` v2.0.
Measured evidence in `spikes/results/RESULTS.md`; raw data in `spikes/results/raw/`.

### Outcome

TypeScript on Node.js 22 LTS **SELECTED**; Python **REJECTED** for the primary
stack; mixed-language architecture **REJECTED** for now. On measured merit the
stacks tie (weighted 145 vs 142, 2.1% apart); the decision is carried by three
governance-structural criteria — frozen NPM-first distribution, operational
complexity, and cross-platform reach.

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Comparable TypeScript and Python spikes exist | MET | `spikes/typescript/`, `spikes/python/` — same corpus, iteration counts and result contract |
| 2 | Startup, memory, footprint, MCP latency, PostgreSQL throughput, filesystem, Git, parsing, concurrency, packaging measured | MET | 13 benchmarks × 2 runtimes × 3 runs; `report-run{1,2,3-final}.json` |
| 3 | Material libraries evaluated for correctness, maintenance, licensing, security, performance, native dependencies | MET | `dependency-assessment.json` |
| 4 | Each material technology decision has documented alternatives | MET | TECHNOLOGY-DECISIONS §2–§5, each with SELECTED / REJECTED / REASON / EVIDENCE / KNOWN TRADEOFFS |
| 5 | Parser candidates evaluated on correctness, structure preservation, provenance, malformed input, licensing, maintenance, performance, native dependencies | **PARTIAL** | Malformed input, licensing, maintenance, performance and native deps measured for one parser per format per stack. **Structure preservation and provenance fidelity were not directly measured** — text-extraction volume was compared, not structural fidelity. |
| 6 | Data-access candidates evaluated against required PostgreSQL behaviour | MET | `data-access-evaluation.json` — Drizzle and Kysely against all six required behaviours |
| 7 | MCP uses an established SDK | MET | `@modelcontextprotocol/sdk` 1.30.0; no custom protocol code |
| 8 | Rejected alternatives and reasons documented | MET | TECHNOLOGY-DECISIONS §2–§5, §12 |
| 9 | Final choice preserves the minimal-configuration requirement | MET | NPM-first, single runtime, no added infrastructure |
| 10 | No unnecessary queue/cache/search/graph infrastructure introduced | MET | None introduced; PostgreSQL FTS answered retrieval at 6.1 ms median |
| 11 | Final decisions recorded in `docs/TECHNOLOGY-DECISIONS.md` | MET | v2.0 |

### Definition of Done

| Item | Status |
|---|---|
| Benchmark/spike results committed | MET |
| Evidence reviewed | MET |
| Final technologies recorded | MET |
| Rejected alternatives documented | MET |
| Licensing checked | MET — one unlicensed transitive found (`buffers@0.1.1`), tracked as a condition on the XLSX selection |
| Dependency footprint reviewed | MET |
| Cross-platform packaging validated | **PARTIAL — macOS was not validated.** Windows 11 and Linux containers both pass with no native builds. No macOS host was available. |
| Governance alignment confirmed | MET |

### Open items blocking DONE

1. **macOS packaging unvalidated.** Recommend accepting this as EPIC-105
   (Cross-Platform Packaging) scope rather than holding EPIC-005 open, since
   EPIC-105 owns packaging validation. Requires governance acceptance.
   **Discharged 2026-09-03:** macOS is in the CI matrix and passes — 112 test
   files and 2 463 tests on `macos-latest`, the packaging suite included. The
   acceptance this asked for is no longer needed, because the gap it was
   accepting is measured.
2. **Parser structure-preservation and provenance fidelity unmeasured.** Recommend
   folding into EPIC-024 (Parser Framework) and EPIC-097 (Parser Quality Harness),
   which own structural correctness and golden-dataset validation.

Neither gap affects the language decision, which was the gate blocking
implementation Epics.

### Conditions carried forward

- **`pdfjs-dist` must be configured with `isEvalSupported: false`** (Governance §12).
- **`exceljs` is a conditional selection** — replace it or obtain governance
  acceptance of the unlicensed `buffers@0.1.1` transitive before EPIC-027/EPIC-028.
- **tree-sitter grammar versions must be pinned and version-stamped** in the index
  (Governance §21); the two ecosystems' grammars disagreed by ~1.2% on node counts.
- **Re-measure indexing throughput on Linux** during EPIC-031; Node's filesystem
  scan is 1.6× faster than Python on Windows but 5.1× slower on Linux.
