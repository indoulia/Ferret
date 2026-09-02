# EPIC-047 — Conflict Detection

**Status: APPROVED | Priority: P1 | Domain: Evidence & Provenance**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Evidence & Provenance, where
> it has been named and prioritised since the registry was written; only the
> specification is new.

## 1. Objective

Make a conflict mean two sources disagreeing — recorded durably, cleared when it
ends, and never resolved by dropping a side.

## 2. Value — measured, on Ferret's own index

`EPIC-008`'s checkpoint recorded the gap: "Conflicts are detected but nothing
writes the `conflicting` state → **EPIC-047**". `EvidenceState.CONFLICTING`
exists, EPIC-062's believability ranks it at 10, migration 0004 indexes `state`
for it, and **nothing has ever written it** — so EPIC-062's
`candidate.state === EvidenceState.CONFLICTING` branch is unreachable and
EPIC-063 cannot report a conflict it was asked to explain.

Underneath that is a sharper defect, and it is measured rather than argued.
**Nothing calls `EvidenceStore.supersede`.** So when a field's value changes, the
old observation stays `current` beside the new one, and `detectConflicts` reads
the pair as a disagreement. On Ferret's own 597-file index:

```
conflict_groups | single_source_groups | cross_source_groups | records_involved
              2 |                    2 |                   0 |               22
```

Both groups are `branch.attributes.headCommit`, and the second has **twenty
current records** for one branch. A branch's head moves with every commit; each
observation is a new row, and none of the previous nineteen was ever superseded.
So `ferret_why` on `main` reports a twenty-way conflict about where `main`
points — and it is not a conflict at all. It is one source reporting a value that
changed, with nothing marking the earlier readings as past.

`observed_at` is `NULL` on all twenty, so EPIC-057 §8.4's supersession rule
cannot fire either: it needs an observation time, and Git's branch listing does
not supply one. `recorded_at` is `NOT NULL DEFAULT now()` and has always been
there.

## 3. Scope

- **A conflict is disagreement between *sources*.** One source restating a field
  is supersession, not a conflict — EPIC-057 §8.4's rule, applied to detection.
- **Supersession that actually happens**: recording a differing statement about
  the same subject, field and source system marks the prior current record
  superseded, in the transaction that records the new one.
- **`conflicting` written**, on every member of a genuine group, and **cleared**
  when the disagreement ends.
- **Reconciliation over the subjects an index run touched**, so the state is
  maintained rather than computed on demand by whoever remembers to ask.
- **No side dropped, ever** — Governance §15.

## 4. Non-scope

- **Choosing a winner.** `preferredEvidence` (EPIC-045/057) already answers
  "which should a caller believe" and returns `undefined` when it cannot say.
  Marking a conflict is not resolving one, and §8.5 records why the two must stay
  apart.
- **Computing confidence — EPIC-046.** A low-confidence record that disagrees is
  still a conflict.
- **Ranking — EPIC-056/057.** They read `state` through EPIC-062's believability;
  making it discriminate is this Epic's job.
- **Cross-session decision conflicts** — EPIC-042 §4 names this Epic for that;
  it is about engineering memory rather than evidence, needs session comparison
  this Epic does not build, and §16 raises it.
- **Detecting a conflict between two *entities*** — EPIC-051's cross-source
  entity resolution.
- **A new table or migration.** `state`, `superseded_by` and `recorded_at` are
  all in 0004, and `evidence_state_idx` is already the index this needs.

## 5. Inputs

- `detectConflicts` and `ConflictGroup` (EPIC-008), unchanged in shape.
- `state`, `superseded_by`, `recorded_at`, `source_system`, `field` — all
  existing columns.
- The subjects an index run recorded evidence about.

## 6. Outputs

- `detectConflicts` distinguishes disagreement from restatement.
- `EvidenceStore.record` supersedes the prior current record.
- `EvidenceStore.reconcileConflicts(subjectId)` writes and clears `conflicting`.
- No schema change.

## 7. Dependencies

EPIC-008 (the states, the columns, the detector), EPIC-044 (the store),
EPIC-045/057 (the supersession rule this reuses), EPIC-062 (the consumer whose
branch is currently unreachable), EPIC-063 (the surface that will report it).

## 8. Contracts

### 8.1 A conflict is disagreement between sources

Two current records about the same subject and field, with different statements,
are a conflict **only if they come from different source systems**. Where they
share one, the later is the source's current position and the earlier is past —
which is precisely what EPIC-057 §8.4 decided for `preferredEvidence`, and this
is the same rule applied one layer down.

