# EPIC-108 — Content Indexing Integration

**Status: APPROVED | Priority: P0 | Domain: File Intelligence**

> **Specification note.** Authored from the Indexer Integration Ownership Review
> and Governance §4, §5, §6, §8, §12, §13, §21 and §22, following the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md). Registered in
> the [Epic registry](README.md) under File Intelligence.
>
> The registry approves an Epic by name, domain and priority *before* its
> specification is written; this one inverted that order deliberately, because
> the capability it names was discovered as an ownership gap rather than planned
> as a feature. The specification was therefore written first, reviewed, and the
> registry entry added afterwards. Recorded because it is a deviation from the
> registry's stated sequence, not a precedent for skipping it.
>
> It introduces no new capability outcome. Every component it connects is
> already VALIDATED; what does not exist is the connection, and no approved Epic
> owned it. **Scope is approved; implementation has not begun** — see §17.

## 1. Objective

Make the file-intelligence and code-intelligence capabilities Ferret has already
built reachable from a real indexing run: obtain file content through the source
provider, and record what the existing structure, parser, AST and symbol-index
components derive from it.

## 2. Value

Five VALIDATED P0 Epics currently deliver nothing to production.

`ferret index` writes a graph of files it has never opened. `listFiles` returns
tree entries — path, kind, object id, size, mode — and the indexer writes
entities from those alone. `ParserFramework.parse()` requires `{ path, bytes }`;
nothing in the repository produces `bytes` for a repository file. The only
non-test importers of `src/parsing/`, `src/parsers/`, `src/files/structure.ts`,
`src/code/` and `src/storage/symbols.ts` are barrel re-exports.
`createCodeParserProvider` is registered in no runtime. `SymbolStore` is
constructed nowhere in `src/`.

The repository already records this, in its own evidence, without an owner:

> **Nothing calls this yet.** EPIC-033 builds symbols and EPIC-034 stores them;
> the indexer does not yet parse files, so no production path reaches either.
> **Wiring belongs to the Epic that makes indexing read content.**
> — `validation/EPIC-034-VALIDATION.md`

That Epic has never existed. This is it.

The value is not a new capability. It is the difference between a well-tested
library and a product: until content reaches the index, "where is `resolveConfig`
defined" is answered by a full-text search that ranks every call site above the
definition, and a context pack cannot cut below a whole file.

## 3. Scope

1. **One content-read operation on the `source.repository` capability** —
   bounded, cancellable, addressing a file already discovered by `listFiles`
   through the object id that listing returns. Contract documented, capability
   version raised, declaration semantics stated.
2. **Its Git implementation**, reading the blob rather than the working tree, so
   the content read is of the revision that was indexed.
3. **Composition of the code parser into `ferret index`** through EPIC-013
   provider discovery, with the single, explicit boundary-test amendment §8.5
   specifies and no weakening of EPIC-025's package-root prohibition.
4. **Two narrow ports on the indexer**, structural like the five it already has,
   so the core continues to import no `storage/` module.
5. **The per-file flow**, behind a flag that is off by default:
   content read → `describeFileStructure` → `emitFiles({ structure })` →
   `ParserFramework.parse` → `buildCodeSymbols` → `indexFileSymbols`.
6. **A re-parse gate** over EPIC-010's existing derived-artifact record, keyed on
   file content, parser identity and grammar identity, so an unchanged file is
   not re-read and a parser or grammar change is.
7. **Content and symbol counts in `IndexReport`**, each defined unambiguously.
8. **Failure, cancellation and partial-run semantics** that preserve every
   guarantee EPIC-031 and EPIC-032 established.

Nothing in this list is a new derivation. Items 5 and 7 call existing functions
and count what they return.

## 4. Non-scope

- **References, call sites and call graphs** — EPIC-035.
- **A `file_declares_symbol` relationship type, or any new relationship type.**
  Symbols land as canonical entities and nothing else. Three approved documents
  name EPIC-049 or EPIC-035 as the owner of symbol-level edges
  (`validation/EPIC-030-VALIDATION.md`, `validation/EPIC-033-VALIDATION.md`,
  `EPIC-022-023-File-Discovery-Identity.md` §4), and an edge asserted here would
  be this Epic taking scope from one of them.
- **Content blob storage and deduplication** — EPIC-087. Content is read,
  derived from, and discarded; nothing here persists bytes.
- **Non-code parsers** — EPIC-026 through EPIC-029. Files no parser claims are
  recorded `no-parser`, which is EPIC-024's designed outcome, not a gap.
- **Ranking or filtering on classification** — EPIC-056, EPIC-057. This Epic
  records the structure EPIC-030 derives; it changes no ordering.
- **An MCP symbol tool** — an EPIC-065 extension. Symbols become findable through
  `SymbolIndexPort`; exposing them to an AI client is a separate surface.
- **Parser sandboxing or out-of-process parsing.** EPIC-024 recorded the absence
  of a sandbox as a limitation and did not plan one; that is unchanged here, and
  §11 states what it means now that parsers run in the index path.
