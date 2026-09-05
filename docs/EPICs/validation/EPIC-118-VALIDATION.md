# EPIC-118 — Ferret Self-Dogfood: validation evidence

**Status: VALIDATED** · one defect found by running Ferret against Ferret, one
found while fixing it, no schema change and no migration. The dogfood oracle now
agrees with `git` on every question it asks, including the one it had been
failing itself on.

## Environment

| | |
| --- | --- |
| Tree | `69d97e9` (`main`, both of its own CI runs green) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | Real MCP over `InMemoryTransport` for the surface; real stdio for the oracle |
| Database | PostgreSQL 17.11 + pgvector 0.8.6; per-file test databases, and the persistent dogfood container for the oracle |
| Repository under test | This one — 830 tracked files at `69d97e9` |
| Date | 2026-09-05 |

## What the Epic does

`ferret_find` gains an `offset` and reports a `nextOffset`, so a repository
larger than one page can be enumerated through the agent-facing surface. The
paged query's ordering was made total first, because `OFFSET` over a
non-deterministic order is not paging.

## The defect, measured before and after

The oracle is `scripts/dogfood.mjs`: it indexes this repository with the built
CLI, asks its questions over MCP as a real client, and checks every answer
against `git`. Run against `69d97e9` with content indexing on, **before** the
change:

```
  ok    repository indexed  (Ferret)
  FAIL  the file list is complete
        ferret_find returned a full page and offers no cursor, so the remaining
        files cannot be enumerated and the checks below are running on a
        truncated set.
  ok    no phantom files  (487 active)
  ok    structure recorded  (145 source files)
  FAIL  no missing files
        343 tracked file(s) absent from the index: src/mcp/session-tools.ts,
        src/observability/index.ts, ...
  2 finding(s). Ferret disagrees with the repository.
```

**487 + 343 = 830**, exactly the tracked-file count. The index was complete and
the retrieval was truncated, and the second finding is what that looks like from
a client: not a short answer but a confident claim that 343 files are missing.
`ferret_find` returned 500 rows — 487 `active` and 13 tombstones — and had no
way to be asked for the rest.

After, on the same index:

```
  ok    the file list is complete  (844 entities over 2 page(s))
  ok    no phantom files  (830 active)
  ok    structure recorded  (457 source files)
  ok    no missing files  (830 tracked)
  Ferret agrees with the repository on every question asked.
```

`830 active` against `830 tracked`, and `457` source files carrying EPIC-030
structure where the truncated read had seen 145. Exit 0.

## The second defect, and why its test is source-level

Paging over `ORDER BY e.kind, e.source_id` is unsound: nothing constrains that
pair to be unique. Measured on Ferret's own index rather than argued:

```
SELECT kind, count(*) FROM (
  SELECT kind, source_id FROM ferret.entity
   GROUP BY kind, source_id HAVING count(*) > 1) t GROUP BY kind;

    kind     | tied_groups
-------------+-------------
 code_symbol |         178
```

178 tied groups, all `code_symbol` — whose source id is the symbol's name, so
every name declared in two files ties. Files do not tie. PostgreSQL may order
tied rows differently between two executions, which is invisible within one page
and corrupting across a boundary. `e.id` — the primary key — was appended, which
makes the order total by construction.

**The behavioural test for this does not work, and that was measured.** With the
tiebreak reverted, `enumeration.test.ts`'s tie case still **passed**: on a
four-row table PostgreSQL returns insertion order. The reordering is latitude
the planner has, not behaviour it always exhibits, and a test that passes either
way is not a control. So the control is source-level —
`tests/unit/paged-ordering.test.ts` asserts that every query in
`src/storage/retrieval.ts` carrying an `OFFSET` orders on a unique column last,
on the precedent of `mcp-destructive-tools.test.ts` and `boundaries.test.ts`.
Verified in both directions: it fails with the tiebreak removed —

```
AssertionError: paged query orders by "e.kind, e.source_id", which ties
```

— and passes with it restored. The behavioural case is kept anyway, because
"every tied row is reached exactly once" is worth asserting whatever the planner
chooses to do.

## Acceptance criteria

| # | Criterion | Result |
| --- | --- | --- |
| 1 | The whole repository is reachable | **MET** — oracle: 830 active vs 830 tracked, 844 entities over 2 pages |
| 2 | A larger answer offers the next page; paging reaches everything exactly once | **MET** — `tools.test.ts`, `enumeration.test.ts` |
| 3 | `nextOffset` advances by page size, not by surviving rows | **MET** — asserted with 4 rows withheld |
| 4 | A withheld row is not a next page | **MET** — `truncated` true, `nextOffset` absent |
| 5 | The last page says so; an offset past the end returns nothing | **MET** |
| 6 | The paged query orders totally | **MET** — source-level control, verified failing without the fix |
| 7 | Paging is confined to one source | **MET** — two repositories, neither bleeds into the other |
| 8 | Provenance is identical on every page | **MET** — source system, scope, id, path and content hash asserted on all pages |
| 9 | Re-indexing changes neither membership nor order | **MET** |
| 10 | Add, change and delete past the first page are visible | **MET** — tombstone `deleted`, `active` filter excludes it |
| 11 | A negative offset is refused, not clamped | **MET** — schema rejects it |

## Measured runs

| Suite | Result |
| --- | --- |
| `tests/unit` (92 files, includes `paged-ordering.test.ts` and `boundaries.test.ts`) | **2224 passed**, 50.1 s |
| `tests/integration/mcp` + `retrieval` + `indexing` (19 files) | **389 passed**, 303.3 s |
| `tests/integration/mcp/tools.test.ts` alone | **84 passed**, 199 ms |
| `tests/integration/retrieval/enumeration.test.ts` alone | **11 passed**, 17.9 s |
| `tests/integration/storage` + `tests/security` (43 files) | **547 passed**, 183.4 s |
| `npm run lint`, `npm run typecheck`, `npm run build` | clean |
| `node scripts/dogfood.mjs --check --content` | **exit 0**, every check `ok` |

## What was not done, and why

- **No cursor and no snapshot.** An offset over a total order is exact for an
  index that is not being rewritten under the reader. Making a multi-page read
  consistent *during* an index run is a product decision about what a client may
  see mid-write, and this Epic did not take it. Recorded as a limitation.
- **`byIdentifier` still orders on the untotal key.** It does not page, so no
  row can cross a page boundary; the only effect is which of two tied hits is
  listed first. It is EPIC-055's query, and changing it here would put another
  Epic's behaviour in this one's diff.
- **The dogfood run is not a CI gate.** It needs a database, a built CLI and a
  full index of this repository. EPIC-114's scheduled lane is the shape that
  would fit; spending a runner on it is a decision.

## A records gap this Epic observed and does not own

EPIC-113, 114, 115, 116 and 117 are **absent from the registry catalog**. The
[roadmap's completion record](../ROADMAP.md#completion-record) carries all five
with their commits, PRs, merges and validation records; the catalog — the
authoritative delivery map — does not mention them. This is the same shape as
the [catalog reconciliation of 2026-09-05](../README.md#catalog-reconciliation--2026-09-05),
which closed the identical gap for EPIC-109 through EPIC-112.

It is recorded rather than fixed: five Epics' catalog entries are not this
Epic's scope, and adding them silently inside a dogfooding change would be the
kind of unrecorded scope this project's governance exists to prevent.

## Honest recording

This document was written alongside the work, not after it. Every number above
was produced by a run on this tree; nothing is carried forward from an earlier
record. The before/after oracle output is quoted from two runs against the same
index, differing only in the build under test.
