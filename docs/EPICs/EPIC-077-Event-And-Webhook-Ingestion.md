# EPIC-077 — Event & Webhook Ingestion

**Status: VALIDATED | Priority: P1 | Domain: Synchronization & Reconciliation**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Synchronization.

## 1. Objective

Let a change tell Ferret about itself — from a webhook or from a disk — so the
next read is targeted rather than a poll of everything.

## 2. Value

Ferret's synchronization is complete and entirely pull-based: EPIC-076 reads
incrementally, EPIC-078 reconciles periodically, EPIC-079 backs off. All three
answer *when should I look again?* with a schedule, and a schedule is a
compromise between staleness and traffic that is wrong in both directions most
of the time.

Four validation documents park the same limitation here in the same words:

> *"No incremental repository discovery: Ferret cannot say which repositories
> appeared since a given moment. It needs a filesystem watcher, and Event &
> Webhook Ingestion is where event-driven sources belong."*

A webhook and a filesystem watcher are the same thing seen twice: something
changed, here is roughly what. Both are handled by one shape.

## 3. Scope

- **`src/events/signature.ts`** — verifying a webhook came from who it says.
- **`src/events/normalize.ts`** — a payload as a change notification.
- **`src/events/deliveries.ts`** — a bounded ledger, so a redelivery is not a
  second write.
- **`src/events/watch.ts`** — a debounced filesystem watcher producing the same
  events.

## 4. Non-scope

- **Hosting an HTTP endpoint.** §8.1, and it is the largest decision here.
- **Ingesting a payload's contents.** §8.4.
- **Replacing reconciliation.** §8.6. A watcher is a hint; EPIC-078 is what is
  correct.
- **A durable delivery ledger.** §8.5 explains why in-memory is honest and what
  it does not guarantee.
- **Webhook registration.** Creating a webhook is a write, and EPIC-021 §8.2
  made this family of providers structurally read-only.
- **Retry of failed handling.** EPIC-079 owns backoff and a caller that failed
  to act on an event has a retry problem, not an ingestion problem.

## 5. Inputs

A raw request body, its headers, and a configured secret. Or a directory.

## 6. Outputs

`src/events/`, exported from the package root.

## 7. Dependencies

EPIC-080 (idempotent ingestion, which is what makes §8.5 safe), EPIC-078
(reconciliation, which is what makes §8.6 honest), EPIC-021/071 (the systems
that send the webhooks).

## 8. Contracts

### 8.1 Ferret does not host an HTTP endpoint

The tempting design is `ferret serve --webhooks`. It is wrong for this project.

An HTTP listener is a public network surface with its own TLS story, its own
process model, its own bind-address mistakes and its own dependency — a
framework here would be the largest package in the tree, for the part of the
problem Ferret is least suited to own. Every deployment that wants webhooks
already has something terminating HTTPS.

So Ferret supplies what only Ferret can: verification, normalization and
deduplication, as pure functions over bytes. The host calls them. This is the
same ports-and-adapters position the MCP server takes about transports and the
storage provider takes about connections, and `boundaries.test.ts` asserts that
`src/events/` adds no package at all.

### 8.2 Verification is the module, not a feature of it

A webhook payload is the most attacker-reachable input Ferret will ever have: it
arrives unsolicited, over the network, at an endpoint whose URL is frequently
discoverable. Everything else Ferret reads at least required somebody to have
write access to a repository.

- **The signature is over the raw body.** Not a parsed object, and the function
  cannot be called with one. `JSON.parse` followed by `JSON.stringify` preserves
  key order and destroys whitespace, and a digest over the reformatted bytes
  never matches — this is the failure every webhook integration has had, and
  taking `Uint8Array | string` is what makes it unavailable.
- **Comparison is `timingSafeEqual`**, with the length checked first because
  that function throws on a mismatch, and a thrown exception inside a verifier
  is a denial of service.
- **An unconfigured secret is a refusal, not a pass.** A deployment that forgot
  to set one would otherwise accept anything anyone sent it, and would look
  exactly like a working one.

### 8.3 A refusal says one thing, whatever went wrong

Four refusal reasons exist for a *log*. Exactly one sentence goes back to the
sender: *"The request signature could not be verified."*

A sender that could tell "no secret configured" from "wrong signature" learns
whether the endpoint is worth attacking; one that could tell "malformed" from
"mismatch" learns the format. Neither is information the legitimate sender
needs — it signed correctly or it did not — and this is EPIC-068's reasoning
about `NOT_PERMITTED` applied to an unauthenticated caller.

### 8.4 A webhook says *what changed*, not *what it now is*

Ferret does not ingest a payload's contents. A payload is a vendor's own JSON,
shaped for its own convenience, and modelling it would be a third extraction
path beside EPIC-021's records and EPIC-072's modelling — with the additional
property that its input is attacker-supplied rather than merely untrusted.

What a webhook is good for is a targeted re-read. A `SourceEvent` carries the
subject, the project, a reference and the vendor's own event name verbatim,
because `pull_request.closed` is what a person searches the vendor's
documentation for and a normalized rewording would be a vocabulary nobody else
uses.

An event Ferret declines and an event it does not recognise are **different
results**. A `star` changes nothing Ferret holds; reporting it as unparseable
would tell an operator there is a gap where there is a decision.

### 8.5 A redelivery is not a second write, and the ledger is honest about itself

A webhook is redelivered on any non-2xx and on a timeout the sender decided
about unilaterally. `DeliveryLedger` remembers ten thousand delivery ids, keyed
on the source system as well as the id — two systems' generators can collide.

