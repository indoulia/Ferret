# EPIC-012 — Architecture Decisions

Decisions taken while building the Provider SDK, with the reasoning that
produced them. Recorded per Governance §22 so a later reader can tell a
considered choice from an accident.

---

## D1 — Build retry on platform primitives rather than adopt a retry package

**Context.** Governance §5 and the delivery brief both forbid reinventing retry
mechanisms. `p-retry` and `async-retry` are mature and widely used.

**Decision.** Reuse Node 22's `AbortSignal.any`, `AbortSignal.timeout` and
`timers/promises.setTimeout({ signal })`. Do not adopt a retry package.

**Why.** The backoff formula is the easy half, and the platform now supplies the
cancellable sleep that used to be a library's main contribution. The hard half is
deciding **whether an error is worth retrying**, and that decision is specific to
Ferret's error taxonomy — a general library must be told the answer through a
predicate, which is the entire remaining surface. Adopting one would add a
dependency to gain a formula while leaving the part that actually matters
unchanged.

The resulting policy is roughly sixty lines and is tested against the failure
modes that matter: a non-retryable error retried, a cancellation mistaken for a
transient failure, a synchronised retry storm, an upstream `Retry-After`
ignored.

**Consequence.** `boundaries.test.ts` asserts the SDK adds no dependency beyond
the core set, so a later reversal has to be deliberate rather than incidental.

---

## D2 — Do not pin per-capability method signatures yet

**Context.** EPIC-011's checkpoint anticipated this Epic pinning the interface of
each of the eight capabilities.

**Decision.** Pin the **shared operation protocol** — `ProviderOperationContext`,
`PageRequest`, `Page<T>`, the cursor encoding, emission, cancellation, retry —
and leave each capability's own interface to the Epic that first implements it.

**Why.** Four capabilities (`parser`, `embedding`, `mcp`, `source.project`) have
no consumer closer than EPIC-024; a signature written now would be written against
an imagined requirement. The other four *would* be written against a real
requirement — but that requirement belongs to EPIC-017/018/019/022, which are the
Epics that have to live with the shape.

Governance §2 prefers the smaller commitment. Reversing this decision costs
nothing: pinning a signature later is additive.

**Consequence.** A provider author gets the protocol from the SDK and writes their
capability's interface. The Epic that defines it records it in its own
specification.

---

## D3 — A cursor is untrusted input, and is bound to its issuer

**Context.** Cursors travel out to an AI client over MCP and come back later.

**Decision.** Encode `{ version, providerId, capability, position }`, base64url.
Validate length, alphabet, envelope and forbidden keys before the caller's
validator ever sees the position. Refuse a cursor issued by a different provider
or for a different capability.

**Why.** Two distinct failures, and the second is worse:

- **Denial of service.** Without a length bound, a client makes Ferret
  base64-decode and JSON-parse an arbitrarily large string on every request, at
  no cost to itself.
- **Silent wrong answers.** An unbound cursor handed to a different provider
  decodes cleanly into a position that means something else entirely, and the
  enumeration resumes at nonsense. Nothing throws. Governance §12 — content
  crossing a trust boundary is data, never policy.

**Alternatives considered.** Signing cursors with an HMAC would also detect
tampering, and was rejected: it needs a key, a key needs storage and rotation,
and the property that actually matters — *this cursor belongs to this
enumeration* — is delivered by binding without any of that. Revisit if a cursor
ever carries something whose integrity matters on its own.

---

## D4 — Fairness over throughput in the rate limiter

**Context.** A token bucket can serve whoever fits, or serve in arrival order.

**Decision.** Strict FIFO. A later, cheaper request never overtakes an earlier,
more expensive one, even when there are tokens for it right now.

**Why.** Overtaking is how a large request waits forever behind an endless stream
of small ones. It costs a little throughput at saturation and removes a
starvation bug that only appears under sustained load — which is when nobody is
watching, and when a stalled indexer is least likely to be diagnosed correctly.

**Consequence.** The `#drain` loop stops at the head rather than scanning for
something it can serve, and `acquire` takes the fast path only when nothing is
already waiting.

---

## D5 — An aborted waiter re-drains the queue

**Context.** A queued waiter whose caller gives up must be removed.

**Decision.** Removing it also re-runs the drain immediately.

**Why.** This is the defect the class exists to prevent. The tempting
implementation rejects the waiter and returns — leaving the drain timer scheduled
for a moment computed from a head that has since departed. Everything behind it
then waits for a timer set for someone else. It presents as an intermittent hang,
which is the hardest possible shape to diagnose.

The queue is a doubly-linked list rather than an array for the same reason:
removing from the middle of an array is O(n), which is quadratic exactly when a
shutdown cancels every queued request at once.

---

## D6 — A failed initialization resets rather than being remembered

**Context.** Making `initialize` run once under concurrent calls invites caching
the promise.

**Decision.** Cache the in-flight promise so racing callers join it; clear it
when it settles, and reset the provider to `created` when it rejects.

**Why.** A cached promise caches the *rejection* too. A provider that failed
because the database was briefly starting up could then never succeed again for
the life of the process — a restart-only failure produced by the fix for a
different bug. Asserted directly: after a failed race the provider is `created`,
and the next attempt runs.

---

## D7 — Shutdown waits for an in-flight initialization

**Context.** A signal can arrive while a provider is still connecting.

**Decision.** `shutdown` captures the in-flight `initialize` promise, awaits it
(swallowing its failure, which belongs to `initialize`'s caller), then runs
`onShutdown`.

**Why.** Tearing down first releases what does not exist yet and reports success,
while the resource created a moment later is never released by anyone. This was
not hypothetical: `PostgresStorageProvider.shutdown()` had exactly this shape, and
adopting `BaseProvider` fixed it — see the validation evidence §3.1.

---

## D8 — Test doubles ship, under their own subpath

**Context.** The point of a provider contract is that providers are written
elsewhere. Those providers need tests.

**Decision.** Publish `CapturingLogger`, `createTestProviderContext`,
`createTestOperationContext`, `StubProvider` and `createBarrier` under
`@indoulia/ferret/testing`, and assert by architecture test that they are **not**
reachable from the package root.

**Why.** Without them, an out-of-tree author's options are to point tests at a
live GitHub or to reconstruct a `ProviderContext` from its type definition.
Keeping them in `tests/` would help nobody outside this repository. Putting them
on the root export would put a stub provider and a capturing logger into every
production bundle.

---

## D9 — Redact the retry label at the source

**Context.** `retry` logs its operation name on every attempt.

**Decision.** Pass it through `redactString` before logging.

**Why.** The name is chosen by the provider author, and the natural way to choose
it is from whatever is being called — for an HTTP provider, a URL that may carry
userinfo credentials. The production logger already redacts on the way out, so
this was not exploitable through Ferret's own logging path. It was still wrong:
the Epic states the guarantee as this module's own, and a guarantee that silently
depends on a downstream layer is one nobody notices breaking. Defence in depth
costs one function call on a path that only runs on failure.
