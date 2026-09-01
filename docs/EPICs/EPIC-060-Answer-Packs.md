# EPIC-060 — Answer Packs

**Status: IMPLEMENTED | Priority: P0 | Domain: Context Compilation**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> the registry entry, the known-limitation row at
> `validation/EPIC-059-061-064-065-VALIDATION.md` §156, `src/retrieval/classify.ts`
> line 17, `QueryPlan.partial`, and Governance §18, §6, §11 and §3. **Nothing here
> invents a requirement.** Where a plausible requirement is *not* on record, §4
> excludes it and names the Epic that owns it — or says plainly that no Epic does.
>
> Authored after a readiness review against `28c9ab6` measured what exists; §2, §3
> and §8 describe the code as it is.

## 1. Objective

Answer a question Ferret can answer exactly — as claims with citations, and an
explicit account of what it does not know — rather than as ranked material for
someone else to answer from.

## 2. Value

EPIC-059's own validation names the gap:

> **No answer packs, and no explanation of why a result was chosen.** A pack says
> *that* an item matched, not how the query was planned. — **EPIC-060**,
> **EPIC-063**

And the distinction the Epic rests on is already stated in the code. Of a
question with an exact shape, `src/retrieval/classify.ts:17` says:

> Single right answer, so ranking would be a lie.

Ferret recognises three such shapes — a Ferret entity id, a Git object id or
abbreviation, and a path — and the planner already routes them down an exact path
that is *not* blended with ranked results, because "someone asking for `b9559ab`
is not helped by the commit ranked above three documents mentioning it"
(`planner.ts:99`).

Measured on `28c9ab6`, every one of those questions is nevertheless answered with
a **ranked context pack**. `ferret_context_pack` takes a question, searches, and
returns items ordered by relevance with omissions — which is exactly right for
prose and the wrong shape for `src/parser.ts`. A client asking about one file gets
a ranking of one, an unstated assumption that it is the right one, and no
statement of what Ferret does not hold about it.

Three consequences:

1. **The plan is invisible.** `QueryPlan` carries `shape`, `reason`, `exact`,
   `strategies` and `partial` — documented as "the one field a caller checks to
   know the answer may be incomplete" (`planner.ts:58`) — and **no surface returns
   it**. A client cannot tell an answer assembled from three strategies from one
   assembled from a single strategy whose two companions failed.

2. **Ambiguity is indistinguishable from an answer.** An abbreviated object id
   matching two commits returns two ranked items. For a question with one right
   answer, presenting the higher-ranked one first is a claim Ferret has no basis
   for, and Governance §6 forbids manufacturing certainty.

3. **Absence is a short list.** "Ferret holds nothing about this path" arrives as
   `items: []` — the same shape as "the budget ran out", which EPIC-048 had to fix
   in the evidence surface for exactly this reason.

EPIC-062 made the *choice* of evidence explainable. This Epic makes the **answer**
explainable, and it is largely composition: the classifier, the planner, the
evidence port and `selectEvidence` all exist and are tested.

## 3. Scope

- An **answer pack shape** — the claims Ferret is making, each with its citations
  and Ferret's reading of whether it still holds.
- **Exact-question routing**, so a question with one right answer is answered
  rather than ranked.
- **An explicit completeness verdict** — answered, partial, ambiguous,
  not-indexed, or not-answerable — with a reason a person can check.
- **A stated account of what Ferret does not know**, including strategies that did
  not run and evidence that was not cited.
- **Ambiguity as an answer**: candidates listed, none chosen.
- **Refusal to answer prose structurally**, naming the context pack as the right
  surface instead of inventing a claim.
- **Plan disclosure**, so how the question was routed travels with the answer.
- **Composition into the MCP surface**, because Governance §3 makes MCP the
  primary interface and an answer nothing can reach answers nothing.
- **A renderer**, for a client that wants text rather than structure.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Generating a natural-language answer.** Ferret has no model, and prose
  synthesised from evidence is indistinguishable from prose invented from it.
  An answer pack is **structured claims with citations**; the sentence is the
  client's to write. Not deferred to another Epic — excluded on principle
  (Governance §6, and §1: Ferret is a knowledge layer, not an assistant).
- **Persisting an answer pack** as a `derived_artifact` of kind `answer-pack`.
  `src/storage/schema/derived.ts:27` anticipates it and EPIC-010's migration
  records the intent, but **no Epic owns it** and this one deliberately does not
  take it: writing rows nothing reads is the write-only-subsystem defect EPIC-048
  was written to correct, and serving answers from a cache needs question
  normalization and an invalidation policy that no approved Epic defines. Raised
  rather than absorbed — see §16.
- **A user-facing narrative explanation of the query** — EPIC-063. This Epic
  returns `QueryPlan` as it stands; it does not compose prose about it.
- **Ranking or reranking** — EPIC-056/057. An answer pack applies no ranking; that
  is the point.