Keyed on `sourceSystem` and not on `producer`, exactly as EPIC-057 keyed it, so
the two cannot drift. The measured consequence: Ferret's own index goes from two
reported conflicts to **zero**, and both of the two were `headCommit` moving.

### 8.2 Supersession happens when the new record lands

`EvidenceStore.record` already runs in a transaction and already distinguishes a
genuine insert from a deduplicated one. On a genuine insert, any *other* record
with the same `subject_id`, `field` and `source_system` that is `current` **or
`conflicting`** is marked `superseded`, with `superseded_by` pointing at the new
record.

`conflicting` is included because it is a **sub-state of current**, not a sibling
— a conflicting record is still the source's present reading, with a flag on it.
§17 records what happens without that: a source that comes to agree leaves its
own disagreeing record marked `conflicting` for ever, and reconciliation can
never clear the group.

Three properties, each a decision:

- **In the same transaction.** Otherwise a reader between the two statements sees
  two current records and a conflict that never existed.
- **Only on a genuine insert.** A deduplicated record is the same content and the
  same id; superseding on a re-record would supersede a row with itself.
- **The content is never touched.** Only `state`, `superseded_by` and
  `last_checked_at` — the columns 0004's own comment reserves for "Ferret's
  interpretation". The observation stays verifiable, which is what lets "what did
  Ferret believe before, and why did that change" be answered.

Ordering is by *recording*, not observation. `observed_at` is optional and is
absent on exactly the records this defect appears on; `recorded_at` is
`NOT NULL`. "The later recording by the same source about the same field is
Ferret's current reading" is what `current` was always supposed to mean.

### 8.3 `conflicting` is written and cleared

`reconcileConflicts(subjectId)` runs detection over the subject's current records
and, in one transaction:

- marks every member of every genuine group `conflicting`;
- returns to `current` any record marked `conflicting` that is no longer in one.

