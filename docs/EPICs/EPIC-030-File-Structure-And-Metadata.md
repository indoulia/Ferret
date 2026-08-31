# EPIC-030 — File Structure & Metadata

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-030-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §6, §8, §9, §11 and §22, following the Epic Specification Standard.
> `attributes.ts` already names this Epic as the one that enriches `file` and
> `file_version`; this is that enrichment.

## 1. Objective

Describe what a file *is* — its shape, its line structure, and whether a human
wrote it — and record that as canonical attributes on `file` and `file_version`.

## 2. Value

EPIC-022 and EPIC-023 gave files identity from their tree entry alone, and
EPIC-024 answers only what is needed to pick a parser. Nothing yet says how many
lines a file has, whether it uses CRLF, or — the one that matters most —
**whether anybody wrote it.**

A repository's `dist/`, its lockfiles, its minified bundles and its vendored
dependencies are frequently the majority of its bytes and almost never the
answer to a question. Without a classification, retrieval ranks a 40,000-line
`package-lock.json` against the function someone asked about, and a context pack
spends its budget on generated output. Marking them is not filtering — the files
stay indexed and answerable — it is giving every consumer downstream a fact it
would otherwise each guess at, differently.

## 3. Scope

- line structure: line count, line-ending style, trailing newline, longest line;
- encoding and binary verdict, carried through from EPIC-024 detection;
- a single classification per file — source, test, documentation, configuration,
  data, generated, vendored or binary — with the reason it was chosen;
- independent `generated` and `vendored` flags, because a file can be both and
  still needs one classification;
- generated detection from the path *and* from in-content markers;
- extended `fileAttributes` and `fileVersionAttributes`;
- an optional structure input to `emitFiles`, so a caller that has content can
  record it.

## 4. Non-scope

- reading file content. This Epic derives from bytes it is given; nothing here
  opens a file, and wiring content into indexing belongs to the Epic that makes
  indexing read it.
- language *parsing* — EPIC-024, EPIC-025;
- the symbol index and declaration counts — EPIC-034;
- ranking or filtering by classification. This Epic supplies the fact; EPIC-056
  and EPIC-057 decide what to do with it.
- diff, blame or per-line history — EPIC-019, EPIC-020.

## 5. Inputs

- EPIC-024 `detectContent`: media type, binary verdict, encoding, decoded text;
- EPIC-006 canonical attributes for `file` and `file_version`;
- EPIC-022 tree entries, for path and size.

## 6. Outputs

- `describeFileStructure(path, bytes)` returning a `FileStructure`;
- `FileClassification` and `LineEnding`, both stable enumerations;
- `fileAttributesFrom` and `fileVersionAttributesFrom`, the attribute fragments;
- extended `fileAttributes` / `fileVersionAttributes` schemas;
- `extensionOf`, moved into the core so the Git provider and this Epic share one
  definition rather than two.

## 7. Dependencies

EPIC-006, EPIC-022, EPIC-023, EPIC-024.

## 8. Contracts

### One classification, two flags

`classification` is single-valued and precedence-ordered, because a consumer
needs one answer. `generated` and `vendored` are separate booleans, because a
minified bundle inside `node_modules` is genuinely both and a consumer asking
"is this generated" must not get `false` because `vendored` won.

### Path and content both decide

A path says `dist/bundle.js` is generated; a `@generated` marker says
`src/schema.ts` is too. Neither alone is enough, and content is checked only in
the first few kilobytes, because a marker that is not near the top of the file
is not a marker.

### Classification is a claim with a reason

Every `FileStructure` carries `classificationReason` — the pattern or marker
that decided it. Governance §6 forbids a derived judgement that cannot be
explained, and "why is this file marked generated" is the first question anyone
will ask of it.

### Binary files get structure too

A binary file has a size, an extension and a classification. It has no line
count, and the field is `undefined` rather than `0` — which would be a claim
that the file has no lines rather than that the question does not apply.

### Attributes are additive

`fileAttributes` and `fileVersionAttributes` gain optional fields. The entity
envelope is unchanged, so `ENTITY_SCHEMA` stays at version 1 — this is exactly
the extension EPIC-006 AC-4 anticipated.

## 9. Acceptance criteria

- **AC-1** Line count, line-ending style and trailing-newline are reported for
  text, and are `undefined` for binary.
- **AC-2** A file mixing LF and CRLF reports `mixed` rather than either.
- **AC-3** A generated file is detected from its path, and separately from an
  in-content marker.
- **AC-4** A vendored file is detected from its path, and a vendored *and*
  generated file reports both flags with `vendored` as the classification.
- **AC-5** Test, documentation, configuration and data files each classify, and
  an ordinary source file classifies as `source`.
- **AC-6** Every classification carries a reason naming what decided it.
- **AC-7** A binary file classifies as `binary` and reports no line structure.
- **AC-8** An empty file is reported as empty, and does not classify as binary.
- **AC-9** The attribute fragments validate against the extended schemas, and a
  round trip through `createEntity` preserves them.
- **AC-10** `emitFiles` records the structure it is given, and behaves exactly as
  before when it is given none.
- **AC-11** A content marker beyond the inspected window does not mark a file
  generated, so a repository cannot hide a file from retrieval by burying a
  marker in it.
- **AC-12** `extensionOf` has one definition, shared by the Git provider.

## 10. Test requirements

- line structure for LF, CRLF, mixed, no trailing newline, and a single line;
- a generated path, a generated marker, a marker past the window, and a file
  that merely mentions the word;
- vendored, vendored-and-generated, test, docs, config, data, source;
- binary and empty;
- schema validation of both fragments, and an entity round trip;
- `emitFiles` with and without structure;
- a test that the Git provider's `extensionOf` is the core one.

## 11. Security requirements

Classification is derived from repository content, so it is a *claim by the
repository* wherever a marker decides it. It must never grant or remove
authority: marking a file generated changes how it ranks, never whether it is
readable or whether a security control applies. The content window is bounded so
a large file cannot make detection expensive, and detection runs no pattern that
can backtrack catastrophically on hostile input.

## 12. Observability

Every structure carries the reason for its classification, so an aggregate
answer — "43% of this repository is generated, mostly `dist/`" — is a query over
recorded attributes rather than a re-derivation.

## 13. Performance constraints

One pass over the decoded text for line statistics, and a bounded prefix scan
for markers. No second decode: the text EPIC-024 already produced is reused.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, schema extension,
exports, documentation and validation evidence. No ranking, parsing or content
reading behaviour is claimed here.

## 15. Governance alignment

- **§6 Evidence Before Inference** — every classification says what decided it.
- **§8 Files Are First-Class** — a file is described, not just identified.
- **§9 Context Is First-Class** — "is this generated" is context every consumer
  needs and none should re-derive.
- **§11 Retrieval** — supplies the signal ranking will use, without ranking.
- **§22 Change Management** — stays within the approved File Structure &
  Metadata capability.
