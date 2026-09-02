# EPIC-108 — Content Indexing Integration: validation evidence

**Status: VALIDATED** · no new table, no new migration, no new relationship
type. One capability version, two indexer ports, one boundary-allowlist entry.

## What the Epic does

`ferret index --content` reads each file's bytes through the `source.repository`
capability, derives EPIC-030 structure from them, parses through EPIC-024's
framework, builds EPIC-033 symbols and stores them through EPIC-034's port. A
re-parse gate over EPIC-010's derived-artefact record keyed on content hash,
parser identity and grammar identity means an unchanged file is neither re-read
nor reparsed. Off by default.

Five VALIDATED P0 Epics reached production for the first time through this one.
Before it, the only non-test importers of `src/parsing/`, `src/parsers/`,
`src/files/structure.ts`, `src/code/` and `src/storage/symbols.ts` were barrel
re-exports.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 content off changes nothing | PASS | `tests/unit/content-composition.test.ts` — report shape identical with the flag absent and explicitly false; `report.content` is `undefined`, not zeroes. `tests/integration/indexing/content-indexing.test.ts` — a metadata run writes no `code_symbol` and no content-derived attribute |
| AC-2 documented, bounded, cancellable operation; version 2, minimum 1 | PASS | `tests/unit/capabilities.test.ts` (12 cases) + `tests/integration/git/content-capability.test.ts` — declaration at version 2 naming `readFileContent`, selectable through the registry, EPIC-016 conformance green unchanged |
| AC-3 tree → content → structure → parse → symbols → storage, no filesystem or subprocess in the indexer | PASS | `tests/integration/indexing/content-indexing.test.ts`; the indexer reaches content only through `ContentReader`, and `tests/unit/boundaries.test.ts` proves the core graph names no provider |
| AC-4 structure on `file` and `file_version` | PASS | `records structure on the file and its version` — `mediaType: text/x-typescript`, `classification`, `isBinary`, `isGenerated` present on the `file` entity |
| AC-5 TS/TSX/JS/Python produce readable symbols | PASS | `produces code symbols readable back by file`, `finds symbols by name and by qualified name through the port` — `Box`, `Box.resize`, `makeBox` |
| AC-6 second run reads nothing, writes nothing | PASS | `reads nothing and writes nothing on an unchanged second run` — content rows snapshotted either side and asserted byte-identical; `filesRead: 0`, every file skipped-unchanged. See the note below on why the row snapshot replaces a counter |
| AC-7 parser or grammar change re-reads; neither does not | PASS | `tests/unit/content-gate.test.ts` — the full decision table: unchanged, changed content, changed parser version, changed grammar hash, absent artefact, and a file reverted to a version indexed before |
| AC-8 tombstone, reinstate, and leave unparsed files alone | PASS | `tombstones a symbol the file stopped declaring, and reinstates it`; `leaves symbols alone in files the run did not parse` — one file re-read, the other gate-skipped and untouched |
| AC-9 no-parser, over-bound, binary and throwing parser each counted, none stops the run | PASS | `tests/unit/content-failure.test.ts` — all four in one run; each lands in its own `UNPARSED_REASONS` bucket and the run completes |
| AC-10 cancelled or failed stage moves no watermark, retires nothing | PASS | `leaves the watermark where it was when the content stage was cancelled`; `retires nothing and reinstates nothing when a content run is cancelled`; `retires nothing when the tree listing was truncated, with content enabled` |
| AC-11 `filesRead === filesParsed + filesUnparsed`, buckets distinct | PASS | `tests/unit/content-failure.test.ts` and the integration counts test; proved again on the dogfooding run — 425 = 265 + 160 |
| AC-12 core reaches no `storage/` module, no `web-tree-sitter` | PASS | `tests/unit/boundaries.test.ts`, unmodified assertions |
| AC-13 one allowlist entry, assertions (1)(2)(3) unchanged, positive discovery test | PASS | The amendment is `CLI_DYNAMIC_PACKAGES`, reasoned at its declaration. Before amending, the suite was run and assertion (4) was the **only** failure. `tests/integration/providers/parser-composition.test.ts` (8 cases) proves the parser is loaded through discovery and selected by capability |
| AC-14 Ferret over Ferret, real counts, zero phantom files | PASS | Recorded below |
| AC-15 no symbol identity derived here; zero tombstones on a second run | PASS | Source-level assertion in `content-gate.test.ts` that `src/indexing/content.ts` names no `codeSymbolId`, `codeSymbolEntityInput`, `canonicalKey` or `symbolScope`; and `tombstones zero symbols on a second run over unchanged content` against real PostgreSQL |
| AC-16 unsupported source detected before it is called, metadata-only with a reason | PASS | `tests/unit/content-composition.test.ts` — a content reader that throws if consulted is never consulted on any fallback path; the reason is logged at `info` |
| AC-17 grammar identity obtained without parsing, one path into the parser | PASS | `ParserFramework.producerVersion` calls `select` then the parser's read-only `producerIdentity`; a counting parser proves `parse` is never entered. `CodeParserProvider.producerIdentity` goes through the same cached `#language` accessor `parse` uses |

