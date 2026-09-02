# EPIC-012 — Validation Evidence

**Epic:** EPIC-012 — Provider SDK
**Branch:** `feat/epic-012-provider-sdk`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

> **Specification note.** EPIC-012 had no specification file — the registry
> approved the capability by name, domain and priority. The specification was
> written first, to the approved standard, from the registry entry and
> Governance §4, §5, §13 and §20, and is part of this change. **The acceptance
> criteria validated below are therefore ones this work authored**, which is
> worth stating plainly. The specification is in the diff for review.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | `BaseProvider` gives lifecycle for free, and `initialize` runs its work exactly once under concurrent calls | **PASS** | `concurrency.test.ts` → "initializes exactly once when several callers race" — 32 racing callers, one `onInitialize`. |
| AC-2 | `shutdown` is idempotent, tolerates never having been initialized, and waits for an in-flight `initialize` rather than leaking what it created | **PASS** | "shuts down exactly once when several callers race"; `provider-sdk.test.ts` → "tolerates a shutdown it was never initialized for"; "does not leak what initialization created when shutdown races it" asserts `leaked === []`. |
| AC-3 | A failed `initialize` is a classified `FerretError` and may be retried | **PASS** | "preserves a classified initialization failure instead of relabelling it"; "can be initialized again after a failure"; "gives every racing caller the same failure, and stays retryable". |
| AC-4 | Emission attaches provider attribution so a provider cannot omit it | **PASS** | "attaches producer and version to every piece of evidence"; "fills in the source system a provider would otherwise repeat"; "fills in the source system on relationships too". |
| AC-5 | An emission batch is idempotent | **PASS** | "collapses a fact emitted twice into one record"; `concurrency.test.ts` → "deduplicates correctly when producers interleave" (1,500 emissions → 500 entities, 1,000 duplicates). |
| AC-6 | Cancellation helpers add no listener and no timer that outlives their work | **PASS** | "leaks no listener across many derived signals" (50,000); "leaks no listener across many deadlines" (20,000); "leaves no timer behind when a delay is cancelled" (5,000, counted through `process.getActiveResourcesInfo`). |
| AC-7 | Retry honours `retryable`, never retries a non-retryable error, and stops immediately when aborted | **PASS** | "never retries an error the taxonomy says is not worth retrying"; "stops immediately when cancelled mid-backoff"; "abandons every in-flight retry the moment the runtime stops" — 500 retries × 30 s backoff, under 10 s. |
| AC-8 | The rate limiter never exceeds its rate, serves waiters in order, and an aborted waiter does not stall the ones behind it | **PASS** | "never exceeds its rate, however many callers arrive at once"; "serves waiters in arrival order" (strict FIFO over 40); "does not stall the queue when the waiter at its head gives up"; "does not starve an expensive request behind a stream of cheap ones". |
| AC-9 | A foreign cursor is refused, and a malformed one is refused clearly rather than crashing | **PASS** | 14 cursor cases, including foreign provider, foreign capability, oversized, non-base64url, prototype-polluting and over-nested. |
| AC-10 | Test doubles are importable from a published subpath and suffice to test a provider with no live upstream | **PASS** | `package.json` exports `./testing`; `packaging.test.ts` verifies the shipped tree; every SDK test uses them and nothing else. |

**10 / 10 PASS.**

---

## 2. Test requirements

| Required test | Status | Location |
| --- | --- | --- |
| Unit — every helper's contract and failure modes | PASS | `tests/unit/provider-sdk.test.ts`, 79 cases |
| Concurrency — init, shutdown, the race between them, limiter contention, aborted waiters | PASS | `tests/integration/provider-sdk/concurrency.test.ts`, 7 + 7 cases |
| Durability — listener and timer leaks at scale | PASS | 4 cases, 50,000 / 20,000 / 5,000 iterations |
| Reliability — convergence under a flapping dependency, and giving up on a dead one | PASS | 4 cases |
| Performance — emission, cursor round trip, uncontended acquisition | PASS | 3 cases, §6 |
| Security — hostile cursors, redaction of emitted content and of retry logging | PASS | §5 |
| Architecture — the SDK depends on the contract, never on an implementation | PASS | `boundaries.test.ts` → "provider SDK boundary", 4 cases |

`npm run verify` — **947 passed, 3 skipped** across 39 files against a live
PostgreSQL 17 + pgvector, zero unhandled errors. `npm audit` — **0
vulnerabilities**.

---

## 3. Defects this Epic's tests caught

### 3.1 A pool leak in the storage provider, closed by adopting `BaseProvider`

The hand-written `PostgresStorageProvider.shutdown()` read `#pool`, found it
`undefined`, and returned. That is correct for a provider that was never
started — and a **leak** when a shutdown arrived while `initialize` was still
connecting: it closed nothing, and the pool created a moment later was never
closed by anyone. The process would hold PostgreSQL connections open until it
exited.

