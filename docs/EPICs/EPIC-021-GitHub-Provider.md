# EPIC-021 — GitHub Provider

**Status: VALIDATED | Priority: P1 | Domain: Source Ingestion**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Source Ingestion.

## 1. Objective

Give `Capability.SOURCE_PROJECT` a contract and a first implementation — issues,
pull requests, reviews, comments and releases, read from GitHub, safely and
within somebody else's rate limit.

## 2. Value

`capabilities.ts` has declared this since EPIC-013:

> `SOURCE_PROJECT: 'source.project'` — *"Issues, pull requests, reviews,
> releases, deployments."*

There is no contract file behind it and no provider that offers it. Four Epics
are waiting on it — EPIC-071 (Jira), EPIC-072 (pull requests and reviews),
EPIC-073 (releases and deployments), EPIC-077 (webhooks) — and each of them
would otherwise have to invent the same transport.

That matters because a repository's history says *what changed* and a project
tracker says *why*. Ferret can already answer "who last touched this file"; it
cannot answer "which pull request introduced this, who approved it, and what the
issue said it was for". That is the gap.

## 3. Scope

- **`src/providers/contracts/source-project.ts`** — the contract, written for
  two providers rather than one.
- **`src/github/`** — the provider: authentication, base URL, pagination, rate
  limits, conditional requests, retries, and the mapping onto the contract.
- **Two error codes** — `SOURCE_UNAUTHORIZED` and `SOURCE_UNAVAILABLE`.
- **Credentials through the existing mechanism**, not a new one.

## 4. Non-scope

- **Modelling.** This returns records. Turning a pull request into entities,
  relationships and evidence is EPIC-072's; a release into a deployment fact is
  EPIC-073's. The same separation EPIC-024 draws between a parser and the
  canonical model.
- **Writing.** No issue is opened, no comment posted, no status set. §8.2, and
  it is enforced by the client having no method but `get`.
- **Webhooks.** EPIC-077. This polls, and polling is what a conditional request
  makes cheap.
- **GraphQL.** REST is enough for these five operations and costs one dependency
  fewer; a query language would be worth it for a caller that needs to shape its
  own responses, which nothing here does.
- **Projects (the board), discussions, actions, packages.** None is asked for by
  a downstream Epic.
- **Cloning.** EPIC-019 reads Git through the `git` executable and continues to.

## 5. Inputs

A `ProjectQuery` — the repository, a cursor, a `since` instant, an `etag`.

## 6. Outputs

The contract, the provider, and the two error codes.

## 7. Dependencies

EPIC-013 (capabilities), EPIC-016 (the provider SDK and conformance suite),
EPIC-081 (secret references), EPIC-093 (error taxonomy).

## 8. Contracts

### 8.1 The contract is written for two providers, not one

Every field here has to mean something to Jira as well as to GitHub, because
EPIC-071 implements the same capability. So:

- `lifecycle` is `open`, `closed` or `merged` — what every tracker agrees on —
  and `state` carries the vendor's own word verbatim beside it. A custom
  workflow column is a fact Ferret cannot compare across systems, and flattening
  it into a fixed vocabulary would either lose it or lie about it.
- `id` is the source system's stable identifier, not a number in a URL.
- `cursor` is opaque and provider-defined. EPIC-075 already refused to let a
  caller construct a sync cursor, for the same reason.

### 8.2 Read-only, and structurally so

`GithubClient` exposes `get` and nothing else. The HTTP method is not a
parameter, so a future caller cannot make it one by accident — the same
reasoning EPIC-069 applies to destructive MCP tools, one layer lower. A token
with write scope still cannot write through this provider.

### 8.3 Pagination follows the server's links, never a page number

GitHub returns a `Link` header whose `rel="next"` is a complete URL. That URL is
followed verbatim. A client that built `?page=n+1` would be guessing at a scheme
the server is free to change — and when it changed, would silently re-read page
one for ever, which is a bug that looks like slow progress rather than like a
failure.

A cursor is therefore GitHub's own URL, and a request that carries one does not
append this call's parameters to it: they are already in there.

### 8.4 The rate limit is somebody else's budget, and a reserve is never spent

A token is usually shared with the user's own `gh`, their editor and their CI.
Ferret spending it to zero makes Ferret the reason a colleague's tooling started
failing.