**In memory, and bounded.** A durable ledger would be a table, and a table is
EPIC-075's cursor problem wearing a different hat. The *content* is already
idempotent by EPIC-080, so this saves work rather than guaranteeing correctness,
and saying so plainly is what stops somebody later relying on it for the
guarantee. A delivery redelivered after ten thousand others is one the sender
gave up on hours ago; re-admitting it costs one redundant read.

### 8.6 A watcher is a hint, and reconciliation is the truth

`fs.watch` drops events under load, reports different things on every platform,
and says nothing at all about what happened while the process was not running.

So the watcher emits the same `SourceEvent` a webhook does — *something here
changed, go and look* — and EPIC-078's periodic reconciliation remains what is
actually correct. A watcher trusted instead of reconciliation would be a cache
with no invalidation.

**Debounced per root.** A `git clone` produces thousands of events over several
seconds; one event per file would make the watcher the load. The pending timer
is replaced rather than extended, so a burst emits once at its end. The timer is
`unref`'d, because an optimisation that prevents process exit is a hang.

**Bounded at 64 roots**, and a watch that fails to attach is swallowed: no hints
from that root, and reconciliation still covers it. Failing the process because
a directory became unwatchable would make the optimisation load-bearing.

## 9. Acceptance criteria

- **AC-1** A correct signature over the raw body verifies.
- **AC-2** A signature over a reformatted body does not.
- **AC-3** Raw bytes and a string are both accepted.
- **AC-4** An unconfigured secret is a refusal.
- **AC-5** Missing, malformed and mismatched refusals are distinguishable in the
  result and identical in the message.
- **AC-6** A wrong-length signature does not throw.
- **AC-7** A GitHub delivery becomes a `SourceEvent` with the vendor's own event
  name.
- **AC-8** Headers are read case-insensitively.
- **AC-9** A declined event and an unrecognised one are different results.
- **AC-10** Every claimed GitHub event maps to a subject.
- **AC-11** A payload missing every optional field does not fail.
- **AC-12** A Jira event is read from the body, with a caller-minted delivery
  id.
- **AC-13** The ledger admits a delivery once, keyed on the system too.
- **AC-14** The ledger evicts the oldest and re-admits what it forgot.
- **AC-15** The watcher emits once per burst.
- **AC-16** The watcher's event deduplicates through the ledger.
- **AC-17** A root added twice is watched once.
- **AC-18** A root removed while a burst is pending emits nothing.
- **AC-19** The watcher refuses more roots than it declared.
- **AC-20** `src/events/` adds no package and reaches no provider or store.

## 10. Test requirements

**Unit** — every acceptance criterion. The watcher's clock and filesystem are
injected, so the burst behaviour is asserted without sleeping and without a
directory.

**Boundary** — AC-20.

## 11. Security requirements

The whole of §8.2 and §8.3. Additionally: every field a payload is read for is
optional in practice however mandatory the documentation says it is, because the
payload is attacker-supplied — AC-11 asserts a payload of `{}` produces an event
rather than an exception.

## 12. Observability

`NormalizeResult.ignored` distinguishes three reasons, so webhook traffic is
countable by outcome. `SignatureRefusal` distinguishes four, for the log.

## 13. Performance constraints

One HMAC and one `JSON.parse` per delivery. The watcher is one timer per root.

## 14. Definition of Done

Scope implemented; AC-1 to AC-20 with evidence in
`validation/EPIC-077-VALIDATION.md`; `npm run verify` green; the registry
updated; the four parked "no incremental repository discovery" rows struck.

## 15. Governance alignment

- **§12 Untrusted Input** — §8.2 and §11. This is the Epic that reads input
  nobody had to be authorised to send.
- **§6 Evidence Before Inference** — §8.6: a watcher is labelled a hint; §8.4:
  a declined event is not an unrecognised one; §8.5: the ledger says what it
  does not guarantee.
- **§10 Idempotence** — §8.5.
- **§5 Reuse Before Reinvent** — §8.1: the host's HTTP server, not Ferret's.

## 16. Raised, not absorbed

- **Nothing here has received a real webhook.** Payload shapes come from the
  vendors' documentation, as EPIC-021 §16 and EPIC-071 §16 record for their own
  clients.
- **The ledger does not survive a restart.** §8.5 states what that costs — a
  redundant read — and why the guarantee lives in EPIC-080 instead.
- **Jira sends no delivery id.** The caller mints one, which means two callers
  terminating the same request behind a load balancer would each treat it as
  new. A durable ledger keyed on a payload digest would fix it and is the same
  table §8.5 declined.
- **`fs.watch` on a network filesystem is unreliable**, and there is nothing
  this Epic can do about it beyond §8.6's position that a watcher is a hint.
- **No CLI surface.** `ferret watch` would be a long-running process whose only
  output is an internal event, and nothing consumes those from a terminal yet.
  When indexing grows an event-driven entry point, that is where it belongs.

## 17. Recorded during implementation

**The design decision was not to write the obvious thing.** `ferret serve
--webhooks` is what this Epic looks like it should be, and it would have added a
web framework, a TLS story and a bind-address footgun to a tool whose entire
value is what it knows rather than what it serves. The four functions here are
what a host cannot write for itself; the listener is what every host already
has.

**`timingSafeEqual` throws on a length mismatch**, which turns a verifier into a
denial of service for anyone who sends a short signature. The hex length is
already fixed by the format check, so the guard is unreachable — and it stays,
because an unreachable guard costs nothing and this is not a place to be clever.

**A signature over re-serialized JSON never matches**, and the only reliable
defence is a signature is that the function cannot be handed an object. That is
why `verifySignature` takes bytes and `normalizeGithubEvent` parses the string
itself rather than accepting a parsed payload: asking a caller for both invites
it to derive one from the other.

Full evidence in [validation](validation/EPIC-077-VALIDATION.md).
