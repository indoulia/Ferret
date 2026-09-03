# EPIC-071 — Jira Provider

**Status: VALIDATED | Priority: P1 | Domain: External Project Knowledge**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under External Project Knowledge.

## 1. Objective

Read Jira issues and comments — and, in doing so, find out whether EPIC-021's
contract was written for two providers or for one.

## 2. Value

Half of Ferret's users track work somewhere other than GitHub. That is the
ordinary reason for this Epic and it is the smaller one.

The larger one is that EPIC-021 §8.1 makes a claim it cannot verify:

> *"Every field here has to mean something to Jira as well as to GitHub, because
> EPIC-071 implements the same capability. A contract shaped around one vendor's
> JSON is a contract the second provider has to break."*

A contract *claimed* to be written for two providers is a claim until a second
provider is written. This Epic is that test, and §17 records what it found.

## 3. Scope

- **`src/jira/`** — client and provider: authentication, JQL, offset paging,
  retries, and the mapping onto `source.project`.
- **Issues and comments.** Two operations, declared honestly.
- **Whatever the contract needed to admit a second implementation** — §8.2,
  §8.5, and §17.

## 4. Non-scope

- **Pull requests, reviews and releases.** Jira has none. Its development panel
  is a private API backed by whatever VCS integration an instance happens to
  have, and reading it would be reading GitHub through a keyhole.
- **Writing.** No transition, no comment, no field set. §8.6.
- **Custom fields.** An instance may have hundreds; which of them carry meaning
  is a per-organisation question and modelling them generically would produce
  attributes nobody can query.