- **Scheduled or unattended indexing** — EPIC-075, EPIC-076.
- **Namespace, schema or migration restructuring.** No new table, no new column,
  no new migration. EPIC-034 settled "no new table" under Governance §5;
  `derived_artifact` (migration `0006`) and the `code_symbol` indexes (migration
  `0010`) already exist and are sufficient.
- **Semantic or fuzzy symbol matching** — EPIC-054, EPIC-056.
- **Any change to EPIC-031, EPIC-032 or their acceptance criteria.** Both are
  VALIDATED. This Epic adds a stage; it redefines none of theirs.
- **Renaming or rebranding existing runtime infrastructure.**

## 5. Inputs

- EPIC-022/023 `TreeEntry`: `path`, `kind`, `oid`, `sizeBytes`, `mode` — the
  object id is what makes a content read addressable without a working tree.
- EPIC-024 `ParserFramework.parse({ path, bytes })`, `detectContent`,
  `UNPARSED_REASONS`.
- EPIC-025 `createCodeParserProvider`, and `GrammarIdentity` (`grammar`,
  `abiVersion`, `binaryHash`).
- EPIC-030 `describeFileStructure(path, bytes)`, and the `structure` option
  `GitProvider.emitFiles` already accepts and no caller fills.
- EPIC-033 `buildCodeSymbols(parse, context)`.
- EPIC-034 `SymbolIndexPort.indexFileSymbols`, and its `SymbolIndexReport`
  counts.
- EPIC-010 `recordArtifact`, `getArtifact`, `validateArtifact` on the
  derived-artifact store.
- EPIC-011/013 capability declaration, `declares()`, and `discoverProviders`.
- EPIC-031 `RepositoryIndexer`, its ports, its watermark and its report.
- EPIC-032 completeness gating and lifecycle reconciliation.

## 6. Outputs

- A content-read operation on the `source.repository` contract, its
  `RepositoryOperation` name, and its Git implementation.
- `CAPABILITY_VERSIONS['source.repository'] = 2`, with
  `MINIMUM_CAPABILITY_VERSIONS` unchanged at 1.
- Two indexer ports and their entries on `IndexerDependencies`.
- A content stage in `RepositoryIndexer.index`, off unless requested.
- `ferret index --content` (name fixed in implementation), default off.
- `IndexReport.content`, defined in §8.8.
- One recorded amendment to `tests/unit/boundaries.test.ts`, and the reason.

## 7. Dependencies

Each classified rather than listed, because "mentioned historically" is not a
dependency.

**Hard dependencies** — this Epic calls their code and fails without it:

- **EPIC-022/023** (VALIDATED) — the tree entry and its object id.
- **EPIC-024** (VALIDATED) — the framework, detection, and unparsed reasons.
- **EPIC-025** (VALIDATED) — the code parser provider and grammar identity.
- **EPIC-030** (VALIDATED) — `describeFileStructure` and the `emitFiles`
  structure option.
- **EPIC-033** (VALIDATED) — `buildCodeSymbols` and symbol identity.
- **EPIC-034** (VALIDATED) — `indexFileSymbols`, reconciliation, migration
  `0010`.
- **EPIC-031** (VALIDATED) — the indexer, its ports and its watermark. Depended
  upon, **not modified**.
- **EPIC-010** (VALIDATED) — the derived-artifact record the re-parse gate uses.

**Architectural prerequisites** — this Epic changes or extends their contract
and must satisfy their rules:

- **EPIC-011** (VALIDATED) — the capability contract gains an operation and a
  version. Governance §4 makes this versioned and documented work.
- **EPIC-013** (VALIDATED) — `discoverProviders` is how the parser is composed.
  This Epic would be its **first production caller**; it is exercised only by
  unit tests today.
- **EPIC-032** (VALIDATED) — completeness gating and lifecycle reconciliation
  must continue to hold with a content stage present.

**Evidence and reference only** — relied on for correctness of behaviour, not
called or extended:

- **EPIC-016** (VALIDATED) — the conformance suite validates that the new
  capability declaration is well-formed and selectable. It does **not** cover
  operation behaviour: EPIC-016 §4 non-scopes "capability *behaviour*
  semantics — that a repository provider actually discovers repositories is
  EPIC-017's suite, not this one." Behavioural coverage for the content
  operation is therefore this Epic's own integration suite, in the pattern
  EPIC-017 and EPIC-022 set.
- **EPIC-082** (VALIDATED) — redaction, applied by the framework at its boundary.
  This Epic adds no redaction and removes none.
- **EPIC-006/007/009** (VALIDATED) — identity, entities, scope.

**Not a dependency, recorded because the review examined it:**

- **EPIC-045 — Source Authority.** As of this writing the authority policy is on
  **open PR #46** (`feat/epic-044-045-evidence`, all four checks green) and
  **not on `main`**; the registry on `main` still lists EPIC-044 and EPIC-045 as
  P0 with no status. **EPIC-108 does not depend on it and must not be sequenced
  behind it.** The relationship is one-directional and automatic: once #46
  merges, evidence emitted through `Emitter` for content-derived facts receives
  its rank from `authorityFor(method)` with no work here — a `parsed` method
  ranking below a directly-read observation, which is the correct ordering for
  facts a grammar produced. If #46 does not merge, content evidence carries the
  same default authority every other record carries today and nothing in this
  Epic behaves differently. **EPIC-045 is not modified by this Epic.**

