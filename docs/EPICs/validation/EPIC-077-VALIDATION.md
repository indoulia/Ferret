# EPIC-077 — Event & Webhook Ingestion — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-077](../EPIC-077-Event-And-Webhook-Ingestion.md), AC-1 to AC-20.

Ferret's synchronization was complete and entirely pull-based: EPIC-076 reads
incrementally, EPIC-078 reconciles periodically, EPIC-079 backs off. All three
answer *when should I look again?* with a schedule, and a schedule is a
compromise that is wrong in both directions most of the time.

Four validation documents parked the same limitation here in the same words:
*"It needs a filesystem watcher, and Event & Webhook Ingestion is where
event-driven sources belong."* All four are struck.

## The decision not to write the obvious thing

`ferret serve --webhooks` is what this Epic looks like it should be. It would
have added a web framework — the largest package in the tree — a TLS story, a
process model and a bind-address footgun, to a tool whose entire value is what
it knows rather than what it serves. Every deployment that wants webhooks
already has something terminating HTTPS.

So Ferret supplies what only Ferret can — verification, normalization,
deduplication — as pure functions over bytes, and the host calls them. The same
position the MCP server takes about transports and the storage provider takes
about connections. `boundaries.test.ts` asserts `src/events/` adds **no package
at all**: `node:crypto` and `node:fs` are the whole dependency list, and a
signature verifier is the last place to take a third-party one.

## What was built

- **`src/events/signature.ts`** — HMAC verification over the raw body.
- **`src/events/normalize.ts`** — a delivery as a change notification.
- **`src/events/deliveries.ts`** — a bounded ledger that says what it does not
  guarantee.
- **`src/events/watch.ts`** — a debounced watcher producing the same events.
- **`tests/unit/webhook-events.test.ts`** — 26 tests.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `accepts a correct signature over the raw body`. |
| AC-2 | **MET** | `refuses a signature over a reformatted body` — the failure every webhook integration has had, and the reason the function takes bytes. |
| AC-3 | **MET** | `accepts raw bytes as well as a string`. |
| AC-4 | **MET** | `refuses when no secret is configured — not a pass`. A deployment that forgot to set one would otherwise accept anything and look exactly like a working one. |
| AC-5 | **MET** | `refuses a missing, malformed or wrong signature, distinguishably`, and `says the same thing to a sender however it failed`. |
| AC-6 | **MET** | `does not throw on a signature of the wrong length` — `timingSafeEqual` throws on a mismatch, and an exception in a verifier is a denial of service. |
| AC-7 | **MET** | `names what changed, not what it contains` — the whole `SourceEvent` asserted, with `pull_request.closed` verbatim. |
| AC-8 | **MET** | `reads headers whatever case the server normalized them to`. |
| AC-9 | **MET** | `distinguishes an event it declines from one it does not know` — a `star` is a decision, not a gap. |
| AC-10 | **MET** | `maps every event it claims to a subject` — seven cases. |
| AC-11 | **MET** | `survives a payload with nothing in it`. |
| AC-12 | **MET** | `reads the event from the body, because Jira sends no header`, and `requires a delivery id the caller minted`. |
| AC-13 | **MET** | `admits a delivery once`, `keys on the source system as well as the id`. |
| AC-14 | **MET** | `evicts the oldest, and re-admits what it forgot`. |
| AC-15 | **MET** | `emits once per burst, not once per file` — a hundred changes, one event. |
| AC-16 | **MET** | `mints a delivery id the ledger can deduplicate on`. |
| AC-17 | **MET** | `watches a root once however often it is added`. |
| AC-18 | **MET** | `emits nothing for a root removed while a burst was pending`. |
| AC-19 | **MET** | `refuses to hold more roots open than it declared`. |
| AC-20 | **MET** | `event ingestion boundary` in `boundaries.test.ts` — no packages, no provider, no store, no CLI. |

## The security posture

This is the Epic that reads input nobody had to be authorised to send. A webhook
payload arrives unsolicited, over the network, at an endpoint whose URL is
frequently discoverable; everything else Ferret reads at least required somebody
to have write access to a repository.

- **The signature is over the raw body, and the function cannot be handed an
  object.** `normalizeGithubEvent` parses the string itself for the same reason:
  asking a caller for both a string and a parsed payload invites it to derive
  one from the other, and a digest over re-serialized JSON never matches.
- **An unconfigured secret refuses.**
- **One sentence goes back to the sender**, whatever went wrong. A sender that
  could tell "no secret configured" from "wrong signature" learns whether the
  endpoint is worth attacking. EPIC-068's reasoning about `NOT_PERMITTED`,
  applied to an unauthenticated caller.
- **Every payload field is treated as optional**, however mandatory the vendor's
  documentation says it is — AC-11.

## What this does not claim

- **Nothing here has received a real webhook.** Payload shapes come from the
  vendors' documentation, as EPIC-021 §16 and EPIC-071 §16 record for their
  clients.
- **The ledger does not survive a restart**, and §8.5 says what that costs — one
  redundant read — and why the guarantee lives in EPIC-080 instead. A durable
  ledger would be a table, and a table is EPIC-075's cursor problem again.
- **Jira sends no delivery id**, so two callers behind a load balancer would each
  treat the same delivery as new.
- **A watcher is a hint.** `fs.watch` drops events under load and says nothing
  about what happened while the process was not running. EPIC-078 remains what
  is correct, and a watcher trusted instead would be a cache with no
  invalidation.
- **There is no CLI surface.** `ferret watch` would be a long-running process
  whose only output is an internal event, and nothing consumes those from a
  terminal yet.