**Both directions, and the reverse is the one that matters.** A state that is
only ever set accumulates false positives until an operator stops reading it —
EPIC-094 recorded exactly that failure ("584 of 585 indexed scopes were built by
a different Ferret" on a healthy index). A conflict that a later observation
settles must stop being reported.

`superseded` and `stale` are never overwritten. Reconciliation reads the
`current` and `conflicting` records only — the two states that describe a present
reading — and writes only between those two, so a record Ferret has already
judged past cannot be resurrected into a conflict.

### 8.4 Reconciliation is maintained, not asked for

An index run reconciles the subjects it recorded evidence about. `conflictsFor`
remains — computing on demand is still the right answer for a caller asking
about one subject — but the stored state no longer depends on somebody
remembering to call it, which is what made `conflicting` unreachable for five
Epics.

### 8.5 Marking is not resolving

Every member of a group is marked. No side is dropped, no winner is chosen, and
`preferredEvidence` is not consulted — Governance §15 forbids resolving a
conflict by discarding evidence, and §6 forbids manufacturing the certainty that
choosing would imply. A caller that needs one answer asks `preferredEvidence`,
which returns `undefined` when the candidates are genuinely indistinguishable.

The two must stay apart for a reason this Epic can state precisely: authority can
pick a winner between two sources that disagree, and a `conflicting` state that
the winner cleared would hide the disagreement from every other consumer —
including the operator who needs to know two systems are out of step.

## 9. Acceptance criteria

- **AC-1** Two current records from *different* source systems, same subject and
  field, different statements, are one conflict group.
- **AC-1a** Supersession applies to a `conflicting` record as well as a `current`
  one, so a source that comes to agree can clear the group it was in.
- **AC-2** Two current records from the *same* source system are **not** a
  conflict group.
- **AC-3** Recording a differing statement about the same subject, field and
  source system marks the prior current record `superseded` with
  `superseded_by` set to the new record.
- **AC-4** The superseded record's content and `integrity_hash` are unchanged and
  it still verifies.
- **AC-5** Re-recording an identical statement supersedes nothing.
- **AC-6** A record is never superseded by itself.
- **AC-7** Recording a differing statement from a *different* source system
  supersedes nothing.
- **AC-8** A branch whose head moves twenty times ends with one current record
  and nineteen superseded.
- **AC-9** `reconcileConflicts` marks every member of a genuine group
  `conflicting`.
- **AC-10** `reconcileConflicts` returns a record to `current` when the group it
  was in no longer exists.
- **AC-11** `reconcileConflicts` never changes a `superseded` or `stale` record.
- **AC-12** No record is deleted or excluded by any operation in this Epic.
- **AC-13** An index run leaves the subjects it touched with correct
  `conflicting` state, without a caller asking.
- **AC-14** On Ferret's own index, `conflictsFor` reports **zero** groups where it
  previously reported two.
- **AC-15** EPIC-062's `conflicting` branch is now reachable: an item whose
  subject has a genuine group reports the fact, and no record is excluded for
  being in one.

## 10. Test requirements

**Unit** — `detectConflicts` for AC-1, AC-2, and a three-source group where two
agree and one differs; the same-source group of twenty; a group where `field` is
absent.

**Integration (real PostgreSQL)** — AC-3 to AC-14 against a live store: the
supersession chain, the untouched integrity hash, the identical re-record, the
cross-source case, twenty moves of one branch, both directions of
reconciliation, and the two `superseded`/`stale` non-interference cases.

**Security** — reconciliation reads and writes only the subject it was given;
`permission_scope` is untouched, and a scoped record's statement is never read
into a comparison a caller did not authorize.

**Failure** — reconciliation of a subject with no evidence; a subject whose only
records are superseded; a transaction that fails mid-reconcile leaving no partial
state.

**Regression** — EPIC-008's, EPIC-044/045's and EPIC-062's suites unchanged.

## 11. Security requirements

`detectConflicts` compares *statements*, which are source content, so
reconciliation must never widen what a caller sees. It does not: it is a
maintenance operation over one subject's stored records, run by the indexer under
its own authority, and it writes only Ferret's interpretation columns. No
statement crosses a scope boundary because no statement is returned — the output
is a state, and `conflictsFor` continues to apply `permittedScopes` as it always
has.

## 12. Observability

The `conflicting` state itself, which EPIC-062 already cites in a reason string
and EPIC-063 already reports where recorded — both were waiting for something to
write it. An index run reports how many subjects it reconciled and how many
groups it found, beside the counts it already reports.

## 13. Performance constraints

Supersession is one indexed `UPDATE` per genuine insert, on
`(subject_id, field, source_system)` — covered by scanning the subject's rows,
which `forSubject` already does. Reconciliation is one read and at most two
updates per subject, over subjects an index run already touched.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 satisfied with evidence in
`validation/EPIC-047-VALIDATION.md`; unit, integration, security and failure
tests present and passing; `npm run verify` green; the measured before-and-after
figure on Ferret's own index recorded; the registry updated; EPIC-008's recorded
gap struck with a dated note rather than edited away.

## 15. Governance alignment

- **§15 Reliability** — "must not silently discard conflicting evidence". §8.5 is
  that rule as a contract: marking is not resolving.
- **§6 Evidence Before Inference** — §8.1 declines to call a changed value a
  disagreement, and §8.3 declines to leave a settled conflict reported.
- **§18 Provenance and Explainability** — "considered conflicting" is the last of
  the five verbs, and the only one EPIC-063 had to record as unserved.
- **§10 Time and History** — a superseded observation stays verifiable, so "what
  did Ferret believe before" remains answerable.
- **§5 Reuse Before Reinvent** — EPIC-057's supersession rule, EPIC-008's
  detector, 0004's columns and index. Nothing new is stored.

## 16. Raised, not absorbed

- **Cross-session decision conflicts** — EPIC-042 §4 names this Epic for them.
  They are about engineering memory rather than evidence and need session
  comparison nothing builds; not delivered here, and the registry does not
  determine an owner.
- **Ferret has one source provider, so a genuine conflict cannot yet occur.**
  AC-1 and AC-9 are proved by construction in tests, and AC-14's measured figure
  is a *reduction of false positives* rather than a demonstration of true ones.
  The first real cross-source conflict arrives with EPIC-021 or EPIC-071, and it
  will arrive into a mechanism that already works.
- **Git's branch listing supplies no `observed_at`.** That is why §8.2 orders by
  recording. If a provider later supplies observation times, the two orderings
  could disagree, and preferring the observed one would be a change to this
  contract rather than an improvement to be made quietly.
- **A superseded record's dependents are not revisited.** Evidence derived from a
  record that has since been superseded keeps its own state. EPIC-046's
  propagation runs at emission and does not re-run; re-deriving a chain is a
  capability no Epic owns.

## 17. Recorded during implementation

- **`conflicting` is a sub-state of `current`, not a sibling.** The first cut
  superseded only `current` records, so a source that came to agree left its own
  disagreeing record marked `conflicting` for ever and reconciliation could never
  clear the group. Anything acting on "the source's present position" must
  include `conflicting`. Caught by test, inside the Epic whose whole point is
  clearing.
- **Three fixtures were corrected and no criterion was changed.** EPIC-060's AC-7
  and AC-13 and EPIC-062's AC-9 built a dispute from two same-source records,
  which §8.1 makes a restatement. Both criteria say a disputed fact must be
  reported and neither says what makes one; the fixtures now use two source
  systems, which is what they meant.
