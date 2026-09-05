# EPIC-118 — Ferret Self-Dogfood

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Evaluation & Quality · Retrieval & Context · AI Control Plane
**Classification:** HARDENING

## Outcome

Ferret indexes its own repository and answers questions about it through the
agent-facing MCP surface — the **whole** repository, checked against `git` as an
independent oracle rather than read and believed.

## Problem

Dogfooding was already the practice: `.mcp.json` wires Ferret into this
repository as an MCP server, `scripts/dogfood-db.mjs` builds the index it
answers from, and `scripts/dogfood.mjs` asks Ferret questions whose answers
`git` can produce independently. Four defects in EPIC-058, EPIC-060 and issue
#71 were found that way, and none was visible from the test suite.

What the practice had no answer for is a repository larger than one page.
`MAX_LIMIT` is 500 and Ferret tracks 830 files, and `ferret_find` — the tool
whose stated purpose is *"every file in this repository"* — had no offset.
Nothing in the store was missing: `EntityQuery.offset` had existed since
EPIC-052, and `findEntities` had passed it to `OFFSET` all along. No caller
reached it, so the store could page and no client could ask it to, and
`MAX_LIMIT` stopped being a page size and became a ceiling on what Ferret could
describe.

**The failure was not a short answer.** It was a confidently wrong one. Ferret's
own oracle read 487 files where the repository has 830 and reported the other
343 as *tracked files absent from the index* — the index was complete and the
retrieval was truncated, and from the call site those are indistinguishable.
That is the same class as issue #51 and F-31: a fact inferred from a list
something else had already shortened.

## Decisions this Epic implements

None. No product semantics were decided here: the offset already existed in the
contract and in the SQL, and this Epic connects them to the surface that needs
them. `MAX_LIMIT` is unchanged, and remains what EPIC-052/053 made it — a bound
on what one response may occupy.

## Design

**An offset, not a cursor.** `ferret_find` gains `offset`, and reports
`nextOffset` when the store says more rows match. An opaque cursor would need a
place to keep the state it encodes, a rule for expiring it and a decision about
what a client holding a stale one should see; the offset needs none of those and
answers the question that was actually unanswerable. MISS: the smallest thing
that makes the repository reachable.

**`nextOffset` advances by the page size, never by `count`.** The store applies
`OFFSET`/`LIMIT` in SQL and permission filtering removes rows afterwards in
TypeScript, so a cursor derived from what came back would rewind by exactly the
number withheld and hand a client rows it already had.

**A withheld row is not a next page.** `truncated` stays true when rows were
withheld — that was already right — but `nextOffset` appears only when the store
reports `more`. Offering an offset for rows this caller may never see would loop
a client for ever over an answer that cannot grow.

**The ordering had to become total first.** `ORDER BY e.kind, e.source_id` is
not: no constraint makes that pair unique, and one kind ties in practice — a
`code_symbol`'s source id is the symbol's name, so every name declared in two
files is a tie, and Ferret's own index holds **178** such groups. PostgreSQL is
free to order tied rows differently between two executions of the same query,
which is invisible within one page and corrupting to every paged enumeration:
a row that moves across a page boundary is returned twice or skipped entirely.
Appending the primary key makes the order total by construction.

**The oracle pages, and its recorded limitation is closed.**
`scripts/dogfood.mjs` said in a comment that `ferret_find` "offers no cursor, so
'every file in this repository' is whatever fits in one page", and failed itself
on that basis. It now pages to exhaustion and trusts `nextOffset` rather than
computing an offset from the rows it received.

## Scope

- `offset` on `ferret_find`, and `nextOffset` on its response.
- `boundedOffset`, beside `boundedLimit`, exported from the retrieval contract.
- A total ordering on the paged entity query.
- `scripts/dogfood.mjs` pages the file enumeration.
- Tests: the paging surface, the enumeration against a real repository, and a
  source-level control on the ordering.

## Non-scope

- **An opaque cursor, and snapshot isolation across pages.** An offset over a
  total order is exact for an index that is not being rewritten underneath the
  reader, which is what an enumeration between two index runs is. Making a
  multi-page read consistent *against a concurrent index run* means a snapshot
  or a keyset cursor, and both are product decisions about what a client is
  entitled to see mid-write. Recorded as a limitation below rather than decided
  here.
- **Paging any other tool.** `ferret_search` ranks and `ferret_neighbours`
  traverses; both already say when a bound cut them, and neither has "enumerate
  the whole set" as its purpose. `ferret_find` is the tool whose stated purpose
  the ceiling contradicted.
