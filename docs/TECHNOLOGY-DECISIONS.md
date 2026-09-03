# Ferret Technology Decisions

**Status: APPROVED**
**Version: 2.0**
**Effective: 2026-08-30**
**Supersedes: v1.0 (framework only, no decisions taken)**

This document records the technology-selection framework for Ferret **and** the
evidence-backed decisions taken under EPIC-005. v1.0 defined the framework and
marked implementation technologies EVALUATE. v2.0 keeps that framework intact and
records the decisions, the alternatives considered, and the reasons for rejection.

Measured evidence: `spikes/results/RESULTS.md`, with raw data in
`spikes/results/raw/`. Every claim below is traceable to that evidence.

---

## 1. Frozen technology direction

Unchanged from v1.0. These were frozen before EPIC-005 and were **inputs** to the
evaluation, not outputs of it:

- **Distribution:** NPM-first.
- **Primary persistence:** PostgreSQL.
- **Vector search:** pgvector where semantic search is required.
- **Full-text search:** PostgreSQL FTS initially.
- **AI protocol:** MCP using the established official SDK.
- **Code parsing direction:** Tree-sitter and other mature language tooling.
- **Document parsing:** mature existing libraries/providers; no custom parsers.
- **Observability:** OpenTelemetry-compatible architecture.
- **Testing direction:** Vitest plus real PostgreSQL integration tests using
  Testcontainers or an equivalent mature approach.
- **Logging direction:** structured logging using a mature implementation such as Pino.

The runtime and language entries that v1.0 listed here as *candidates* are now
decided in section 2.

---

## 2. TypeScript vs Python — DECIDED

**Decision: TypeScript on Node.js LTS is SELECTED as Ferret's primary
implementation stack. Python is REJECTED for the primary stack and retained as a
candidate for a future isolated capability provider (see section 12).**

### SELECTED

TypeScript on Node.js 22 LTS, distributed via NPM.

### REJECTED

Python 3.12 as the primary implementation stack.

### REASON

The benchmark evidence did **not** select the stack. On measured merit the two
are within 2.1% (weighted 145 vs 142 across eleven measured criteria), which is
inside the run-to-run variance observed across three recorded runs. Each stack
won roughly half the benchmarks, and several rankings reversed between Windows
and Linux.

The decision is therefore carried by three **governance-structural** criteria,
which contribute 65 weighted points to Node against 30 to Python:

1. **NPM-first distribution is a frozen direction** (section 1, and approved
   P0 Epics EPIC-102 NPM Distribution and EPIC-103 Global CLI). Node satisfies it
   natively. Python would require bundling an interpreter inside an NPM package,
   requiring a host Python, or amending an approved frozen direction.
2. **Operational complexity.** Because NPM distribution is frozen, choosing Python
   means shipping and supporting *two* runtimes — Node for distribution plus
   Python for the product. Node gives one runtime for the CLI, the MCP server and
   indexing, with types shared across provider contracts (Governance §4).
3. **Governance §2 (Simplicity Is a Product Requirement)** states a normal install
   must require only database details. Interpreter provisioning is exactly the
   kind of step that rules out.

Where the benchmarks *did* speak clearly, they favoured Node on the path that
matters most: **MCP is Ferret's primary interface** (Governance §3), and the AI
client spawns the server per session. Node's MCP cold start is 3.0× faster
(496 ms vs 1,485 ms) and its tool round-trip 4.0× faster (0.4 ms vs 1.6 ms).

### EVIDENCE

- Weighted decision matrix: `spikes/results/raw/decision-matrix.json`, computed by
  `spikes/tools/decide.py`. Weights derive from approved governance and were fixed
  before scoring. Result: **Node 210, Python 172 (55%/45%)**.
- Sensitivity checks: Node also wins under equal weighting (57 vs 49); with the
  governance-structural criteria removed the result is 145 vs 142 — **a tie**.
- Three benchmark runs: `spikes/results/raw/report-run{1,2,3-final}.json`.
- Linux validation: `spikes/results/raw/linux-validation.json`.
- Dependency, licence and CVE assessment: `spikes/results/raw/dependency-assessment.json`.

Measured highlights (final run, Windows; full table in `spikes/results/RESULTS.md`):

| Area | Node | Python | Winner |
|---|---:|---:|---|
| MCP cold start | 496 ms | 1,485 ms | Node 3.0× |
| MCP tool round-trip | 0.4 ms | 1.6 ms | Node 4.0× |
| PDF parse | 412 ms | 1,126 ms | Node 2.7× |
| XLSX parse | 623 ms | 1,767 ms | Node 2.8× |
| CSV parse | 809 ms | 222 ms | Python 3.6× |
| 84 MB CSV stream | 4.06 s | 1.17 s | Python 3.5× |
| tree-sitter, 1,590 files | 2.50 s | 1.31 s | Python 1.9× |
| Install footprint | 175 MB / 228 pkgs | 101 MB / 42 pkgs | Python |
| PostgreSQL insert/index/query | ≈ | ≈ | tie |

