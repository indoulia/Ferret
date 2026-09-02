# EPIC-029 — Text & Markdown Intelligence

**Status: APPROVED | Priority: P1 | Domain: File Intelligence**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under File Intelligence, where it
> has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Give a document the structure a code file already has — headings, code blocks,
tables, front matter — so retrieval can quote a section rather than a file.

## 2. Value — measured on Ferret's own repository

Four Epics deferred non-code parsing to EPIC-026 through EPIC-029 (EPIC-024 §4,
EPIC-025 §4, EPIC-097 §4, EPIC-108 §4), and EPIC-108's validation recorded the
consequence.

Measured now, on Ferret's own 611 files:

| extension | files with no structure |
| --- | --- |
| `md` | **206** |
| `json` | 26 |
| `mjs` | 19 |
| `sql` | 17 |
| `txt` | 3 |

**206 markdown files**, and they are where most of Ferret's recorded knowledge
lives: every Epic specification, every validation record, every architecture
decision. EPIC-097's harness prints the same fact from the other side —
`README.md parsed=false`, `docs/architecture.md parsed=false`,
`docs/onboarding.md parsed=false`.

A document with no structure is retrievable only as a whole file. EPIC-059 can
put it in a context pack and cannot quote the section that answers the question;
EPIC-087's content search can find a term inside it and cannot say which heading
it was under.

## 3. Scope

- **A Markdown parser**: ATX and setext headings into a nested outline; fenced
  and indented code blocks; tables; YAML front matter; prose.
- **A plain-text parser**, registered as a fallback so it claims what nothing
  else will without displacing a specific parser.
- **`outlineKind` on the parse contract** — §8.4, and the defect it prevents.
- **No new dependency and no grammar.** §8.1.
- **The parsing labels updated** to record that a parser now claims these files,
  because the harness gates on agreeing with them.

## 4. Non-scope

- **PDF, Office and spreadsheets** — EPIC-026, EPIC-027, EPIC-028. Each needs a
  decoder this Epic does not add.
- **JSON, YAML, SQL and `.mjs`.** `.mjs` is JavaScript and belongs to EPIC-025's
  grammar table; the data formats have no Epic and §16 raises them.
- **Semantic understanding of prose.** A heading is a heading because the syntax
  says so. Nothing here summarises, classifies or embeds.
- **Link graphs between documents.** A Markdown link is a reference to a path,
  and resolving one to an entity is EPIC-035's shape of problem over a different
  edge type; §16 raises it.
- **Rendering.** Ferret extracts structure; presenting it is a client's.
- **Changing what a `code_symbol` is** — §8.4 exists precisely so a heading does
  not become one.

## 5. Inputs

`text/markdown` and `text/plain` from EPIC-024's detection, which already maps
`.md`, `.markdown` and `.mdx`; the file's decoded text.

## 6. Outputs

- `src/parsers/text/` — the Markdown and plain-text parsers.
- `ParseOutput.outlineKind`, set by every Ferret parser.
- Segments and an outline for 206 files that had neither.
- No schema change.

## 7. Dependencies

EPIC-024 (the framework, the contract and media-type detection), EPIC-030 (the
structure a file records), EPIC-097 (the harness and the labels this changes),
EPIC-108 (the content stage that will now parse these files).

## 8. Contracts

### 8.1 No grammar, and no new dependency

The code parser loads several megabytes of WASM per language, and
`src/parsers/index.ts` records why that is confined: "a grammar is several
megabytes of WASM, and the core must be installable and importable without any
of it".

Markdown does not need one. Headings, fences, tables and front matter are
**line-oriented** syntax, and a scanner over lines is deterministic, auditable
in one file, and costs nothing to install. Adding `tree-sitter-markdown` would
double the grammar payload to recognise `##`.

What that costs, stated: no inline parsing. Emphasis, links and inline code are
left in the text of the segment they belong to. A caller wanting the link target
gets the line; §16 raises the link graph.

### 8.2 Structure is what the syntax says, and nothing more

- **A heading** — `#`…`######`, or a setext underline of `=` or `-` — is a
  `HEADING` segment and an outline node at that level.
- **A fenced block** — ` ``` ` or `~~~` — is a `CODE` segment, and its info
  string is recorded as the language it claims. **Its content is never scanned
  for headings**: a `#` inside a fence is a comment in someone else's language.