So: every response's `x-ratelimit-*` headers are recorded; the budget is checked
**before** each request rather than after — a check that ran afterwards would
report the exhaustion it had just caused; and 100 requests are held back. The
refusal is retryable and names the reset instant.

`rateLimit()` reports the last known figure and spends nothing to do it.

### 8.5 A conditional request's `304` is not an empty page

`If-None-Match` costs no rate limit when it hits, which is what makes polling
affordable at all. The result carries `unchanged: true` and no items, and that
is a different fact from a page with no items: "nothing exists" and "nothing
changed" would otherwise be the same answer, and an incremental sync built on
the first would delete everything.

### 8.6 A pull request is not an issue, whatever the API says

`GET /repos/{o}/{r}/issues` returns pull requests too, because in GitHub's data
model a pull request *is* an issue. Ferret's model does not agree — EPIC-072
gives a pull request a merge commit, a branch pair and reviews — so `listIssues`
filters them out by the `pull_request` field GitHub sets on exactly those
records.

Without the filter every pull request is returned twice, once from each
operation, and every downstream count is wrong in a way that looks plausible.

### 8.7 A login is not an identity

GitHub allows an account to be renamed and the old name to be taken by somebody
else. Keying a person on `login` would silently merge two people, which is the
worst failure mode EPIC-040's identity resolution has. `node_id` is what
survives a rename and is what `ProjectActor.identity` carries; the numeric id is
the fallback for an Enterprise Server old enough not to send one.

### 8.8 Only `APPROVED` is approval

A GitHub review state may be `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`,
`DISMISSED` or `PENDING`. `approved` is true for the first and nothing else.
This is the kind of field a compliance question depends on, and a permissive
reading of it would be wrong in the direction that matters.

### 8.9 The credential uses the mechanism that exists

`token` is declared in `secretOptions`, so it is redacted wherever configuration
is rendered, and it may be written as `{"$secret": {"env": "FERRET_GITHUB_TOKEN"}}`
because `resolveSecrets` already runs over the whole configuration document
including provider options. No new mechanism was added — EPIC-081 built one and
this Epic is the first to find out whether it generalises.

It is **not** added to `CREDENTIAL_CONFIG_PATHS`. That list is for credentials
Ferret's *own* configuration schema holds, and its comment is explicit: it
grants access to known credentials rather than defining new ones.

### 8.10 An issue body is untrusted text

An issue body is written by anyone who can open an issue. It is carried verbatim
and interpreted by nothing here. The MCP surface already frames indexed content
as data rather than instruction, and this is the provider that makes that
framing load-bearing.

### 8.11 `fetch` is injected

Not for mockability as an end in itself: a provider that reaches a global cannot
be given a different base URL, a recorded transcript or a clock. Every behaviour
in §8.3 to §8.6 is a protocol behaviour, and a protocol test that needs the
network is a test CI does not run.

## 9. Acceptance criteria

- **AC-1** The provider declares `source.project` with its five operations and
  is selectable by capability.
- **AC-2** Issues, pull requests, reviews, comments and releases each map onto
  the contract.
- **AC-3** A pull request returned by the issues endpoint is not reported as an
  issue.
- **AC-4** A merged pull request reports `lifecycle: merged`, not `closed`.
- **AC-5** Pagination follows `Link`'s `rel="next"` and stops when it is absent.
- **AC-6** A cursor is followed verbatim, with no parameters appended.
- **AC-7** `x-ratelimit-*` headers are recorded and reported by `rateLimit()`.
- **AC-8** A request is refused before it is sent when the remaining budget is
  within the reserve, with a retryable error naming the reset.
- **AC-9** A `304` reports `unchanged`, with no items, and is not an empty page.
- **AC-10** `If-None-Match` is sent when the caller supplies an `etag`.
- **AC-11** `Retry-After` is honoured up to the bound and surfaced beyond it.
- **AC-12** A 401 fails as `SOURCE_UNAUTHORIZED` and is never retried.
- **AC-13** A 5xx retries and then fails as `SOURCE_UNAVAILABLE`.
- **AC-14** The token appears in no error, no log and no `describeConfig`
  output.
- **AC-15** A review is `approved` only for `APPROVED`.
- **AC-16** An actor is keyed on `node_id`, not on `login`.
- **AC-17** A project name that is not `owner/repo` is refused before a request.
- **AC-18** The client has no method that writes.
- **AC-19** `checkDependencies` reports reachability without spending budget.
- **AC-20** `src/github/` reaches neither storage nor the CLI.