### KNOWN TRADEOFFS

Accepting Node means accepting these, with the mitigations noted:

1. **Node loses on bulk text ingestion.** CSV 3.6× and the 84 MB single file
   3.5× slower. Mitigation: both stream with flat memory (Node peak RSS 65 MB on
   the 84 MB file); the absolute cost is seconds per large file, not minutes.
2. **Node loses on tree-sitter throughput** (1.9× via WASM). Mitigation: the
   native binding installs from prebuilts with no MSVC toolchain (verified:
   8 s, 45.5 MB) and is available if EPIC-033/034 need it.
3. **Larger dependency surface: 228 packages vs 42** — a 5.4× bigger attack and
   maintenance surface, and 175 MB vs 101 MB installed. Mitigation: 50 MB is
   `tree-sitter-wasms` bundling ~40 grammars where Ferret needs 3; a targeted
   grammar set recovers most of it.
4. **Two moderate CVEs remain open** (`uuid` via `exceljs`), fixable only by a
   breaking downgrade. See section 4 — `exceljs` is selected *conditionally*.
5. **Python's document/ML ecosystem is genuinely deeper.** If OCR, layout
   analysis or local model inference become required, Node has no equivalent.
   This is the most likely trigger for revisiting — see section 12.
6. **Filesystem scanning reverses by platform.** Node is 1.6× faster on Windows
   but 5.1× *slower* on Linux. Ferret's indexing throughput on Linux servers
   should be re-measured during EPIC-031 rather than assumed from Windows.

### REVERSAL CONDITION

This decision is re-taken if NPM-first distribution is unfrozen, or if a required
capability (OCR, local inference, layout-aware extraction) has no viable Node
implementation. Because the measured merit is a tie, the governance constraint is
the load-bearing element: remove it and the evaluation must be redone.

---

## 3. Query/data access layer — DECIDED

**SELECTED:** `drizzle-orm` (Apache-2.0), with `drizzle-kit` as a **devDependency** only.
**REJECTED:** `kysely` (MIT).

**REASON.** Both candidates passed **all six** PostgreSQL behaviours Ferret
requires — raw DDL with `tsvector` and `vector`, bulk insert with GIN index build,
FTS via `plainto_tsquery`, pgvector `<->` similarity, `pg_try_advisory_lock` for
migration locking (EPIC-002), and transaction rollback. Coverage did not separate
them. Section 3 of this document lists **migration quality first**, and Ferret's
canonical model (EPIC-006…EPIC-010) will change repeatedly under EPIC-010 schema
versioning. Drizzle generates diffed, versioned migrations; Kysely requires every
migration to be hand-written.

**EVIDENCE.** `spikes/results/raw/data-access-evaluation.json`. The decisive test
was whether `drizzle-kit` could generate migrations for Ferret's non-standard
column types. It can: declaring `tsvector` and `vector(3)` through `customType`
produced correct DDL including `CREATE INDEX ... USING gin`.

**KNOWN TRADEOFFS.** Drizzle's runtime is 6× larger (9.9 MB vs 1.6 MB), though
drizzle-kit's 9.8 MB is not shipped. Apache-2.0 adds a second licence family.
`tsvector`/`vector` need `customType` declarations — proven, but a maintenance
point. Schema-first diffing can hide PostgreSQL behaviour, which section 3
explicitly warns against; mitigated by writing FTS and vector queries as raw
`sql` templates so the query path stays explicit even where the schema path is
generated.

**REVERSAL CONDITION.** If drizzle-kit diffing proves unreliable for partial
indexes, temporal tables or the provenance schema during EPIC-002 or EPIC-010,
fall back to Kysely with hand-written migrations — a verified known-good path.

---

## 4. Parser selection — DECIDED per capability

Selected on correctness, security, maintenance, licence, malformed-input
behaviour and performance together. **No parser was selected on speed alone.**

| Capability | SELECTED | REJECTED / not selected | Key reason |
|---|---|---|---|
| PDF | `pdfjs-dist` 6.3.289 (Apache-2.0) | `pdf-parse` (unmaintained) | Mozilla-maintained, published 2026-08-29; 2.7× faster than pypdf |
| DOCX | `mammoth` 1.12.2 (BSD-2-Clause) | `docx4js`, `python-docx` | Raises on malformed input where python-docx returns empty text |
| XLSX | ~~`exceljs` 4.4.0 (MIT) — **CONDITIONAL**~~ → **Ferret's own reader** (2026-09-03, EPIC-028) | `exceljs` (unlicensed transitive), SheetJS `xlsx` (left npm; CVE history) | The condition below was settled by replacement; see the resolution |
| CSV | `csv-parse` 6.2.1 (MIT) | `papaparse` | Streaming, part of the maintained `csv` suite |
| Code | `web-tree-sitter` 0.25.10 (MIT) + pinned grammars | native `tree-sitter` | WASM needs no native artefact; native remains available and verified |

