# EPIC-071 — Jira Provider — Validation

**Validated 2026-09-03.** Evidence for [EPIC-071](../EPIC-071-Jira-Provider.md),
AC-1 to AC-20.

EPIC-021 §8.1 made a claim it could not verify: that `source.project` was
written for two providers rather than one. This Epic is the test.

**It found three places where it was not**, and — worth as much — four places
where it was.

## What the contract had to change

| What | Why |
|---|---|
| Five required methods → **one** | Jira implements two. The alternative was three empty pages, and an empty page makes *"Jira has no pull requests"* and *"this project has no pull requests"* the same answer. |
| `isProjectSource` required four methods | It would have **refused this provider outright** — a capability predicate that had only ever been run against the provider it was written from. |
| `ProjectRecord` had `number` and no `key` | GitHub numbers its issues; Jira keys them. Every Jira issue would have arrived without the identifier its users say out loud. |
| `listComments` took `item: number` | A Jira comment belongs to `FER-12`. |

Every change is additive, and EPIC-021's suite passes unchanged except where it
asserts the operation list — AC-20.

## What survived contact unchanged

- **`rateLimit()` already returned `undefined`.** Jira publishes no rate-limit
  headers, and the contract had already allowed for a provider that cannot say.
- **`cursor` was already opaque.** Jira's is a `startAt` offset where GitHub's
  is a URL — precisely the case EPIC-021 §8.1 made that decision for, and a
  caller that had ever parsed one would break here.
- **`state` beside `lifecycle`.** Added for GitHub, where it is nearly
  redundant. For Jira it carries "In Review" and "Awaiting Deploy" — workflow
  columns an administrator named, meaningless across projects and the only thing
  a Jira user recognises.
- **EPIC-072's modelling took Jira's records with no change at all**, which is
  the strongest evidence that separating transport from modelling was right.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `declares the two operations it implements, and no more` — `['list-issues', 'list-comments']`, and `listPullRequests` is `undefined`. |
| AC-2 | **MET** | `satisfies the contract with two methods` — the correction, asserted. |
| AC-3 | **MET** | `maps an issue, keeping the key a person quotes` — `id: '10042'`, `key: 'FER-12'`. The id, not the key, because a moved issue keeps its id. |
| AC-4 | **MET** | `reads the status category, and keeps the administrator word beside it` — `state: 'In Review'`, `lifecycle: open`; and `reads done as closed`. |
| AC-5 | **MET** | `flattens an Atlassian document into text`, `does not recurse for ever on a self-referential document`. |
| AC-6 | **MET** | `turns since into JQL, in the format JQL actually accepts` — `updated >= "2026-01-02 03:04"`, no `T` and no seconds. |
| AC-7 | **MET** | `builds a project query ordered for stable paging`. |
| AC-8 | **MET** | `refuses a project key that is not one` — four hostile values including `FER" OR "1"="1`. |
| AC-9 | **MET** | `refuses an issue key that is not one, before a request` — and no call is recorded. |
| AC-10 | **MET** | `pages by offset, and stops when the total is reached`; `has no cursor for an empty result`. |
| AC-11 | **MET** | `refuses a cursor it did not issue`. |
| AC-12 | **MET** | `names only the fields it reads`. |
| AC-13 | **MET** | `uses Basic for Cloud, because that is what Atlassian documents`, and `uses Bearer when there is no email, which is a Server token`. |
| AC-14 | **MET** | `keeps the credential and the query out of every error` — the serialised error contains neither the token nor `SECRETPROJECT`. |
| AC-15 | **MET** | `honours Retry-After on a 429`; `surfaces a long Retry-After rather than sleeping through it`. |
| AC-16 | **MET** | `never retries a 403` (one call); `retries a 503 and then fails as unavailable` (three calls). |
| AC-17 | **MET** | `reports no rate limit, because Jira publishes none`. |
| AC-18 | **MET** | `has no method that writes`. |
| AC-19 | **MET** | `Jira provider boundary` in `boundaries.test.ts` — no storage, no CLI, and **no `src/github/`**, asserted in both directions. |
| AC-20 | **MET** | `tests/unit/github-provider.test.ts` passes unchanged. |

## The decisions

**Authentication decides itself from the credential's shape.** An email plus a
token is Jira Cloud's Basic form; a token alone is a Server personal access
token, which is a Bearer. A mode flag beside a pasted credential is eventually
inconsistent with it.

**A project key is validated, not escaped.** It reaches a JQL query, and a
legitimate key never contains a quote. `FER" OR "1"="1` is refused rather than
sanitised, because there is nothing to sanitise.

**Every query orders by `updated ASC`.** A page boundary in a set ordered by
anything else moves as issues change, which makes a resumed read skip or repeat.

**The document walk is depth-bounded.** A description is JSON somebody uploaded,
and a self-referential one is a stack overflow rather than a parse error.

## What this does not claim

- **Nothing here has spoken to Jira.** Response shapes come from Atlassian's
  documentation, as EPIC-021 §16 records for GitHub.
- **`/rest/api/3/search` is deprecated** in favour of `/search/jql`, which pages
  by an opaque token. The contract already admits that — a cursor is opaque — so
  it is a client-level change, not made here because the deprecated endpoint is
  what current instances still serve.
- **OAuth 2.0 (3LO) is not implemented**, the same limitation EPIC-021 records
  for GitHub Apps.
- **Custom fields and issue links are not read.** The second is a graph Ferret
  could hold and `relationship.ts` declares no type for; naming it beats
  inventing one.
