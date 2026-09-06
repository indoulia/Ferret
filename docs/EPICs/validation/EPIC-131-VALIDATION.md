# EPIC-131 — Context Assembly: validation evidence

**Status: VALIDATED** · a real task question that reached **none** of the seven
statements about it now produces a package of **five**, ordered by what acting
against each one costs. **No migration.**

## Environment

| | |
| --- | --- |
| Tree | `8830d20` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | `ferret-dogfood`, PostgreSQL 17 + pgvector |
| Date | 2026-09-06 |

## The task

> Should CI add a macOS runner for the storage suites?

Against seven durable statements this repository actually records about its own
CI, across `EPIC-105`, `EPIC-115`, the roadmap and an agent memory file.

## Before

```
durable context stored                            7
standing context in the package                   0
source records in the package                     3
```

**None.** The strict query is `'ci' & 'add' & 'maco' & 'runner' & 'storag' &
'suit'` and no statement contains all six; it matched one incidental commit.
The planner's own widening did not fire either, because it relaxes only when
*nothing* matched and something had.

The surface whose whole purpose is task-readiness was the one that could not
find the context bearing on the task.

## After

```
standing context in the package                   5
source records in the package                     3
estimated tokens                          1998 of 2000

what Ferret currently holds, in the order it gives:
  constraint   authority 60    support=1 (+2 restated)
  decision     authority 20    support=1
  gotcha       authority 20    support=1
  fact         authority 60    support=1
  next-step    authority 20    support=1

rendered: constraints appear before records     true
rendered: statements stay contained             true
rendered: notice precedes everything            true
```

Five entries from seven statements: three wordings of one constraint arrived as
**one**, carrying `+2 restated` — the fold EPIC-130 computed, consumed rather
than re-decided.

The constraint carries **authority 60** (`parsed`) against the agent memory
file's `asserted` 20, so what Ferret read outranks what it was told, inside the
package as everywhere else.

## What the ordering is, and is not

```
constraint → decision → gotcha → preference → fact → next-step
```

Not a relevance weight. An ordering by **what acting against one costs**:
breaking a constraint is worse than contradicting a decision, which is worse
than being ignorant of a fact. Current always precedes historical — a superseded
constraint is not a constraint any more.

Relevance is deliberately not a key. Retrieval already decided which of these
belong to the question; re-ranking by score would put a well-worded fact above a
constraint.

## A change tried, measured, and reverted

The first attempt wired `ContextPackBuilder` to `QueryPlanner`, on the reasoning
that the planner already owns widening and records the same finding —
*"`tombstone` found a result, 'how are deleted files tombstoned' found
nothing."*

**It did not work, and the dogfood said so:** still zero standing context. The
planner relaxes only when the strict query returns *nothing*, and here it
returned one incidental commit.

Reverted rather than kept. Shipping it would have been a behaviour change to
`ferret_context_pack` whose stated motivation the measurement had already
disproved. The fix that replaced it is narrower: one widened query, restricted
to durable context, inside assembly only. `ferret_search` is untouched.

## A defect the suite found

`#standingFor` trusted `RetrievalPort` to honour its `kinds` filter, and the
pack's own unit fixtures do not filter — so a `commit` reached
`durableContextOf` and threw `Entity c1 is not durable context`, failing 38
tests.

The port is a port: a build may satisfy it with a fixture, a cache or a future
adapter that does not filter by kind. The read now filters defensively, which is
the correct posture at a boundary rather than a workaround for a test double.

## A flake observed, diagnosed, and made legible — not hidden

One full-suite run failed `reconcile.test.ts` at `JSON.parse(result.stdout)`,
on a run that took **787s against a usual ~520s**. It passes in isolation, and
this Epic touches nothing `reconcile` uses.

**Not recorded as "a flake" and moved past.** The mechanism is legible:
`runCli` kills a command after 30s, `execFile` reports a killed process with
`killed: true` and **no numeric `code`**, and the old shape flattened that to
`code: 1` with empty stdout. A caller then saw `JSON.parse('')` throw a bare
`SyntaxError` naming a character position.

That is issue #61's own finding — *"`git init` fails in test fixtures under
full-suite load, **and the reason is discarded**"* — one layer up, in the
harness rather than the fixture.

**The timeout was not raised.** Raising it would hide the next one. What changed
is that a failure now names itself:

- `CliResult` carries `timedOut` and `signal`, so every call site can tell "the
  command failed" from "the harness stopped waiting".
- `parseEnvelope` reports the command, whether it timed out and after how long,
  the exit code, the first 400 bytes of stdout and the last 400 of stderr —
  with the parse error attached as `cause` rather than replacing it.

**Cause not established** for this occurrence, and it has not recurred; a
timeout under contention is the shape the evidence fits. The instrumentation is
what the next occurrence needs, and it is now in place.

## Suites

| Suite | Result |
| --- | --- |
| `tests/unit/context-standing.test.ts` | 12 passed |
| `tests/integration/retrieval/task-assembly.test.ts` | 7 passed |
| `tests/unit/context-pack.test.ts` | 40 passed |
| `tests/integration/mcp/*` · `tests/security/*` | 408 passed together |
| `tests/integration/indexing/reconcile.test.ts` | 11 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