- **Resolving a conflict or an ambiguity** — EPIC-047. Both are reported.
- **Computing confidence** — EPIC-046. No confidence number is produced.
- **Choosing which evidence a claim cites** — EPIC-062, consumed as it stands.
- **Permission enforcement** — EPIC-058.
- **Token estimation and budgeting** — EPIC-061, consumed as it stands.
- **Relationship traversal to reach an indirect answer** — EPIC-050.

## 5. Inputs

- `classify` and `QueryShape` (EPIC-055) — which questions have one right answer.
- `QueryPlanner` and `QueryPlan` (EPIC-055), when one is wired.
- `RetrievalPort` (EPIC-052) for the exact lookup and the subject.
- `EvidenceReader.forSubjectWithState` (EPIC-048, EPIC-062).
- `selectEvidence` (EPIC-062) — which records a claim cites, and why.
- `ContentSafety`, `contain`, `mark` and `containAttributes` (EPIC-084). A claim
  statement is contained when it is **prose** and marked when it is a bare token,
  which is EPIC-084's own line drawn by *shape* rather than by key name — a
  statement has no key name to draw it by. Both halves were defects first; see the
  validation document §5.
- `TokenBudget` and `estimateJsonTokens` (EPIC-061).

## 6. Outputs

- `AnswerPackBuilder.answer(request)` → an `AnswerPack`.
- `AnswerCompleteness`, `AnswerClaim`, `AnswerCitation`, `AnswerCandidate`.
- `renderAnswer(pack)`.
- `ferret_answer` on the MCP server, registered only when an evidence reader is
  wired.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-008 Evidence & Provenance Model | VALIDATED | the claim's statement, field, state and locator |
| EPIC-044/045 Evidence Store & Source Authority | VALIDATED | the records a claim cites and their rank |
| EPIC-048 Answer Traceability | IMPLEMENTED | `EvidenceReader`, the traceability contract |
| EPIC-052 Exact Structured Retrieval | VALIDATED | the exact lookup |
| EPIC-055 Hybrid Query Planner | VALIDATED | `classify`, `QueryPlan`, the exact path |
| EPIC-059/061 Context Packs & Token Budgeting | VALIDATED | the content notice, the estimator, the budget |
| EPIC-062 Evidence Selection | IMPLEMENTED | which records a claim cites, and the reason |
| EPIC-064/065 MCP Server & Knowledge Tools | VALIDATED | the surface the answer is reachable through |
| EPIC-084 Prompt-Injection Resistance | VALIDATED | containment of every value that came from a repository |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **An answer pack never manufactures an answer.** Exactly one of five
  completeness verdicts, each with a reason: `answered`, `partial`, `ambiguous`,
  `not-indexed`, `not-answerable`. There is no sixth state meaning "probably".
- **A prose question is `not-answerable`, not a guess.** `classify` decides, not a
  heuristic in this Epic, and the reason names the context pack as the right
  surface. Governance §6: Ferret must never manufacture certainty.
- **Ambiguity yields no claim.** More than one candidate for a question with one
  right answer produces `ambiguous`, every candidate listed, and `claims` empty.
  Picking the first would be indistinguishable from having decided.
- **Absence is distinguishable from silence.** `not-indexed` says Ferret holds
  nothing; `answered` with no citations says Ferret holds the subject but no
  evidence about it. Two different facts, never the same shape.
- **Every claim carries its citations, or says it has none.** A claim with an
  empty `citations` array is stated as unsupported in `unknowns`, because a claim
  nothing supports is the one a reader most needs warning about.
- **`partial` is never silent.** Whenever the plan reports `partial`, evidence was
  excluded, the candidate window was truncated, or the claim bound was reached,
  the verdict is `partial` and `unknowns` says which.
- **Every repository-authored value is contained.** Claim statements and subject
  attributes pass through `ContentSafety`; Ferret's own sentences — reasons,
  verdicts, unknowns — do not, and are built from enumerated values rather than
  interpolated content.
- **The plan travels with the answer.** `plan` is the planner's `QueryPlan`
  verbatim when a planner is wired, and `undefined` when none is — never a
  fabricated one.
- **A term identifies what it is the identity *of*.** When any candidate's own
  source identity is the term, the answer is about those candidates only; when
  none is, every candidate that carries the term stays and the answer is
  `ambiguous`. This is a distinction in the data rather than a list of entity
  kinds — a file's source id *is* its path, a file version's is `git-blob:<sha>` —
  and it is why `src/context/pack.ts` names a file rather than being ambiguous
  between that file and two of its blobs, while a seven-character object-id
  abbreviation stays honestly ambiguous. Added after dogfooding produced the
  three-candidate answer; see the validation document §5.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | A question with an exact shape resolves to one subject and is answered rather than ranked. | `classify.ts:17`; the §156 gap row |
