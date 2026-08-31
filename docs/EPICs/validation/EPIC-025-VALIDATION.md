# EPIC-025 — Code File Parsing: validation evidence

**Status: VALIDATED** · one new runtime dependency, `web-tree-sitter@0.25.10`,
pinned exactly as TECHNOLOGY-DECISIONS §4 selected it. Grammars ship in the
package; the grammar *source* package is a dev dependency.

## What the parser does

`CodeParserProvider` is a `parser`-kind provider implementing EPIC-024's
`ContentParser`. It claims TypeScript, TSX, JavaScript and Python, parses with
tree-sitter, and returns a segment per declaration — labelled, spanning the
`export`/decorator wrapper a reader would recognise — plus documentation
comments, one segment for the import block, and a hierarchical outline in which
a method is a child of its class.

Every result records the grammar's name, ABI version and the SHA-256 of the
exact `.wasm` loaded.

## Acceptance criteria

Rows are `tests/unit/code-parser.test.ts` unless stated.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 four languages, selected through the framework | PASS | `finds every kind of declaration, labelled`; `parses TSX with the TSX grammar`; `parses JavaScript`; `parses Python, including a decorated function` — all driven through `ParserFramework`, not the provider directly |
| AC-2 function, class, method, interface, type, enum, labelled | PASS | `finds every kind of declaration, labelled` |
| AC-3 a method nests inside its class | PASS | `nests a method inside its class rather than beside it` asserts `Box.children === ['width','height']` *and* that `width` is not also top-level; repeated for JavaScript and Python |
| AC-4 a documentation comment is its own segment | PASS | `keeps a documentation comment as its own segment` |
| AC-5 imports extracted; none means no segment | PASS | `collects imports into one segment`; `has no import segment when a file imports nothing`; `does not mistake an exported declaration for an import` |
| AC-6 a broken file yields what parsed, plus a warning | PASS | `returns what parsed, plus a warning` — `good` survives, `syntax-error` is reported, `hasSyntaxErrors` is true |
| AC-7 spans are byte offsets | PASS | `indexes the original bytes, not UTF-16 code units` slices the original `Uint8Array` by the reported span and compares the decoded text; `agrees with the framework, which rejects a span past the end` |
| AC-8 grammar identity in every result | PASS | `records the grammar that produced the result` — name, numeric ABI version, 16-hex binary hash, and `wts0.25.10` in the parser version |
| AC-9 declines what it cannot parse | PASS | `claims the media types it has grammars for, and nothing else`; `declines rather than guessing, so the framework says no-parser` |
| AC-10 an unloadable grammar costs one language | PASS | `fails that language only` — a provider pointed at a nonexistent grammar directory reports `parser-failed`, and the working provider parses in the same test |
| AC-11 passes the conformance suite | PASS | `satisfies the EPIC-016 conformance suite` |
| AC-12 core carries no grammar; four ship | PASS | `tests/unit/boundaries.test.ts` — `web-tree-sitter` is in the parsers graph and in neither the core nor the CLI graph; `tests/integration/packaging.test.ts` asserts exactly the four `.wasm` files reach the tarball; `tests/integration/distribution.test.ts` asserts the `./parsers` subpath |

## Design decisions worth recording

**A segment spans the wrapper, not the bare declaration.** `export function
add()` is an `export_statement` containing a `function_declaration`. The
declaration is what has a name; the wrapper is what a reader recognises and what
a retrieval hit should quote. The first implementation returned spans starting
at `function`, and the byte-span test caught it — the span was *correct*, and
the unit was wrong.

**`export_statement` is both an import and a declaration.** `export { x } from
'./y'` brings something into scope; `export class Foo {}` does not. Treating the
node type as an import loses every exported class in a TypeScript file, so the
test for it is explicit.

**`.tsx` is routed by path, not by media type.** EPIC-024 maps `.tsx` and `.ts`
to the same `text/x-typescript`, which is correct — it *is* TypeScript — but the
two grammars disagree about `<T>`, and one of them will be wrong on any file
that uses it. The path is the only thing that distinguishes them.

**Byte offsets are computed per line, not per character.** tree-sitter indexes
UTF-16 code units and EPIC-024 spans are UTF-8 bytes. A full index would cost
four bytes per character; instead each line's byte start is precomputed and a
position resolves as that start plus the encoded length of the line's prefix.
Content that is entirely ASCII skips the conversion, because the two agree.

**Grammars are a dev dependency and a build artefact.** `tree-sitter-wasms`
carries about forty grammars and 50 MB; Ferret uses four (5.6 MB).
`scripts/copy-grammars.mjs` copies those four into `dist`, so an installing user
gets four. The script cannot import the TypeScript language table, so its list
is duplicated — and the duplication is guarded by a test that imports both and
compares them.

**The grammar hash is over the bytes, not over a version string.** A republished
package with an unchanged version number is exactly what a recorded version
would miss, and TECHNOLOGY-DECISIONS §4 made grammar identity mandatory because
two ecosystems' grammars disagreed by 1.2% of named nodes over the same corpus.

**Trees and parsers are freed in `finally`.** tree-sitter allocates in WASM
memory, which the JavaScript collector knows nothing about. Freeing on the same
path that allocated — failure included — is what stands between an index run and
a heap that grows by one tree per file. A `Language` has no `delete` in
web-tree-sitter 0.25; a loaded grammar is a process-lifetime resource, and
shutdown drops the cache rather than pretending to free it.

**A file with no declarations gets one segment for itself.** A script is still
content, and returning nothing would make it indistinguishable from a file the
parser could not read.

## Package size

The published package went from 1.4 MB to 7.2 MB unpacked, and the size backstop
was raised deliberately rather than nudged. 5.6 MB is the grammars; the test now
asserts the *non-grammar* output stays under 2 MB, so the raised ceiling cannot
hide a leak. Compressed, the tarball is far smaller — WASM compresses well — but
the unpacked figure is what an install writes to disk and is the honest number.

## Limitations

- **Four languages.** Go, Rust, Java, C# and everything else are declined, which
  the framework reports as `no-parser`. Each addition is a table entry, a
  grammar in the build list, and roughly its own size in the package — the last
  of which is why the set is small rather than complete.
- **Structure, not semantics.** No types resolved, no call graph, no import
  resolved to a file. The canonical AST is EPIC-033 and the symbol index
  EPIC-034; this Epic produces segments and an outline and claims nothing more.
- **Arrow functions and `const` declarations are not declarations here.**
  `export const handler = () => {}` yields no named segment, which is a real gap
  for modern JavaScript and is a table decision rather than a parser one.
- **The outline stops at depth 12.** Declarations deeper than that are still
  found as segments; only the tree stops.
- **No timeout.** EPIC-024 bounds size and passes the abort signal, and the
  signal is checked before parsing starts — but tree-sitter's own parse is not
  interruptible, so a pathological file is bounded by its size, not by a clock.
- **The segment cap is 5,000 and the excess is dropped**, with a warning. What
  is kept is the first 5,000 in tree order, which is not a considered choice
  about *which* 5,000 matter.
- **JSX is parsed with the TSX grammar for `.jsx` too.** That is right for the
  syntax and wrong for the language label, which reports `tsx`.
- **The grammar list is duplicated** between the build script and the language
  table. The test makes drift a failure rather than a surprise, but it is still
  two places.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean; the build reports
`copy-grammars: 4 grammar(s), 5.6 MB`.
`vitest run tests/unit`: 33 files, 885 passed.
`vitest run tests/integration`: 31 files, 605 passed, 3 skipped.
