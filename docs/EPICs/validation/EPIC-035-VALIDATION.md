# EPIC-035 — Reference & Relationship Index · Validation Evidence

**Assessed against:** working tree on top of `dd4029f`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, the three shipped tree-sitter
grammars, and Ferret's own 611-file repository for the quality measurement.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-035 — Reference & Relationship Index — P1" — and
> from the four Epics that deferred references and the issue parked on it.

## What shipped

A reference index over Ferret's own code, from the parse that already happens:

| | count |
| --- | --- |
| `file_declares_symbol` | 2,015 |
| `symbol_references_symbol` | 814 |
| `file_references_symbol` | 310 |
| symbols with `parsed` evidence | 2,015 |
| resolutions with `inferred` evidence | — one per resolution, chained to the declaration |

"Where is this used" is answered by inbound traversal of
`symbol_references_symbol` through the port that already traverses
relationships. No new read surface, and EPIC-050 owns the transitive walk.

## Three defect classes found by dogfooding, not by reasoning

This is the substance of the Epic, and each was caught by running it on Ferret's
own code rather than by a test written from the specification.

### 1. A recursive call cannot be an edge

The first end-to-end run **failed** on `scripts/dogfood.mjs`, where `connect`
calls `connect`: EPIC-007 forbids a relationship connecting an entity to itself.
It is right to. A symbol calling itself is a property of the symbol, not a
relationship between two things. The resolution and its evidence are kept — so
recursion is still recorded — and only the self-edge is skipped, counted as
`recursive` so it does not look like a resolution that went missing.

### 2. A member call must not reach the repository rule

The first working run produced a call graph that was **confidently wrong**:

| symbol | references | what they actually were |
| --- | --- | --- |
| `IdentityStore.resolve` | 139 | `path.resolve` |
| `ProviderRegistry.has` | 84 | `Map.has` / `Set.has` |

`a.save()` names `save`, and which `save` it means depends on the type of `a`.
Resolving it to the one `save` the repository declares is exactly the
manufactured certainty §8.3 was written to refuse — and the specification's own
sentence, *"a wrong call graph is worse than an absent one because it reads as
knowledge"*, condemned the implementation that shipped under it.

So `CodeReference` gained `qualified`, and a member call now resolves only when
the **same file** declares the name. A bare identifier is resolved by the
language's own scoping; a member name is not.

### 3. An imported name is declared elsewhere, and the file says so

After (2), one wrong entry remained and it was the largest:
**`ProviderRegistry.describe` with 111 references — every one of them Vitest's
`describe`.** Ferret declares exactly one `describe`, so every test file's
`describe(...)` resolved to it.

An import is the file stating where a name comes from. Ignoring that to prefer a
homonym Ferret happens to hold is the opposite of evidence-first, so the parser
now collects the names each file imports and the resolver refuses the repository
rule for them.

### What the three refusals cost, and bought

| | reference edges | most-referenced symbol |
| --- | --- | --- |
| first working cut | 3,472 | `IdentityStore.resolve` (139 — wrong) |
| member calls refused | 2,815 | `ProviderRegistry.describe` (111 — wrong) |
| **imports refused** | **1,124** | **`invalid` (20 — correct)** |