## 8. Contracts

### 8.1 Why EPIC-031 is not the owner

Stated here because the question will be asked again, and because the answer is
the reason this Epic exists rather than a patch to that one.

- **Its written non-scope excludes this work.** EPIC-031 §4: "Parsing file
  content — EPIC-024." The registry makes explicit non-scope a property of every
  Epic, and AI-DEVELOPMENT-RULES §3 makes it binding: "Work must remain within
  the active Epic's approved scope."
- **Its ports do not reach here.** `IndexerDependencies` names `source`,
  `entities`, `relationships`, `evidence`, `watermarks`, `lifecycle`, `logger`.
  No content port, no symbol port. Its `IndexableSource` interface declares six
  operations and none returns bytes.
- **Its security contract forbids the indexer acquiring content itself.**
  EPIC-031 §11: "The indexer adds no subprocess, no filesystem access and no
  network." This is the constraint that makes a *provider* operation the only
  available route, and it is why this Epic is a capability change rather than a
  wiring change.
- **Its acceptance criteria never contemplated it.** AC-1 enumerates what a first
  run writes — "repository, worktrees, branches, commits, developers, files and
  versions." Segments, structure and symbols are absent.
- **Its performance contract was measured against a different cost model.** §13:
  "The second run must be cheaper than the first, or the watermark is
  decorative." That was established for a tree listing, not for reading and
  parsing every blob. §13 below states what changes.
- **It is VALIDATED**, with recorded evidence. Adding acceptance criteria to a
  validated Epic invalidates its own evidence document.

Any one of these would justify a separate Epic. Together they make extending
EPIC-031 a material scope expansion, which the registry requires be raised rather
than absorbed: "Material scope expansion creates or updates an Epic explicitly."

### 8.2 The circular deferral, recorded rather than corrected

Six approved documents defer this work, and the chain closes on itself. None is
wrong; each was written from where it stood, and **none is rewritten by this
Epic** — Governance §12 preserves history, and the gap is more useful recorded
than erased.

- `EPIC-022-023` §4 — "Reading file **content** — EPIC-024 onward. Nothing here
  opens a file."
- `EPIC-024` §4 — "storing extraction results — EPIC-031 and EPIC-087"; §5 —
  "file bytes, supplied by the caller — the framework opens nothing itself."
- `EPIC-025` §4 — "wiring the parser into the indexer, which belongs to the Epic
  that makes indexing read content."
- `EPIC-030` §4 — "wiring content into indexing belongs to the Epic that makes
  indexing read it."
- `EPIC-031` §4 — "Parsing file content — EPIC-024."
- `validation/EPIC-034-VALIDATION.md` — "Wiring belongs to the Epic that makes
  indexing read content."

EPIC-024 points at EPIC-031; EPIC-031 points back at EPIC-024; three others point
at an Epic named only by description. The pattern is not carelessness — it is
what happens when every Epic correctly declines work outside its outcome and no
Epic owns the seam between them. EPIC-108 is that seam, named.

### 8.3 Content is read through the capability, never by the indexer

The operation takes a repository, a path and the object id `listFiles` already
returned, plus a revision, and returns bytes under a byte bound and an
`AbortSignal`. Git implements it against the object store, not the working
tree — the indexer indexes a *revision*, and reading the working copy would
answer a different question and would be wrong on any run with `--revision`.

The bound is enforced by the provider before bytes are materialised, not by the
caller after: a caller that receives 400 MB in order to reject it has already
paid the cost the bound exists to avoid. EPIC-024's own size bound remains, and
applies after this one.

**Rejected: the indexer reads the filesystem.** Direct, and forbidden by
EPIC-031 §11 and Governance §4. It would also be incorrect for any revision that
is not the working tree.

**Rejected: a new `source.file` capability.** `Capability.SOURCE_FILE`
(`'source.file'`) exists today, versioned 1, described by EPIC-011's contract
table as "Enumerate and read files" with EPIC-022 as first consumer — and
**nothing declares it or implements it**. It is a named, approved, empty
capability, and its description is a close match for this operation.

It is nonetheless the wrong home, on the repository's own precedent. EPIC-011
also names `source.history`, and history reading was implemented as
`RepositoryOperation.READ_HISTORY` on `source.repository` rather than as its own
capability; so was file listing, as `LIST_FILES`. Both were operations on the
capability that already had the repository context they needed. A content read
needs exactly that context — repository, revision, object id — and putting it on
a second capability would force every source provider to declare two capabilities
to be useful for indexing, and would leave `listFiles` and "read what `listFiles`
returned" on opposite sides of a boundary. `source.file` remains unimplemented
and available; if a provider ever enumerates and reads files *without* being a
repository source, that is when it earns an implementation. **Recorded here so
the choice is visible rather than rediscovered.**

### 8.4 Adding an operation raises the capability version