| AC-2 | A prose question returns `not-answerable` with a reason naming the context pack, and no claim. | Gov §6; `classify` |
| AC-3 | An exact question matching more than one subject returns `ambiguous`, lists every candidate, and makes no claim. | Gov §6 |
| AC-4 | A question matching nothing returns `not-indexed`, distinguishably from a subject held with no evidence. | Gov §6 ("not-indexed"); EPIC-048 precedent |
| AC-5 | Each claim carries the field, the statement, Ferret's reading of its state, and its citations. | Gov §18 |
| AC-6 | Each citation names the source system, locator, method, producer, authority, and the EPIC-062 reason it was cited. | Gov §18; EPIC-062 |
| AC-7 | A disputed fact is reported on the claim and in `unknowns`, and no side is dropped. | Gov §15; EPIC-047 boundary |
| AC-8 | `QueryPlan` is returned verbatim when a planner is wired, and `undefined` when none is. | `planner.ts:58`; §8 |
| AC-9 | A plan reporting `partial`, excluded evidence, a truncated window, or a reached claim bound yields `partial` and a matching `unknowns` entry. | `QueryPlan.partial`; EPIC-062 AC-8 |
| AC-10 | A claim with no citations is stated as unsupported in `unknowns`. | Gov §18; §8 |
| AC-11 | Subject attributes and claim statements are contained; Ferret's own sentences are not. | Gov §12; EPIC-084 |
| AC-12 | The answer is reachable over MCP, read-only, carrying the content notice, and absent rather than useless when no evidence reader is wired. | Gov §3; EPIC-048 AC-9 precedent |
| AC-13 | The rendered answer states the verdict, each claim with its citations, and every unknown. | Gov §18 |
| AC-14 | An answer pack reports its estimated size and drops claims beyond the budget, saying so. | EPIC-061 |

## 10. Test requirements

**Unit.** Each criterion against a fake retrieval and a fake evidence reader:
each shape of question; one, none and several matches; a subject with no
evidence; a disputed fact; a claim with no citations; the plan absent and
present; containment of a hostile statement; the budget bound.

**Integration.** The tool over the real MCP protocol: registered only with an
evidence reader, read-only, content notice present, and a real answer for a real
entity id.

**Failure.** An evidence reader that throws must produce a redacted tool error
rather than a crash; a subject whose attributes are enormous must not produce an
unbounded pack; a question of maximum length must classify without pathological
cost.

**Security.** A claim whose statement is an injection attempt is contained and
marked, and the verdict, reason and unknowns contain no repository text.

**Performance.** One exact lookup and one evidence query per answer. No
per-claim round trip.

## 11. Security requirements

- Every value that came from a repository is contained before it enters the pack
  — subject attributes and claim statements alike (Gov §12, EPIC-084).
- Ferret's own sentences are built from enumerated values, never by interpolating
  content, so the parts of the pack a client is most likely to trust cannot carry
  an instruction.
- The MCP tool is read-only and carries the content notice, like every tool
  EPIC-065 registered.
- `permittedScopes` is threaded to the evidence port unchanged; EPIC-058 owns the
  policy.

## 12. Observability

- The verdict, the reason and `unknowns` are the observability surface, and they
  travel with the answer rather than being logged separately — the client that
  answers is the one that needs them.
- `plan` exposes each strategy's outcome, which is the first surface in Ferret to
  do so.

## 13. Performance constraints

- One exact lookup and one evidence query per answer; claims are grouped in
  memory from the single evidence window.
- Bounded claims and a bounded candidate window, so a subject with two thousand
  observations costs what one with thirty costs.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration and failure tests pass; the regression suite passes.
- `docs/EPICs/validation/EPIC-060-VALIDATION.md` records the evidence.
- Registry entry updated.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§18 Provenance and Explainability** — an answer is traceable to evidence, and
  why it was included or excluded is stated.
- **§6 Evidence Before Inference** — five explicit verdicts; unknown, partial,
  conflicting and not-indexed are represented rather than flattened; no prose is
  synthesised.
- **§11 Retrieval** — deterministic structured lookup is preferred when the
  requested information is structurally known, and the routing is explainable.
- **§3 AI-Operated by Default** — reachable through MCP.
- **§12 Security** — content is contained; content is data, never policy.
- **§5 Reuse Before Reinvent** — the classifier, planner, evidence port,
  selection, containment and estimator are consumed, not re-created.

## 16. Raised for governance

**Answer-pack persistence has no owning Epic.**
`src/storage/schema/derived.ts:27` lists `answer-pack` among the artefact kinds
and EPIC-010's migration comment records the expectation that EPIC-060 would add
one. This specification deliberately does not, and says why in §4. If persistence
and cache read-back are wanted, they need an Epic with acceptance criteria for
question normalization and invalidation; they are not smuggled in here.
