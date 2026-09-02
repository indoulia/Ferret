# EPIC-070 — AI Client Capability Discovery · Validation Evidence

**Assessed against:** working tree on top of `ff78b27`, on EPIC-067's branch
**Date:** 2026-09-03
**Environment:** the **real MCP protocol** over an in-memory transport, with a
`HealthAccess` port supplying reports that include a failed database and a check
that could not run — the states the tool exists for.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 the aggregate status and every component | **MET** | `health-tools.test.ts` "returns the aggregate status and every component" |
| AC-2 status, required, remediation per component | **MET** | same test — `required: true` on the database, the remediation on the index check |
| AC-3 an `unknown` check is reported, not omitted | **MET** | "reports a check that could not run rather than omitting it" |
| AC-4 versions and platform | **MET** | "names the versions and the platform" |
| AC-5 the inventory | **MET** | "carries the inventory and the last run" — 739 entities across two kinds, evidence, relationships and blobs |
| AC-6 the last run's age | **MET** | same test |
| AC-7 an empty index is reported as empty | **MET** | "says an empty index is empty, and why that is not a failure" — with the notice a client needs before misreading an empty answer |
| AC-8 a report rather than a throw when the database is down | **MET** | "returns a report when the database is unreachable" — `isError: false`, status `unavailable`, index unavailable with a reason |
| AC-9 refused without `READ` | **MET** | "is refused without READ" — `E_NOT_PERMITTED` through the real protocol |
| AC-10 not registered without the port | **MET** | "is annotated read-only, and is the only tool registered"; the server registers it only when `health` is supplied |
| AC-11 `readOnlyHint: true` | **MET** | same test, read from the protocol's own tool listing |
| AC-12 no credential or connection string | **MET** | "leaks no credential or connection string" — no `postgres://` and no `password` anywhere in the response |
| AC-13 no capability list, no provider state | **MET** | "carries no capability list and no provider state" — and the response points at `ferret_providers` instead |
| AC-14 no `ferret_tools` catalogue | **MET** | the tool listing is exactly `['ferret_health']` |

Fourteen of fourteen MET. `npm run verify` green: 148 files, 3 061 passed,
3 skipped.

## Found while implementing

**A port was a boundary requirement, not a preference.** `probeHealth` lives in
`src/cli/health.ts`, and `boundaries.test.ts` asserts that no MCP module reaches
a CLI one — so `ferret_health` could not call it even though it is exactly the
right function. `HealthAccess` is two functions supplied by the composition
root, which is the same shape EPIC-066 used for `configuration` and EPIC-067 for
`providers`, and here it is forced rather than chosen.

**The inventory and the report fail independently.** `probeHealth` needs no
database — Governance §20 requires it to work when things are broken — but
`readInventory` does. So a failing inventory is reported as an **absence with a
reason** rather than failing the call, which is the same shape §8.3 requires of
a check that could not run. A test asserts the driver's message ("relation does
not exist") is not what a client is handed.

**The boundary gate refused the inventory *type*.** `boundaries.test.ts` failed
two ways — "builds on retrieval and context, not on storage" and "adds nothing
beyond the MCP SDK and the core set" — because importing `IndexInventory` from
`src/storage/` pulled Drizzle and `pg` into the MCP layer's package set. A type
import is enough to do that. `IndexCounts` is declared in the port instead,
structurally identical so the composition root passes EPIC-095's inventory
straight through, and this layer depends on a shape rather than on a store. The
gate found it; nothing about the tool changed.

**`DependencyStatus` has no `FAILED`.** It is `ok`, `degraded`, `unavailable`,
`unknown` — a four-value vocabulary, and `unavailable` is the one that means
"this is not working". Worth recording because a fifth value invented in a test
compiles nowhere, and the absence of `failed` is deliberate: EPIC-004 chose
`unavailable` because a *dependency* is not available, which is a fact about the
dependency rather than a verdict on Ferret.

## Decisions worth recording

**Readiness and capability are different questions, and the response says so.**
EPIC-067's `ferret_providers` answers *what can this Ferret do, and which
provider is stopping it*. This answers *is this Ferret working, and is there
anything in it*. §8.4 states the boundary and the response carries a line
pointing at the other tool, because two tools that both drifted toward
"everything about the server" would end up disagreeing and a client would have
no way to know which to trust. A test asserts this response carries no
capability list and no provider state.

**Tool discovery is MCP's, and Ferret does not reimplement it.** `listTools` is
the mechanism and every tool already carries a description written for a client.
A `ferret_tools` catalogue would be a second copy maintained by hand, and the
failure mode of a second copy is that it goes stale silently. So "capability
discovery" in this Epic's title means *what this Ferret can do right now* — a
runtime question — and AC-14 asserts no catalogue exists.

**The empty-index notice is the point of the tool.** An empty index and an
unmatched query look identical from a result set, so a client that cannot tell
them apart will report "nothing matched" for a Ferret that has never been run.
The notice says which it is, and says an empty index is *not a failure*.

## Issue #117 fixed in the same change set

**The sweep it asked for now exists.** EPIC-076 named the class of defect and
had no scope to fix it: *"Nothing sweeps limitation tables for records the code
has outgrown, so the next stale one will also wait for an Epic to be pointed at
it."* `tests/unit/limitation-owners.test.ts` is that sweep.

It reads every validation document's limitation tables, takes the **owner** cell
— a cell that is *entirely* bolded Epic references, which is how these documents
spell an owner — and checks the registry's status for each.

Two things it found, and one it corrected in itself:

1. **A first draft matched every `EPIC-0NN` inside a limitation section and
   found 291**, almost all references to another Epic's *reasoning* rather than
   a promise it would do work. A ceiling of 291 asserts nothing, so the sweep
   was narrowed to the owner cell — which is the thing that is actually a
   promise.
2. **72 owner cells name an Epic the registry now records as closed.** Most were
   correct when written and the owner has since **delivered** the work: "no
   traversal depth or cycle protection → **EPIC-050**" is a row EPIC-050 closed.
   Those should be *struck*, not re-owned, and striking each needs a reader to
   confirm the work actually landed — 72 judgements across forty documents, not
   a mechanical rewrite.

So the gate **pins the count at 72** rather than asserting zero. A 73rd fails
the build, which is the whole ask: the next stale row now fails a test instead
of waiting for someone to read it. Striking one also fails, deliberately — the
number coming down is a good change and still a reviewable one.

What the sweep **permits** is a limitation with no owner at all, which is issue
#117's own distinction: an unowned row is an honest absence, and that issue left
three of them `unassigned` rather than guessing. A row pointed at a closed Epic
is a promise nobody is keeping; a row pointed at nothing is a question nobody
has answered. Only the first is a defect.

The issue's three unowned rows are **not** resolved here — they need an owning
Epic, existing or new, which is a governance decision and not a test.

## Limitations, recorded

- **An AI client still cannot index.** No MCP tool starts an index run, and this
  Epic does not add one: an index is a long operation with no progress channel
  in MCP, and a tool that returned before finishing would report success for
  work that had not happened. EPIC-059/065's row is now closed for *configure*
  and *manage*; **index** stays open with no owner.
- **`probeHealth` opens its own connection**, so each call costs a connect. That
  is EPIC-004's design, unchanged, and another reason §4 declines polling.
- **The inventory is counts, not coverage.** "Is this repository fully indexed"
  needs a comparison against the source that only an index run performs.
- **No per-repository health.** The report is Ferret-wide; EPIC-078's drift
  report is the closest thing and it is CLI-only.
- **72 stale limitation owners remain**, pinned rather than struck. The sweep
  makes the next one visible; it does not do the 72 judgements.