`declares()` returns `true` when a declaration omits `operations` — "omitting the
field means all of them," as `capabilities.ts` states. A third-party provider
declaring `source.repository` at version 1 with `operations` omitted would
therefore begin claiming an operation it has never implemented the moment the
operation is added, and the failure would surface as a missing method at call
time rather than as an honest unsupported verdict.

The approved rule, in four parts:

1. `CAPABILITY_VERSIONS['source.repository']` becomes `2`.
2. `MINIMUM_CAPABILITY_VERSIONS['source.repository']` stays at `1`, so the
   runtime keeps accepting version-1 providers wherever the existing contract
   requires it. Nothing built against version 1 stops working.
3. **A version-1 provider is never considered to support the content-read
   operation**, whatever its `operations` field says or omits. Version 1 covers
   the six operations that existed at version 1, and that set is closed.
4. **Support for the content-read operation must be positively declared, and
   `declares()`'s omission semantics must never be used to infer it.** Omitting
   `operations` means "all of them" only for the operation set of the version
   being declared; it may not reach forward into an operation that did not exist
   when the declaration was written.

Part 4 is the one that matters, and it is stricter than the mechanism as it
stands: the purpose is that a provider declared before this operation existed
cannot accidentally claim it. Inferring support from silence is exactly how a
missing method becomes a runtime failure instead of an honest verdict.

The indexer asks `supports(capability, operation)` before calling, and degrades
to metadata-only indexing for a source that cannot read content — the same shape
as the existing optional `lifecycle` port, and for the same reason: a source that
cannot do something must not be made to pretend.

This is the part of this Epic that is genuinely a contract change rather than an
integration, and it is why the work is governed rather than incidental.

### 8.5 The boundary decision — explicit, minimal, and not a weakening

`tests/unit/boundaries.test.ts` encodes EPIC-025's architectural constraint in
four assertions. Composing the code parser into `ferret index` interacts with
them, and the interaction must be a recorded decision rather than an edit made to
get a suite green.

What the assertions are today:

1. `core.packages.has('web-tree-sitter') === false` — the package root carries no
   grammar runtime. **This is EPIC-025 AC-12 and is not touched.**
2. `cli.packages.has('web-tree-sitter') === false` — the CLI's static graph
   carries none either.
3. `[...cli.files].filter(f => f.startsWith('parsers/'))` is empty — the CLI
   statically imports no parser module.
4. The CLI's external package set equals exactly
   `commander + STORAGE_PACKAGES + MCP_PACKAGES + ALLOWED_CORE_PACKAGES`.

`importGraph`'s specifier pattern matches `import(` as well as `from`, so a
dynamic import of a **literal relative path** is caught by (3) exactly as a
static one is. A relative `import('../../parsers/index.js')` is therefore not an
escape, and must not be treated as one.

**The decision: compose the parser through EPIC-013 `discoverProviders` with the
package's own published subpath, `@indoulia/ferret/parsers`, as the module
specifier.** This is the mechanism EPIC-013 built — it "loads and registers
providers from an explicit, ordered module list", and "the caller owns trust in
the module specifiers" — and EPIC-108 would be its first production caller.

Under that composition, assertions (1), (2) and (3) all continue to hold
unchanged and for the right reason: the grammar runtime is loaded on demand, only
for a run that asked for content indexing, and nothing in the CLI's static graph
names a parser module or a grammar. Assertion (4) fails, because the specifier
appears as one new external package name.

**The amendment is exactly that: `@indoulia/ferret/parsers` is added to the CLI's
permitted external set, with the reason recorded in the test.** Nothing is
deleted, no prohibition is relaxed, and the entry is meaningful on its face — the
CLI may load Ferret's own parser subpath at runtime.

Two obligations come with it, because an assertion that passes by invisibility is
weaker than one that passes by absence:

- A **positive test** must assert that content indexing actually loads the parser
  through discovery and selects it by capability. Without it, assertions (2) and
  (3) would be satisfied by a composition that silently does nothing.
- The amendment must be committed as a **stated decision with its reason in the
  test file**, not as a bare diff to an allowlist.

The approval attached one further constraint, recorded here because it governs
the implementation rather than the decision: **no existing boundary assertion may
be deleted or broadly weakened merely to make the new composition pass.** If the
composition cannot be made to satisfy assertions (1), (2) and (3) as they stand,
the composition is wrong and must change — not the assertions. The allowlist
entry in (4) is the whole of the permitted amendment.

**Rejected: amending assertion (3) to permit the CLI to import `parsers/`
statically.** It works, and it is a strictly larger amendment: it would put a
5.6 MB WebAssembly runtime in the static graph of every `ferret` invocation,
including `ferret status` and `ferret config`, to serve one optional flag.

**Rejected: a configuration-driven module list.** Cleaner in the long run, and it
requires a config-schema addition this Epic does not need. Recorded as the
natural extension when a second external provider wants composing.

### 8.6 Symbol identity is used, never re-derived

EPIC-034 failed this once, and the failure mode is why this clause is a contract
and not a note. `src/code/identity.ts` records it: the id `codeSymbolId` hashed
and the id `createEntity` hashed were derived in two places three files apart,
reconciliation compared stored ids against freshly derived ones that disagreed,
and **every symbol was retired on every run.**

The integration path therefore:

