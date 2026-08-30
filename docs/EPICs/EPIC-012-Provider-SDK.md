# EPIC-012 — Provider SDK

**Status: APPROVED | Priority: P0**

> **Specification note.** The Epic registry (v3.0) approved this capability by
> name, domain and priority. This specification elaborates it to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry, `docs/Governance/README.md` §4, §5, §13 and §20, and the
> contracts EPIC-001 through EPIC-011 already publish. It introduces no
> capability the registry did not approve.

## 1. Objective

Give provider authors the shared machinery every provider needs — lifecycle,
emission, cancellation, retry, rate limiting, pagination and test doubles — so
that writing a provider is mostly writing the part that is genuinely specific to
the system behind it.

## 2. Value

EPIC-011 said *what* a provider must offer. It did not make offering it easy, and
the gap is where correctness quietly goes.

Every provider Ferret will ship — Git, GitHub, Jira, Confluence, an embedding
service, a parser — needs the same six things, and each of them is easy to get
subtly wrong:

| Need | The way it goes wrong when each provider does it alone |
| --- | --- |
| Lifecycle | Double initialization; a `shutdown` that races an in-flight `initialize` and leaks the resources it created; a failed init that can never be retried |
| Emission | A provider that forgets `producerVersion`, making "re-extract everything the old parser touched" unanswerable (Governance §21) |
| Cancellation | A listener added to a long-lived signal per unit of work, never removed — a warning at 11, unbounded memory at a million files |
| Retry | Retrying a permission error forever; a backoff with no jitter synchronising every worker onto the same instant |
| Rate limiting | A queue that loses a token when a waiter aborts, stalling every request behind it |
| Pagination | A cursor from one provider fed to another, silently resuming at nonsense |

None of these is interesting work, all of it is load-bearing, and a bug in any of
them appears as *"indexing sometimes hangs"* rather than as itself. Doing it once
and testing it hard is worth more than doing it six times.

The SDK is also what makes **EPIC-016 (Provider Conformance Testing)** tractable:
a conformance suite can only assert invariants that providers have a common way
of satisfying.

## 3. Scope

- **`BaseProvider`** — the lifecycle half of the provider contract, implemented
  once, correct under concurrent initialization and shutdown.
- **Emission helpers** — building canonical entities, relationships and evidence
  with provider attribution attached automatically, and a batch that deduplicates.
- **Cancellation** — deriving, linking and disposing `AbortSignal`s without
  leaking listeners or timers.
- **Retry** — an abortable backoff policy that decides retryability from
  Ferret's error taxonomy rather than guessing.
- **Rate limiting** — a fair token bucket honouring a provider's declared
  `rateLimitPerMinute`.
- **Pagination** — the cursor protocol every paged capability shares, with
  cursors treated as untrusted input.
- **Test doubles** — a provider context, a recording emitter and a controllable
  stub provider, published so an out-of-tree provider author can test without a
  live upstream.

## 4. Non-scope

- **Per-capability method signatures.** See §8; they belong to the Epic that
  first needs each capability.
- Concrete providers — EPIC-017, EPIC-021, EPIC-071.
- Discovery from installed packages — EPIC-013.
- Provider configuration and secrets — EPIC-015.
- The conformance suite itself — EPIC-016.
- Work scheduling, queueing and parallelism across providers — EPIC-032.

## 5. Inputs

- EPIC-001 `Provider`, `ProviderContext`, `ProviderRegistry`.
- EPIC-011 `Capability`, `CapabilityDeclaration`, `CapabilityLimits`.
- EPIC-006–008 canonical entities, relationships and evidence — what a provider
  emits.
- EPIC-009 `FerretError`, its codes and its `retryable` flag.
- Node 22 `AbortSignal.any`, `AbortSignal.timeout`, `timers/promises`.

## 6. Outputs

- `src/providers/sdk/` — the SDK, exported from the package root.
- `@indoulia/ferret/testing` — the test doubles, as a package subpath so an
  out-of-tree provider can import them without reaching into `dist`.

## 7. Dependencies

EPIC-001, EPIC-006, EPIC-007, EPIC-008, EPIC-009, EPIC-011. No new external
dependency (see §15).

## 8. Contracts

### The shared operation protocol

Every capability operation that reaches an external system takes a
`ProviderOperationContext` — a logger, an `AbortSignal`, and an optional
deadline — and every paged one returns a `Page<T>` carrying an opaque cursor.
Fixing this shape now is what lets a caller cancel, time-bound and resume any
provider operation without knowing which capability it belongs to.

### Why per-capability signatures are still not pinned

EPIC-011's checkpoint anticipated that this Epic would pin the method signature
of each of the eight capabilities. **It deliberately does not**, and the reason is
worth recording rather than leaving as a silent omission.

Four of the eight — `parser`, `embedding`, `mcp`, `source.project` — have no
consumer closer than EPIC-024, and a signature written now would be written
against an imagined requirement. The other four would be written against a real
one, but that requirement belongs to EPIC-017/018/019/022, which are the Epics
that must live with the shape.

What is genuinely shared — the operation context, the page, the cursor, emission,
cancellation, retry — *is* pinned here. Each capability's own interface is
defined by the Epic that first implements it, on top of this protocol. That is
the smaller commitment, and Governance §2 prefers it.

### Cursors are untrusted input

