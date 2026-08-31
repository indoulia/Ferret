# EPIC-033 — AST Model: validation evidence

**Status: VALIDATED** · no new dependency, no I/O. One walk of a parser's
outline and one pass over its segments.

## What the Epic does

`buildCodeSymbols(parse, context)` turns an EPIC-024 `ParseOutput` into
`CodeSymbol`s: canonical kind, name, qualified name, span, signature, modifiers,
documentation, parent, overload ordinal and a derived stable id. Flat and in
document order; `codeSymbolTree` reassembles the nesting.

`code_symbol` is registered as a canonical entity kind through
`registerEntityKind`, so the core entity envelope is untouched.

## Acceptance criteria

All rows are `tests/unit/code-symbols.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 kinds map; unmapped becomes `unknown` | PASS | seven mappings in a table; `maps an unrecognised kind to unknown, not to the grammar word`; `keeps the parser word so a mapping gap is diagnosable` |
| AC-2 flat, ordered, parented; tree reassembles | PASS | `returns symbols flat, in document order, each naming its parent`; `reassembles the same nesting`; `keeps a symbol whose parent was filtered out, as a root` |
| AC-3 qualified names from enclosing scopes | PASS | `qualifies a nested name with its enclosing scopes`; `qualifies three levels deep` |
| AC-4 documentation by adjacency | PASS | four tests: directly above, one blank line above, two lines above (not attached), and none |
| AC-5 modifiers | PASS | six combinations in a table; `reports none for an unmodified declaration`; `does not find a modifier inside a name`; `reports modifiers in a canonical order, not the source order` |
| AC-6 bounded first-line signature | PASS | `takes the first line and stops at the body`; `keeps a declaration with no body intact`; `bounds a pathological signature` |
| AC-7 overloads get distinct ids | PASS | `gives two same-named declarations distinct ids, and records the ordinal` |
| AC-8 identity stable and scoped | PASS | `is stable across two builds over the same content`; `differs for the same name in another file or repository` — three distinct ids from one qualified name |
| AC-9 no outline, no symbols, no failure | PASS | `yields nothing for a parse with no outline, and does not fail`, covering both an empty array and an absent field |
| AC-10 reaches no parser or provider | PASS | `tests/unit/boundaries.test.ts` — the code graph contains no `parsers/` module and no `web-tree-sitter`; the round-trip test drives the real parser from the *test*, not from the module |
| AC-11 registers as an entity kind | PASS | `registers without changing the core envelope`; `round-trips a symbol through createEntity` |

## Design decisions worth recording

**A closed vocabulary Ferret owns.** `method_definition` and
`function_definition` are grammar words, and TECHNOLOGY-DECISIONS §4 recorded
that two ecosystems' grammars disagree by about 1.2% of named nodes over the
same corpus. Mapping onto a closed set is what stops a grammar upgrade from
changing what a consumer switches on. `declaredKind` is kept alongside, so a
symbol landing on `unknown` names the gap in the mapping without a re-parse.

**Declarations, not a full syntax tree.** An expression, a statement and a
literal are not symbols. This is a deliberate loss of fidelity: a complete AST is
larger than the source, and no consumer — the symbol index, retrieval, a context
pack, evidence — asks for one.

**Identity is derived through `canonicalId`, not invented here.** A second
identity scheme is how two halves of one graph stop agreeing about what a thing
is. The scope is `repository:path` and the source id is the qualified name plus
an overload ordinal, so the same name in two files or two repositories yields
three distinct ids — which the test asserts directly.

**A rename produces a different id, and that is correct.** It is a different
symbol; that it replaced the old one is a fact about the graph (EPIC-049), not
about the identifier.

**Documentation is adjacency, not inference.** A comment counts when it ends on
the line above the declaration or one blank line above. Two lines away is a
comment about something else. Nothing parses the comment.

**Only the leading run of tokens is read for modifiers.** Scanning the whole
line finds `readonly` in `readonlyThing`, and there is a test for exactly that.
Modifiers are reported in a canonical order rather than the source's, so two
declarations written differently compare equal.

**A symbol whose parent was filtered out becomes a root.** `codeSymbolTree` is
given whatever list a caller has; dropping a node because its parent is missing
would lose data silently, and a shallower tree is the better failure.

**One test drives the real parser.** The rest build outlines by hand, which
proves the mapping and nothing about whether EPIC-025's actual output fits it.
`builds symbols from what EPIC-025 actually produces` is the test that would
fail if the two Epics drifted, and it asserts the signature, the modifiers and
the attached doc comment against a real parse.

## Limitations

- **Nothing stores these.** EPIC-034 owns persistence and lookup; this Epic
  produces symbols in memory and registers the entity kind they would take.
- **Signatures and modifiers are read from text, not from the tree.** The
  parser's outline carries a span and a title, not a parameter list, so the
  signature is the declaration's first line and the modifiers are its leading
  tokens. That is right for the four languages EPIC-025 supports and would need
  revisiting for a language whose modifiers follow the name.
- **A signature stops at the first `{`.** A default parameter value containing a
  brace truncates early.
- **The overload ordinal is positional.** Two declarations of `handle` are `#0`
  and `#1` in document order, so inserting a new first overload changes the
  second one's id. That is a real churn source for the symbol index and is
  accepted here because the alternative — hashing the signature — makes an id
  change whenever a parameter type does.
- **No `constructor`, `property` or `constant` in practice.** The kinds exist,
  and EPIC-025's language table does not yet emit outline kinds that map to
  them, so they are unreachable today.
- **`unknown` is reachable and untested against a real grammar.** The unit test
  uses a synthetic kind; no EPIC-025 outline kind currently maps to `unknown`.
- **Qualified names are not namespaced by module.** `Box.width` is unique within
  a file and not across a repository; the file is part of the id, not part of
  the name.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 35 files, 980 passed.
