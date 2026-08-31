# EPIC-025 — Code File Parsing

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-025-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry, Governance
> §4, §5, §6, §12, §13, §19 and §21, and TECHNOLOGY-DECISIONS §4, following the
> Epic Specification Standard. The canonical AST model (EPIC-033) and the symbol
> index (EPIC-034) are separate Epics and are not implemented here.

## 1. Objective

Extract the structure of a source file — its declarations, their nesting, their
documentation and its imports — as EPIC-024 segments and an outline, from a
grammar whose exact version is recorded with the result.

## 2. Value

EPIC-024 defined what extraction *is* and deliberately shipped no parser, so
nothing yet reads a line of code. Code files are the majority of what Ferret
indexes and the subject of most questions asked of it, and a whole-file blob is
the wrong unit for every consumer downstream: retrieval returns a 2,000-line
file instead of the function asked about, a context pack cannot cut below the
file, and evidence cannot quote a method.

A parser that survives broken code matters as much as one that handles correct
code. Half the files worth indexing are mid-edit, and a parser that returns
nothing for a file with one unbalanced brace is a parser that fails exactly when
someone needs help.

## 3. Scope

- a `parser` capability provider for source files, behind EPIC-024's contract;
- `web-tree-sitter` with grammars pinned and version-stamped, per
  TECHNOLOGY-DECISIONS §4;
- TypeScript, TSX, JavaScript and Python;
- segments for declarations, documentation comments and the import block;
- a hierarchical outline: a method nests inside its class;
- byte-accurate spans for content that is not ASCII;
- partial extraction from a file with syntax errors, reported as a warning;
- grammar provenance in the result: grammar name, ABI version and the hash of
  the exact grammar binary used;
- publication on its own package subpath, so the core never carries a grammar.

## 4. Non-scope

- the canonical AST model — EPIC-033;
- the symbol index and cross-file references — EPIC-034, EPIC-035;
- any non-code format — EPIC-026 through EPIC-029;
- semantic analysis: type resolution, call graphs, imports resolved to files;
- languages beyond the four listed. Adding one is a table entry and a grammar,
  by design, but each is a size and maintenance decision.
- wiring the parser into the indexer, which belongs to the Epic that makes
  indexing read content.

## 5. Inputs

- EPIC-024's `ContentParser` contract, framework, detection and media types;
- EPIC-011/013 capability declaration and selection;
- `web-tree-sitter` 0.25.10 and `tree-sitter-wasms` 0.1.12, both pinned exactly.

## 6. Outputs

- `CodeParserProvider`, a `parser`-kind provider implementing `ContentParser`;
- `dist/parsers/code/grammars/*.wasm`, the four grammars, copied at build;
- `@indoulia/ferret/parsers` — the subpath that carries them;
- `CODE_LANGUAGES`, the language table, as data.

## 7. Dependencies

EPIC-011, EPIC-013, EPIC-024, and TECHNOLOGY-DECISIONS §4.

## 8. Contracts

### Grammars are pinned and stamped

TECHNOLOGY-DECISIONS §4 requires it: the two ecosystems' grammars disagreed by
1.2% of named nodes over the same corpus, so a grammar version is part of what
produced a result. Every parse records the grammar's name, its ABI version and
the SHA-256 of the exact `.wasm` loaded. A grammar change is therefore
detectable in the index without re-reading a file.

### Grammars ship in the package, not in the dependency tree

`tree-sitter-wasms` carries about forty grammars and 50 MB; Ferret uses four.
It is a **dev** dependency, and the build copies only what is used into `dist`,
so an installing user gets four grammars and no unused ones.

### Partial results are results

A file with syntax errors is parsed as far as tree-sitter can, its segments are
returned, and a warning records that the tree had errors. Returning nothing
would make "this file is broken" indistinguishable from "this file is empty",
which Governance §6 forbids.

### Spans are byte offsets, whatever the encoding

tree-sitter indexes UTF-16 code units; EPIC-024 spans are UTF-8 byte offsets
into the original content. The parser converts. For ASCII content the two are
equal and the conversion is skipped.

### The core never loads a grammar

The provider lives outside the core import graph and is published on its own
subpath. Nothing reachable from `@indoulia/ferret` imports `web-tree-sitter`.

## 9. Acceptance criteria

- **AC-1** TypeScript, TSX, JavaScript and Python files are each parsed into
  segments, selected by media type through EPIC-024's framework.
- **AC-2** A function, class, method, interface, type alias and enum each become
  a segment labelled with its name.
- **AC-3** A method's outline node is a child of its class's, not a sibling.
- **AC-4** A documentation comment is a segment of kind `comment`.
- **AC-5** Import statements are extracted, and a file with none has no import
  segment rather than an empty one.
- **AC-6** A file with a syntax error yields the segments that did parse plus a
  warning naming the condition.
- **AC-7** Spans are byte offsets: a file containing non-ASCII characters has
  spans that index the original bytes correctly.
- **AC-8** Every result carries the grammar name, ABI version and binary hash.
- **AC-9** A media type the parser does not handle is declined, so the framework
  reports `no-parser` rather than the parser guessing.
- **AC-10** A grammar that cannot be loaded fails that language only; the others
  keep working.
- **AC-11** The provider satisfies the EPIC-016 conformance suite.
- **AC-12** No module reachable from `@indoulia/ferret` imports
  `web-tree-sitter`, and the built package contains exactly the four grammars.

## 10. Test requirements

- a fixture file per language, asserting labelled segments and outline nesting;
- nesting: a class with two methods, checked as a tree rather than a list;
- a syntactically broken file, asserting partial segments and the warning;
- a file with non-ASCII content, asserting spans slice the right bytes;
- a declined media type, driven through the framework;
- a grammar-load failure injected, asserting the other languages still parse;
- the conformance suite run against the provider;
- boundary tests for the import graph, and a packaging test for the grammars.

## 11. Security requirements

Grammar binaries are loaded from the package's own directory, never from a path
derived from repository content, and their hashes are recorded. A `.wasm` is
data to tree-sitter, not a module Ferret imports.

Source files are attacker-controlled. EPIC-024 already bounds size and redacts
extracted text; this parser adds a segment-count cap so a pathological file
cannot produce an unbounded result, and holds no reference to a tree after it
has finished with it, because tree-sitter memory is explicitly freed rather
than collected.

## 12. Observability

Each result reports the language, the grammar identity, the segment count,
whether the tree had errors and whether the segment cap was reached.

## 13. Performance constraints

Grammars load once per process and are cached by language; a second parse of the
same language performs no I/O. Parsing is one tree-sitter pass and one walk.
Every tree and cursor is freed on the same path that created it, including on
failure.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, conformance,
packaging evidence, exports, documentation and validation evidence. No AST
model, symbol index, or non-code format behaviour is claimed here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — a parser provider behind the capability;
  the core names it nowhere.
- **§5 Reuse Before Reinvent** — tree-sitter, as TECHNOLOGY-DECISIONS §4
  selected, rather than a hand-written parser per language.
- **§6 Evidence Before Inference** — a broken file yields what parsed and says
  it was broken.
- **§12 Security** — grammars come from the package; content never selects a
  binary.
- **§13 Reliability** — one unloadable grammar costs one language.
- **§21 Versioning and Reproducibility** — grammar identity is recorded with
  every result, which §4 of the technology decisions makes mandatory.