- **Agile boards, sprints and epics (Jira's own).** No downstream Epic asks.
- **Modelling.** EPIC-072's `modelProject` already takes these records: that it
  needs no change for a second source is the strongest evidence the separation
  was right.

## 5. Inputs

A `ProjectQuery`. The project is a Jira key — `FER` — rather than `owner/repo`.

## 6. Outputs

`src/jira/`, published at `@indoulia/ferret/jira`, and the contract corrections.

## 7. Dependencies

EPIC-021 (the contract), EPIC-016 (the SDK and conformance suite), EPIC-081
(secret references), EPIC-093 (the error taxonomy).

## 8. Contracts

### 8.1 Nothing here imports the GitHub provider

Asserted in `boundaries.test.ts`, and it is the point of the Epic: a second
implementation that reused the first would be a subclass wearing a provider's
clothes and would prove nothing about whether the contract generalises.

### 8.2 A provider declares what it implements, and implements what it declares

The contract's first draft required five methods. Jira has two of them, so the
choice was to return three empty pages or to change the contract — and an empty
page is a lie: it makes *"Jira has no pull requests"* and *"this project has no
pull requests"* the same answer.

So `listIssues` is the only required method, and everything else is optional and
declared through `operations`, the way the Git provider declares
`RepositoryOperation`. The method being absent and the operation being
undeclared become one fact stated once. `isProjectSource` was checking for four
methods and would have refused this provider outright.

### 8.3 Incremental reading is JQL, because Jira has nothing else

Jira offers no `since` parameter, no `Link` header and no conditional requests
on search. What it has is a query language, so:

- `since` becomes `updated >= "..."`, in **JQL's own instant format** —
  `2026-01-02 03:04`, no `T` and no seconds. A small enough incompatibility to
  miss and a total enough one to make every incremental query fail.
- The cursor is a `startAt` offset. That it is a number where GitHub's is a URL
  is exactly why EPIC-021 §8.1 kept cursors opaque, and a caller that had ever
  parsed one would break here.
- Every query is `ORDER BY updated ASC`. A page boundary in a set ordered by
  anything else moves as issues change, which makes a resumed read skip or
  repeat.

A project key is validated rather than escaped: it reaches a query, and a
legitimate key never contains a quote.

### 8.4 There is no rate-limit budget to report

Jira publishes no `x-ratelimit-*` headers, so `rateLimit()` returns `undefined`
rather than a fabricated budget. `Retry-After` on a 429 is the only signal there
is, and it is honoured up to the same bound the GitHub client uses.

The contract already allowed this — `rateLimit()` returns
`ProjectRateLimit | undefined` — which is one place it survived contact with a
second provider unchanged.

### 8.5 A key is not a number

GitHub numbers its issues; Jira keys them. `ProjectRecord` had `number` and
nothing else, so every Jira issue would have arrived without the identifier its
users actually say out loud. `key` is the addition, and it is the smallest one
that could be correct.

The **identity** is neither: it is Jira's numeric id, because an issue *moved*
between projects gets a new key and keeps its id — which is precisely the
property EPIC-072 §8.1 needs from an identity.

### 8.6 Read-only, structurally, and the credential decides its own scheme

`JiraClient` exposes `get` and nothing else — EPIC-021 §8.2's reasoning,
unchanged.

Authentication is decided by the credential's *shape*: an email plus a token is
Jira Cloud's Basic form, and a token alone is a Server or Data Center personal
access token, which is a Bearer. One field decides, so the two cannot be
configured inconsistently — which a mode flag beside a pasted credential
eventually is.

### 8.7 A status is what an administrator called a column

`statusCategory` is the comparable reading, and the status name is kept verbatim
beside it. "In Review", "Awaiting Deploy" and "Blocked on Legal" are workflow
columns somebody named, and comparing them across projects is meaningless — but
discarding them would throw away the only thing a Jira user recognises.

Exactly the pair EPIC-021 §8.1 built `state` and `lifecycle` for, used for the
first time by the provider it was designed for.

### 8.8 A description is a document, not a string

Jira Cloud sends Atlassian Document Format: a tree of nodes. Walking it for text
is the whole conversion, because the formatting is presentation — EPIC-027 §4's
position for Word, applied here. A Server instance sends a plain string, which
is the other branch.

The walk is depth-bounded. A document is JSON somebody uploaded, and a
self-referential one is a stack overflow rather than a parse error.

## 9. Acceptance criteria

- **AC-1** The provider declares `source.project` with exactly the two
  operations it implements, and is selectable by capability.
- **AC-2** `isProjectSource` accepts a provider with two methods.
- **AC-3** An issue maps onto the contract, with its key and its numeric id.
- **AC-4** The status category is the lifecycle; the status name is `state`.
- **AC-5** An Atlassian document flattens to text, and a cyclic one terminates.
- **AC-6** `since` becomes JQL in JQL's own instant format.
- **AC-7** Every query orders by `updated ASC`.
- **AC-8** A project key that is not one is refused before a request.
- **AC-9** An issue key that is not one is refused before a request.
- **AC-10** Paging is by offset, and the cursor is absent on the last page.
- **AC-11** A cursor Ferret did not issue is refused.
- **AC-12** Only the fields the provider reads are requested.
- **AC-13** Cloud uses Basic; a token with no email uses Bearer.
- **AC-14** The token and the JQL query appear in no error.
- **AC-15** `Retry-After` is honoured up to the bound and surfaced beyond it.
- **AC-16** A 403 never retries; a 503 retries and then fails as unavailable.
- **AC-17** `rateLimit()` returns `undefined`.
- **AC-18** The client has no method that writes.
- **AC-19** `src/jira/` imports neither storage, the CLI, nor `src/github/`.
- **AC-20** The GitHub provider still passes its own suite unchanged — the
  contract changes were additive.

## 10. Test requirements

**Unit** — every acceptance criterion, against a recorded transport, for
EPIC-021 §8.11's reason.

**Conformance** — EPIC-016's suite through EPIC-099's harness.

**Boundary** — AC-19.

**Regression** — AC-20: EPIC-021's suite, unchanged except where it asserts the
operation list.

**Not tested here** — a live Jira. §16.

## 11. Security requirements

§8.6 (read-only and the credential), AC-14 (nothing leaks), §8.8 (the bounded
walk). A JQL query is caller-supplied text and never appears in an error's
details — the same reason EPIC-021 omits a GitHub query string.

## 12. Observability

`checkDependencies` calls `/myself`, which is the cheapest endpoint that proves
both reachability and the credential.

## 13. Performance constraints

One request per page. The field list is named, because an instance's custom
fields are megabytes Ferret does not read.

## 14. Definition of Done

Scope implemented; AC-1 to AC-20 with evidence in
`validation/EPIC-071-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-021's contract amended where a second provider required it.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.2: an undeclared operation rather than
  an empty page; §8.4: no budget rather than a fabricated one; §8.7: the
  administrator's word kept beside the comparable reading.
- **§5 Reuse Before Reinvent** — EPIC-072's modelling needed no change for a
  second source, which is what §4's non-scope records.
- **§12 Untrusted Input** — §8.8 and §11.

## 16. Raised, not absorbed

- **Nothing here has spoken to Jira**, as EPIC-021 §16 records for GitHub. The
  response shapes come from Atlassian's documentation.
- **`/rest/api/3/search` is deprecated in favour of `/search/jql`**, which pages
  by an opaque `nextPageToken` rather than an offset. The contract already
  admits that — a cursor is opaque — so the change is a client-level one, and it
  is not made here because the deprecated endpoint is what current instances
  still serve.
- **OAuth 2.0 (3LO) is not implemented.** An access token works today because it
  is also a Bearer; obtaining one needs a callback URL and a refresh flow, which
  is a credential shape `secretOptions` does not model — the same limitation
  EPIC-021 §16 records for GitHub Apps.
- **Custom fields are not read.** §4.
- **A Jira issue's links are not modelled.** `blocks`, `duplicates`, `relates
  to` are a graph Ferret could hold and `relationship.ts` declares no type for.
  Naming it here rather than inventing one.

## 17. Recorded during implementation

**The contract needed three changes, and that is the finding.** EPIC-021 §8.1
claimed to be written for two providers; a second provider found three places
where it was not.

**It required five methods.** Jira implements two. The choice was three empty
pages — indistinguishable from "this project has none" — or an optional-method
contract with operations as the declaration. `isProjectSource` was checking for
four methods and would have refused this provider outright, which is a
capability predicate that had only ever been run against the provider it was
written from.

**It had `number` and no `key`.** Every Jira issue would have arrived without
the identifier its users say out loud.

**`listComments` took `item: number`.** A Jira comment belongs to `FER-12`.

**What survived unchanged is worth as much.** `rateLimit()` already returned
`undefined`. `cursor` was already opaque, and Jira's being an offset where
GitHub's is a URL is the case that decision was made for. `state` beside
`lifecycle` — added for GitHub, where it is nearly redundant — is what carries
"In Review" for Jira, where it is the only thing a user recognises. And
EPIC-072's modelling took Jira's records with no change at all.

Full evidence in [validation](validation/EPIC-071-VALIDATION.md).