- calls `buildCodeSymbols(parse, context)` and nothing else to produce symbols;
- calls `SymbolIndexPort.indexFileSymbols(context, symbols)` and nothing else to
  store them;
- **derives no symbol id, constructs no `code_symbol` entity input, and computes
  no canonical key** anywhere in this Epic's code;
- supplies `context.scope` as the repository entity id and `context.path` as the
  repository-relative path, which is the shape `symbolScope` expects.

AC-15 makes this testable rather than aspirational.

### 8.7 The re-parse gate, and what it can know before parsing

The gate is EPIC-010's derived-artifact record — `recordArtifact`, `getArtifact`,
`validateArtifact` — not a new persistence model. `validateArtifact` already
answers the exact question and already distinguishes the reasons: "built by a
different producer version" and "the source content has changed" call for the
same action and are different facts, and an operator asking why everything is
reparsing deserves the real one.

- **Scope** — one artefact per indexed file version. `derived_artifact.scope_id`
  is a `uuid` with a unique index on `(kind, scope_id)`, so the scope is the
  `file_version` entity id, derived through EPIC-009's identity function in the
  pattern `watermarkScopeId` established. Because EPIC-023 makes file-version
  identity content-derived, an unchanged file has an unchanged scope.
- **`sourceContentHash`** — the file's content hash, which `listFiles` already
  returns as the Git object id. Available **before** reading content, which is
  what lets the gate skip the read and not merely the parse.
- **`producerVersion`** — parser id, parser version, and grammar binary hash,
  composed into one string. All three change the output, so all three invalidate.

The wrinkle worth stating: `grammarBinaryHash` is reported in a parse result
attribute, which is *after* a parse, and a gate that only learns it afterwards
cannot use it to decide. It is available earlier — `loadGrammarBytes` hashes the
binary it read, grammars are cached per language per process, and the identity is
therefore known once per language per run rather than once per file. The
integration reads it through a **read-only accessor on the parser provider that
performs no parse**. If that accessor does not exist, this Epic adds it; it must
not become a second path into the parser.

**Rejected: gating on content hash alone.** Cheaper, and it would leave a parser
fix never reaching files already indexed — the precise failure EPIC-024 §8 built
result provenance to make detectable.

**Rejected: a new table for parse state.** Governance §5, and EPIC-010's own
migration records the intent — "EPIC-031 will add an index, EPIC-054 embeddings,
EPIC-060 answer packs. Each is a derived artefact needing the same question
answered." This is a fourth.

**Cost, stated rather than discovered later:** one `derived_artifact` row per file
version, so the table grows with distinct file versions indexed. That is the same
order as the `file_version` entities themselves and is accepted; it is recorded
here so it is a known property rather than a surprise.

### 8.8 Counts mean one thing each

`IndexReport.content` is added; nothing existing is renamed or redefined.

- `filesConsidered` — files the content stage examined, after EPIC-022's skip
  rules and before the gate.
- `filesSkippedUnchanged` — passed the gate; content was **not read** and not
  parsed.
- `filesRead` — content actually fetched from the provider. Excludes the above.
- `filesParsed` — a parse returned a result. A partial result from a file with
  syntax errors **is** parsed, and its warning is EPIC-024's to carry.
- `filesUnparsed` — a result marked unparsed, with `unparsedReasons` counting
  each `UNPARSED_REASONS` value separately.
- `filesFailed` — content could not be read at all. Distinct from unparsed: one
  is "Ferret could not obtain the bytes", the other is "Ferret has the bytes and
  no parser produced a result", and collapsing them would hide a provider fault
  inside a parser statistic.
- `symbols` — `created`, `updated`, `unchanged`, `tombstoned`, `reinstated`,
  summed from the `SymbolIndexReport` EPIC-034 already returns. Reported with
  EPIC-034's meanings, not new ones.

The invariant `filesRead === filesParsed + filesUnparsed` holds on every run, and
AC-11 asserts it.

A run with the flag off reports `content: undefined` — not a block of zeroes,
which would claim the stage ran and found nothing. Governance §6: "no result" and
"nothing there" must not look the same.

### 8.9 A content stage cannot make a run less safe than it is today

Every existing guarantee is preserved, and the content stage is subordinate to
all of them:

- **The watermark still moves only after every stage succeeded.** A content stage
  that failed or was cancelled means the run failed; the watermark does not move.
  EPIC-031 AC-6 is unchanged and now covers one more stage.
- **Lifecycle reconciliation is unaffected by content.** EPIC-032 gates
  tombstoning on a *complete tree listing*, and content is not evidence of
  presence or absence. A content stage that read nothing, read some, or was
  cancelled tombstones nothing and reinstates nothing. Files are retired on
  EPIC-032's rules alone.
- **Symbol reconciliation is per file and only for files parsed on this run.**
  EPIC-034's rule, unchanged: a file the content stage did not reach has its
  symbols left exactly as they are. A file skipped by the gate is not a file
  whose symbols were withdrawn.
- **One bad file cannot stop a run.** EPIC-024 already isolates a throwing
  parser; this Epic extends the same treatment to an unreadable file. Both are
  counted and reported, neither aborts.
