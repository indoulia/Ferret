# EPIC-048 — Answer Traceability

**Status: PROPOSED | Priority: P0 | Domain: Evidence & Provenance**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> the registry entry, EPIC-008's decision D-006, the PARTIAL row in
> `validation/EPIC-008-VALIDATION.md` §121, and EPIC-044's existing lineage
> contract. **Nothing here invents a requirement.** Where a plausible requirement
> is *not* on record, §4 says so and excludes it rather than quietly adopting it.
>
> Authored after a readiness review against `da06909` measured what exists and
> what does not; §3 and §8 reflect the code as it is, not as an earlier document
> described it.

## 1. Objective

Make an answer built from Ferret's knowledge traceable back to the observations
it rests on — and make the absence of such observations equally visible.

## 2. Value

EPIC-008 D-006 states the intent plainly:

> Backwards — "why does Ferret believe this" — is what EPIC-048 turns into a
> user-facing explanation.

The backwards traversal exists, is bounded, is tested, and **has no caller
outside `src/storage/`**. Measured on `da06909`, one `ferret index` run over
Ferret's own repository records **556 evidence rows**, and an AI client can reach
**none** of them: `createMcpServer` takes `{ retrieval, planner?, logger }` and no
evidence dependency at all.

So the evidence subsystem is presently write-only from the product's point of
view. This Epic is what makes EPIC-008, EPIC-044 and EPIC-045 observable in an
answer, and it closes the last PARTIAL row on EPIC-008:

> Consumed by downstream retrieval contracts — **PARTIAL** … No retrieval layer
> exists yet to consume them, so this is demonstrated against the interface
> rather than against a consumer.

It is stabilization rather than expansion: nearly every criterion below is
satisfiable by calling functions that already exist and are already tested.

## 3. Scope

- A **traceability read contract** — for a subject, the evidence Ferret holds,
  each record's source locator and authority, and its lineage.
- **Composition into the MCP surface**, so the capability is reachable by the
  client the product is built for (Governance §3 makes MCP the primary
  interface).
- **Evidence on context-pack items**, so a pack an AI answers from carries what
  each item rests on.
- **Truthful lineage**, including a lineage that was not fetched being
  distinguishable from one that is empty.
- **Truthful absence**, so "Ferret holds no evidence for this" is an answer
  rather than a silence.

## 4. Non-scope

Each exclusion names its owner. An item is excluded because another Epic owns it,
not because it is inconvenient.

- **Computing confidence** — EPIC-046. This reports the field; it does not derive
  it.
- **Resolving a conflict** — EPIC-047. `conflictsFor` reports disagreement and
  that remains the behaviour.
- **Ranking by authority or freshness** — EPIC-056, EPIC-057. This surfaces the
  signal; those Epics weigh it.
- **Enforcing permissions** — EPIC-058. §8 requires the scope parameter be
  threaded so that Epic has a seam, and requires nothing else.
- **Creating derivations.** No shipping producer emits `derivedFrom` today; every
  record is a direct observation. This Epic exposes the chain, it does not
  manufacture one.
- **Evidence for `code_symbol`** — issue #49, owned by EPIC-035. Symbols carry no
  evidence; this Epic reports that truthfully and does not invent a statement for
  them.
- **A new table, column or migration.** EPIC-008's schema is sufficient.
- **Rewriting the evidence store.** It is read here.

## 5. Inputs

- EPIC-008's evidence model and `evidence_derivation` join table;
- EPIC-044's `EvidenceStore`: `forSubject`, `provenanceOf`, `dependentsOf`,
  `verify`, `conflictsFor`;
- EPIC-045's `authority` ranks, now real rather than uniformly zero;
- EPIC-059's `ContextPack` and its omission reporting;
- EPIC-064/065's MCP server and tool conventions.

## 6. Outputs

- A narrow evidence-read port on the MCP server's dependencies;
- one additional read-only MCP tool;
- evidence attached to context-pack items, with omissions reported;
- validation evidence closing EPIC-008's PARTIAL row.

## 7. Dependencies

EPIC-008, EPIC-044, EPIC-045, EPIC-059, EPIC-061, EPIC-064, EPIC-065 — all
VALIDATED. Nothing blocks this Epic.

EPIC-058 is **not** a dependency but is a related risk: the retrieval path does
no permission filtering, and this Epic widens what a client can read. All
locally-indexed evidence has `permissionScope` null today, so the risk is latent;
§8 requires the seam regardless.

## 8. Contracts

**Reached by port, not by import.** The MCP server names the narrow evidence
interface it needs, and `EvidenceStore` satisfies it structurally — the same
shape as `EntityWriter` and the other indexer ports, so the core continues to
import no `storage/` module and the architecture test continues to prove it.

