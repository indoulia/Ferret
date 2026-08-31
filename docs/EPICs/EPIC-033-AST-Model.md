# EPIC-033 — AST Model

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-033-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry, Governance
> §4, §6, §8, §21 and §22, and TECHNOLOGY-DECISIONS §4, following the Epic
> Specification Standard. Storage and lookup of these symbols is EPIC-034;
> cross-file references are EPIC-035.

## 1. Objective

Turn a parser's extraction into a canonical, provider-neutral model of the code
a file declares — named, nested, qualified, and stably identified.

## 2. Value

EPIC-025 produces segments and an outline, both shaped by tree-sitter's node
types. That is the right output for a parser and the wrong input for everything
else: `method_definition` and `function_definition` are grammar vocabulary, and
a consumer that switches on them is coupled to the grammar version — which
TECHNOLOGY-DECISIONS §4 warned is not even stable across ecosystems.

The symbol index (EPIC-034), retrieval, context packs and evidence all need the
same four things about a declaration: what kind of thing it is in words Ferret
owns, what it is *called* including its enclosing scopes, where it is, and an
identifier that stays the same when the file is re-indexed. Deriving those once
is the difference between one code model and four.

## 3. Scope

- a canonical `CodeSymbolKind` vocabulary, independent of any grammar;
- `CodeSymbol`: kind, name, qualified name, span, signature, modifiers,
  documentation, parent, and stable id;
- construction from an EPIC-024 `ParseOutput` — outline for structure, segments
  for text;
- qualified names built from enclosing scopes;
- documentation attached from the comment immediately above a declaration;
- modifiers and a one-line signature, derived from the declaration's own text;
- overload disambiguation, so two same-named declarations get distinct ids;
- stable identity derived the way EPIC-006 derives every other id.

## 4. Non-scope

- storing or querying symbols — EPIC-034;
- references, call graphs and cross-file resolution — EPIC-035;
- type checking or any semantic analysis;
- parsing. This Epic consumes `ParseOutput` and never sees a grammar.
- a full syntax tree. Ferret models *declarations*, not every expression node;
  a complete AST is a parser's internal concern and is orders of magnitude
  larger than what any consumer asks for.

## 5. Inputs

- EPIC-024 `ParseOutput`: segments, outline, attributes;
- EPIC-025's outline kinds, mapped rather than adopted;
- EPIC-006 canonical identity (`canonicalKey`, `canonicalId`).

## 6. Outputs

- `CodeSymbolKind` and `CODE_SYMBOL_KINDS`;
- `CodeSymbol`, and `buildCodeSymbols(parse, context)` returning them flat, in
  document order, each naming its parent;
- `codeSymbolTree`, the same symbols nested;
- `codeSymbolId`, the stable identifier.

## 7. Dependencies

EPIC-006, EPIC-024, EPIC-025.

## 8. Contracts

### Ferret's vocabulary, not the grammar's

`CodeSymbolKind` is a closed set Ferret owns. A parser's outline kind is mapped
onto it, and an unmapped one becomes `unknown` rather than leaking a grammar
node type into the canonical model. TECHNOLOGY-DECISIONS §4 recorded that two
ecosystems' grammars disagree; a canonical model that spoke grammar would
inherit that disagreement.

### Declarations, not every node

Ferret models what a file *declares*. An expression, a statement and a literal
are not symbols. This is a deliberate loss of fidelity: the alternative is a
model that is larger than the source and that nothing downstream would use.

### A qualified name is the path of enclosing scopes

`Box.width`, not `width`. It is the only name that is unique within a file and
the only one a person searching would recognise, and it is built from the
outline's nesting rather than from anything a parser had to be told.

### Identity is derived, not assigned

`codeSymbolId` is `canonicalId` over the same key shape everything else in
EPIC-006 uses: kind, source system, scope, source id — where the scope is the
file and the source id is the qualified name plus an overload ordinal. Two runs
over unchanged content produce the same ids; a rename produces different ones,
which is correct, because it is a different symbol.

### Documentation is adjacency, not inference

A comment is attached to a declaration when it ends on the line immediately
above it, or one blank line above. Nothing parses the comment, and nothing
guesses at intent from further away.

## 9. Acceptance criteria

- **AC-1** Outline kinds map to canonical kinds, and an unmapped kind becomes
  `unknown` rather than the grammar's word.
- **AC-2** Symbols are returned flat in document order, each naming its parent,
  and `codeSymbolTree` reassembles the same nesting.
- **AC-3** A nested declaration's qualified name is the path of its enclosing
  scopes.
- **AC-4** A comment directly above a declaration becomes its documentation; one
  further away does not.
- **AC-5** Modifiers are extracted from the declaration text — `export`,
  `async`, `static`, `abstract`, visibility, `readonly` — and an unmodified
  declaration reports none.
- **AC-6** A signature is the declaration's first line, without its body, and is
  bounded in length.
- **AC-7** Two same-named declarations in one file get distinct ids, and the
  ordinal is recorded.
- **AC-8** Ids are stable across runs over identical content, and differ for the
  same name in a different file or repository.
- **AC-9** A parse with no outline yields no symbols, and does not fail.
- **AC-10** Building symbols never reads a file, a grammar, or a provider.
- **AC-11** The model round-trips through the canonical entity model as a
  registered kind, without changing the core entity envelope.

## 10. Test requirements

- kind mapping for every parser kind, and for an unknown one;
- flat order, parent links, and tree reassembly compared against each other;
- qualified names two and three levels deep;
- documentation attached, separated by a blank line, and separated by two;
- each modifier, and a declaration with none;
- a signature with a body on the same line, and one longer than the bound;
- two overloads, asserting distinct ids and recorded ordinals;
- identity stability across two builds and across two files;
- an empty outline;
- an architecture test that the module reaches no parser and no provider.

## 11. Security requirements

Symbol names, signatures and documentation come from repository content and are
untrusted text. They are stored and returned as data, never interpreted:
nothing here evaluates a name, resolves it to a path, or uses it to select code.
Signatures are length-bounded so a pathological declaration cannot produce an
unbounded field, and documentation is taken verbatim from a segment EPIC-024 has
already redacted.

## 12. Observability

Every symbol carries its span, its parent and the ordinal that disambiguated it,
so "why do these two symbols have different ids" is answerable from the record
alone.

## 13. Performance constraints

One walk of the outline and one pass over the segment list to index comments by
line. No re-parsing, no second pass over content.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, entity-kind
registration, exports, documentation and validation evidence. No storage,
lookup, or reference-resolution behaviour is claimed here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — the canonical model speaks Ferret's
  vocabulary; a grammar's node types stop at the parser boundary.
- **§6 Evidence Before Inference** — a symbol carries its span and its
  provenance; nothing is inferred beyond adjacency.
- **§8 Files Are First-Class** — a symbol is addressed within its file.
- **§21 Versioning and Reproducibility** — identity is derived from content, so
  two runs agree.
- **§22 Change Management** — stays within the approved AST Model capability.
