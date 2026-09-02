# EPIC-035 — Reference & Relationship Index

**Status: APPROVED | Priority: P1 | Domain: Code Intelligence**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Code Intelligence, where it
> has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Answer "where is this used", from references a parser actually found, resolved
only where the answer is unambiguous — and say so when it is not.

## 2. Value — four Epics deferred it and one issue is parked on it

- **EPIC-025 §4** — "the symbol index and cross-file references — EPIC-034,
  EPIC-035".
- **EPIC-033 §4** — "references, call graphs and cross-file resolution".
- **EPIC-034 §4** — "references, call sites, call graphs and cross-file
  resolution"; its validation adds "**No references.** 'Where is this called' is
  EPIC-035."
- **EPIC-108 §4** — "References, call sites and call graphs", and it records that
  "no approved criterion names EPIC-049 or EPIC-035 as the owner of symbol-level
  edges".
- **[Issue #49](https://github.com/indoulia/Ferret/issues/49)**, parked on this
  Epic by EPIC-048 §4: "Code symbols carry no evidence, so nothing can rank or
  trace them."

So Ferret indexes 1,600 symbols of its own code and cannot answer the most
common question asked of a code assistant after "where is this defined" — which
EPIC-034 delivered — namely "where is it used". And a symbol has identity,
attributes and lifecycle but **no evidence row stating how Ferret came to
believe it**, so EPIC-045's authority ranking has nothing to apply, `derivedFrom`
cannot trace a symbol to the parse that produced it, and EPIC-047's conflict
detection has no input for symbols.

## 3. Scope

- **Reference extraction**: call sites and constructions, per language, by the
  same node-type table `declarations` already uses.
- **Resolution, where it is unambiguous**: to a declaration in the same file,
  then to a uniquely named declaration in the same repository. Ambiguity is
  recorded, never guessed.
- **Symbol-level edges**, registered beside the kind rather than added to the
  core's built-in table (§8.5).
- **Evidence for symbols and for resolutions** — issue #49 — with a resolution
  rule's confidence, which makes this the first producer EPIC-046 was waiting
  for.
- **"Where is this used" answered by traversal**, through the port that already
  traverses relationships.

## 4. Non-scope

- **Call graphs.** A transitive walk over reference edges is EPIC-050's
  traversal over this Epic's edges; building a second traversal here would
  duplicate it.
- **Type-based resolution.** Ferret has no type checker and will not gain one
  here. §8.3 is explicit that resolution is name-based and says what that costs.
- **Cross-repository resolution.** A symbol's scope is its repository (EPIC-034);
  resolving across two is EPIC-051's entity-resolution problem.
- **Ranking references** — EPIC-056/057, which rank whatever retrieval returns.
- **A new relationship table** — EPIC-049's storage is reused unchanged.
- **New languages.** The three grammars EPIC-025 ships are the three this
  covers; a fourth is that Epic's to add.
- **Measuring reference recall.** EPIC-097 owns the parser quality harness, and
  §16 raises what extending it would need.

## 5. Inputs

- The parsed tree the code parser already walks (EPIC-025).
- `CodeSymbol` declarations and their spans (EPIC-034).
- `SymbolIndexPort.findSymbols`, for resolution within a repository.
- EPIC-049's relationship store; EPIC-044's evidence store.
- EPIC-046's `Confidence` bands.

## 6. Outputs

- `CodeReference` on the parser's result: name, span, and the declaration it
  appears inside.
- `src/code/references.ts` — resolution, core and pure.
- Three registered relationship types (§8.5).
- `parsed` evidence per symbol and `inferred` evidence per resolution.
- No schema change.

## 7. Dependencies

EPIC-024/025 (the parser and the grammars), EPIC-033 (the AST model), EPIC-034
(symbols and their identity), EPIC-049 (relationship storage), EPIC-044/045
(evidence and authority), EPIC-046 (confidence bands), EPIC-050 (the traversal
that answers the question).

## 8. Contracts

### 8.1 A reference is what the grammar says it is

Extraction follows the pattern `declarations` established: a per-language table
of node types, and a rule for finding the referenced name inside one. No
tree-sitter query language, because the existing walk already visits every node
and a second mechanism would be a second place for language support to drift.

Extracted: a call (`call_expression`, Python's `call`) and a construction
(`new_expression`). **Not** every identifier — an identifier occurrence is not a
reference to a declaration in any sense a name-based resolver can honour, and
indexing all of them would bury the ones that mean something.

### 8.2 A reference is attributed to the declaration it sits inside

The enclosing declaration is what makes an edge answerable: "`refundInvoice`
calls `applyTax`" is the useful fact, and "line 42 calls `applyTax`" is not a
graph. A reference outside any declaration — top-level code — is attributed to
the **file**, and §8.5's edge types are shaped so both cases are expressible
rather than one being dropped.

### 8.3 Resolution is name-based, unambiguous-only, and says which rule it used

Three rules, tried in order, each with an EPIC-046 confidence band:

| rule | resolves to | confidence |
| --- | --- | --- |
| `same-file` | a declaration in the same file with that name | `STRONG` |
| `unique-in-repository` | exactly one declaration with that name in the repository, **and the callee was a bare identifier** | `PROBABLE` |
| `ambiguous` | nothing — two or more candidates | *not resolved* |
| `receiver-unknown` | nothing — a member call the repository rule may not answer | *not resolved* |

**Nothing is guessed.** Where two declarations share a name across files, no
edge is written and the reference is recorded as unresolved with its candidate
count. Governance §6: an edge asserting one of two possibilities is
manufacturing certainty, and a wrong call graph is worse than an absent one
because it reads as knowledge.

The bands are not new numbers — they are EPIC-046's, which are EPIC-009's and
EPIC-042's. `same-file` outranks `unique-in-repository` because a language's own
scoping makes the first nearly certain and the second is an inference from the
absence of a homonym.

**A member call does not reach the repository rule, and this was found by
dogfooding rather than by reasoning.** The first version let `a.save()` resolve
to a repository-unique `save`, and on Ferret's own code that produced
`ProviderRegistry.has` with **84 references** — nearly all of them `Map.has` —
and `IdentityStore.resolve` with **139**, nearly all of them `path.resolve`. A
call graph that says `Map.has` is `ProviderRegistry.has` is not an imperfect
answer; it is a wrong one that reads as knowledge, which is the thing this
section exists to refuse.

The rule that follows: a **bare identifier** is resolved by the language's own
scoping to something in scope, so the repository rule is a reasonable inference
about it. A **member name** is scoped by the receiver's type, which Ferret does
not know, so the repository rule may not be applied to it at all — it is
`receiver-unknown` unless the same file declares the name. That is why
`CodeReference` carries `qualified`.

What remains a limitation: a member call on a locally declared class resolves by
`same-file` and could still be wrong if two unrelated types in one file share a
method name. That case is bounded by the file and is recorded rather than
solved.

### 8.4 A symbol gets evidence, and a resolution gets evidence about the resolution

Issue #49's fix. Two kinds of record, and the distinction is the point:

- **A symbol** is `parsed` evidence: a grammar extracted this declaration from
  this file's content. Authority `PARSED` (60) follows from the method, exactly
  as EPIC-045 intends.
- **A resolution** is `inferred` evidence, with `derivedFrom` naming the
  reference's own record, and the confidence of the rule that resolved it. So a
  caller can ask why Ferret believes `refundInvoice` calls `applyTax` and be told
  which rule concluded it and how much that rule is worth.

This is the first shipping producer of `inferred` evidence, which makes
EPIC-046's propagation and EPIC-045's method-based authority live rather than
latent.

### 8.5 Symbol edges are registered, not built in

Three types:

```
file_declares_symbol       file        → code_symbol
symbol_references_symbol   code_symbol → code_symbol
file_references_symbol     file        → code_symbol
```

The third is §8.2's top-level case, and it is a separate type rather than
`symbol_references_symbol` with a file at the source end: the endpoint kinds are
what make an edge type mean something, and one type accepting either kind would
make "which symbol calls this" unanswerable at exactly the point it matters.

Registered through `registerRelationshipType` from `src/code/`, beside the
`code_symbol` kind itself — **not** added to `domain/relationship.ts`'s built-in
table. `code_symbol` is a *registered* kind, not one the core ships, so a
built-in type naming it would put `domain/` in the position of naming a kind it
does not have. That is the boundary EPIC-006 drew when it made kinds
registrable, and EPIC-108 recorded that no approved criterion had yet assigned
these edges an owner.

Neither type is `exclusiveFrom`: a file declares many symbols and a symbol
references many.

### 8.6 Re-indexing a file replaces its references

A file's references are derived entirely from its content, so re-parsing it is
the authority on what they are. Edges from symbols in that file are ended
rather than deleted — EPIC-007's temporal model already does this, and a
reference that existed and stopped is a fact worth keeping.

## 9. Acceptance criteria

- **AC-1** A call to a function declared in the same file produces one
  `symbol_references_symbol` edge.
- **AC-2** A construction (`new Foo()`) produces an edge to `Foo`'s declaration.
- **AC-3** A reference resolved in the same file records rule `same-file` and
  confidence `STRONG`.
- **AC-4** A reference resolved by unique name across files records
  `unique-in-repository` and `PROBABLE`.
- **AC-5** A reference whose name has two declarations in the repository
  produces **no edge**, and is reported unresolved with its candidate count.
- **AC-6** A reference to a name with no declaration produces no edge and is
  reported unresolved.
- **AC-6a** A **member** call whose name is not declared in the same file
  produces no edge and is reported `receiver-unknown`, even when the repository
  holds exactly one declaration of that name.
- **AC-6b** A recursive call resolves to its own declaration and produces **no
  edge**, because EPIC-007 forbids a relationship connecting an entity to
  itself; it is counted as `recursive`.
- **AC-7** A reference inside a declaration is attributed to that declaration; a
  top-level reference is attributed to the file.
- **AC-8** Every indexed symbol has one `parsed` evidence record naming the
  file, the producer and the producer version — issue #49.
- **AC-9** Every resolution has one `inferred` evidence record whose
  `derivedFrom` names the reference's record.
- **AC-10** A `code_symbol` entity's evidence is reachable through the same
  traversal a file's is.
- **AC-11** All three relationship types are registered, and asserting one with
  the wrong endpoint kind is refused.
- **AC-12** Re-indexing a file with a reference removed ends that edge rather
  than deleting it.
- **AC-13** Re-indexing an unchanged file writes no new edge and no new evidence.
- **AC-14** "Where is this used" is answerable by traversing
  `symbol_references_symbol` inbound, with no new read surface.
- **AC-15** Extraction adds no measurable parse regression: EPIC-097's harness
  reports the same matched counts.
- **AC-16** A file whose grammar is unavailable yields no references and no
  error.

## 10. Test requirements

**Unit** — extraction per language over fixtures with a call, a construction, a
nested call inside a method, and a top-level call; the resolver for each of the
three rules, the no-candidate case, and a name declared twice; enclosing-scope
attribution; the registered types' endpoint validation.

**Integration (real PostgreSQL)** — a repository with two files where one calls
the other: edges written, evidence written, traversal answers "where is this
used"; re-index unchanged writes nothing new; re-index with the call removed
ends the edge; an ambiguous name writes nothing.

**Quality** — AC-15 through EPIC-097's harness, before and after.

**Failure** — a grammar that will not load; a file that parses with errors; a
reference whose enclosing declaration was not indexed.

**Regression** — EPIC-025's, EPIC-034's and EPIC-108's suites unchanged.

## 11. Security requirements

A reference name comes from repository content and reaches an edge as a
*resolved entity id* or not at all — no source text is stored on a relationship,
so EPIC-084's containment is not needed on this path and no injected text can
travel through it. Symbol evidence carries the declaration's name, which is
already in the symbol entity EPIC-034 stores and is subject to the same scope.

## 12. Observability

An index run reports references extracted, resolved by rule, and unresolved with
the reason. The unresolved count is the number that matters: a repository where
most references are ambiguous is one where §8.3's honesty is doing real work,
and an operator should be able to see that rather than infer it from a sparse
graph.

## 13. Performance constraints

Extraction is part of the walk that already happens — no second parse.
Resolution is one `findSymbols` lookup per distinct name per file, memoised
within a run; it adds no per-reference query. Edges and evidence are written
through the existing batched paths.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 satisfied with evidence in
`validation/EPIC-035-VALIDATION.md`; unit, integration, quality and failure tests
present and passing; `npm run verify` green; the registry updated; issue #49
closed with the evidence that closes it.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.3 refuses to resolve an ambiguous name,
  and §8.4 gives a symbol the evidence row it never had.
- **§18 Provenance and Explainability** — a resolution can now be explained by
  the rule that made it, which is what issue #49 said was impossible.
- **§4 Provider-First** — §8.5 keeps the core from naming a kind it does not
  ship.
- **§5 Reuse Before Reinvent** — the existing walk, the existing relationship
  store, the existing traversal, EPIC-046's existing bands. Nothing new is
  stored and no new read surface is added.
- **§19 Testing and Quality** — AC-15 holds the parser harness flat.

## 16. Raised, not absorbed

- **Reference recall is not measured.** EPIC-097's harness measures declarations
  against labelled fixtures; references would need labelled reference sets, which
  is a change to that Epic's dataset and its decision. AC-15 only holds
  declarations flat.
- **A method call on an unknown type is resolved by name or not at all** (§8.3).
  The honest fix is a type-aware resolver, which is a capability no registry
  entry owns and which would not be a small addition to this one.
- **Imports are not followed.** `imports` node types are already recognised by
  the language spec and this Epic does not use them; resolving a reference
  through an import statement would narrow ambiguity considerably and is the
  first thing to add if the unresolved count proves high.
- **Only three languages.** The grammars EPIC-025 ships. A repository of Go or
  Java gets no references, reported rather than silent.

## 17. Recorded during implementation

Three defect classes, each found by running the Epic on Ferret's own code rather
than by a test written from this specification. The validation document carries
the figures.

- **A recursive call cannot be an edge.** EPIC-007 forbids a relationship
  connecting an entity to itself, and it is right to: a symbol calling itself is
  a property of the symbol. The resolution and its evidence are kept; only the
  self-edge is skipped, counted as `recursive`.
- **A member call must not reach the repository rule.** The first working run
  gave `IdentityStore.resolve` 139 references (`path.resolve`) and
  `ProviderRegistry.has` 84 (`Map.has`). §8.3 now refuses it, and
  `CodeReference` carries `qualified` for that reason.
- **An imported name is declared elsewhere.** `ProviderRegistry.describe` had 111
  references, every one of them Vitest's `describe`. The parser now collects each
  file's imported names and the resolver refuses the repository rule for them.

Together these took the graph from 3,472 edges to 1,124 — a third of the size and
trustworthy, which is this Epic's objective as a number.

Two structural findings and one reintroduced defect:

- **The content stage derives edges and does not write them**, because it runs
  before the graph is persisted and a `file` entity does not exist yet.
- **Cross-file resolution needs a second pass**, because a file that sorts first
  would otherwise ask for a symbol not yet parsed — and the gate would never let
  a later run correct it.
- **`authorityFor` is applied by the SDK's `Emitter`, not by the store.** A
  caller writing evidence directly gets authority `0`, the state EPIC-045 existed
  to end. Applied explicitly at the new write path.
