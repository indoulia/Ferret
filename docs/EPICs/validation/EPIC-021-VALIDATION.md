# EPIC-021 — GitHub Provider — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-021](../EPIC-021-GitHub-Provider.md), AC-1 to AC-20.

`Capability.SOURCE_PROJECT` has been declared since EPIC-013 — *"Issues, pull
requests, reviews, releases, deployments"* — with no contract behind it and no
provider offering it. Four Epics were waiting on it, and each would otherwise
have invented the same transport.

## What was built

- **`src/providers/contracts/source-project.ts`** — the contract, written for
  GitHub *and* for EPIC-071's Jira provider.
- **`src/github/client.ts`** — authentication, pagination, rate limits,
  conditional requests, retries. One method: `get`.
- **`src/github/provider.ts`** — the capability declaration and the mapping.
- **`SOURCE_UNAUTHORIZED` / `SOURCE_UNAVAILABLE`** — two error codes.
- **`tests/unit/github-provider.test.ts`** — 33 tests over a recorded transport.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `declares source.project with its five operations` and `is selectable by capability, never by name` — `registry.forCapability(SOURCE_PROJECT)` returns it. |
| AC-2 | **MET** | `maps an issue onto the contract` and `maps comments and releases` — id, number, lifecycle, author, labels from both object and string forms. |
| AC-3 | **MET** | `does not report a pull request as an issue` — the issues endpoint returns both; without the filter every pull request is counted twice. |
| AC-4 | **MET** | `reports a merged pull request as merged, not closed`, and `reports a closed, unmerged pull request as closed`. `merged` is not a GitHub state. |
| AC-5 | **MET** | `returns the server link as the cursor`, `has no cursor on the last page`, `pages through the client until the links run out`. |
| AC-6 | **MET** | `follows a cursor verbatim, appending nothing` — the recorded URL equals the cursor exactly. |
| AC-7 | **MET** | `records what the response said` — limit, remaining, reserved and an ISO reset. |
| AC-8 | **MET** | `refuses before sending when the reserve is reached` — and the transport records **no** additional call, which is the property. `names the reset and is retryable` asserts the error's shape. |
| AC-9 | **MET** | `reports a 304 as unchanged, not as an empty page`. |
| AC-10 | **MET** | `sends If-None-Match when given an etag` and `returns the etag so a caller can send it back`. |
| AC-11 | **MET** | `honours Retry-After up to the bound` (one 2 s sleep, then success) and `surfaces a Retry-After beyond the bound rather than sleeping` (no sleep at all). |
| AC-12 | **MET** | `fails a 401 as unauthorized and never retries` — one call, `retryable: false`. |
| AC-13 | **MET** | `retries a 5xx, then fails as unavailable` — exactly three calls. |
| AC-14 | **MET** | `declares the token as a secret option` and `keeps the token out of every error` — the serialised error contains neither the token nor the query string. |
| AC-15 | **MET** | `treats only APPROVED as approval` — `[true, false, false, false]` over `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`. |
| AC-16 | **MET** | `keys an actor on node_id, not on login`, and the numeric fallback for an older Enterprise Server. |
| AC-17 | **MET** | `refuses a project name that is not owner/repo` — four hostile names, and no request made. |
| AC-18 | **MET** | `has no method that writes` — the prototype carries `get` and none of `post`/`put`/`patch`/`delete`/`request`/`send`, and the source contains no other method literal. |
| AC-19 | **MET** | `checks reachability without spending budget` — `/rate_limit`; and `reports a rejected token as degraded rather than unavailable`. |
| AC-20 | **MET** | `GitHub provider boundary` in `boundaries.test.ts` — no storage, no CLI, no package beyond the core's three. |

## The defect the tests found

`#recordRateLimit` read three headers as `Number(headers.get(name))` and guarded
with `Number.isFinite`. **`Number(null)` is `0`, and `Number.isFinite(0)` is
`true`** — so a response carrying no rate-limit headers was recorded as a budget
of zero, and every subsequent request was refused for the life of the process.

The symptom would have been Ferret reporting a GitHub rate limit that GitHub had
never mentioned, permanently, after a single 503 from a gateway. It was found by
the 403 and 503 tests, neither of which was written to look for it, and it is
the strongest argument in this Epic for testing the transport rather than
mocking the client.

## The gates

**The exit-code map is exhaustive by type**, so adding two error codes was a
compile error until somebody decided what a script should see. Both map to
`DEPENDENCY`: a script retries the same way whether GitHub is down or the token
is wrong, and the message is what distinguishes them for a person.

**EPIC-099's conformance harness** required the provider on sight, and it is
registered with a transport that answers nothing — a conformance gate that
depended on GitHub being up would be a gate that fails for reasons unrelated to
conformance.

## What this does not claim

- **Nothing here has spoken to GitHub.** Every behaviour is asserted against
  recorded response shapes taken from GitHub's documentation. The risk that a
  shape is subtly wrong is real and is not reduced by these tests; the first
  live run belongs to whichever Epic first indexes a real repository. §16.
- **GitHub App authentication is not implemented** — an installation token works
  today because it is also a `Bearer`, but minting one needs a signed JWT, which
  is a credential shape `secretOptions` does not model.
- **Secondary rate limits are handled only through `Retry-After`**, because
  GitHub documents them as deliberately unpredictable.
- **Nothing is cached.** An `etag` is handed back to the caller; storing it is a
  sync-cursor question and EPIC-075 owns those.
- ~~**`deployments` is declared in the capability's comment and not
  implemented.**~~ **Closed 2026-09-03 by EPIC-073**, which added the records,
  the two operations and the provider methods.