### PDF — security condition (mandatory)

`pdfjs-dist` must be configured with **`isEvalSupported: false`**. The evaluation
found advisory **GHSA-hq66-cqwq-w95j** (high): arbitrary JavaScript execution when
opening a malicious PDF. Remediated by upgrading `^5.4.0 → 6.3.289` *and*
disabling the PDF JS engine. Ferret indexes untrusted repository content
(Governance §12), so this configuration is a requirement, not a default.

### XLSX — conditional selection

`exceljs` is selected **with a mandatory follow-up**, because it is the single
worst dependency in the tree despite winning its benchmark 2.8×:

- last published **2024-12-20** — the stalest direct dependency in either stack;
- sole source of **all six** deprecated transitive packages (`rimraf@2`, `glob@7`,
  `inflight`, `fstream`, `lodash.isequal`, `uuid@8`);
- sole source of **both** remaining moderate CVEs (`uuid` <11.1.1), fixable only
  by a breaking downgrade to `exceljs@3.4.0`;
- pulls **`buffers@0.1.1`, which declares no licence at all** — a distribution
  risk for a redistributed product.

**Condition:** before EPIC-027/EPIC-028 (Office and Spreadsheet Intelligence) are
implemented, either replace `exceljs` or obtain explicit governance acceptance of
the unlicensed transitive. This is exactly the case the instruction to not pick a
parser on benchmark results alone was written for.

#### Resolution — 2026-09-03, EPIC-028: replaced

The condition was **re-measured before it was acted on**, because the evaluation
above is dated and npm moves. On a clean install of `exceljs@4.4.0`:

| Recorded above | Still true on 2026-09-03 |
|---|---|
| last published 2024-12-20 | yes — `4.4.0` is still `latest`, `time.modified` unchanged |
| `buffers@0.1.1` declares no licence | yes — present, and the only unlicensed package in the 80 |
| two moderate CVEs from `uuid` | yes — `npm audit` reports 2 moderate, both `uuid` |

So the condition was live, and EPIC-028 took the **replace** branch — with
nothing. A `.xlsx` is a ZIP of XML, `node:zlib` inflates, and what Ferret needs
from a spreadsheet is its text rather than a spreadsheet engine. The replacement
is `src/parsers/sheet/`, it adds **no dependency**, and it removes an unlicensed
transitive from a redistributed product instead of asking for permission to ship
one.

`csv-parse` 6.2.1 is unchanged and remains selected: one package, MIT, no
dependencies of its own.

**What was given up**, stated rather than glossed: shared formulas, pivot
caches, `.xlsm` macro packages and streaming. The framework refuses any file
over 4 MiB before a parser is called, so streaming cannot be needed; the rest
are recorded in EPIC-028 §16. `boundaries.test.ts` now fails if `exceljs` or
`xlsx` ever enters any graph.

### Code parsing — grammar pinning is mandatory

The two ecosystems' tree-sitter grammars disagreed: 758,096 named nodes (Node) vs
749,220 (Python) over the identical 1,590 files, ~1.2% apart. AST shape is part of
Ferret's canonical model (EPIC-033), so **grammar versions must be pinned and
version-stamped in the index**, per Governance §21.

### Malformed and untrusted input — measured

16 adversarial cases per stack (truncated, bit-corrupted, empty, wrong-magic,
decompression amplification, XXE), each in an isolated process with a 30 s timeout:

- **No crashes, no hangs, no timeouts in either stack.**
- **Neither stack resolved the XXE external entity** — verified directly by
  confirming the target file's contents did not appear in extracted text.
- `mammoth` **raises** on the XXE document where `python-docx` returns **empty
  text with no error**. Silent emptiness would let Ferret record "no content" as
  evidence, violating Governance §6. This contributed to selecting `mammoth`.
- Both CSV readers accept corrupt CSV without complaint — inherent to the format.
  CSV ingestion therefore needs Ferret-side validation, not parser-side trust.

---

## 5. Git implementation — DECIDED

**SELECTED:** the installed **`git` executable**, invoked as a subprocess.
**REJECTED:** an in-process Git library (`isomorphic-git`, `nodegit`).

**REASON.** Correctness and feature coverage come free from the reference
implementation; no native build; authentication stays with the user's existing
Git configuration rather than being reimplemented (Governance §5, §12).
Measured cost is acceptable: 183 ms for `log -n 200` + `ls-files` + `status`
in parallel.

