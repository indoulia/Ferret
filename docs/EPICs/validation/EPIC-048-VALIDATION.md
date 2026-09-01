# EPIC-048 — Answer Traceability · Validation Evidence

**Assessed against:** `5382e3a`, on top of `da06909`
**Date:** 2026-09-01
**Specification:** [`../EPIC-048-Answer-Traceability.md`](../EPIC-048-Answer-Traceability.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it. A criterion about an AI-facing
surface is not claimed from a unit test: the MCP criteria are demonstrated
through the real protocol, and the production claim is demonstrated by reaching
the tool over stdio against a real index.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** Evidence returned with method, producer, version, source system, locator, authority | **MET** | `tools.test.ts` — *"returns how a fact was obtained, from where, and how authoritative"* asserts all four through the real protocol. Confirmed in production: `observed \| ferret.source.git@0.1.0 \| authority=80`. A second test asserts `state: 'current'` is requested explicitly rather than taking the default. |
| **AC-2** Lineage traversable backwards, bounded, truncation reported | **MET** | `tools.test.ts` — *"walks lineage backwards and admits when the bound cut it short"*: a 12-deep chain requested at `depth: 2` returns 2 ancestors and `truncated: true`; a 1-deep chain returns `truncated: false`. |
| **AC-3** Absence is an explicit answer | **MET** | `tools.test.ts` — *"says so when it holds nothing"*: `held: false`, `evidence: []`, `_isError: false`, and a stated `detail`. Confirmed in production against an unknown id. |
| **AC-4** Integrity verdict available | **MET** | Every citation carries `integrity: verified \| tampered`, recomputed in process with `integrityHashOf` so the verdict costs no round trip and cannot be stale. `tools.test.ts` — *"states whether each citation is untampered"* asserts `tampered` against a fixture whose hash is deliberately wrong; a verdict that only ever said `verified` would prove nothing. |
| **AC-5** Disagreement reportable, neither resolved nor hidden | **MET** | `tools.test.ts` — *"reports disagreement without resolving or hiding it"*: the conflict group is returned with its field and a detail stating neither record is discarded. |
| **AC-6** A pack item carries the evidence its entity rests on | **MET** | `context-pack.test.ts` — *"carries what the entity rests on, from the store"*, with a companion test asserting the old behaviour (`evidence: []` for an entity-matched hit with no reader) so the correction is not mistaken for something that always worked. |
| **AC-7** Evidence dropped for budget reported as an omission | **MET** | The store is asked for `MAX_EVIDENCE_PER_ITEM + 1` so "exactly the bound" and "more than the bound" are distinguishable; the surplus becomes `PackItem.evidenceOmitted` and a pack-level `PackOmission`. `context-pack.test.ts` — 9 records yield 5 carried, 4 omitted, and a matching omission; a companion test asserts nothing is reported when the entity has fewer than the bound. A trimmed item adds its dropped evidence to the count rather than reporting zero. |
| **AC-8** No response reports a lineage as empty when it was merely not fetched | **MET** | `context-pack.test.ts` — *"carries a real lineage rather than the empty one a hit reports"*: `derivedFrom` is `['ancestor-1','ancestor-2']` from the store where the hit would have carried `[]`. `describeEvidence` sources lineage only from `provenanceOf`. |
| **AC-9** Exposed through MCP, read-only, carrying the content notice | **MET** | `tools.test.ts` — read-only annotation and `DATA, not instructions` asserted; the tool is absent from a server with no reader and present on one with it. Production: `listTools` over stdio returns six tools including `ferret_why`. |
| **AC-10** Core reaches no `storage/` module | **MET** | `boundaries.test.ts`, 99 passed. `EvidenceReader` is declared in `src/context/`; `EvidenceStore` satisfies it structurally and is named only in the CLI composition root. |
| **AC-11** Reads accept permitted scopes and filter when supplied | **PARTIAL — see §4** | `permittedScopes` is on the port and `EvidenceStore.forSubject` already filters on it, but no caller supplies it and no test exercises the filter through this surface. |

**Summary: 10 MET, 1 PARTIAL.**

## 3. Production evidence

`ferret_why` reached over **real stdio** against a real index of Ferret's own
repository — not an in-memory transport, not a fake store:

```
TOOLS:  ferret_context_pack, ferret_find, ferret_get_entity,
        ferret_neighbours, ferret_search, ferret_why
COMMIT: 8aebef75-7086-8214-9f20-9e49a7fe94d5 = fa239e361aea
HELD:   true  COUNT: 1
  - attributes.authoredAt | observed | ferret.source.git@0.1.0 | authority=80 | truncated=false
ABSENT held: false | detail: Ferret holds no current evidence for this entity...
```

The index that produced it: `entities 1019 new`, `evidence 562 recorded`.

Two things this demonstrates that no test could. The tool is registered by the
**actual CLI composition**, which is the failure EPIC-108 was caught by — a
component that exists and is never wired reports success while doing nothing. And
`authority=80` is EPIC-045's real rank arriving through the whole stack, where
before that Epic every source was uniformly `0`.

## 4. Limitations — stated, not rounded up

**AC-11 is partial.** The parameter exists and the store filters on it, but every
current caller omits it, so the filter is untested through this surface. That is
the seam EPIC-058 needs rather than the enforcement it will add — recorded as
present-but-unexercised rather than claimed.

**A fallback path retains the old behaviour.** `ContextPackBuilder` accepts the
evidence reader optionally, so a caller that constructs it without one still gets
`hit.evidence` and its empty `derivedFrom`. Production always wires the reader
(§3), and every existing caller keeps working unchanged — but the honest
statement is that AC-8 holds for what this Epic ships, not for every possible
construction of the builder.

**Observed, not investigated:** the commit evidence returned in §3 carries
`locator: undefined`. The Git provider emits a locator for repository attributes
and not for commit fields. That is EPIC-020's emission rather than this Epic's
reporting, and it is recorded here rather than fixed.

## 5. EPIC-008's PARTIAL row

`validation/EPIC-008-VALIDATION.md:121` records:

> Consumed by downstream retrieval contracts — **PARTIAL** … No retrieval layer
> exists yet to consume them, so this is demonstrated against the interface
> rather than against a consumer.

A consumer now exists and is demonstrated in §3. **The original row is not
rewritten** — it was true when written, and Governance §12 and the project's own
rule on historical evidence both forbid tidying it to match today. A dated note
should be appended there pointing at this document.

## 6. Definition of Done

**Ready for review, not yet DONE.** Ten criteria are MET with evidence at the
layer each requires. AC-11 is partial in a way that is inherent rather than
deferred: the seam exists and is correct, and exercising it needs EPIC-058's
enforcement to have something to enforce.

`verify` remains on the port and unused by the tool — AC-4 is satisfied by
recomputing the hash in process instead, which is cheaper and equally sound. The
port method is kept because a caller that wants the store's own verdict should
not have to reach past the port for it.