- **Cancellation is checked between files, not only between stages**, so a large
  repository stops promptly, and a cancelled content stage leaves the run failed
  rather than partially claimed.

## 9. Acceptance criteria

- **AC-1** With content indexing disabled, `ferret index` produces the same
  output and the same database writes as the current build, and `IndexReport`
  carries no content section.
- **AC-2** The `source.repository` contract exposes a documented, bounded,
  cancellable content-read operation; `CAPABILITY_VERSIONS` reports 2 and
  `MINIMUM_CAPABILITY_VERSIONS` reports 1; a version-1 provider declaring no
  `operations` is **not** treated as supporting it; the Git provider declares and
  implements it; the EPIC-016 suite passes against the Git provider unchanged in
  intent.
- **AC-3** With content indexing enabled, `ferret index` traverses tree entry →
  content → structure → parse → symbols → storage, and `RepositoryIndexer` makes
  no filesystem access, spawns no subprocess and opens no socket: content arrives
  only through the capability.
- **AC-4** A supported file records EPIC-030 structure on its `file` and
  `file_version` attributes, produced by `describeFileStructure` and passed
  through the `structure` option `emitFiles` already accepts.
- **AC-5** TypeScript, TSX, JavaScript and Python files produce `code_symbol`
  entities through `ParserFramework` → `buildCodeSymbols` → `indexFileSymbols`,
  readable back by file, by name and by qualified name.
- **AC-6** A second content-enabled run over an unchanged repository reads no
  file content, parses nothing, writes no rows, and reports every file as
  skipped-unchanged. EPIC-031 AC-2 holds with content enabled.
- **AC-7** Changing the parser version, or the grammar binary hash, causes the
  affected files to be re-read and reparsed on the next run; changing neither
  does not.
- **AC-8** A symbol removed from a file is tombstoned; reinstating it restores
  the same identity as active; symbols in files the run did not parse are
  untouched — including files the gate skipped.
- **AC-9** A file no parser claims, one over the size bound, one detected binary,
  and one whose parser threw are each recorded with the corresponding
  `UNPARSED_REASONS` value and counted as unparsed, never as parsed, and none of
  them stops the run.
- **AC-10** A cancelled content stage, and a content stage that failed, each
  leave the watermark where it was, retire nothing, reinstate nothing, and report
  the run as unsuccessful.
- **AC-11** `IndexReport` content counts satisfy
  `filesRead === filesParsed + filesUnparsed`, exclude gate-skipped files from
  `filesRead`, count content-read failures separately from unparsed files, and
  report symbol counts equal to the sum of the `SymbolIndexReport`s returned.
- **AC-12** The core import graph reaches no `storage/` module and no concrete
  provider, and `core.packages.has('web-tree-sitter')` remains false — both
  asserted by the existing boundary tests, unmodified.
- **AC-13** The only boundary-test change is the addition of
  `@indoulia/ferret/parsers` to the CLI's permitted external package set, with
  its reason recorded in the test; assertions (1), (2) and (3) of §8.5 pass
  unchanged; and a positive test proves the parser is actually loaded through
  discovery and selected by capability when content indexing is enabled.
- **AC-14** Ferret indexes its own repository with content indexing enabled,
  through the production path, and the evidence records real structure and symbol
  counts, the unparsed breakdown by reason, and zero phantom files — the EPIC-032
  check, still passing.
- **AC-15** No module added by this Epic derives a symbol id, builds a
  `code_symbol` entity input, or computes a canonical key; and a regression test
  indexes a file twice through the production path and asserts that the second
  run tombstones **zero** symbols.
- **AC-16** A source provider that does not support the content operation is
  detected through `supports(capability, operation)` before it is called, and the
  run proceeds as a metadata-only index with the reason reported — never a
  missing-method failure.
- **AC-17** Grammar identity used by the re-parse gate is obtained without
  parsing a file, and the parser is entered through exactly one path.

## 10. Test requirements

- **Unit:** the gate decision table — unchanged content, changed content, changed
  parser version, changed grammar hash, absent artefact, artefact from a
  different producer; count arithmetic including the `filesRead` identity;
  capability-version acceptance and rejection, including a version-1 declaration
  that omits `operations`.
- **Integration against real Git:** content read at a revision that is not the
  working tree; a file modified in the working tree but not committed, proving
  the blob is read; the byte bound enforced before materialisation; cancellation
  mid-read; a path that does not exist at that revision.
- **Integration against real PostgreSQL and real Git**, which is where every
  criterion that is a property of both must be proven: AC-3 through AC-11, and
  AC-15.
- **Idempotence:** a third and fourth content-enabled run writing nothing.
- **The mass-tombstoning regression, explicitly:** two production-path runs over
  an unchanged file, asserting zero tombstones — the EPIC-034 defect, protected
  at the integration level rather than only at the unit level where it was fixed.
- **Isolation:** a run that parses one file of two leaves the other's symbols
  untouched; a run whose tree listing was truncated retires nothing, with content
  enabled.
- **Failure isolation:** a throwing parser, an unreadable blob, and an
  over-bound file in the same run, asserting the run completes and each is
  counted in its own bucket.