**KNOWN TRADEOFFS.** Requires Git on PATH — must be surfaced by `ferret doctor`
(EPIC-004). Subprocess overhead is real but was not the bottleneck; both runtimes
were within 10% of each other once calls were parallelised.

---

## 6. Embeddings — PROVIDER ABSTRACTION (unchanged)

No embedding vendor is mandatory. The interface must support hosted and local
implementations. Embeddings are optional augmentation, not the foundation of
deterministic retrieval. **pgvector 0.8.6 was verified working** against
PostgreSQL 17.11, including `<->` similarity ordering through both data-access
candidates.

## 7. Object storage — OPTIONAL (unchanged)

Start with PostgreSQL-backed metadata and the simplest practical content strategy.
Introduce an S3-compatible provider only when evidence justifies it.

## 8. Queue/cache/search/graph infrastructure — DEFERRED (unchanged, and confirmed)

No external queue, cache, dedicated search engine, vector database or graph
database is required. The evaluation introduced **none**. PostgreSQL FTS answered
the retrieval workload at 6.1 ms median over 50,000 rows with a GIN index, and
pgvector covers vector search in the same database.

---

## 9. Selection rule (unchanged)

1. Prefer an established standard.
2. Prefer a mature maintained implementation.
3. Prefer fewer operational dependencies.
4. Prefer the solution that keeps installation simple.
5. Benchmark where the decision materially affects performance or reliability.
6. Record rejected alternatives and the reason.
7. Revisit only when new evidence or requirements justify change.

**No technology is selected merely because it is fashionable, familiar, or
theoretically scalable.**

---

## 10. Security findings and remediation (EPIC-005)

| Finding | Severity | Status |
|---|---|---|
| `pdfjs-dist` arbitrary JS execution on malicious PDF (GHSA-hq66-cqwq-w95j) | High | **FIXED** — upgraded to 6.3.289 and `isEvalSupported: false` mandated |
| `pypdf` 21 advisories, `mcp` 4 advisories on initially pinned versions | Mixed | **FIXED** — version floors raised; `pip-audit` reports clean |
| `uuid` <11.1.1 via `exceljs` (GHSA-w5hq-g745-h8pq) | Moderate ×2 | **OPEN — accepted**; Ferret does not call the affected buffer API. Tied to the XLSX condition in section 4 |
| `buffers@0.1.1` declares no licence | Legal | **OPEN** — tied to the XLSX condition in section 4 |
| `psycopg` is LGPL-3.0-only on the mandatory DB path | Legal | **AVOIDED** — not applicable now Node is selected; `pg` is MIT |

Both stacks reached zero high-severity findings before the decision was taken, so
security did not decide the outcome — it was scored (Python 4, Node 3) and Node
won despite losing this criterion.

## 11. Cross-platform findings

Windows 11 and Linux (containers) were both validated: **both stacks install and
run with no native toolchain and no source builds**. **macOS was not measured** —
no macOS host was available. This is an open gap and must be closed by EPIC-105
(Cross-Platform Packaging) before release; it is recorded here rather than
glossed over.

Platform-dependent behaviour worth carrying forward: Node's filesystem scan is
1.6× faster than Python on Windows but 5.1× slower on Linux. Since Ferret will
commonly index on Linux, EPIC-031 (Incremental Indexing) should measure rather
than assume.

## 12. Mixed-language architecture — REJECTED for now

**Decision: a mixed Node + Python architecture is NOT justified by the evidence.**

Python's measured advantages — CSV 3.6×, large-file streaming 3.5×, tree-sitter
1.9×, Linux filesystem scanning 5.1× — are real but are **seconds, not minutes**,
on a corpus deliberately larger than a typical repository. Against that, a Python
sidecar would add a second runtime to install, provision, version, package, test,
monitor and support, plus an IPC boundary. That fails Governance §2 (simplicity),
§14 (lightweight infrastructure) and §23 (do not accumulate infrastructure), and
the v1.0 rule that a mixed architecture is allowed "only when it produces a clear
measured benefit without violating lightweight operation".

**The benefit is not clear, and the cost is certain. Rejected.**

**Reconsider when**, and only when, a capability with **no viable Node
implementation** becomes a requirement — realistically OCR, layout-aware document
analysis, or local model inference. At that point the right shape is a **provider
behind a stable contract** (Governance §4), not a split core: an optional,
separately-installed capability provider that Ferret degrades gracefully without.

---

## Approval

**APPROVED.** v2.0 records the EPIC-005 decisions. The framework of v1.0 is
preserved; the EVALUATE markers for language/runtime, data access, parsers and
Git are now resolved with recorded evidence, alternatives and reversal conditions.
Amendments require explicit, versioned governance change.
