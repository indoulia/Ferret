# EPIC-079 — Retry & Backoff

**Status: APPROVED | Priority: P0 | Domain: Synchronization & Reconciliation**

> **Specification note.** Prompted by an intermittent CI failure and written
> before that failure was measured. The measurement (§2) showed the missing
> classifications this Epic fixes are **not** its cause; issues #21 and #55 stay
> open. The Epic is worth doing regardless, and the wrong first inference is left
> in the record rather than edited out. The registry approved this Epic by name,
> domain and priority before this specification existed.

## 1. Objective

Make a transient failure cost a retry instead of a run: classify the errors
PostgreSQL says are retryable, and retry them where retrying is correct.

## 2. Value

`src/providers/sdk/retry.ts` was built by EPIC-012, is validated, and **nothing
calls it.** Its own header states the design: *"the hard half is deciding whether
an error is worth retrying at all … EPIC-009 already classifies every error
Ferret raises, so the answer exists; this module's job is to use it."*

The answer does not exist. `SQLSTATE` in `src/storage/connection.ts` enumerates
eleven codes — privileges, credentials, missing objects, shutdown, connection
loss — and not one transient conflict. Missing:

| code | meaning | PostgreSQL's guidance |
| --- | --- | --- |
| `40001` | serialization_failure | retry the transaction |
| `40P01` | deadlock_detected | retry the transaction |

`classifyDatabaseError` falls through to its generic branch, so both arrive as a
`FerretError` with `retryable` unset. A conflict that would have succeeded on a
second attempt fails the caller instead.

**A correction, recorded because the specification was written before the
measurement.** This Epic was prompted by an intermittent CI failure, and the
missing codes looked like its cause. They are not: 480 contended upserts in
isolation produce zero failures, before and after the fix, and the failure
reproduces only under full-suite load. The missing classifications are a real
defect worth fixing on their own merits — an indexing run over a large repository
contends thousands of times — but issues #21 and #55 stay open. §14 no longer
claims to close them.

The failure that prompted this, kept because it is what a caller sees when a
conflict is unclassified:

```
FAIL tests/integration/storage/concurrency.test.ts
  > keeps the last writer's content when several update the same entity at once
FerretError: PostgreSQL operation "storage.entity.upsert" failed
  ❯ classifyDatabaseError src/storage/connection.ts:259:10
```

Eight concurrent upserts of one entity id. Green on rerun, green locally, and —
as it turned out — green in isolation at sixty times the concurrency. What it
demonstrates is the shape of the problem this Epic does fix: a database error
arriving with `retryable` unset, from a generic branch, with no SQLSTATE in the
message to say what it was.

## 3. Scope

1. **Classify transient conflicts.** `40001` and `40P01` become known SQLSTATEs,
   raised as a retryable error with their own error code.
2. **Retry where a retry is correct** — around the whole transaction in
   `EntityStore.upsert` and the other transactional stores, never inside it.
3. **A bounded, jittered policy** with a stated ceiling, using the existing
   `retry()` rather than a second mechanism.
4. **Observability**: a retried operation says it retried, how often, and why.

## 4. Non-scope

- **A second retry implementation.** EPIC-012 built one; this Epic is its first
  caller.
- **Retrying anything that is not transient.** A permission error, a missing
  table, an invalid credential: retrying those hammers a system that will never
  say yes and looks to an operator like a hang rather than a denial.
- **Provider-level retry policy** — EPIC-093 owns provider failure isolation.
- **Changing isolation levels or the upsert's SQL.** The conflict is expected and
  correct; what is wrong is the response to it.
- **`23505` unique_violation.** It can mean a genuine concurrent insert *or* a
  real constraint violation, and the two want different answers. Recorded in §8.2
  as a deliberate exclusion rather than an oversight.

## 5. Inputs

- EPIC-012 `retry`, `nextDelayMs`, `RetryOptions`, `abortableDelay`.
- EPIC-002 `classifyDatabaseError`, `SQLSTATE`, the transactional stores.
- EPIC-009 the error taxonomy and `FerretError.retryable`.

## 6. Outputs

- `SQLSTATE.SERIALIZATION_FAILURE`, `SQLSTATE.DEADLOCK_DETECTED`.
- `ErrorCode.STORAGE_CONFLICT`, raised retryable.
- A storage retry policy, applied at the transaction boundary.