- **Boundary:** the existing suite unmodified except for the §8.5 amendment, plus
  the positive discovery test AC-13 requires.
- **Conformance:** the EPIC-016 suite against the Git provider, unchanged in
  intent, confirming the new declaration is well-formed and selectable.
- **Dogfooding:** Ferret over Ferret, content enabled, reported through the MCP
  surface where the surface exists and through `IndexReport` where it does not.

## 11. Security requirements

This Epic changes Ferret's exposure more than any line of its code suggests, and
the change should be stated plainly: **before it, no repository content ever
reached a parser in the production path. After it, attacker-controlled bytes are
parsed during every content-enabled index.**

Nothing here weakens an existing control, and every one of them now matters more:

- **The provider bounds the read before bytes are materialised.** A repository
  cannot make Ferret allocate an arbitrary buffer by containing a large blob.
- **EPIC-024's size bound and EPIC-025's segment cap still apply**, after the read
  bound, so a file under the read bound cannot produce an unbounded extraction.
- **EPIC-082 redaction is unchanged and unbypassed.** Extracted text is redacted
  at the framework boundary; this Epic adds no path that reaches segment text
  before the framework returns it.
- **Secret-bearing paths are already excluded** by `emitFiles` before a file
  becomes an entity, and the content stage operates on the files that survived
  that exclusion — so a `.env` is not read merely because content indexing is on.
- **Content never selects code.** A media type chooses among registered parsers; a
  grammar is loaded from the package's own directory by language name; nothing
  derived from repository content becomes a module specifier or a path.
- **The parser module specifier is fixed and internal.** `discoverProviders`
  "never scans a repository, package tree, or configuration file for code to
  execute", and this Epic passes it one constant.
- **No sandbox, stated rather than implied.** EPIC-024 recorded that a parser runs
  in-process with full privileges and that bounding is a weaker claim than
  containing. That was acceptable when parsers ran only in tests; it is now the
  live posture of an indexing run, and it is accepted here **because this Epic
  changes no trust boundary** — but it is the reason content indexing ships off by
  default, and the reason out-of-process parsing should be raised as its own Epic
  if it is ever wanted.
- **Symbol names, signatures and documentation remain untrusted data.** EPIC-034
  binds every value as a parameter and escapes `LIKE` metacharacters; this Epic
  adds no query.

## 12. Observability

- Per run: the content counts of §8.8, including the unparsed breakdown by
  reason, so "how much of this repository is unparsed, and why" stays a query
  rather than an investigation.
- Per skip: the gate's reason, taken from `validateArtifact`, so "the parser
  changed" and "the file changed" remain distinguishable in the log.
- A content stage that did not run says why — flag off, provider does not support
  the operation, or the run was cancelled — at `info`. EPIC-032 established that a
  skipped sweep is logged rather than silent; the same applies here.
- A content-read failure names the path and the classified error, once per file,
  not once per retry.

## 13. Performance constraints

EPIC-031 §13 established that the second run must be cheaper than the first, and
established it for a run that read a tree listing. **Reading and parsing content
is a materially different cost model, and this Epic does not claim otherwise.**

- Content indexing is **opt-in and off by default**, so no existing run changes
  cost at all. AC-1 is the guarantee.
- **The first content-enabled run is expected to be materially more expensive**
  than a metadata run, by an amount that depends on the repository. No figure is
  asserted, because no approved governance or specification document defines one
  and an invented threshold is a number that will be met by adjusting the
  measurement.
- **Subsequent runs must demonstrate the saving the gate exists to produce:**
  AC-6 requires that an unchanged repository is not re-read and not reparsed, and
  the gate consults the content hash `listFiles` already returned, so an
  unchanged file costs one comparison and no I/O.
- Grammars load once per language per process, as EPIC-025 §13 established, and
  grammar identity is read once per language per run rather than once per file.
- EPIC-031's own guarantee is preserved unchanged **for the metadata stages**, and
  AC-6 extends the "second run adds no rows" property to content.
- **No claim of parity with a metadata-only run will be made**, in this
  specification or in its evidence, without a measurement recorded in the
  validation document.

## 14. Definition of Done

- Every acceptance criterion in §9 satisfied, with the integration criteria proven
  against real PostgreSQL and real Git rather than against mocks.
- `npm run verify` green — lint, typecheck, build and the suite, run **after** any
  rebase, on the merge result rather than on the branch as it stood before.
- The EPIC-016 conformance suite green against the Git provider.
- The boundary amendment of §8.5 present, minimal, reasoned in the test file, and
  accompanied by the positive discovery test.
- The dogfooding run of AC-14 recorded, with real counts.
- A validation document at `docs/EPICs/validation/EPIC-108-VALIDATION.md`
  recording evidence per criterion and every limitation found, in the pattern the
  existing validation documents set.
- The registry entry updated to the status the evidence supports — and no earlier.
- No change to EPIC-031, EPIC-032, EPIC-045, or any validated Epic's acceptance
  criteria or evidence.

## 15. Governance alignment

- **§4 Provider-First Architecture** — content arrives through a versioned,
  documented capability contract; the indexer depends on no provider, and the
  parser is composed rather than imported.
