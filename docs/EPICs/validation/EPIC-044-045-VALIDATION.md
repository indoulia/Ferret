# EPIC-044 — Evidence Store · EPIC-045 — Source Authority: validation evidence

**Status: VALIDATED (both)** · EPIC-044 by audit, with no code change.
EPIC-045 implemented: a named authority scale, a method mapping, and
application at emission.

## EPIC-044 — the audit

Its implementation was built as the storage half of EPIC-008 and had never been
assessed against its own criteria. Governance §7 requires the smallest correct
change, so nothing was rewritten to claim credit; the criteria were stated and
checked, and the result is recorded here.

All rows are `tests/integration/domain/evidence-store.test.ts` against real
PostgreSQL — 30 tests, all passing — or `tests/unit/evidence.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 immutable once recorded | PASS | `EvidenceStore` exposes `record`, `supersede` and `markStale` and **no update path**; the module comment states the reason — Governance §6 forbids silently rewriting source evidence, and a store that *can* update cannot promise it |
| AC-2 deduplicates and says which | PASS | `record` returns `deduplicated`, covered by the store suite's idempotency cases |
| AC-3 a different producer version is different evidence | PASS | identity covers producer and producer version, which is what makes "re-extract everything the old parser touched" answerable |
| AC-4 readable by subject, field and state | PASS | `forSubject(subjectId, query)` with `field`, `state` and `limit` |
| AC-5 lineage traversable both ways, bounded | PASS | `provenanceOf(id, maxDepth)` and `dependentsOf(id, maxDepth)`, each depth-bounded |
| AC-6 supersede and stale retain | PASS | `supersede` and `markStale` set state; neither deletes |
| AC-7 integrity verifiable, tampering detected | PASS | `verify(id)` and `verifyAll(subjectId)` returning `{ checked, tampered }` |
| AC-8 conflicts reportable | PASS | `conflictsFor(subjectId)`, over `detectConflicts` |

**No gap found, and nothing changed.** The capability the registry approved is
present and tested. What was missing was the record saying so.

## EPIC-045 — the gap, and what it was

`authority` has been on every evidence record since EPIC-008, and
`preferredEvidence` sorts by it **first**. Nothing ever set it: the schema
defaulted it to `0`, so every source in Ferret was equally authoritative and the
comparison never discriminated — resolution silently fell through to confidence,
which most evidence does not carry either.

The field, the sort and the comment "EPIC-045 owns the policy" were all in
place. The policy was not.

All rows are `tests/unit/source-authority.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-9 each method maps to a documented rank | PASS | six mappings in a table; `covers every method the model defines` iterates `EvidenceMethod` itself, so a method added without a rank fails; `orders read above parsed above derived above asserted` |
| AC-10 override up for owned facts, never for a guess | PASS | `promotes what the provider actually read`; `refuses to promote %s` over all four non-direct methods |
| AC-11 unknown is distinct from lowest | PASS | `is distinct from the lowest known rank`; `is what an unrecognised method gets` |
| AC-12 preference changes, ties still tie | PASS | `prefers the higher authority`; `still returns nothing for a genuine tie`; three `emission applies the policy` tests |

## Design decisions worth recording

**Authority is a property of *how*, not *who*.** The default rank comes from the
evidence method: read directly outranks parsed, which outranks worked-out, which
outranks a model's output. A provider cannot promote a guess by declaring itself
important — `refuses to promote %s` covers all four non-direct methods, and the
promotable set is exactly `observed` and `parsed`.

**`GENERATED` ranks with `ASSERTED`.** EPIC-008 separated the methods so a
model's output would never be conflated with an observation; this is the same
rule expressed as a rank, rather than a new judgement.

**Unknown is not lowest.** `UNKNOWN` is the lowest *number* and deliberately not
the lowest *meaning*: it says "unassessed" where `ASSERTED` says "assessed, and
weak". `isUnknownAuthority` is how a caller tells them apart, because ranking an
unassessed source below a known-weak one is a claim Governance §6 forbids
manufacturing. An unrecognised method gets `UNKNOWN` for the same reason.

**Five named ranks, spaced by twenty.** A later rank can be inserted without
renumbering anything already stored, and there is a test asserting the gaps. A
continuous score invites tuning, and a tuned authority number is
indistinguishable from a fudge by the time it reaches an answer.

**The override is keyed on the provider, never on content.** A file claiming to
be authoritative is a claim by an untrusted source; Governance §12 makes
repository content data rather than policy. `systemOfRecord` is declared by
registered, trusted code in its `EmissionIdentity`.

**A caller-supplied authority is kept.** The emitter fills in a rank only when
one was not given, so a provider that has already decided is not overruled.

## Limitations

- **No provider declares `systemOfRecord` yet.** The mechanism exists and the
  Git provider does not use it, so Git evidence currently ranks `OBSERVED`
  rather than `SYSTEM_OF_RECORD`. That is the honest default — it is not obvious
  that Git is the system of record for everything it reports — and turning it on
  is a per-provider judgement rather than a blanket one.
- **Already-indexed evidence keeps authority 0.** Nothing back-fills, so a
  database written before this change has records that still tie. Re-indexing
  fixes it; there is no migration.
- **No per-fact ownership.** `systemOfRecord` is per provider, not per field.
  Jira is authoritative about an issue's status and not about the code it
  mentions, and the model cannot yet express that distinction.
- **Freshness is not in the ordering.** `preferredEvidence` breaks an authority
  tie with confidence and then recency, and a highly authoritative stale record
  still beats a fresh weak one. That is EPIC-057.
- **The ranks are a considered starting set, not a measured one.** They were
  chosen from the method semantics EPIC-008 already defined; nothing has
  validated them against retrieval quality, which is EPIC-098's shape of
  problem.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 38 files, 1094 passed.
`vitest run tests/integration/domain/evidence-store.test.ts`: 30 passed, real
PostgreSQL.

## Addendum — 2026-09-02, after EPIC-057

**The "Freshness is not in the ordering" limitation is closed.** The paragraph
above is left as written, for the reason EPIC-048's addendum gave: a record that
edited itself whenever a later Epic closed something would stop being evidence of
anything.

It read: "`preferredEvidence` breaks an authority tie with confidence and then
recency, and a highly authoritative stale record still beats a fresh weak one.
That is EPIC-057." EPIC-057 §8.4 decided the policy that answers it, and did so
narrowly: **where two records share a `sourceSystem` and a `field`, the later
`observedAt` supersedes the earlier before authority is consulted.** Two
*different* systems disagreeing still tie on authority and still surface as a
conflict, because that is EPIC-047's question and not this one.

Two further things that Epic found in this one's territory, both recorded in
`validation/EPIC-057-VALIDATION.md`:

- **`preferredEvidence` sorted on the raw authority number**, so `UNKNOWN` ranked
  below `ASSERTED` — the opposite of what `SourceAuthority.UNKNOWN` in this
  Epic's own module has documented since it was written. EPIC-062 had already
  built `effectiveAuthority` for its own ordering and the two had never met; the
  helper now lives in `domain/authority.ts` and both use it.
- **`preferredEvidence` moved to `authority.ts`**, beside the scale it decides
  with. Same name, same export, no caller changed.

The other limitations above stand: nothing back-fills authority on an
already-indexed database, `systemOfRecord` is still per provider rather than per
field, and the ranks are still a considered starting set rather than a measured
one.
