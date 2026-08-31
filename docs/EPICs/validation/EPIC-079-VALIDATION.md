# EPIC-079 — Retry & Backoff: validation evidence

**Status: VALIDATED** · no new dependency, no second retry mechanism. Two
SQLSTATEs, one error code, one wrapper around EPIC-012's `retry`.

## What the Epic does

Classifies the two errors PostgreSQL documents as retryable — `40001`
serialization_failure and `40P01` deadlock_detected — as `E_STORAGE_CONFLICT`
with `retryable: true`, and retries the *transaction* that hit them.

EPIC-012 built `retry` and its header stated the design: *"the hard half is
deciding whether an error is worth retrying at all … EPIC-009 already classifies
every error Ferret raises, so the answer exists; this module's job is to use it."*
The answer did not exist and nothing called `retry`. This Epic supplies the
classification and is its first production caller.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 `40001` and `40P01` are retryable `STORAGE_CONFLICT`, naming the SQLSTATE | PASS | `tests/unit/conflict-retry.test.ts` — both codes, `retryable: true`, `details.sqlstate` present |
| AC-2 non-transient codes keep their classification and stay non-retryable | PASS | `42501`, `28P01`, `3D000` asserted unchanged |
| AC-3 a conflicting operation is retried and succeeds | PASS | `retries a conflict and returns the eventual success` — fails twice, commits on the third |
| AC-4 a retry wraps the transaction | PASS | `calls the operation again from the beginning` — the operation is a function that opens its own transaction, and is re-entered rather than resumed |
| AC-5 retries are bounded and the last error is reported | PASS | `gives up after a bounded number of attempts` — exactly `CONFLICT_MAX_ATTEMPTS` |
| AC-6 a non-transient failure is not retried | PASS | one attempt for a permission error, and one for a dropped connection |
| AC-7 cancellation stops a retry immediately | PASS | one attempt, no backoff waited |
| AC-8 concurrent upserts of one entity all succeed, leaving one row | PASS | `tests/integration/storage/concurrency.test.ts` — 16 writers × 5 rounds against real PostgreSQL; 80 contended writes, none failing, one row each round. Note this passed **before** the fix too: see "What this fixes, and what it does not" |
| AC-9 no second retry mechanism | PASS | `withConflictRetry` delegates to `providers/sdk/retry.js`; the only additions are a predicate and a policy |

## What this fixes, and what it does not

**Fixed: two genuinely missing classifications.** `40001` and `40P01` were absent
from `SQLSTATE`, so a conflict PostgreSQL documents as retryable arrived with
`retryable` unset and failed its caller. That was real, and it is now classified,
retried and tested.

**Not fixed, and not claimed: the intermittent CI failure of issues #21 and
#55.** The first draft of this document said it was. It is not, and the
correction is worth recording because the reasoning that produced the wrong claim
was plausible.

The CI failure looked exactly like a row conflict: eight concurrent upserts of
one entity id, `classifyDatabaseError` falling through to its generic branch,
green on rerun. Missing conflict codes were an obvious cause and turned out to be
a real defect — but a different one.

Measured rather than assumed: **480 contended upserts across 30 rounds of 16
concurrent writers, in isolation, produced zero failures** — before the fix as
well as after. The failure reproduces only under full-suite load, which points at
connection-pool exhaustion or a statement timeout rather than at a row conflict.
The test pool is deliberately `max: 3`.

The stack from the failing run confirms the retry ran and rethrew, so the wiring
works and the error simply is not one of the codes this Epic classified.

**What changed as a result:** an unclassified database error now names its
SQLSTATE in the message, not only in `details`. A test runner printing an error
does not show `details`, which is why diagnosing this took a round trip the code
could have saved. The next occurrence will identify itself.

Issue #55 has been updated with the measurement, so the next person to look at it
starts from evidence rather than from this Epic's first guess.

## Decisions worth review

**`23505` unique_violation is deliberately excluded.** Under `ON CONFLICT` it
means a genuine concurrent insert and is retryable; outside it, the caller wrote
something that violates a constraint and retrying is a loop. Ferret cannot tell
which from the SQLSTATE alone, and guessing in the retryable direction turns a
bug into a hang. Excluded until a call site needs it and can say which it is.

**The predicate is narrower than `error.retryable`.** `retry` defaults to
Ferret's general retryable flag, which includes a dropped connection. That is
correctly retryable in general and wrong here: the pool has already lost the
session the transaction lived in, so re-running it retries against a connection
that is gone. Reconnection is the pool's job. Asserted directly.

**The backoff is short.** 5 ms initial, 250 ms ceiling, 5 attempts, full jitter.
A row conflict clears when the winning transaction commits — milliseconds — so a
backoff measured in seconds would be waiting for something that already happened,
and a large attempt count would hide contention an operator should see.

**`STORAGE_CONFLICT` is its own error code, not `STORAGE_UNAVAILABLE`.** The
database is entirely available. A log line saying "PostgreSQL is unavailable" for
a contended row sends an operator to look at the wrong thing. Its exit code is
the dependency class, because the remedy — reduce concurrency, or try again — is
the same shape as a server that is busy.

**Cancellation surfaces the operation's own error**, not a generic
`E_INTERRUPTED`. `retry` rethrows what actually failed when the signal is
aborted, which is the more useful of the two: an operator sees the conflict that
was in progress rather than only that someone pressed Ctrl-C. Asserted so the
choice is recorded rather than rediscovered.

## Limitations

- **Only `EntityStore.upsert` is wrapped.** It is the contended path — one row
  per entity, written by every stage of every run. The relationship, evidence and symbol stores use the same
  classifier and will raise a retryable `STORAGE_CONFLICT`, but nothing retries
  for them yet. They should be wrapped when a call site shows contention, rather
  than pre-emptively.
- **A retry is invisible to the caller's counters.** An `upsert` that succeeded
  on the third attempt reports the same outcome as one that succeeded on the
  first. The attempts are logged at `debug` by `retry`, which satisfies §12, but
  `IndexReport` carries no retry count. Worth adding when someone needs to see
  contention rising over a run rather than in a log.
- **Nothing bounds total time across retries.** Five attempts with a 250 ms
  ceiling bounds it in practice to well under two seconds, but the bound is a
  consequence of the numbers rather than an enforced budget.

## Test inventory

| Suite | Cases | What it proves |
| --- | --- | --- |
| `tests/unit/conflict-retry.test.ts` | 16 | The classification in both directions, and the retry policy |
| `tests/integration/storage/concurrency.test.ts` | 1 added | 80 contended writes against real PostgreSQL, none failing |
