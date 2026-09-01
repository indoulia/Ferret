# EPIC-060 — Answer Packs · Validation Evidence

**Assessed against:** working tree on top of `28c9ab6`
**Date:** 2026-09-01
**Specification:** [`../EPIC-060-Answer-Packs.md`](../EPIC-060-Answer-Packs.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

The specification was written as the first part of this change, from the registry
entry, the known-limitation row at
`validation/EPIC-059-061-064-065-VALIDATION.md` §156, `src/retrieval/classify.ts`
line 17, and Governance §18, §6, §11, §3 and §12.

Verdict and claim rules are demonstrated by unit tests against fake ports — a
context pack's own suite gives the reason, and it applies here: "a pack is
assembled from whatever `RetrievalPort` returns, so a fake one is the *right*
test double". The planner in those tests is the **real** `QueryPlanner` over fake
strategies, so the routing under test is Ferret's own. The MCP surface is
demonstrated through the real protocol, and every verdict is additionally
demonstrated over **real stdio against a real index**.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** An exact question resolves to one subject and is answered rather than ranked | **MET** | `answer-pack.test.ts` — *"answers about one subject rather than ranking it"*: verdict `answered`, one subject, `candidates: []`. Through the protocol in `tools.test.ts`, and in production for a real entity id. |
| **AC-2** A prose question returns `not-answerable` naming the context pack, with no claim | **MET** | `answer-pack.test.ts` — *"refuses prose and names the right surface"*. `classify` owns the decision; there is no second heuristic here to drift. Confirmed in production: *"The question is prose, which is what ranked retrieval is for… Use a context pack for this."* |
| **AC-3** More than one subject returns `ambiguous`, lists every candidate, makes no claim | **MET** | `answer-pack.test.ts` — *"reports ambiguity and makes no claim"* (two commits sharing an abbreviation) and *"stays ambiguous when nothing is identified more specifically"*. |
| **AC-4** Nothing matched returns `not-indexed`, distinguishably from a subject held with no evidence | **MET** | `answer-pack.test.ts` — *"reports nothing indexed, distinguishably from a subject with no evidence"* asserts both halves in one test: `not-indexed` with no subject, versus `partial` with a subject and *"no evidence about it"*. Both observed in production — see §3, where the second is a real finding (§5). |
| **AC-5** Each claim carries field, statement, state and citations | **MET** | `answer-pack.test.ts` — *"carries field, statement, state and citations"*. Through the protocol in `tools.test.ts`. |
| **AC-6** Each citation names source system, locator, method, producer, authority and the EPIC-062 reason | **MET** | Same test asserts all six, including `reason` containing `observed authority` and `state current` — EPIC-062's sentence carried into the answer, so the answer explains its own citation rather than listing it. |
| **AC-7** A disputed fact is reported on the claim and in `unknowns`, no side dropped | **MET** | `answer-pack.test.ts` — *"reports a disputed fact on the claim and in unknowns"*: `disputed: true`, both records cited, `unknowns` names the field. A dispute also forces the verdict to `partial` — see §5. |
| **AC-8** `QueryPlan` verbatim when a planner is wired, `undefined` when none is | **MET** | `answer-pack.test.ts` — *"returns the plan verbatim when a planner is wired, and nothing when none is"*. Production shows each strategy's outcome, which is the first surface in Ferret to expose them. |
| **AC-9** `partial` whenever the plan is partial, evidence was excluded, the window truncated, or a bound reached — with a matching `unknowns` entry | **MET** | Five tests: *"reports a strategy that could not run"*, *"reports that exact routing did not run without a planner"*, *"bounds the citations on one claim and says so"*, *"bounds the claims and says so"*, *"drops claims that do not fit the budget and says how many"*. A companion test asserts `unknowns` is **empty** when nothing is missing, so a non-empty list means something. |
| **AC-10** A claim with no citations is stated as unsupported in `unknowns` | **MET** | Implemented in `#answerAbout`; exercised by the no-evidence path in *"reports nothing indexed, distinguishably from a subject with no evidence"* and reached in production for every `file` subject (§5). |
| **AC-11** Subject attributes and claim statements contained; Ferret's own sentences not | **MET** | `answer-pack.test.ts` — *"contains a hostile statement and leaves Ferret own sentences alone"*, and `tools.test.ts` — *"contains the hostile statement it cites"* through the protocol. The second **failed first and found a real defect** — see §5. |
| **AC-12** Reachable over MCP, read-only, with the notice, absent rather than useless with no evidence reader | **MET** | `tools.test.ts` — *"is not offered when no evidence reader is wired"*: absent from the plain server, present on the wired one, `readOnlyHint: true`, description carrying the notice and stating that Ferret never writes the prose answer. Production `listTools` returns seven tools including `ferret_answer`. |
| **AC-13** The rendered answer states the verdict, each claim with citations, and every unknown | **MET** | `answer-pack.test.ts` — *"states the verdict, each claim with its citations, and every unknown"*, plus *"puts the notice before any indexed content"* and *"says nothing was missing rather than printing an empty list"*. Through the protocol with `format: 'text'`. |
| **AC-14** Reports its estimated size and drops claims beyond the budget, saying so | **MET** | `answer-pack.test.ts` — *"drops claims that do not fit the budget and says how many"*: eight 400-character claims against a 400-token budget yields fewer claims and `did not fit in 400` in `unknowns`. |

**Summary: 14 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite: **85 files, 2012
passed, 3 skipped**, database suites against a real PostgreSQL. New:
`tests/unit/answer-pack.test.ts` (25 tests), 7 tests added to
`tests/integration/mcp/tools.test.ts`.

`ferret_answer` reached over **real stdio** against a real index of Ferret's own
repository. All four verdicts, in one run:

```
TOOLS: ferret_answer, ferret_context_pack, ferret_find, ferret_get_entity,
       ferret_neighbours, ferret_search, ferret_why

Q "50a061ca-af67-828d-a7f5-0780ae4f1be9"
  read as: entity-id  verdict: answered
  subject: commit 50a061ca-af67-828d-a7f5-0780ae4f1be9
  claim: attributes.authoredAt [current]
    cited: observed/git — observed by ferret.source.git, observed authority, state current

Q "src/context/pack.ts"
  read as: path  verdict: partial
  reason: identifies exactly one file, and 0 claim(s) about it are supported…
  unknown: Ferret holds this subject but no evidence about it, so nothing here is cited.

Q "where did we discuss timeouts"
  read as: prose  verdict: not-answerable
  reason: The question is prose, which is what ranked retrieval is for… Use a context pack for this.

Q "deadbeef1234"
  read as: object-id  verdict: not-indexed
  unknown: Nothing matched. This is an absence in the index, not an empty answer about something Ferret holds.
  strategy exact: ran=true returned=0 skipped=Nothing matched exactly; ranked retrieval was used instead.
  strategy semantic: ran=false skipped=No embedding provider is registered…
  strategy text: ran=true returned=0
```

Two things only production shows. `ferret_answer` is registered by the **actual
CLI composition** — the failure EPIC-108 was caught by is a component that exists
and is never wired. And the last block is EPIC-055's plan reaching a client for
the first time: `semantic: ran=false` with the reason, which before this was
computed on every query and visible to nobody.

## 4. Where the evidence is weaker than the criterion

**No production case exercised a dispute, a truncated window, or the claim
bound.** Ferret's own index holds at most 2 observations per subject and all of
them in state `current` — the same limitation §4 of the EPIC-062 validation
records, and it has the same cause. AC-7 and AC-9 are therefore demonstrated
against constructed candidates and, for the EPIC-062 half of the mechanism,
against a real store in `evidence-store.test.ts`.

**The budget rule drops claims; it does not trim them.** A statement is quoted
evidence and half of one is a misquotation, which is the reasoning the context
pack already applies to evidence. So a subject whose single claim exceeds the
budget yields zero claims and says so, rather than a shortened claim. Stated
rather than discovered later.

**`permittedScopes` is threaded, not enforced** — EPIC-058 owns it, and §4 of the
specification excludes it.

**No answer-pack persistence.** §4 and §16 of the specification exclude it and
explain why; `derived_artifact` gains no row of kind `answer-pack` in this Epic.

## 5. What dogfooding found

Three findings, all from running the thing rather than reading it.

**A claim statement was wrapped when it should not have been.** The fix below
over-corrected. Wrapping every string statement reintroduced the exact cost
EPIC-084 had reasoned its way out of — "a client that compares `attributes.path`
to a file it knows about would find every comparison fail" — and a claim whose
field is `attributes.path` and whose statement is `src/context/pack.ts` is
precisely such a value. Found in the dogfood output of the fix for issue #71,
where a file's own path came back wrapped. The line is now EPIC-084's own, drawn
by **shape** rather than by key name, because shape is the property a `statement`
actually has: prose is wrapped, a bare token is left matchable. An injection needs
sentences, and a token has no whitespace to put them in. Two tests assert the
boundary from both sides, and one records honestly that a single-token statement
is neither wrapped nor marked — the same exposure EPIC-084 already accepts for a
path and a symbol name.

**A claim statement was marked and not wrapped.** The integration test
*"contains the hostile statement it cites"* failed on first run: a 110-character
injection attempt reached the claim unwrapped. The cause was reusing
`containAttributes`, which draws its line at *prose* — by key name or by length —
and the reasoning it gives for that is sound where it is applied: "a client that
compares `attributes.path` to a file it knows about would find every comparison
fail". A claim statement is neither a token nor a compared value. It is
repository-authored content in the most trusted position Ferret has, and nothing
compares it to anything, so the matchability cost that justifies the heuristic
does not exist. `containStatement` now wraps a string statement unconditionally.
Caught by a test written to the criterion rather than to the implementation.

**A path came back `ambiguous` with three candidates.** In production,
`src/context/pack.ts` matched a `file` and two `file_version` rows, all three
carrying that path as an attribute. Technically true and useless — nobody asking
about a file means "choose between this file and two of its historical blobs".
The fix narrows to the candidates the term is the *identity* of rather than the
ones that merely carry it, which is a distinction in the data rather than a list
of kinds: the file's own source id is the path, a version's is `git-blob:<sha>`.
It settles the object-id case at the same time — a full sha names the commit
itself — while an abbreviation still matches nothing exactly and stays
ambiguous, which is correct. Two unit tests pin both halves.

**A dispute was yielding `answered`.** The rendering test expected `partial` and
got `answered`, which turned out to be the test being right. Nothing is *missing*
when two current observations disagree — Ferret holds both — but it cannot say
which holds, and `answered` on a fact it cannot settle is certainty manufactured
at the verdict, the level a client is least likely to look past. A dispute now
makes the verdict `partial`, and so does an uncited claim.

## 6. Raised, not absorbed

**`file` entities carry no evidence** — [issue #71](https://github.com/indoulia/Ferret/issues/71).
Measured on a full index: 0 of 465 `file` entities have any evidence, while all
463 `file_version` entities do. So the one entity kind a developer names by hand
is the one kind Ferret cannot justify holding. EPIC-060 reports it honestly, which
is how it was found, and does not paper over it: reaching a file's current version
by traversal is EPIC-050, excluded by name in §4. The issue names EPIC-023/030,
EPIC-050 and EPIC-045 as candidate owners and the decision as not this Epic's.

**Answer-pack persistence has no owning Epic** — specification §16.

## 7. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 14 MET |
| Unit tests | Yes — 25 new |
| Integration tests | Yes — real MCP protocol; real stdio against a real index |
| Failure and boundary cases | Yes — empty question, a path prefix, a term that only appears in content, no planner, every bound |
| Security implications | Yes — a claim statement is contained unconditionally; a defect was found and fixed (§5) |
| Observability | Yes — the verdict, the reason, `unknowns` and the plan travel with the answer |
| Documentation | Specification and this document |
| Governance | §18, §6, §11, §3, §12, §5 |
| Dependencies validated | EPIC-008, 044, 045, 048, 052, 055, 059, 061, 062, 064, 065, 084 |
| Known blockers | None |