## Dogfooding — AC-14

Ferret indexed its own repository through the production CLI path, against real
PostgreSQL 17 and real tree-sitter grammars.

**First content-enabled run**

```
read              1 commits, 425 files, 12 branches, 1 worktrees
entities          0 new, 851 changed, 18 unchanged
content           425 read, 0 unchanged, 0 unreadable, of 425 considered
parsed            265 parsed, 160 unparsed
unparsed by       159 no-parser, 1 binary
symbols           1508 new, 0 changed, 0 unchanged, 0 deleted, 0 restored
took              129283ms
```

**Second run, unchanged repository**

```
entities          0 new, 0 changed, 869 unchanged
content           0 read, 425 unchanged, 0 unreadable, of 425 considered
parsed            0 parsed, 0 unparsed
symbols           0 new, 0 changed, 0 unchanged, 0 deleted, 0 restored
took              15095ms
```

The saving the gate exists to produce, measured rather than asserted: **129s to
15s**, no content read, no row written, no symbol tombstoned. §13 asked for no
claim of parity with a metadata-only run without a measurement; this is the
measurement, and the second content run costs roughly what a metadata run costs.

`159 no-parser` is EPIC-024's designed outcome, not a gap — Markdown, JSON and
YAML have no parser yet (EPIC-026 through EPIC-029). `1 binary` is a `.wasm`
grammar. Zero unreadable.

**The oracle**, `npm run dogfood -- --content`, every check against `git`:

```
ok    content notice
ok    repository indexed  (Ferret)
ok    no phantom files  (425 active)
ok    structure recorded  (235 source files)
ok    symbols indexed  (1 declaration(s) of RepositoryIndexer)
ok    symbols point at real files
ok    no missing files  (425 tracked)
ok    commits carry content
ok    exact lookup filters
ok    change kind is visible
ok    health reflects the index
Ferret agrees with the repository on every question asked.
```

The EPIC-032 phantom-file check still passes with content indexing on.

## What dogfooding caught that the suite did not

**Content indexing read nothing and reported success.** `discoverProviders` ran
inside `runtime.run(...)`, and `ProviderRegistry` refuses to register a provider
once the runtime has initialized. Discovery recorded a skip, the `parser`
capability was never available, and `ferret index --content` completed with exit
code 0 and no content section — the silent no-op §8.5 requires a positive test to
rule out.

Every unit and integration test passed with that defect present, because all of
them registered into a fresh `ProviderRegistry` and none exercised the real
runtime lifecycle. The fix moves discovery before `runtime.run`; the regression
test now composes through an actual runtime, and asserts the failure mode
directly. Reported as issue #50, because `discoverProviders` collapsing a
caller-ordering error into a best-effort skip is a weakness beyond this Epic.

This is the second time this repository's dogfooding has found something its
suite could not, and both were the same shape: a boundary the tests stood on the
wrong side of.

## Deviations from the specification

Each was found by a failing acceptance criterion, not chosen. All are recorded in
the Epic under §18.

- **§18.4 — the gate is keyed per path, not per file version.** §8.7 specifies
  one artefact per indexed file *version*. Under that scoping, index → edit →
  index → revert → index leaves the reverted file with its symbols still
  tombstoned: the revert finds the first run's artefact, calls the file
  unchanged, and skips it. AC-8 failed. One artefact per `(repository, path)`
  carrying the content hash as `sourceContentHash` is what `validateArtifact` was
  built for, fixes it, and grows the table by distinct paths rather than by
  distinct file versions — strictly less than §8.7 accepted.
- **§18.5 — the file tree is written before history on a content run.** EPIC-020
  emits a `file` entity holding `{ path, extension }` for every path a commit
  touched, and upsert replaces attributes. Written after the tree, it stripped
  EPIC-030's structure and the tree stage wrote it back: two rows per file per
  run, permanently. Confined to content runs; a metadata run keeps the original
  order exactly. Reported as issue #52.