This is the failure mode AC-2 describes, found in the one provider that already
existed rather than in a hypothetical one. `BaseProvider` waits for the in-flight
initialization before tearing down, which closes the race for every provider at
once, and "does not leak what initialization created when shutdown races it"
asserts it.

### 3.2 An unclassified throw escaping `encodeCursor`

A cyclic position or a `BigInt` makes `JSON.stringify` throw a bare `TypeError`,
which escaped from a function whose entire contract is "a classified Ferret error
or it worked". Now `E_USAGE` with remediation.

### 3.3 The retry logger printed its operation name unredacted

`retry` logs its operation name on **every attempt** — the highest-frequency log
line in the module. The name is chosen by the provider author, and the natural
way to choose it is from whatever is being called, which for an HTTP provider is
a URL that may carry userinfo credentials in its authority component.

The production logger redacts on the way out, so this was not exploitable through
Ferret's own logging path. It was still wrong: EPIC-012 §11 states the guarantee
as the module's own, and a guarantee that silently depends on a downstream layer
is one nobody will notice breaking. Now redacted at the source, asserted with a
logger that deliberately does not redact.

---

## 4. Concurrency and thread safety

Node runs one thread, so "concurrent" here means interleaved across `await`
points. That is enough to produce every defect below, and all of them are
reachable from ordinary composition-root code or from a signal arriving at an
inconvenient moment.

| Property | How it is proven |
| --- | --- |
| Initialization runs exactly once | 32 callers released simultaneously from a barrier; `initializeCalls === 1` |
| A failed initialization is not cached as a permanent failure | 16 racing callers all receive the error; state returns to `created`; a later attempt succeeds |
| Shutdown never leaks what initialization was creating | Shutdown issued while `onInitialize` is blocked on a barrier; every opened handle is closed |
| Shutdown runs exactly once | 32 racing callers; `shutdownCalls === 1` |
| Interleaved starts and stops leave no half-state | 25 rounds × 8 interleaved init/shutdown pairs; always `stopped`, never leaked |
| Rate limiting is FIFO | 40 concurrent acquisitions complete in arrival order exactly |
| An abandoned waiter does not stall the queue | The head aborts; those behind it complete within a bounded time |
| An abandoned waiter costs no budget | 20 abandoned + 5 surviving; `granted === 6` |
| No starvation of an expensive request | A cost-8 request completes with 200 cost-1 requests behind it |
| Every waiter's abort listener is detached | Listener count on a shared signal returns to baseline after 200 grants and after 50 cancellations |

---

## 5. Security

| Concern | Handling |
| --- | --- |
| **Cursors are untrusted input.** They round-trip through an AI client over MCP and come back attacker-influenceable. | Length-capped at 4 KiB *before* decoding; alphabet-validated before parsing; parsed inside a guard; envelope checked before contents; contents only through the caller's validator. Bound to the issuing provider and capability, so one provider's cursor cannot silently resume another's enumeration. |
| Prototype pollution through a decoded position | `__proto__`, `constructor` and `prototype` are refused anywhere in the decoded value, walked to a bounded depth so the guard is not itself a denial of service. |
| Echoing a hostile cursor's contents into a log | Rejections never include the cursor. It came from outside, and is a fine place to hide a value that should not reach a log. Asserted. |
| A credential in emitted content | Emission passes through EPIC-008's redaction; `DATABASE_PASSWORD=…` in observed file content is masked and the record is flagged `redacted`. Asserted. |
| A credential in a retry log line | §3.3. |
| The SDK widening a provider's reach | It reads no `process.env`, constructs no logger and opens no connection; `boundaries.test.ts` proves it adds no dependency beyond the core set. |

---

## 6. Performance

Budgets are set to catch an order-of-magnitude regression, not to police CI
weather. Observed figures are from a Windows development machine; the CI Linux
runner is faster.

| Measurement | Observed | Budget |
| --- | --- | --- |
| 10,000 entities each with evidence — 20,000 validations, 40,000 SHA-256 digests | ~430 ms | 20 s |
| 100,000 cursor encode + decode round trips | ~290 ms | 5 s |
| 100,000 uncontended token acquisitions | ~18 ms | 5 s |

The cursor figure is the one worth holding: the security validation added in §5
walks the decoded value, and it would be easy to make that walk something large.

---

## 7. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| The SDK is implemented and exported | **PASS** | `src/providers/sdk/`, exported from the package root; test doubles under `./testing`. |
| The storage provider is expressed through `BaseProvider` with no behavioural change | **PASS** | `PostgresStorageProvider extends BaseProvider`; every pre-existing storage test passes unmodified against a live database. It is not *quite* "no change" — §3.1 fixes a leak — which is recorded rather than glossed. |
| Concurrency, durability, reliability and performance suites pass | **PASS** | §2, §4, §6. |
| Test doubles are published and used by the SDK's own tests | **PASS** | `package.json` exports; every SDK test imports them. |
| Validation evidence records every criterion | **PASS** | This document. |

