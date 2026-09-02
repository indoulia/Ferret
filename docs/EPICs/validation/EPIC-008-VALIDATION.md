# EPIC-008 — Validation Evidence

**Epic:** EPIC-008 — Evidence & Provenance Model
**Branch:** `feat/epic-008-evidence-and-provenance-model`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Important derived facts have evidence references | **PASS** | A record produced by `inferred`, `generated` or `aggregated` **must** name what it was derived from — `createEvidence` refuses one that cites nothing, because a conclusion that cites nothing cannot be traced. `evidence.test.ts` → "requires a derived fact to name what it was derived from"; `evidence-store.test.ts` → "refuses a derived record that cites nothing", and a foreign key refuses a citation of evidence that does not exist. |
| AC-2 | Evidence identifies source and source location where available | **PASS** | Every record carries `sourceSystem`, `sourceId`, `sourceUrl` and an open `locator` — a line range, a page, a cell, a byte offset. `evidence-store.test.ts` → "traces a conclusion back to the observation it rests on" asserts the chain's root is a direct observation with a line locator and a commit id. |
| AC-3 | Source evidence is not silently rewritten as a new fact | **PASS** | The store is append-only in content. A re-observation resolves to the same id and updates only `last_checked_at`; `recorded_at` is never rewritten. `evidence-store.test.ts` → "deduplicates a re-observation without rewriting the record" asserts both columns directly. Supersession changes Ferret's *interpretation* (`state`, `superseded_by`), never the observation. |
| AC-4 | Derived data records its derivation/version where material | **PASS** | `method`, `producer` and `producerVersion` are mandatory on every record. A different producer version is a genuinely different observation and is kept separately — which is what makes "re-extract everything the old parser touched" answerable (Governance §21). `evidence-store.test.ts` → "keeps a different parser version as a separate observation". |
| AC-5 | Stale, partial, unavailable, unknown and conflicting states are representable | **PASS** | Five states (`current`, `stale`, `superseded`, `conflicting`, `unavailable`); `Completeness` of `complete`/`partial`/`unknown` defaulting to **unknown**; and confidence where **absent ≠ zero** — zero says "believed false", absent says "not assessed". `evidence.test.ts` → "not-knowing is representable" (5 cases); staleness detected by source-content hash in `evidence-store.test.ts` (3 cases). |
| AC-6 | Evidence integrity can be checked | **PASS** | `integrityHash` covers the immutable half only, so a superseded record still verifies — integrity checking must not fail exactly where history matters. `verify()` recomputes and raises `E_EVIDENCE_TAMPERED`; `verifyAll()` sweeps and reports every bad row rather than the first. `evidence-store.test.ts` → "integrity" (4 cases), including a row altered by direct SQL. |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names seven test areas. All seven exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Provenance chain | PASS | `evidence-store.test.ts` → "the provenance chain" (3 cases): backwards to the root observation, forwards for re-extraction, and termination on a loop |
| Evidence deduplication | PASS | `evidence-store.test.ts` → deduplication without rewriting; 10 concurrent writers produce one row |
| Stale evidence | PASS | `evidence-store.test.ts` → "staleness" (3 cases), including "unknown rather than fresh" when there is no hash to compare |
| Conflicting evidence | PASS | `evidence.test.ts` → "conflicting evidence" (7 cases); `evidence-store.test.ts` → two sources disagreeing, both retained |
| Missing source | PASS | `evidence.test.ts` → a record with no source system is refused; a derivation from non-existent evidence is refused by the foreign key |
| Tampered content hash | PASS | `evidence-store.test.ts` → "detects a row altered outside Ferret" (`E_EVIDENCE_TAMPERED`) |
| Permission filtering | PASS | `evidence-store.test.ts` → "permission filtering" (4 cases) |

### Coverage beyond the required list

- **Model output is never conflated with observation** — `generated` is a
  distinct method and is not a direct observation, so evidence of what a model
  said cannot be mistaken for evidence of what is true.
- **Forwards traversal** — `dependentsOf` finds everything downstream of an
  observation, which is what a re-extraction needs when a parser version turns
  out to be wrong.
- **Cycle termination** — a deliberately looped chain is walked with a depth
  limit rather than trusting the data.
- **Conflict resolution says "cannot choose"** rather than picking arbitrarily,
  because an arbitrary pick is indistinguishable from a considered one by the
  time it reaches an answer.
- **Concurrency** — 10 simultaneous identical observations produce one row; a
  provenance chain written from six concurrent roots is intact.
- **Durability** — cascade on subject deletion; survival of every connection
  being terminated.

---

## 3. Security

EPIC-008 states the requirement directly: *credentials and secrets are never
stored as evidence content merely because they were encountered.* Ferret indexes
configuration files, environment dumps and logs, so it **will** encounter them.

Evidence content passes through Ferret's existing redaction before it is hashed
or stored, and the record notes that masking occurred. The fact survives, the
secret does not — recording that a token was present at line 42, masked, is more
useful than recording nothing and far more useful than recording the token.

| Concern | Handling |
| --- | --- |
| Credential in source content | Masked before storage. Asserted at the database row, not just the return value. |
| Credential as an identity key | The masked form is what identity is derived from, so a secret is never part of a key either. |
| Rejected values in errors | Never echoed — evidence content may be the very secret this module guards. |
| Permission-scoped content | Filtered at the point evidence is read, not after an answer is assembled. Governance §12 requires authorization before protected information enters retrieval results. |
| Tampering | Detectable after the fact by integrity hash. |
| Dangling provenance | Refused by a foreign key. A chain that leads nowhere looks like an explanation and is worse than none. |

### A redaction gap this Epic found and closed