## 10. Test requirements

**Unit** — every acceptance criterion, against an injected transport that
replays recorded response shapes: statuses, `Link` headers, `x-ratelimit-*`,
`Retry-After`, `304`.

**Conformance** — the EPIC-016 suite, through EPIC-099's harness.

**Boundary** — AC-20 in `boundaries.test.ts`.

**Not tested here** — the live API. A test that needs a token and a network is
a test CI cannot run, and §16 records what that leaves unverified.

## 11. Security requirements

§8.2 (read-only), §8.9 (the credential), §8.10 (untrusted bodies), and AC-14 —
the token must not reach an error, a log or a rendered configuration. The error
path reads GitHub's own `message` and the request path, never the query, because
a query can carry a search term and a search term can carry anything.

## 12. Observability

`rateLimit()` is the interesting one: it answers "how much traffic is left"
without spending any. `checkDependencies` uses `/rate_limit`, which is the one
endpoint that costs nothing.

## 13. Performance constraints

One request per page. A conditional request that hits costs no budget at all,
which is what makes polling viable and is the reason `etag` is in the contract
rather than in the provider.

## 14. Definition of Done

Scope implemented; AC-1 to AC-20 with evidence in
`validation/EPIC-021-VALIDATION.md`; `npm run verify` green; the registry
updated.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.5: an unchanged page is not an empty
  one; §8.8: only approval is approval.
- **§12 Untrusted Input** — §8.10.
- **§5 Reuse Before Reinvent** — §8.9: EPIC-081's mechanism, unchanged.
- **§21 Reproducibility** — the API version is pinned in a header.

## 16. Raised, not absorbed

- **Nothing here has spoken to GitHub.** Every behaviour is asserted against a
  transport that replays recorded shapes. The shapes are taken from GitHub's
  documented responses, and the risk that they are subtly wrong is real and is
  not reduced by this Epic's tests. The first live run belongs to whichever
  Epic first indexes a real repository.
- **GitHub App authentication is not implemented.** A personal access token and
  an installation token are both `Bearer`, so a caller that already has an
  installation token can use this today; *minting* one requires a JWT signed
  with a private key, which is a credential shape `secretOptions` does not model.
- **Secondary rate limits are handled only through `Retry-After`.** GitHub
  documents them as deliberately unpredictable, and a client that guessed would
  be guessing.
- **No caching.** An `etag` is returned to the caller and the caller decides what
  to do with it. Storing it is a sync-cursor question, which is EPIC-075's.
- ~~**`deployments` is declared in the capability comment and not implemented.**
  EPIC-073 owns deployment modelling and will say what it needs.~~ **Closed
  2026-09-03 by EPIC-073:** it said what it needed — `ProjectDeployment`,
  `ProjectDeploymentStatus` and two operations — and the provider implements
  both. Statuses stayed a separate call, for this Epic's own §8.4 reason.

## 17. Recorded during implementation

**`Number(null)` is `0`, and `Number.isFinite(0)` is `true`.** The rate-limit
recorder read three headers with `Number(headers.get(...))` and guarded with
`Number.isFinite`. A response carrying **no** rate-limit headers — a 503 from a
gateway, a 403 from a proxy — was therefore recorded as a budget of *zero*, and
`#assertBudget` then refused every subsequent request for the life of the
process. One bad gateway response would have taken the client down permanently,
and the symptom would have been "GitHub says we are rate limited" while GitHub
had said nothing of the kind.

Found by the two tests that exercise a 403 and a 503, neither of which was
written to find it. Fixed by reading the header first and converting only when
it is present, which is also why `#retryDelay` now shares the same helper.

**The exit-code map is exhaustive by type.** Adding two error codes broke
`src/cli/exit-codes.ts` at compile time, because `BY_ERROR_CODE` is typed
`Record<ErrorCode, ExitCode>`. That is the design working: a new error code
cannot reach a user without somebody deciding what a script should see. Both map
to `DEPENDENCY`, deliberately — a script retries the same way whether GitHub is
down or the token is wrong, and the message is what tells an operator which.

**`DependencyStatus` has no `UNSUPPORTED`.** A rejected token is `degraded`:
GitHub answered, and the distinction is what points an operator at the token
rather than at the network.

Full evidence in [validation](validation/EPIC-021-VALIDATION.md).