- **A table** — a pipe row followed by a delimiter row — is a `TABLE` segment.
- **Front matter** — a `---` block at the very start — is `METADATA`, which is
  what EPIC-024's contract reserves it for ("front matter, EXIF, document
  properties — facts about the file").
- **Everything else** is `TEXT`, in runs, so a paragraph is one segment rather
  than one per line.

An outline node's level comes from the syntax, and a document that jumps from
`#` to `###` nests the `###` under the `#` rather than inventing a level. Real
documents skip levels, and a parser that refused them would produce no outline
for the files most in need of one.

### 8.3 A plain-text parser claims what nothing else will

Registered with `ParserSupport.FALLBACK`, which the contract added for exactly
this: "a generic text parser can be registered alongside specific ones without
displacing them". It produces one `TEXT` segment per paragraph and no outline —
a `.txt` file has no structure to claim, and inventing one would be a claim about
content this Epic does not make.

### 8.4 An outline is not always a symbol table

**The defect this contract prevents.** `runContentStage` calls
`buildCodeSymbols` for every parse that produced an outline, and
`codeSymbolKindOf` maps an unrecognised kind to `CodeSymbolKind.UNKNOWN`. So a
Markdown outline would become `code_symbol` entities — a heading indexed as a
declaration, 206 files' worth, filling EPIC-034's symbol index with prose.

So `ParseOutput` gains `outlineKind`:

```
code      — the outline is declarations. `buildCodeSymbols` applies.
document  — the outline is sections. It does not.
```

**Absent means no code symbols**, which is the safe default and the honest one:
a parser that has not said its outline is a symbol table has not said it. Every
Ferret parser sets it explicitly, and the content stage requires `code` before
it builds a symbol. A third-party parser that says nothing gets segments and an
outline and no symbols, which is a smaller loss than a symbol index full of
headings.

### 8.5 The labels change, and that is a fact rather than a concession

`datasets/parsing/labels.json` records `"unparsedReason": "no-parser"` for four
Markdown files, and EPIC-097's harness gates `parseDisagreements` on zero
because "the label says which files have a parser, and disagreeing with it is a
fact about the product, not a ranking opinion".

A parser now claims them, so the fact changed and the label must say so:
`language: "markdown"`, no `unparsedReason`, and `expected: []` — **no symbols
are expected**, because §8.4 makes a heading not a symbol. No acceptance
criterion is weakened; a criterion is being kept honest.

### 8.6 Retrieval quality must not regress

The golden corpus contains four Markdown files and one of its labels
(`text-onboarding`) targets one. Structure changes what content indexing stores
for them, so EPIC-098's figures are re-measured and must not fall.

## 9. Acceptance criteria

- **AC-1** An ATX heading becomes a `HEADING` segment and an outline node at its
  level.
- **AC-2** A setext heading does the same, at level 1 for `=` and 2 for `-`.
- **AC-3** Nested headings produce a nested outline; a skipped level nests under
  the nearest shallower heading rather than inventing one.
- **AC-4** A fenced code block becomes a `CODE` segment carrying its info string.
- **AC-5** A `#` inside a fence produces no heading and no outline node.
- **AC-6** An unterminated fence does not swallow the rest of the file silently:
  it ends at the file and is reported as a warning.
- **AC-7** A table becomes one `TABLE` segment.
- **AC-8** YAML front matter at the start becomes a `METADATA` segment; a `---`
  elsewhere does not.
