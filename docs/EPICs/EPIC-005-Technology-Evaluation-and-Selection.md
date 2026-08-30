# EPIC-005 — Technology Evaluation & Selection

**Status: APPROVED | Priority: P0**

## Objective
Select the implementation stack and material dependencies using measurable evidence, with special focus on TypeScript/Node.js versus Python.

## Scope
Benchmark language/runtime candidates; evaluate package size, startup, memory, MCP integration, filesystem scanning, Git, PostgreSQL, representative PDF/DOCX/XLSX parsing, concurrency, cross-platform packaging, dependency friction, licensing, maintenance, and developer complexity. Evaluate data-access layer, parser choices, Git strategy, embedding abstraction, storage, job, cache, and tooling choices.

## Decision principle
TypeScript/Node.js is the current default candidate because it aligns with NPM and MCP and can provide one CLI/MCP runtime. Python remains a first-class candidate because of its document/data/ML ecosystem. Neither is permanently frozen until evidence is reviewed.

## Acceptance criteria
- Comparable TypeScript and Python spikes exist.
- Startup, idle memory, install/package footprint, MCP latency, PostgreSQL throughput, filesystem performance, Git operations, parsing, concurrency, and packaging are measured.
- Material libraries are evaluated for correctness, maintenance, licensing, security, performance, and native dependencies.
- Rejected alternatives and reasons are documented.
- The final choice preserves the minimal-configuration requirement.
- No unnecessary queue/cache/search/graph infrastructure is introduced.

## Tests/validation
Repeatable benchmark harness; representative corpus; clean-machine install; Windows/Linux/macOS packaging validation where applicable.

## Definition of Done
Evidence reviewed; final technologies recorded in `docs/TECHNOLOGY-DECISIONS.md`; alternatives documented; governance alignment confirmed.