A cursor round-trips through an AI client over MCP, which means it is
attacker-influenceable by the time it comes back. It is therefore:

- bound to the provider and capability that issued it, so one provider's cursor
  cannot resume another's enumeration;
- length-capped and character-validated before it is decoded;
- decoded as JSON only, with no prototype-polluting key accepted;
- shape-validated after decoding, never trusted for its contents.

## 9. Acceptance criteria

- **AC-1** A provider extending `BaseProvider` gets lifecycle for free, and
  `initialize` runs its work exactly once under concurrent calls.
- **AC-2** `shutdown` is idempotent, tolerates never having been initialized, and
  when it races an in-flight `initialize` it waits rather than leaking what
  initialization created.
- **AC-3** A failed `initialize` is reported as a classified `FerretError` and
  may be retried.
- **AC-4** Emission helpers attach provider attribution — system, producer,
  producer version — so a provider cannot omit them.
- **AC-5** An emission batch is idempotent: emitting the same entity twice
  collapses to one.
- **AC-6** Cancellation helpers add no listener and no timer that outlives the
  work they were created for.
- **AC-7** Retry honours Ferret's `retryable` classification, never retries a
  non-retryable error, and stops immediately when aborted.
- **AC-8** The rate limiter never exceeds its declared rate, serves waiters in
  order, and an aborted waiter does not stall the ones behind it.
- **AC-9** A cursor issued by one provider is refused by another, and a malformed
  cursor is refused with a clear error rather than a decode crash.
- **AC-10** Test doubles are importable from a published subpath and are
  sufficient to test a provider with no live upstream.

## 10. Test requirements

- **Unit:** every helper's contract, including its failure modes.
- **Concurrency:** concurrent `initialize`; concurrent `shutdown`; `shutdown`
  racing `initialize`; concurrent rate-limiter acquisition; aborting a queued
  waiter; interleaved retry attempts.
- **Durability:** no listener leak across a large number of derived signals; no
  timer leak across a large number of aborted delays; the process is able to exit
  after cancellation.
- **Reliability:** retry converges under a flapping dependency; the limiter makes
  progress under sustained contention with no starvation.
- **Performance:** emission and cursor encoding are on the ingestion hot path and
  are held to a regression ceiling.
- **Security:** an oversized, malformed, foreign or prototype-polluting cursor is
  refused; emitted evidence carrying a secret-shaped value is redacted.
- **Architecture:** the SDK depends on the contract, never on a concrete provider.

## 11. Security requirements

- Cursors are untrusted input and are validated as §8 describes.
- Emission passes through EPIC-008's redaction, so a provider that encounters a
  credential in source content cannot store it merely by emitting it.
- The SDK gives a provider no capability it did not already have: it reads no
  `process.env`, constructs no logger and opens no connection.
- Retry never logs the value that failed, only its classification — a retried
  request may carry a credential in its arguments.

## 12. Observability

- Every retry attempt is logged at `debug` with attempt number, delay and the
  error's code; the final failure at `warn` with the attempt count.
- Rate-limiter waiting time is logged when it exceeds a threshold, because a
  provider silently waiting is indistinguishable from a hang.
- Lifecycle transitions are logged with the provider's id.

## 13. Performance constraints

| Operation | Ceiling |
| --- | --- |
| Emitting an entity with evidence | 10,000 in 2 s |
| Cursor encode + decode round trip | 100,000 in 1 s |
| Acquiring an uncontended rate-limit token | 100,000 in 1 s |

## 14. Definition of Done

- The SDK is implemented, exported, and the storage provider is expressed through
  `BaseProvider` with no behavioural change.
- Concurrency, durability, reliability and performance suites all pass.
- Test doubles are published under a package subpath and used by the SDK's own
  tests, proving they are sufficient.
- Validation evidence records every criterion with a named artefact.

## 15. Reuse decision (Governance §5)

Governance §5 and the delivery brief both forbid reinventing retry mechanisms, so
the decision is recorded rather than assumed.

**Reused:** Node 22's `AbortSignal.any`, `AbortSignal.timeout` and
`timers/promises.setTimeout({ signal })` — the abort composition and the
cancellable sleep are the parts a library would otherwise supply, and the
platform now supplies them correctly.

**Not adopted:** a general retry package (`p-retry`, `async-retry`). The hard
part of retrying is deciding *whether an error is worth retrying*, and that
decision is specific to Ferret's error taxonomy — a generic library must be told
the answer through a predicate, which is the entire remaining surface. Adopting
one would add a dependency to gain a backoff formula while leaving the part that
actually matters unchanged. The policy here is roughly sixty lines on top of
platform primitives, and it is tested against the failure modes §10 names.

## 16. Governance alignment

- **§2 Simplicity** — pin what is shared; leave what is not to the Epic that
  knows.
- **§4 Provider-First** — the SDK depends on the contract, never the reverse.
- **§5 Reuse** — §15.
- **§6 Evidence** — attribution is attached by construction, not by discipline.
- **§10 Idempotent ingestion** — an emission batch deduplicates.
- **§12 Security** — cursors and emitted content are untrusted.
- **§13 Reliability** — retry, rate limiting and cancellation are the mechanisms
  by which a flaky upstream degrades instead of breaking.
- **§20 Observability** — waiting and retrying are visible.
- **§21 Versioning** — a provider cannot emit without stating its version.