- **§18.1 — symbols carry no evidence.** Not required by any acceptance
  criterion; recorded rather than added, because deciding what a symbol's
  evidentiary statement is would settle a question EPIC-034 left open. Reported
  as issue #49.
- **§18.2 — `not-found` covers a missing object and a non-blob object.** Git
  answers both with `bad file`; separating them would be manufacturing certainty.
- **§18.3 — the Git provider ignores `revision` when reading content.** An
  object id is already absolute. The field stays on the contract so this
  provider's shortcut does not become every provider's requirement.

## Limitations

- **No sandbox.** Attacker-controlled bytes are parsed in-process during every
  content-enabled index. EPIC-024 recorded the absence of a sandbox and this Epic
  changes no trust boundary — but that was acceptable when parsers ran only in
  tests, and it is now the live posture of an indexing run. It is why content
  indexing ships off by default, and why out-of-process parsing should be raised
  as its own Epic if it is ever wanted.
- **No content evidence at all.** Structure lands on entity attributes and
  symbols carry no evidence, so EPIC-045's authority ranking has nothing in this
  Epic's output to rank. §7 was corrected to say so.
- **A `--full --content` run rewrites file entities.** The §18.5 fix removes the
  churn for the incremental path, which is the default and what AC-6 and
  EPIC-031 AC-2 are written about. A full run re-reads all history and the
  contention returns.
- **One unrelated `entities.updated` on every incremental second run.** A stub
  `commit` entity overwrites a fully described parent. Reproduced with content
  **off**; predates this Epic. Reported as issue #48. AC-6 is proved by
  snapshotting content-derived rows rather than by the counter, which is a
  stronger assertion and immune to it.
- **The published-subpath composition is exercised against source, not `dist`.**
  A `tsconfig` path and a matching vitest alias resolve
  `@indoulia/ferret/parsers` to `src/` so the suite tests the working tree rather
  than the last build. The emitted `dist/cli/commands/parser-composition.js`
  keeps the literal self-reference, verified after `npm run build`, but no test
  loads the installed package as a consumer would.

## Test inventory

| Suite | Cases | What it proves |
| --- | --- | --- |
| `tests/integration/git/blob-content.test.ts` | 11 | Byte preservation, the read bound before materialisation, revision-not-worktree, cancellation |
| `tests/integration/git/content-capability.test.ts` | 8 | The operation through the capability, version 2 declaration, contract vocabulary |
| `tests/unit/capabilities.test.ts` | 12 added | Version-gated declaration semantics, both directions |
| `tests/unit/content-composition.test.ts` | 12 | Flag off by default, metadata-only fallback, never a missing method |
| `tests/unit/content-gate.test.ts` | 21 | The gate decision table, the per-file flow, grammar identity without parsing |
| `tests/unit/content-failure.test.ts` | 12 | Failure isolation, count invariants, cancellation between files |
| `tests/integration/indexing/content-indexing.test.ts` | 16 | End to end against real PostgreSQL and Git, including the mass-tombstoning regression |
| `tests/integration/providers/parser-composition.test.ts` | 8 | The positive discovery test, and the runtime-lifecycle regression |
| `tests/unit/boundaries.test.ts` | 1 added | The amendment is honest: subpath loaded dynamically, no parser named statically |

## Addendum — 2026-09-02, after EPIC-029

**The `no-parser` figure recorded above has moved.** The original text is left as
written.

It recorded that Markdown, JSON, SQL and YAML "have no parser yet (EPIC-026
through EPIC-029)". EPIC-029 has landed, and on Ferret's own repository:

| | parsed | unparsed | `no-parser` |
| --- | --- | --- | --- |
| before | 367 | 244 | 243 |
| after | 572 | 47 | 46 |

**205 more files parsed.** What remains genuinely has no owner: 26 JSON, 17 SQL,
2 SVG, 1 YAML — the registry names an Epic for none of them — plus one `.wasm`
correctly reported `binary`. The three `.txt` files are claimed by the new
fallback parser.

One contract change is worth knowing here, because this Epic's content stage is
where it applies. `ParseOutput.outlineKind` now says whether an outline is a
symbol table, and `runContentStage` builds code symbols only when it is
`code`. Without it a Markdown heading became a `code_symbol` — this stage called
`buildCodeSymbols` for every parse that produced an outline, and
`codeSymbolKindOf` maps an unrecognised kind to `UNKNOWN` rather than refusing.
**Absent now means no code symbols**, which is the safe default and the honest
one.

Evidence: `docs/EPICs/validation/EPIC-029-VALIDATION.md`.
