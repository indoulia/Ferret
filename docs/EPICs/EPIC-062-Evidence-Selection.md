# EPIC-062 — Evidence Selection

**Status: IMPLEMENTED | Priority: P0 | Domain: Context Compilation**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> the registry entry, Governance §18 ("Ferret should be able to explain why
> evidence was included, excluded, considered authoritative, considered stale, or
> considered conflicting"), Governance §6 and §7, EPIC-045's authority scale, and
> EPIC-048's bounded per-item evidence. **Nothing here invents a requirement.**
> Where a plausible requirement is *not* on record, §4 excludes it and names the
> Epic that owns it.
>
> Authored after a readiness review against `5e5fe5c` measured what exists; §2,
> §3 and §8 describe the code as it is.

## 1. Objective

Choose which evidence records accompany a context-pack item, and state why each
one was chosen or left out.

## 2. Value

Governance §18 is the requirement, in its own words:

> Every important derived answer must be traceable to evidence. Ferret should be
> able to explain **why evidence was included, excluded, considered
> authoritative, considered stale, or considered conflicting.**

EPIC-048 made evidence reachable. It did not make the choice of evidence
defensible. Measured on `5e5fe5c`, three things are true at once:

1. `ContextPackBuilder.#evidenceFor` asks `forSubject(id, { limit: 6 })` with
   **no `state` filter** (`src/context/pack.ts:337`). `EvidenceState` has five
   values and four of them mean "do not believe this without saying so" —
   `stale`, `superseded`, `conflicting`, `unavailable`. All four are citable
   today, and a pack presents them identically to `current`.
   `src/context/evidence-port.ts:28` already states the rule this violates: *"a
   citation surface must ask for what it means rather than take the default."*

2. The store orders candidates by `COALESCE(observed_at, recorded_at) DESC`
   (`src/storage/evidence.ts:235`) and the builder takes the first five, so
   selection is **recency only**. EPIC-045 built a five-rank authority scale and
   `preferredEvidence` ranks by it; `preferredEvidence` has **no caller outside
   `src/domain/`**. A rank-20 `ASSERTED` record — a model's own output — observed
   today therefore displaces a rank-100 `SYSTEM_OF_RECORD` observation from last
   week.

3. What was excluded is reported as one integer, `evidenceOmitted`. An integer
   cannot answer "why", and §18 asks for why.

A fourth finding shaped §5 and §6. **`CanonicalEvidence` carries no `state`.**
The column exists, `forSubject` filters on it (`src/storage/evidence.ts:217`) and
`.select()` already fetches it, but `toCanonical` (`src/storage/evidence.ts:57`)
discards it — so a caller that receives a record *cannot know* whether Ferret
still believes it. Honouring `state` in a selection therefore needs the store to
return what it already read. §6 adds one read projection for that and nothing
else.

This is stabilization rather than expansion. Every input the selection needs is
already stored on every evidence row: `authority`, `state`, `confidence`,
`observedAt`, `field`, `completeness`.

## 3. Scope

- A **selection contract** — given the evidence Ferret holds about a subject and
  a bound, which records to cite and in what order.
- **Authority-first ordering**, so EPIC-045's scale reaches an answer.
- **State-aware selection**, so a record Ferret no longer believes is
  distinguishable from one it does, and is never silently preferred over it.
- **Field diversity**, so one heavily-observed field cannot consume an item's
  whole evidence bound.
- **An exclusion account** — for each record left out, the reason, in a form a
  person can check.
- **Conflict visibility on the pack path**, so an item resting on a disputed fact
  says so.
- **Composition into the context pack and its rendering**, because a selection
  nothing consumes explains nothing.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Computing or calibrating confidence** — EPIC-046. This Epic reads the stored
  `confidence` field as a tiebreak, exactly as `preferredEvidence` already does;
  it does not produce one.
- **Resolving conflicts** — EPIC-047. A conflict is reported, never decided.
  Governance §15 forbids discarding conflicting evidence and §6 forbids
  manufacturing certainty.
- **Assigning authority ranks** — EPIC-045, already validated. This Epic consumes
  `authority`; it does not set it.
- **Ranking or reranking search results** — EPIC-056/057. Selection here is
  *within* one item's evidence, never across items.
- **Permission enforcement** — EPIC-058. `permittedScopes` is threaded through the
  contract because the port already accepts it, but deciding a caller's scopes
  and mandating the filter belongs to EPIC-058.
- **Token budgeting** — EPIC-061, already validated. Selection produces a bounded
  set; the budget decides whether the item carrying it fits.
- **Answer packs** — EPIC-060.
- **Detecting staleness** — EPIC-031/032 set `state`; this Epic honours it.

## 5. Inputs

- Evidence records for a subject, via the `EvidenceReader` port (EPIC-048 §8).
- `authority`, `state`, `confidence`, `observedAt`, `recordedAt`, `field` and
  `completeness` on each record (EPIC-008 schema).
- `SourceAuthority` and `isUnknownAuthority` (EPIC-045).
- `EvidenceState` and, per record, Ferret's current interpretation of it —
  supplied by a read projection on the evidence store, because
  `CanonicalEvidence` does not carry state (§2).
- `detectConflicts` (EPIC-008), applied to the candidate window, so disagreement
  is found without a second round trip.
- A per-item bound (`MAX_EVIDENCE_PER_ITEM`, EPIC-048).

## 6. Outputs

- `EvidenceReader.forSubjectWithState` and `EvidenceStore.forSubjectWithState` —
  the same query as `forSubject`, returning each record with the `state` and
  `supersededBy` the store already fetched. A read projection over existing
  columns; no schema change, no extra query.
- `selectEvidence(candidates, options)` — a selection: the records to cite in
  cited order, each with the reason it was included; the records excluded, each
  with the reason; and whether the candidate window itself was truncated.
- `PackItem.evidenceSelection` — the account, carried on the item.
- `ContextPack.omitted` entries that name the exclusion reasons rather than only
  a count.
- Rendered output that states, per item, what the evidence rests on and what was
  left out.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-008 Evidence & Provenance Model | VALIDATED | `authority`, `state`, `confidence`, `field` on every record |
| EPIC-044 Evidence Store | VALIDATED | `forSubject`, `conflictsFor` |
| EPIC-045 Source Authority | VALIDATED | the authority scale and `isUnknownAuthority` |
| EPIC-048 Answer Traceability | IMPLEMENTED | the `EvidenceReader` port, the per-item bound, evidence on pack items |
| EPIC-059 Context Packs | VALIDATED | `ContextPackBuilder`, `PackItem`, `PackOmission` |
| EPIC-061 Token Budgeting | VALIDATED | the estimator the selected set is measured with |

No external dependency. No new package.

## 8. Contracts

Other Epics may rely on the following.

- **Selection is pure and deterministic.** Same candidates in, same selection
  out, with no clock, no database and no I/O. A selection that cannot be
  reproduced cannot be explained.
- **Total order.** Records are ordered by, in strict precedence: believability of
  `state`; `authority` descending; `confidence` descending; `observedAt`
  descending; then record `id` ascending. The final key is what makes the order
  total — two records identical in every ranked field must not swap between runs.
- **`state` precedes `authority`.** A record whose state says Ferret no longer
  believes it must never be cited ahead of one Ferret does believe, however
  authoritative its source was when it was observed. Authority describes *where a
  fact came from*; state describes *whether it still holds*.
- **Unknown authority is not lowest.** `isUnknownAuthority` distinguishes
  "unassessed" from "assessed and weak" (EPIC-045). An unassessed record orders
  between `ASSERTED` and `DERIVED`, and its inclusion reason says it is
  unassessed, rather than being ranked below a known-weak source — which would be
  a claim Governance §6 forbids manufacturing.
- **Nothing is discarded silently.** Every candidate appears in the selection
  exactly once, as included or as excluded-with-a-reason. The two lists partition
  the input.
- **Diversity does not override belief.** The field cap applies within the ordered
  list; it can never admit a less-believed record ahead of a more-believed one
  for the same field.
- **An unassessed state is not ranked below a disbelieved one.** A record whose
  state was not read, or whose state Ferret does not recognise, orders after
  `current` and `conflicting` and before `unavailable`, `stale` and `superseded`
  — the same reasoning EPIC-045 applied when it placed `UNKNOWN` authority
  between `ASSERTED` and `DERIVED`. Ranking "nobody assessed this" below
  "assessed and replaced" would be a claim, and Governance §6 forbids
  manufacturing it.
- **A truncated candidate window is reported.** When more records exist than were
  fetched, the selection says so, so "the best five of nine" and "the best five of
  some unknown number" are distinguishable.
- **Conflict is reported, never resolved.** A subject with a conflict group yields
  an item that says the fact is disputed. No record is excluded for being in one.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | A higher-authority record is cited ahead of a more recent lower-authority one. | Gov §7; EPIC-045 |
| AC-2 | A record whose `state` is not `current` is never cited ahead of a `current` record for the same subject. | Gov §6; `evidence-port.ts:28` |
| AC-3 | A cited record carries a reason naming its authority and its state. | Gov §18 |
| AC-4 | An excluded record carries a cause distinguishing `per-item-bound`, `field-already-covered` and `not-current`, and a reason naming the actual state or bound. | Gov §18 |
| AC-5 | Included and excluded records together are exactly the candidates, with no record in both and none missing. | Gov §15 |
| AC-6 | Ordering is total: the same candidates in any input order select identically. | §8 |
| AC-7 | One field with many observations cannot consume the whole per-item bound while other fields have evidence. | registry: *selection* |
| AC-8 | A truncated candidate window is stated in the selection, and is distinguishable from a complete one. | EPIC-048 AC-8 precedent |
| AC-9 | An item whose subject has a conflict group reports the fact, and no record is excluded for being in one. | Gov §15; EPIC-047 boundary |
| AC-10 | A context pack's `omitted` names the exclusion reasons, not only a count. | Gov §18 |
| AC-11 | An unassessed-authority record is not ordered below a known-weak one, and its reason says it is unassessed. | EPIC-045 `isUnknownAuthority` |
| AC-12 | Selection performs no I/O and consults no clock. | §8 |
| AC-13 | A subject with no evidence yields an empty selection with no exclusions — an honest absence, not an error. | EPIC-048 "truthful absence" |
| AC-14 | The rendered pack states, per item, what its evidence rests on and what was left out. | Gov §18 |

## 10. Test requirements

**Unit.** Each acceptance criterion above, against constructed candidate sets:
authority beats recency; state beats authority; the partition holds under every
exclusion path; determinism under shuffled input; the field cap; the unassessed
rank; the empty case; a reported truncated window.

**Integration.** A pack built over a real store with mixed-authority,
mixed-state evidence for one subject cites the authoritative current record and
accounts for the rest; conflict surfaces on the item.

**Failure.** A candidate with a missing `observedAt`, a missing `confidence`, an
unrecognised `state`, or an authority outside the scale must all order without
throwing — evidence arrives from providers, and a selection that crashes on an
unexpected value takes the whole answer with it.

**Security.** Selection reads no content and makes no trust decision from
repository text; a record whose `statement` contains an instruction is ordered by
its metadata alone (Gov §12).

**Performance.** Selection is O(n log n) in the candidate window, and the window
is bounded by a constant, so per-item cost is bounded independent of how much
evidence a subject accumulates.

## 11. Security requirements

- Selection is metadata-only. No repository content influences the order, so
  indexed text cannot promote itself into a citation (Gov §12).
- `permittedScopes` is passed to the port unchanged; this Epic neither widens nor
  narrows it (EPIC-058 owns the policy).
- No reason string interpolates repository content. Reasons are Ferret's own
  sentences built from enumerated values, and are therefore safe outside the
  containment envelope — the rule `PackItem.reason` already follows.

## 12. Observability

- The exclusion account *is* the observability surface: it travels with the pack
  rather than being logged separately, because the client that answers is the one
  that needs it.
- Pack `omitted` entries carry the reason breakdown, so a caller can see at pack
  level what it would otherwise have to sum per item.

## 13. Performance constraints

- No additional store round trip per item — one query fetches the candidate
  window, and conflict is detected from that window in memory rather than by a
  second query.
- The candidate window is bounded by a constant, so an entity with two thousand
  observations costs the same as one with thirty.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration and failure tests pass; the regression suite passes.
- `docs/EPICs/validation/EPIC-062-VALIDATION.md` records the evidence.
- Registry entry updated.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§18 Provenance and Explainability** — the requirement this Epic exists to
  satisfy, quoted in §2.
- **§6 Evidence Before Inference** — stale, partial, conflicting and unknown
  states are represented rather than flattened.
- **§7 Source Authority** — the stored authority rank reaches an answer.
- **§12 Security** — metadata-only ordering; content is data, never policy.
- **§15 Data Integrity** — the partition rule: nothing is discarded silently.
- **§5 Reuse Before Reinvent** — `SourceAuthority`, `isUnknownAuthority`,
  `EvidenceState` and the existing port are consumed, not re-created.