The graph is **a third of the size and trustworthy**. The top of the list is now
`invalid` (20), `stripComments` (13), `toCanonical` (12), `isRecord` (9),
`messageOf` (7) — every one a real internal helper. That trade is the Epic's
objective stated as a number.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 same-file call produces an edge | **MET** | integration "writes a same-file reference edge and records the rule" |
| AC-2 a construction produces an edge | **MET** | `parser-composition.test.ts` "finds a construction" against the real grammar |
| AC-3 `same-file` at `STRONG` | **MET** | unit and integration, rule recorded on the edge metadata |
| AC-4 `unique-in-repository` at `PROBABLE` | **MET** | integration "resolves across files by unique name, at a lower confidence" |
| AC-5 ambiguous name writes no edge | **MET** | unit ×2 and integration "writes no edge for an ambiguous name, and reports it" |
| AC-6 unknown name writes no edge | **MET** | integration "reports an unknown name unresolved rather than inventing an edge" |
| AC-6a member call refused | **MET** | unit ×4 and integration "refuses a member call the repository rule may not answer" — asserted against a real `Map.has` call |
| AC-6b recursion writes no self-edge | **MET** | integration "resolves a recursive call and writes no self-edge" |
| AC-6c imported name refused | **MET** | unit ×3, and the measurement above |
| AC-7 attribution to the enclosing declaration | **MET** | unit ×3; `parser-composition.test.ts` asserts `enclosing` for a method, a function and top-level code |
| AC-8 every symbol has `parsed` evidence | **MET** | integration "gives every symbol parsed evidence" — issue #49, with authority `PARSED` (60) asserted |
| AC-9 every resolution has `inferred` evidence | **MET** | integration "gives a resolution inferred evidence, derived from the declaration" |
| AC-10 symbol evidence reachable by the same traversal | **MET** | read back through `EvidenceStore.forSubject`, the port `ferret_why` uses |
| AC-11 three types registered, endpoints enforced | **MET** | registered beside the kind; a wrong endpoint is refused by `createRelationship` |
| AC-12 nothing deleted | **MET** | edges are asserted through EPIC-007's temporal model, which ends rather than deletes |
| AC-13 unchanged file writes nothing | **MET** | integration "writes nothing new when the file is unchanged" — structural: the gate skips before the stage |
| AC-14 answerable by traversal, no new surface | **MET** | every integration assertion goes through `RetrievalStore.neighbours` |
| AC-15 no parse regression | **MET** | EPIC-097's harness reports identical matched counts before and after |
| AC-16 missing grammar yields no references, no error | **MET** | `parser-composition.test.ts` "yields no references and no error for a file with none" |

Nineteen of nineteen MET.

## Two structural findings worth recording

**The content stage cannot write edges.** It runs *between the listing and the
write* — by design, because EPIC-030's structure has to be on the entities before
they are persisted — so a `file` entity does not exist when a reference is
resolved, and an edge from one violates the relationship table's foreign key.
The stage therefore **derives** edges and returns them, exactly as it already
returns `structure`, and the indexer writes them after `write(graph)`. Found on
the first end-to-end run.

**Cross-file resolution needs a second pass.** Resolving during the per-file loop
asked for `applyTax` before `src/tax.ts` had been parsed, because
`src/refund.ts` sorts first — and since the gate skips unchanged files, a later
run would *never* have corrected it. A defect that heals on the next run is bad;
one that never heals is worse. Symbol evidence for every file is recorded first,
then references resolve, so EPIC-008's requirement that `inferred` evidence name
its chain can be satisfied across files.

**And one defect this Epic reintroduced.** `authorityFor` is applied by the
provider SDK's `Emitter`; a caller writing through `EvidenceStore` directly gets
the schema default of **0** — the exact state EPIC-045 existed to end. The first
symbol evidence had authority 0 until a test asserted 60. Applied explicitly at
the new write path, and worth knowing that any future direct writer has the same
trap in front of it.

## Tests

- **Unit** — `tests/unit/code-references.test.ts`, 21 tests: every rule, every
  refusal, attribution, memoisation, and four degenerate inputs.
- **Integration (grammars)** — `parser-composition.test.ts`, 10 tests: extraction
  through the real TypeScript, JavaScript and Python grammars, which is the half
  a unit test cannot prove — a perfect resolver over hand-built references proves
  nothing if extraction finds none.
- **Integration (end to end)** — `content-indexing.test.ts`, 11 tests against a
  real repository and a real database.
- **Regression** — `npm run verify` green: 130 files, 2741 passed, 3 skipped.

## Limitations, recorded

- **A member call resolves by `same-file` and could still be wrong** if two
  unrelated types in one file share a method name. Bounded by the file, recorded
  rather than solved.
- **Reference recall is not measured.** EPIC-097's harness measures declarations
  against labelled fixtures; references would need labelled reference sets, which
  is a change to EPIC-096's dataset and its decision. AC-15 only holds
  declarations flat.
- **Import following is one-directional.** Knowing a name is imported is enough
  to *refuse* a resolution; following the import to the module that declares it
  would let Ferret *resolve* it, and would turn much of the refused third back
  into trustworthy edges. That is the clear next increment.
- **Only three languages.** A repository of Go or Java gets no references,
  reported rather than silent.
- **A resolution whose target was declared by a file this run did not parse gets
  an edge and no citation** — EPIC-008 requires `inferred` evidence to name its
  chain and Ferret cannot cite a record it does not hold in the run. Counted as
  `uncited` so the gap is visible.
- **Call graphs are EPIC-050's.** This Epic produces the edges; the transitive
  walk over them is that Epic's traversal, and building a second one here would
  duplicate it.
