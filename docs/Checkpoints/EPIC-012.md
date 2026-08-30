# Development Checkpoint — EPIC-012

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-012 — Provider SDK (P0, Provider Platform)

**Objective:** The shared machinery every provider needs, so writing a provider
is mostly writing the part that is genuinely specific to the system behind it.

**Branch:** `feat/epic-012-provider-sdk`, cut from `main` at `66f044a`.

**Epic status:** VALIDATED — 10/10 acceptance criteria PASS. Evidence in
[`docs/EPICs/validation/EPIC-012-VALIDATION.md`](../EPICs/validation/EPIC-012-VALIDATION.md).

---

## Completed

- **`BaseProvider`** — lifecycle implemented once, correct under concurrent
  initialization, concurrent shutdown, and the race between them.
- **Emission** — `Emitter` and `BatchEmitter`, attaching source system, producer
  and producer version by construction; the batch deduplicates by canonical id.
- **Cancellation** — `linkSignals`, `withDeadline`, `abortableDelay`,
  `throwIfAborted`. Everything derived is `Disposable`, and disposing removes
  what it added.
- **Retry** — abortable backoff with full jitter, driven by `FerretError.retryable`
  rather than by guesswork, honouring an upstream `retryAfterMs`.
- **Rate limiting** — a fair token bucket built from a provider's declared
  `rateLimitPerMinute`; strict FIFO, and an aborted waiter neither stalls the
  queue nor costs budget.
- **Pagination** — `Page`, `PageRequest`, `paginate`, and a cursor protocol that
  treats a returning token as untrusted input.
- **Test doubles** — published at `@indoulia/ferret/testing`.
- **The storage provider adopts `BaseProvider`**, which closed a real pool leak.

## Files

```text
docs/EPICs/EPIC-012-Provider-SDK.md          the specification, written to the standard
src/providers/sdk/base.ts                    lifecycle
src/providers/sdk/cancellation.ts            derived signals, deadlines, abortable sleep
src/providers/sdk/emit.ts                    Emitter, BatchEmitter
src/providers/sdk/operation.ts               operation context, pages, cursors
src/providers/sdk/rate-limit.ts              fair token bucket
src/providers/sdk/retry.ts                   backoff policy
src/providers/sdk/testing.ts                 test doubles (published subpath)
src/providers/sdk/index.ts

tests/unit/provider-sdk.test.ts                        79 cases
tests/integration/provider-sdk/concurrency.test.ts     25 cases
```

Modified: `src/providers/index.ts`, `src/index.ts` (SDK exports),
`src/errors/codes.ts` (`E_CURSOR_INVALID`), `src/cli/exit-codes.ts`,
`src/storage/provider.ts` (extends `BaseProvider`),
`tests/unit/boundaries.test.ts` (SDK boundary), `package.json` (`./testing`).

## Tests

`npm run verify` — **947 passed, 3 skipped** across 39 files against a live
PostgreSQL 17 + pgvector, zero unhandled errors. `npm audit` — **0
vulnerabilities**.

## The defects these tests caught

1. **A pool leak in the storage provider.** Its hand-written `shutdown` read
   `#pool`, found it undefined and returned — correct for a provider that was
   never started, and a leak when a shutdown arrived mid-connect. Closed by
   `BaseProvider`, which waits for the in-flight initialization.
2. **`encodeCursor` let a `TypeError` escape** for a cyclic or `BigInt` position.
   Now `E_USAGE`.
3. **`retry` logged its operation name unredacted**, on every attempt — and that
   name is naturally built from the thing being called.

## Notes for whoever picks this up

- **Extend `BaseProvider`; override `onInitialize` / `onShutdown`.** Do not
  implement `initialize` or `shutdown` yourself. Four correctness properties come
  for free and none of them is obvious.
- **Emit through an `Emitter`, never through `createEntity` directly.** The
  attribution is the point. A provider that emits without a `producerVersion`
  makes Governance §21's central question unanswerable months later.
- **Cursors are bound to the provider and capability that issued them.** Use
  `encodeCursor`/`decodeCursor` rather than JSON — the binding is what stops one
  provider resuming another's enumeration at nonsense.
- **Every derived signal must be disposed.** `using derived = linkSignals(...)`
  is the shortest correct form.
- **Retry decides from `FerretError.retryable`.** If a provider's errors are not
  classified, retry cannot help it — classify them at the provider boundary.
- **Method signatures per capability are still not pinned**, deliberately. See
  the specification §8 and the decisions record D2.

## Blockers

None.

## Known limitations

Full table in the validation evidence §8. Carried forward:

- Per-capability method signatures not pinned → **EPIC-017/018/019/022**
- The rate limiter is per-process; two Ferrets together can exceed a shared
  limit → **EPIC-032**
- No circuit breaker across operations → **EPIC-032**
- `BatchEmitter` grows without bound; flush policy belongs to the pipeline →
  **EPIC-031**
- The operation deadline is advisory; only the signal is enforced → **EPIC-016**
- macOS unvalidated → **EPIC-105**

## Next step

**EPIC-017 — Local Repository Discovery**, taking the critical path to a usable
release rather than strict registry order, as the delivery brief directs
(build the first complete vertical slice as soon as the dependency chain
permits).

EPIC-017 is the first *real* provider, and it is what turns the last two Epics
from contracts into something demonstrable: it declares `source.repository`,
extends `BaseProvider`, emits repository entities through an `Emitter`, and pins
the `source.repository` interface that EPIC-011 and EPIC-012 both deliberately
left open. It also brings the first subprocess execution into the product, so
Governance §12's rule against unsafe subprocess primitives becomes load-bearing —
`execFile` with an argument vector, never a shell.

Then **EPIC-018** (branch and worktree discovery), **EPIC-019/020** (history),
**EPIC-022/023** (files), and the slice reaches storage.

**EPIC-013** (Registry & Discovery), **EPIC-014** (Lifecycle & Health),
**EPIC-015** (Configuration & Secrets) and **EPIC-016** (Conformance Testing)
remain open and are better taken once two real providers exist — EPIC-016 in
particular is untestable in any meaningful sense before then, which is why
EPIC-011 recorded two of its own test areas as NOT APPLICABLE and pointed here.