- **§5 Reuse Before Reinvent** — no new table, no new persistence model, no second
  parser path, no second symbol-identity derivation. Every component this Epic
  connects already exists and is called as it was built to be called.
- **§6 Evidence Before Inference** — an unparsed file says why; a skipped file says
  why; a stage that did not run says why; a run with content off reports no
  content section rather than zeroes.
- **§8 Files Are First-Class** — this is the Epic in which that rule becomes true
  in production rather than in a library.
- **§12 Security** — bounded before materialisation, redacted at the framework
  boundary, content never selecting code; the absence of a sandbox stated rather
  than glossed.
- **§13 Reliability** — one unreadable file, one broken file and one throwing
  parser each cost exactly themselves; a cancelled run claims nothing.
- **§21 Versioning and Reproducibility** — the re-parse gate is keyed on parser and
  grammar identity, so a result can always be attributed to what produced it.
- **§22 Change Management** — the capability change is why this is an Epic and not
  a wiring commit, and the boundary amendment is recorded here rather than made
  incidentally during implementation.
- **AI-DEVELOPMENT-RULES §3, §7** — EPIC-031's scope contract is honoured by not
  extending it, and the scope above is the smallest that completely satisfies the
  criteria.

## 16. Staged implementation plan

Not implementation, and not to begin before §17. Each phase names the evidence
that closes it.

**Phase 1 — The capability.** The contract operation, its `RepositoryOperation`
name, the version raise and the version-1 compatibility rule, the Git
implementation against the object store. *Evidence:* unit tests for declaration
and version acceptance; integration tests against real Git for revision
correctness, the byte bound, cancellation and a missing path; the EPIC-016 suite
green. AC-2, and the provider half of AC-3.

**Phase 2 — Composition and ports.** `discoverProviders` in `ferret index`, the
two indexer ports, the flag, the capability-support check and metadata-only
fallback, and the §8.5 boundary amendment with its positive test. *Evidence:*
AC-1, AC-13, AC-16, and the indexer half of AC-3. **The flag does nothing yet,
deliberately — this phase proves the composition without the pipeline.**

**Phase 3 — Structure, parse and symbols.** The per-file flow, calling existing
functions only. *Evidence:* AC-4, AC-5, AC-8, AC-15, and the identity regression
test. Symbols reach the database through the production path for the first time.

**Phase 4 — The gate.** The derived-artefact record, the composed producer
version, the pre-parse grammar identity accessor. *Evidence:* AC-6, AC-7, AC-17,
and the idempotence runs.

**Phase 5 — Failure, cancellation and reporting.** The counts, the unparsed
breakdown, the read-failure bucket, the cancellation and watermark semantics, the
lifecycle non-interference. *Evidence:* AC-9, AC-10, AC-11, and the truncated
listing and isolation tests.

**Phase 6 — Dogfooding and validation.** Ferret over Ferret with content on;
counts recorded; limitations written down honestly. *Evidence:* AC-14, and the
validation document §14 requires.

Phases 1 and 2 are separable and reviewable on their own. Phases 3 to 5 are one
capability and would be artificial to split further. Phase 6 closes the Epic.

## 17. Approval record

Scope is **APPROVED**. Implementation has **not** been authorised and has not
begun; it starts only on an explicit, separate instruction.

Four governance decisions were put to the maintainer and all four were approved,
with the constraints recorded beside them:

1. **The Epic.** EPIC-108 — Content Indexing Integration, domain **File
   Intelligence**, priority **P0**, registered in the [Epic registry](README.md).
   Priority follows the registry's existing P0/P1/P2 convention; no new priority
   model was introduced.
2. **The capability change** — `source.repository` to version 2, with the
   compatibility rule of §8.4 preserved exactly: minimum supported version
   remains 1 where the existing contract requires it; a version-1 provider is
   never considered to support the content-read operation; and `declares()`'s
   omission semantics are never used to infer support for it. The stated purpose
   is that a provider declared before this operation existed cannot accidentally
   claim it.
3. **The boundary amendment** of §8.5, narrowly scoped: EPIC-025's package-root
   boundary is not weakened, no direct parser import into a prohibited layer is
   permitted, only the CLI external-package allowlist is amended and only as the
   provider-discovery composition actually requires, the positive test proving
   the parser is loaded is retained, and no existing assertion is deleted or
   broadly weakened to make the composition pass.
4. **`source.file` remains unimplemented.** Content reading is a
   `source.repository` operation. No second content-read path through
   `source.file` is introduced, and the reasoning in §8.3 stands.

Approving the scope authorises none of the following, which remain out of bounds
for the implementation when it is authorised:

- reopening EPIC-031, or modifying its acceptance criteria;
- modifying the acceptance criteria of EPIC-024, EPIC-025, EPIC-030, EPIC-033 or
  EPIC-034;
- editing any validated Epic's evidence;
- relaxing an architecture boundary to make a test pass;
- adding a relationship type, an intelligence feature, a table or a schema
  change;
- making content indexing a default;
- changing a provider contract without its version and conformance treatment;
- renaming or rebranding unrelated runtime infrastructure.
