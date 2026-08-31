# EPIC-044 — Evidence Store · EPIC-045 — Source Authority

**Status: VALIDATED | Priority: P0 (both)** — [evidence](validation/EPIC-044-045-VALIDATION.md)

> **Specification note.** Two registry entries, one document: EPIC-045 is the
> policy over a field EPIC-044 stores, and `evidence.ts` already carries the
> comment "EPIC-045 owns the policy" against it. Authored from the approved
> registry entries and Governance §6, §7, §15 and §22.
>
> **EPIC-044 is an audit.** Its implementation was built as the storage half of
> EPIC-008 and has never been assessed against its own acceptance criteria. This
> specification states those criteria and the validation document records the
> result. Governance is explicit that an Epic is not DONE on code existence
> alone; it is equally explicit about the smallest correct change, so where the
> audit finds the requirement met, nothing is rewritten to claim credit.

## 1. Objective

**EPIC-044:** hold every observation immutably, with its provenance, and let it
be read back by subject, by state and by lineage.
**EPIC-045:** decide which source wins when two disagree.

## 2. Value

EPIC-008 modelled evidence and EPIC-002's storage layer persisted it, so
EPIC-044's capability substantially exists. What has never happened is checking
it against the criteria the registry approved — and an Epic marked complete on
the strength of "there is code in that file" is exactly what Governance §9
forbids.

EPIC-045 is a genuine gap, and a sharp one. `authority` is on every evidence
record, `preferredEvidence` ranks by it first, and **nothing ever sets it**: the
schema defaults it to `0`, so every source in Ferret is equally authoritative
and the ranking silently falls through to confidence. Two sources disagreeing
about the same fact — a stale README saying one thing and the code saying
another — are today resolved by whichever happens to have a confidence number.

The policy is what makes "considered authoritative" in Governance §18 mean
anything.

## 3. Scope

**EPIC-044 — audit:**

- assess the existing store against the acceptance criteria below;
- record the result, including anything not met, as validation evidence;
- fix only what the audit finds missing.

**EPIC-045 — implement:**

- a provider-neutral `SourceAuthority` scale, as named ranks rather than
  magic numbers;
- `authorityFor(method, options)`, deriving a default rank from how evidence was
  obtained;
- a source-system override, so a provider that knows it is the system of record
  can say so;
- application at emission, so evidence carries a real rank rather than zero;
- an explicit "unknown" rank that is distinct from "lowest".

## 4. Non-scope

- freshness and staleness ranking — EPIC-057;
- acting on a detected conflict — EPIC-047;
- permission-aware filtering — EPIC-058;
- retrieval ranking — EPIC-056. This supplies the signal; that Epic weighs it.
- rewriting the evidence store. The audit fixes gaps, not style.

## 5. Inputs

- EPIC-008's evidence model, including `authority`, `method` and `sourceSystem`;
- EPIC-002's storage layer;
- the existing `preferredEvidence` ranking.

## 6. Outputs

- validation evidence for EPIC-044, mapping each criterion to a test;
- `SourceAuthority`, the named scale;
- `authorityFor(method, options)`;
- `AUTHORITY_BY_METHOD`, the default mapping, as data.

## 7. Dependencies

EPIC-002, EPIC-006, EPIC-008.

## 8. Contracts

### Authority is a property of *how*, not *who*

The default rank comes from the evidence method: something read directly
outranks something parsed, which outranks something inferred, which outranks
something a model generated. A source system may raise its own rank when it is
the system of record for a fact — Jira is authoritative about a Jira issue's
status and nothing else is — but it may not raise the rank of a *guess*.

### Unknown is not lowest

A source whose authority nobody has decided is `UNKNOWN`, which is distinct from
`ASSERTED`. Ranking an unassessed source below a known-weak one is a claim, and
Governance §6 forbids manufacturing it.

### The scale is coarse and named

Five ranks with names, spaced so a later insertion does not require renumbering.
A continuous score invites tuning, and a tuned authority number is
indistinguishable from a fudge once it reaches an answer.

### Equal authority stays equal

`preferredEvidence` already returns `undefined` when nothing distinguishes two
candidates. Introducing real ranks must not change that: a genuine tie is still
"cannot say", and the honest answer is a reported conflict.

## 9. Acceptance criteria

**EPIC-044 (audit):**

- **AC-1** An observation is immutable once recorded; there is no update path.
- **AC-2** Recording the same observation twice deduplicates rather than
  accumulating, and says which happened.
- **AC-3** A different producer or producer version is a different observation.
- **AC-4** Evidence is readable by subject, filtered by field and state.
- **AC-5** Lineage is traversable in both directions, bounded.
- **AC-6** Superseding and staleness are recorded without deleting anything.
- **AC-7** Integrity is verifiable, and tampering is detected.
- **AC-8** Conflicting evidence about one fact is reportable.

**EPIC-045 (implement):**

- **AC-9** Each evidence method maps to a documented default rank.
- **AC-10** A source system may override upward for facts it owns, and may not
  raise an inferred or generated observation above its method's ceiling.
- **AC-11** `UNKNOWN` is distinct from the lowest known rank.
- **AC-12** With real ranks, `preferredEvidence` prefers the higher authority,
  and still returns nothing for a genuine tie.

## 10. Test requirements

- for EPIC-044, map every criterion to an existing test, and write one where
  none exists;
- for EPIC-045, one test per method mapping; an override raising and an override
  refused; unknown versus lowest; and a `preferredEvidence` case that changes
  outcome because of authority, plus a tie that still returns nothing.

## 11. Security requirements

Authority must never be derived from repository content: a file claiming to be
authoritative is a claim by an untrusted source, and Governance §12 makes
repository content data rather than policy. The override is keyed on the
*provider*, which is registered, trusted code.

Authority governs which answer is preferred; it never governs whether evidence
may be *seen*. That is EPIC-058 and EPIC-083, and conflating the two would let a
low-authority source become invisible rather than merely outranked.

## 12. Observability

Evidence already records its method, producer and producer version. With a real
rank stored alongside, "why did Ferret prefer this answer" is answerable from
the record: the rank, the method it came from, and whether an override applied.

## 13. Performance constraints

`authorityFor` is a table lookup. No query changes; the rank is already a stored
column and already the first sort key.

## 14. Definition of Done

EPIC-044: an audit recorded against every criterion, with any gap fixed and
named. EPIC-045: implementation, unit tests, exports, and validation evidence.
No conflict resolution, freshness ranking or permission filtering is claimed.

## 15. Governance alignment

- **§6 Evidence Before Inference** — unknown authority stays unknown; a tie
  stays a tie.
- **§7 Source Authority** — the governance section this Epic exists to satisfy.
- **§15 Data Integrity** — nothing is discarded on the strength of a rank.
- **§22 Change Management** — the audit stays within EPIC-044's approved
  capability and changes only what it finds missing.