- **AC-9** Prose becomes `TEXT` segments in runs, one per paragraph.
- **AC-10** Every segment's span is valid: within the text, `startByte <
  endByte`, and the bytes it names are the segment's own.
- **AC-11** The parser sets `outlineKind: 'document'`; the code parser sets
  `'code'`.
- **AC-12** A Markdown file indexed end to end produces **no `code_symbol`
  entity**.
- **AC-13** The plain-text parser claims `text/plain` as `FALLBACK` and does not
  displace a native parser for a type both could take.
- **AC-14** A file of only whitespace, an empty file, and a file of one heading
  each parse without error.
- **AC-15** EPIC-097's harness reports `parseDisagreements: 0` with the updated
  labels, and `README.md` as `parsed=true`.
- **AC-16** EPIC-098's figures do not regress: mean p@10 ≥ 0.3611, recall ≥
  0.9167, `falsePositives` 0.
- **AC-17** Indexing Ferret's own repository parses the 206 Markdown files, and
  the run reports them as parsed rather than `no-parser`.

## 10. Test requirements

**Unit** — every AC-1 to AC-14 case over strings: each heading form, the fence
cases including the unterminated one, tables, front matter in both positions,
paragraph runs, span validity over a document with all of them, and four
degenerate inputs.

**Integration** — the parser through the real framework and registry, as
EPIC-108 composes it; a Markdown file indexed end to end asserting no
`code_symbol` (AC-12); AC-15 and AC-17.

**Quality** — AC-16 through EPIC-098's harness, before and after.

**Failure** — a file that is not valid UTF-8 (already handled upstream), a
100,000-line document against the segment bound, and a fence claiming a language
that does not exist.

**Regression** — EPIC-024's, EPIC-025's, EPIC-097's and EPIC-108's suites.

## 11. Security requirements

A document is repository content and reaches a client through the same
containment every other parse does — EPIC-084's fences apply to a `TEXT` segment
exactly as to a `CODE` one, and this Epic adds no new surface. One new
consideration: front matter is *machine-readable* content authored in the
repository, and `METADATA` must not be treated as configuration. It is recorded
as a segment and nothing reads it as policy, which is Governance §12's rule that
repository content is data.

## 12. Observability

The content stage's existing counters answer this Epic: `parsed` rises and
`unparsed by no-parser` falls, both already reported per run. The Markdown
parser adds a heading count to its attributes, beside the code parser's
declaration count.

## 13. Performance constraints

One pass over the lines, no backtracking, no grammar to load — so the parser
starts instantly and costs O(bytes). The existing segment bound applies
unchanged.

## 14. Definition of Done

Scope implemented; AC-1 to AC-17 satisfied with evidence in
`validation/EPIC-029-VALIDATION.md`; unit, integration, quality and failure
tests present and passing; `npm run verify` green; the registry updated;
EPIC-108's recorded `no-parser` figure struck with a dated note.

## 15. Governance alignment

- **§8 Files Are First-Class** — a document is a file Ferret understands, not a
  blob it stores.
- **§14 Lightweight Infrastructure** — §8.1 declines a second grammar payload to
  recognise `##`.
- **§6 Evidence Before Inference** — §8.2 extracts what the syntax says and
  nothing more; §8.4's absent-means-no-symbols is the same rule applied to a
  parser's own claim.
- **§19 Testing and Quality** — §8.5 keeps a label honest rather than relaxing a
  gate, and §8.6 re-measures retrieval rather than assuming.

## 16. Raised, not absorbed

- **No inline parsing**, so a Markdown link's target is text rather than a
  reference. Resolving `[a](./b.md)` to the `file` entity for `b.md` would be a
  document link graph — EPIC-035's shape over a different edge type — and it has
  no owner. It is the most valuable next increment on this Epic.
- **JSON, YAML and SQL have no Epic.** 26 + 17 files on Ferret's own repository,
  and the registry names an Epic for none of them. `.mjs` is different: it is
  JavaScript, and EPIC-025's grammar table simply does not list the extension.
- **Front matter is not interpreted.** It is a `METADATA` segment, and what its
  keys *mean* is a per-project convention no Epic defines.
- **The 206 figure is Ferret's own repository.** It is a measurement, not a
  claim about repositories in general.

## 17. Recorded during implementation

- **§8.4 was written because the defect was found before shipping, not after.**
  `runContentStage` built code symbols from every outline and
  `codeSymbolKindOf` maps an unrecognised kind to `UNKNOWN` rather than
  refusing — so a heading would have been indexed as a declaration across 206
  files. Measured after the fix: **0** symbols from Markdown, 2,055 in total.
- **Three gates fired, and each was right.** EPIC-097's `parseDisagreements`
  refused the build until the labels recorded that a parser now claims those
  files; EPIC-099's conformance gate refused it until the new provider was added
  to its runnable list; and two content-stage fakes stopped producing symbols
  because they had not said their outline was code, which is the contract's
  default working.
- **The composition returns two providers now**, through `providers` rather than
  `provider`. Neither can displace the other: the code parser claims what its
  grammars cover natively and the text parser claims Markdown natively and other
  text as a fallback, which is what `ParserSupport` is for.