---

## 8. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Per-capability method signatures are still not pinned.** EPIC-011's checkpoint expected this Epic to do it; the specification §8 explains why it does not. Four of the eight capabilities have no consumer closer than EPIC-024, and the other four belong to the Epics that must live with the shape. | A provider author knows the operation protocol — context, page, cursor, emission, retry — but writes their capability's own interface. That is the smaller commitment and the one that can be made honestly today. | **EPIC-017/018/019/022** and each consuming Epic |
| The rate limiter is per-provider and in-process. Two Ferret processes against the same rate-limited API will each honour the limit, and together exceed it. | Correct for the single-process case Ferret is today. A shared budget needs coordination the storage layer could provide but nothing yet asks for. | ~~EPIC-032~~ **EPIC-078** — see Owner correction |
| No circuit breaker. Retry backs off within one operation; a dependency that is down stays hammered by every *new* operation. | Retry alone is the right primitive for one operation. Suppressing work across operations is a scheduling decision, not a provider one. | ~~EPIC-032~~ **EPIC-078** — see Owner correction |
| `paginate` holds every cursor it has seen to detect a provider that does not advance. | Bounded by page count, not by item count, so an enumeration of a million items across a thousand pages holds a thousand short strings. Acceptable; worth revisiting only if a provider paginates at item granularity. | — |
| Emission is synchronous and in-memory; a `BatchEmitter` grows without bound. | A provider that walks a million files and never flushes will exhaust memory. Flush policy is the indexing pipeline's decision, not the emitter's. | **EPIC-031** |
| The deadline in `ProviderOperationContext` is advisory: nothing forces a provider to consult it. | It is carried so a provider *can* plan. Enforcement is the `AbortSignal`, which is not advisory. | **EPIC-016** (conformance) |
| ~~macOS unvalidated.~~ **Measured 2026-09-03 by EPIC-105:** macOS passes — 112 test files and 2 463 tests on `macos-latest`, including the packaging suite and all seven signal tests. The database suites skip there (no Linux containers), so PostgreSQL behaviour stays validated on Linux only. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |

---

## Owner correction — 2026-09-02

**Rows above whose Owner read `EPIC-032` have had that owner struck.** The
limitations themselves are unchanged and still true; only the assignment was
wrong, and it is struck rather than overwritten so the original claim stays
readable.

EPIC-032 — Index Lifecycle & Tombstones — is VALIDATED, and its scope never
covered any of this. Its §4 (Non-scope) says so directly: "**Scheduled or
unattended indexing.** Not this Epic and not this registry entry; EPIC-075/076
own synchronization." Nine rows across four validation documents were parked on
it anyway, and EPIC-076 added one more while assigning the file tree back to
EPIC-032 — two closed Epics pointing at each other over live work.

This is the class of defect EPIC-076 named and did not have scope to fix:
"Nothing sweeps limitation tables for records the code has outgrown, so the next
stale one will also wait for an Epic to be pointed at it."

**Nothing was absorbed into EPIC-032.** Each row was re-read and given the owner
its own recorded reasoning implies, and where that reasoning does not determine
one, it says `unassigned` rather than guessing:

| row | new owner | why |
| --- | --- | --- |
| rate limiter is per-process | **EPIC-078** | the row's own parenthetical read "EPIC-032 *(scheduling)*" — it was naming the scheduling Epic by the wrong number, and Periodic Reconciliation is that Epic |
| no circuit breaker | **EPIC-078** | "Suppressing work across operations is a scheduling decision, not a provider one" — which also rules out EPIC-014 |
| no incremental repository discovery | **EPIC-077** | "It needs a filesystem watcher", and Event & Webhook Ingestion is where event-driven sources belong |
| indexing is sequential, no back-pressure | **EPIC-078** | "Parallelism across repositories is a scheduling decision" |
| offset paging is O(offset) | *none — accepted* | the row's own Impact settles it: "The read that matters for a running Ferret is the incremental one (`since`)." An accepted cost, not parked work |
| a failed run repeats rather than resumes | *none — accepted* | "Deliberate: resuming from a position never reached would leave a permanent gap." A design decision, recorded as one |
| a merge commit's changes are absent | **unassigned** | "choosing which is a modelling decision" — commit modelling is EPIC-020, which is closed, so this is a new criterion and needs governance |
| the file tree is read in full every run | **unassigned** | EPIC-076 assigned it here; EPIC-032's non-scope assigns synchronization to EPIC-075/076. Both are closed and neither claims it |
| no untracked working-directory state | **unassigned** | "'What am I working on right now' is a different read." No Epic in the registry covers it |

The three `unassigned` rows are tracked in
[#117](https://github.com/indoulia/Ferret/issues/117). They are **not** new P0
scope: no P0 acceptance criterion depends on any of them, which is why they were
parked rather than built.