- **Raising `MAX_LIMIT`.** It bounds what one response may occupy, which is a
  context-window protection and not the thing that was wrong.
- **Making the dogfood run a CI gate.** It needs a database, a built CLI and a
  full index of this repository; EPIC-114's scheduled lane is the shape that
  would fit, and choosing to spend a runner on it is a decision, not an
  implementation detail.
- **Turning Ferret into an agent.** Ferret answers about what it indexed. It
  does not act, plan, or generate engineering answers, and nothing here moves
  that line.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Ferret indexes its own repository, and every tracked file is reachable | `dogfood.mjs` — "no missing files (830 tracked)", "the file list is complete (844 entities over 2 pages)" |
| 2 | An answer larger than one page offers the next, and paging reaches every entity exactly once | `tools.test.ts` — "offers the next page, and reaches every entity exactly once"; `enumeration.test.ts` — "reaches every file exactly once, and knows when it is finished" |
| 3 | The offset advances by the page size, not by the rows that survived filtering | `tools.test.ts` — "advances by the page size, not by the rows that survived filtering" |
| 4 | A withheld row is not offered as a next page | `tools.test.ts` — "offers no next page when the only shortfall is what was withheld" |
| 5 | The last page says it is the last; an offset past the end returns nothing rather than wrapping | `tools.test.ts` — "offers no next page on the last one"; `enumeration.test.ts` — "returns an empty page past the end rather than wrapping to the start" |
| 6 | The paged query orders totally, so two identical reads page identically | `paged-ordering.test.ts` — "breaks every tie on the primary key"; `enumeration.test.ts` — "orders totally…", "reaches every tied row exactly once, and in the same order twice" |
| 7 | Paging is confined to one source: another repository never appears, and the two do not merge | `enumeration.test.ts` — "never returns another repository the whole way through"; "gives each repository its own files, not their union" |
| 8 | Source, path and content hash are identical on the last page and the first | `enumeration.test.ts` — "carries source and path on the last page as on the first" |
| 9 | Re-indexing changes neither membership nor order | `enumeration.test.ts` — "re-indexing changes neither the membership nor the order" |
| 10 | A file added, changed and deleted past the first page is visible as such | `enumeration.test.ts` — "shows a file added, changed and deleted after the first page" |
| 11 | An offset the schema does not allow is refused rather than clamped | `tools.test.ts` — "refuses a negative offset rather than reading from the start" |

## Tests

Six protocol cases in `tests/integration/mcp/tools.test.ts`, eleven against a
real PostgreSQL and a real `git` repository in
`tests/integration/retrieval/enumeration.test.ts`, and two source-level cases in
`tests/unit/paged-ordering.test.ts`.

The source-level control exists because a behavioural one does not work, and
that was measured rather than assumed: with the tiebreak reverted the paging
suite stayed **green**, because PostgreSQL returns insertion order for a small
table. The reordering is latitude the planner has, not behaviour it always
exhibits, so the control asserts the property that guarantees the invariant —
the paged query names a unique column last — on the precedent of
`mcp-destructive-tools.test.ts` and `boundaries.test.ts`.

## Dependencies

EPIC-052/053 (`findEntities` and the bounds), EPIC-058 (the withheld
distinction), EPIC-065 (`ferret_find`), EPIC-108 (content indexing, which
produces the tying kind), EPIC-032 (tombstones).

## Known limitations

- **A page is not a snapshot.** Two pages read either side of an index run see
  two different indexes, so an entity written between them can be missed and one
  removed can be returned. Exact between runs, which is what an enumeration is;
  making it exact *during* one needs a cursor or a snapshot, and that is the
  product decision this Epic declined to take.
- **`byIdentifier` still orders on the untotal key.** It does not page, so no
  row can cross a page boundary, and the only observable effect is which of two
  tied hits is listed first. Left alone deliberately: it is EPIC-055's query and
  changing it here would be a second Epic's behaviour altered in this one's diff.
- **The dogfood run is not a gate.** It runs when someone runs it. See non-scope.
- **EPIC-113 through EPIC-117 are absent from the registry catalog.** Observed
  while adding this Epic's entry; the [roadmap's completion
  record](ROADMAP.md#completion-record) carries all five with their PRs, merges
  and validation records, and the catalog does not. A records gap this Epic did
  not create and does not own.

## Definition of done

Every acceptance criterion tested; the dogfood oracle agreeing with `git` on
every question it asks, including the one it previously failed itself on; the
registry and roadmap updated; merged through normal governance.