An evidence test expected `DATABASE_PASSWORD=hunter2` to be masked and got the
real value back. The pattern was anchored on `\b(password|…)`, and **`\b` does
not match after an underscore** — so `DATABASE_PASSWORD=`, `PG_PASSWORD=`,
`GITHUB_TOKEN=` and `FERRET_DATABASE_PASSWORD=` all passed through unredacted.

Those are precisely the shapes secrets take in the environment Ferret runs in,
and the gap affected **logs, errors and configuration output too**, since they all
redact through the same function. Fixed by allowing a `[A-Za-z0-9_]*` prefix
while still requiring the name to be followed immediately by `=`, so
`MY_TOKENIZER=lexer` and `keyword=search` are left alone. Six regression cases
added to `redact.test.ts`.

---

## 4. Performance

Indexing a file produces evidence per extracted fact, so per-record cost is
multiplied by the size of a corpus.

| Measurement | Budget |
| --- | --- |
| Record one observation (p95 of 40) | 250 ms |
| Read a subject's evidence (p95 of 30) | 150 ms |
| Subject lookup uses its index | asserted via `EXPLAIN` |

---

## 5. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Evidence schema documented | **PASS** | `src/storage/schema/evidence.ts` and migration `0004`, with the append-only split explained inline; `docs/Architecture/EPIC-008-DECISIONS.md`. |
| Provenance invariants documented | **PASS** | Content immutable, interpretation mutable; a derived fact must cite its sources; citations must exist. Each asserted. |
| Queryable | **PASS** | `forSubject`, `provenanceOf`, `dependentsOf`, `conflictsFor`, `stateOf`, `verify`, `verifyAll`, with field, state and permission filters. |
| Tested | **PASS** | 37 unit + 30 integration cases. Total suite: 712 passing, 3 skipped. |
| Consumed by downstream retrieval contracts | **PARTIAL — see limitations** | The contracts EPIC-008 must satisfy exist and are exercised: permission-scoped reads (EPIC-058's requirement), provenance traversal (EPIC-048's requirement) and conflict reporting (EPIC-047's). No retrieval layer exists yet to consume them, so this is demonstrated against the interface rather than against a consumer. |

---

## 6. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| No retrieval layer consumes evidence yet. The contracts are exercised directly. | The Definition of Done's last item is demonstrated against the interface, not against a consumer. Recorded as PARTIAL rather than claimed. | **EPIC-048**, **EPIC-052**–**EPIC-058** |

| Authority is stored as an integer with no policy behind it. | Two sources both claiming authority 0 are indistinguishable, so `preferredEvidence` correctly reports it cannot choose. | **EPIC-045** — Source Authority |
| Confidence is stored but never computed. | A provider must supply it, and most will not, so most evidence has unknown confidence — reported honestly rather than defaulted. | **EPIC-046** — Confidence & Completeness |
| Conflicts are detected, never resolved, and no state transition marks a record `conflicting`. | `conflictsFor` reports disagreement on demand; nothing writes the `conflicting` state yet. | **EPIC-047** — Conflict Detection |
| Permission scopes are an opaque string with no model behind them. | The filter works; deciding which scopes a caller holds is not EPIC-008's. | **EPIC-058**, **EPIC-083** |
| Staleness must be checked by a caller supplying the current source hash. | Nothing sweeps for stale evidence automatically. | **EPIC-078** — Periodic Reconciliation |
| Secret detection is shape-based, not entropy-based. | A high-entropy credential in an unrecognised format would be stored. | **EPIC-082** — Secret Detection & Exclusion |
| ~~Evidence rows are never pruned.~~ **Closed 2026-09-02 by EPIC-088.** | An append-only store grows without bound. | **EPIC-088** — `ferret prune --evidence --superseded-older-than <days>`. Only `superseded` records qualify, only past an age the caller names, and only when no `current` record was derived from them — `evidence_derivation` cascades, so deleting a source would erase a live provenance chain. Current evidence and tombstones are never deleted. |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |

### Addendum — 2026-09-01

**The first limitation above now has a consumer.** EPIC-048 (Answer
Traceability) composes `EvidenceStore` into the MCP server and exposes
`ferret_why`; provenance traversal, authority and integrity are demonstrated
against a real index over real stdio rather than against the interface. See
[`EPIC-048-VALIDATION.md`](EPIC-048-VALIDATION.md) §3.

The row itself is **left exactly as written**. It was true when recorded, and
editing an assessment to match a later state would destroy the evidence that the
gap existed and was closed deliberately. Nothing else in this document is
changed by that Epic.

## Addendum — 2026-09-02, after EPIC-046

**The confidence limitation recorded above is closed in the part EPIC-046 owns.**
The table is left as written, for the reason EPIC-048's addendum gave: a record
that edited itself whenever a later Epic closed something would stop being
evidence of anything.

`confidence` now has a named scale, a propagation rule through `derivedFrom` — a
conclusion is no more certain than what it rests on — and one real producer: the
Git provider emits `RULE_CONFIDENCE[MAILMAP]` on the evidence it records when
`.mailmap` rewrote an address.

The decision worth knowing is a negative one. **Confidence is not derived from
`method`**, because EPIC-045's authority table already is, and a second number
keyed on the same input would restate it on a different scale. Confidence comes
from the specific rule that produced a statement — a distinction already
load-bearing, since `SAME_ADDRESS` and `SAME_NAME_AND_LOCAL_PART` are both
`inferred` and 0.45 apart.

So **most evidence remains unassessed, and that is the correct outcome** rather
than a shortfall: Git observation has no rule and needs none. The Epics that will
populate the field are the inferring ones — EPIC-035, EPIC-047, EPIC-051 — and
all three are unbuilt.

Evidence: `validation/EPIC-046-VALIDATION.md`.