## 7. Dependencies

**Hard** — EPIC-002 (VALIDATED, the store and the classifier), EPIC-012
(VALIDATED, the retry primitive), EPIC-009 (VALIDATED, the taxonomy).

## 8. Contracts

### 8.1 A retry wraps the transaction, never a statement inside it

A serialization failure aborts the whole transaction: every statement after it
fails with `25P02`. Retrying the failing statement in place retries inside a
transaction that can no longer commit, so the retry cannot succeed and the error
an operator sees is the wrong one. The unit of retry is the unit of atomicity.

### 8.2 `23505` is deliberately excluded

Under `ON CONFLICT DO UPDATE` a unique violation means a genuine concurrent
insert and is retryable. Outside it, it means the caller wrote something that
violates a constraint, and retrying is a loop. Ferret cannot tell which from the
SQLSTATE alone, and guessing in the retryable direction turns a bug into a hang.
Excluded until a call site needs it and can say which it is.

### 8.3 Retrying is reported, never silent

A retried operation logs at `debug` per attempt and the outcome carries the
attempt count. An operation that succeeded on the fourth try is healthy in one
sense and a symptom in another, and an operator who cannot see it cannot tell
that contention is rising.

## 9. Acceptance criteria

- **AC-1** `40001` and `40P01` are classified as `STORAGE_CONFLICT` with
  `retryable: true`, naming the SQLSTATE in the details.
- **AC-2** Codes that are not transient keep their current classification and
  stay non-retryable — asserted for privileges, credentials and missing objects.
- **AC-3** A transactional store operation that fails with a transient conflict
  is retried and succeeds, without the caller seeing an error.
- **AC-4** A retry wraps the transaction: the retried attempt opens a new one.
- **AC-5** Retries are bounded; an operation that keeps conflicting fails with
  the last error and reports the attempts it made.
- **AC-6** A non-transient failure is not retried, and fails on the first
  attempt.
- **AC-7** Cancellation stops a retry immediately, without waiting out a backoff.
- **AC-8** Eight concurrent upserts of one entity id all succeed, leaving one row
  whose content is one writer's — run enough times to be evidence rather than
  luck.
- **AC-9** No second retry mechanism is introduced: the storage path calls
  EPIC-012's `retry`.

## 10. Test requirements

- **Unit:** the classifier over each SQLSTATE, transient and not; the policy's
  bound and jitter; cancellation mid-backoff.
- **Integration against real PostgreSQL:** concurrent upserts of one entity id,
  repeated; a deliberately deadlocked pair; a non-transient failure that is not
  retried.
- **Contention at scale:** the `concurrency.test.ts` case, run repeatedly in one
  test so a pass is evidence rather than a coin toss. Not a regression test for
  #21 — see §2.

## 11. Security requirements

- A retry must not re-send a credential to a system that rejected it: an
  authentication failure is non-retryable and stays so.
- Backoff is bounded, so a failing dependency cannot be turned into an
  amplification of Ferret's own traffic.
- The retry log carries the SQLSTATE and the operation, never the parameters —
  the failing query's parameters are indexed content.

## 12. Observability

- Per attempt: operation, attempt number, delay, SQLSTATE, at `debug`.
- Per operation: total attempts, when more than one.

## 13. Performance constraints

- The uncontended path pays one function call and no allocation beyond it.
- Backoff is bounded so a pathological contention cannot extend a run without
  limit; the ceiling is stated and asserted.

## 14. Definition of Done

- Every acceptance criterion satisfied, integration ones against real PostgreSQL.
- `npm run verify` green on the merge result.
- An unclassified database error names its SQLSTATE, so the next one is
  diagnosable without a round trip.
- Issues #55 and #21 updated with what was measured — **not** closed by this
  Epic; see the correction in §2.
- A validation document at `docs/EPICs/validation/EPIC-079-VALIDATION.md`.

## 15. Governance alignment

- **§13 Reliability** — a transient failure costs a retry, not a run.
- **§5 Reuse Before Reinvent** — EPIC-012's retry is called, not re-implemented.
- **§6 Evidence Before Inference** — a retried operation says so; a bounded
  failure reports what it tried.