**`permittedScopes` is threaded from the start.** `EvidenceQuery` already accepts
it and already filters. Passing it through now costs one parameter; retrofitting
it after EPIC-058 would be a rewrite.

**Lineage depth is bounded and the bound is reported.** `provenanceOf` already
takes `maxDepth`. A truncated chain must say it was truncated, for the same
reason a truncated pack does.

**A lineage that was not fetched is not an empty lineage.** `storage/retrieval.ts`
returns `derivedFrom: []` on every search hit for a sound performance reason —
fetching per hit would turn a page of fifty into a hundred round trips — but an
empty array is indistinguishable from "this observation has no antecedents".
Whatever this Epic does about depth, it must not ship a chain that lies about
being empty.

## 9. Acceptance criteria

Each criterion names the record it derives from.

- **AC-1** For a subject, the evidence Ferret holds is returned with each
  record's method, producer and version, source system, locator and authority.
  *(D-006; EPIC-044 AC-4.)*
- **AC-2** Backwards lineage is traversable for a record, bounded, and a chain cut
  short by the bound says so. *(D-006; EPIC-044 AC-5.)*
- **AC-3** A subject with no evidence returns an explicit "none held", not an
  empty result indistinguishable from a failure. *(EPIC-065 AC-20, "absence is an
  answer, not an error".)*
- **AC-4** A record's integrity verdict is available, so a citation can be shown
  to be untampered. *(EPIC-044 AC-7.)*
- **AC-5** Disagreement about a subject is reportable alongside its evidence and
  is neither resolved nor hidden. *(EPIC-044 AC-8; Governance §15.)*
- **AC-6** A context-pack item carries the evidence its entity rests on, not only
  the record that happened to match the query. *(EPIC-059's pack contract; today
  an entity-matched item carries none.)*
- **AC-7** Evidence dropped from a pack for budget is reported as an omission
  with a reason. *(EPIC-059 AC-8.)*
- **AC-8** No response reports a lineage as empty when it was merely not
  fetched. *(§8; Governance §15.)*
- **AC-9** The traceability surface is exposed through MCP as a read-only tool,
  declared read-only, carrying the content notice. *(EPIC-065 AC-15, AC-16,
  AC-17.)*
- **AC-10** The core reaches no `storage/` module; the capability arrives by
  port. *(EPIC-031 AC-9; EPIC-064 AC-14.)*
- **AC-11** Every read accepts permitted scopes and filters on them when supplied.
  *(§8; the seam EPIC-058 needs.)*

## 10. Test requirements

- **Unit:** pack assembly with and without evidence; omission reporting when
  evidence is dropped; the "not fetched" versus "empty" distinction.
- **Integration:** the tool through the **real protocol**, client and server, as
  EPIC-065's tests do — a criterion about an AI-facing surface is not met by a
  unit test.
- **Integration against a real database:** lineage traversal and the depth bound,
  against real evidence written by a real index run.
- **Security:** evidence content carried to a client stays an attributed value
  inside the content envelope, as EPIC-084 requires of every other surface.
- **Architecture:** the boundary test continues to prove the core reaches no
  `storage/` module.
- **Dogfooding:** ask Ferret why it believes something about its own repository,
  and check the answer against `git`.

## 11. Security requirements

Evidence content is repository content and is framed accordingly — EPIC-084's
envelope applies unchanged. Redaction already happened at write time (EPIC-008
D-008) and is not undone here. `permittedScopes` is threaded per §8. No new
credential path exists, because nothing here writes.

## 12. Observability

A traceability response states what it could not answer: a bound reached, a scope
filter applied, evidence omitted for budget. Silence is not an acceptable form of
any of these.

## 13. Performance constraints

No unbounded traversal, no per-hit lineage fetch on a search path, and a bound on
evidence hydrated per pack item. Reuses existing indexes; adds none.

## 14. Definition of Done

Implementation, tests at the layer each criterion actually requires, validation
evidence mapping every criterion to its demonstration, and the EPIC-008 PARTIAL
row closed with a dated note that preserves the original assessment rather than
rewriting it.

## 15. Governance alignment

- **§3 MCP is the primary interface** — the capability is delivered where a
  client can reach it, not only in a store.
- **§7 Smallest correct change** — the traversal, the ranks and the integrity
  check all exist; this composes them.
- **§14 Provider boundaries** — reached by port; no `storage/` import in core.
- **§15 Data integrity** — provenance is preserved and reported; nothing is
  silently discarded, and a lineage that was not read is not reported as absent.
- **§21 Definition of Done** — an integration criterion is not claimed from a
  unit test.
