# Can a fresh agent find the durable context? — the decision, and what it cost

**Store:** `ferret_continuity`, created and dropped by the harness, 27 graded
statements, 0 padding · **Command:** `node benchmark/continuity/run.mjs
--repository --padding 0`, content indexing on · **Date:** 2026-09-07

Two runs, differing in one file. `results/discoverability-before.json` was
measured with `src/mcp/server.ts` reverted to `947c3d5` and everything else at
this tree; `results/discoverability-after.json` with the change in. The tree
therefore differs between the runs by the file the change is in — and §6 shows
that cost nothing measurable: every condition the change does not touch is
identical across the two runs, task by task, to the token.

---

## 1. The question the last phase left open

`FERRET-DOES-CONTEXT-CARRY.md` §2 closed on a finding it deliberately did not
act on. Over a store holding this repository beside twenty-seven durable
statements, `ferret_search` went from 93% sourced to **0%** and from 2 659 tokens
a task to 17 143; the same query with `kinds: ['context']` was byte-identical, on
all fourteen tasks, to the arm with no repository in the store at all. Nothing
was wrong with the ranking, the store or retrieval. The durable statement was
unreachable *by default* and one argument away from being reachable, and the
tool's description never said the argument existed.

Three responses were on the table, and the smallest justified by the evidence was
to be chosen without implementing the others:

1. document `context` as a searchable kind,
2. include or rank durable context in ordinary search automatically,
3. make `ferret_context_pack` the recommended task-oriented surface.

## 2. What the surface actually published

Inspected before anything was decided, by asking a running server for its tool
list rather than by reading the source — what an agent gets is `tools/list`.

Three of the thirty tools name durable context in their description:
`ferret_context_find`, `ferret_context_trust`, `ferret_context_promote`. The
first is a read that needs no identifier — *"List the durable context Ferret
currently holds, newest first"* — and it has been published since EPIC-129.

**So the phase's question already had a yes in it.** An agent that reads the tool
list had a working path to durable context without knowing that `context` is an
entity kind, and the honest form of the previous finding is narrower than "a
fresh agent cannot reach durable context". What was true is that an agent that
reaches for `ferret_search` could not, because:

- `ferret_search`'s description enumerated what it searches and durable context
  was not in the list: *"commit messages, file paths, branch names and recorded
  evidence"*. That was **incomplete rather than a preference** — search does
  search durable context, which is why the restricted query works.
- Its `kinds` argument named four kinds, all built-in: *"Restrict to entity kinds
  such as commit, file, branch, developer."*
- `context` is a **registered** entity kind, not a built-in one.
  `src/context/durable.ts` registers it; `EntityKind` does not contain it. It
  appears in no enum, schema or example a client can see, so there was no
  surface an agent could have derived it from.
- `ferret_context_pack` said *"the most relevant indexed knowledge for a
  question"* and never said durable context is kept ahead of repository
  material — which EPIC-131 built it to do and the previous report measured it
  doing.

## 3. The decision, and why not the other two

**Documentation.** Two incomplete descriptions and one silent guarantee, all
three describing behaviour that already exists.

**Automatic inclusion or ranking in ordinary search — rejected.** It fails the
constraint this phase set, and the evidence does not ask for it:

- **There is no ranking defect to fix.** `kinds: ['context']` was byte-identical
  to a store with no repository, on all fourteen tasks — same lists, same
  scores, same token counts. The mechanism works; only the routing to it did
  not.
- **The task surface already does this, deliberately, and only there.**
  `ferret_context_pack` admits standing context to the budget before repository
  items: 78 standing entries in both arms of the previous A/B, identical order,
  task by task, while whole results were being cut to fit. `src/context/pack.ts`
  states the boundary in as many words — *"the standing read widens
  deliberately, and only here… `ferret_search` is untouched"*. Moving that into
  `ferret_search` would relitigate a decision the code records, and no
  measurement here asks for it.
- **It is a ranking-policy change with nothing measured behind it.** Reserving
  slots in a general search for one entity kind would spend them on every query
  that is not a knowledge question, and this phase measured no query of that
  shape. What the evidence supports is telling an agent which argument to pass,
  not deciding for it.

**Making the pack the recommended surface — collapses into the first.** The pack
is already the question-shaped surface and already prioritises durable context.
What was missing was that its description did not say so, and that
`ferret_search`'s did not point at it. That is a sentence in the same change
rather than a competing approach. It is *not* recommended as the only surface:
`ferret_context_find` sources more than the pack does (§6), and declaring one
canonical surface is not supported by anything measured here.

### Dogfooded, and it corrected one of these arguments

An earlier draft of this section argued that unrestricted search is *currently
correct* on this repository's own index, where the durable tier holds three
records rather than twenty-seven, so a changed default would break something
that works. Dogfooding it did not survive:

| question asked of the dogfood index | unrestricted, top 5 | `kinds: ['context']` |
| --- | --- | --- |
| phrased in the statement's own words | `context, context, file, file, file` | 3 statements |
| *"how is durable context reached through search when a repository shares the store"* | five files | 1 statement |
| *"was the fix for search routing the tool description"* | five files | 1 statement |

So the gap is not an artefact of a large corpus. Ranking is lexical, and on
**two of three** questions a store holding *three* durable records and this
repository returned no durable context at all unrestricted, and returned it
restricted. That strengthens the case for saying which argument to pass and
leaves the case against changing the ranking where it was.

## 4. The change

`src/mcp/server.ts`. No behaviour, no schema, no ranking, no new field.

- `ferret_search`'s description adds durable context to what it searches, and
  says which argument reaches it and which tool to prefer for a task-shaped
  question.
- Its `kinds` argument keeps the four examples it had and gains a sentence
  naming `context` as the kind holding durable statements, and why to restrict
  to it.
- `ferret_context_pack`'s description says durable context comes first and that a
  repository indexed beside it cannot crowd the standing statements out.

`src/mcp/server.ts:358` was the only site in the codebase that enumerated entity
kinds to a client. `ferret_find`'s `kind` argument carries no description and was
left alone: durable context has a dedicated exact-lookup tool that is already
described, and what the evidence measures is the ranked surface.

## 5. The benchmark: two conditions that have read nothing but the tool list

`ferret-search-context` passes `kinds: ['context']` because whoever wrote the
harness had read `src/context/durable.ts`. No agent has that. So that condition
is the **oracle** — the ceiling — and two new conditions measure how much of the
ceiling the published surface hands to an agent that has read nothing but
`tools/list`. Both rules are fixed in `run.mjs` and run unchanged against
whatever the server says, which is what makes a before/after of the *surface*
mean anything:

- **`ferret-surface-kinds`** searches restricted to the kinds the `kinds`
  argument's own description names *in a sentence mentioning "durable"*.
  Restricting to every kind a description lists is the same query as restricting
  to none, so what an agent needs is not a list but which one to ask for. When
  the rule finds nothing the agent has nothing to restrict to and searches
  unrestricted — which is `ferret-search`, deliberately: that is what an agent
  does when the description does not tell it otherwise.
- **`ferret-surface-tool`** picks a *tool*: among read-only tools whose
  description names durable context, the one accepting a whole question, else the
  one callable without an identifier the agent does not hold. This is the
  condition that keeps the phase honest — `ferret_context_find` satisfies it
  before the change as well as after.

What the surface said is recorded in each artefact beside what it produced, so
the two numbers do not have to be taken on trust:

```
before   {"alpha": {"kinds": [],          "tool": "ferret_context_find"}, "beta": … }
after    {"alpha": {"kinds": ["context"], "tool": "ferret_context_pack"}, "beta": … }
```

**Neither rule is a model, and that is the sharpest limit on this measurement.**
What they show is that the routing an agent needs is stated where the agent is
looking, and that acting on the statement recovers the answer. Whether a model
reads a tool description and follows it is not measured here, and no condition in
either benchmark measures anything of that shape. The `kinds` rule is also
asserted in `tests/integration/mcp/tools.test.ts`, so a rewording that stops
satisfying it fails CI rather than quietly moving a number here.

**Scoring was not changed to improve the result.** One classification was
corrected, and it moved a number *against* the change. `unranked` — which refuses
a rank-order metric to a condition that ranked nothing — was applied by condition
name, and `ferret-surface-tool` is the first condition whose behaviour depends on
the surface. Name-based, it graded the identical call `ferret-find` makes through
a five-result window and scored it 64% sourced against that condition's 100%.
The classification now follows what a condition did, which raised the *before*
figure to 100%. Recorded in the benchmark's own corrections.

## 6. Before and after

Fourteen tasks, 27 statements, this repository indexed beside them, content on.
`sourced` is whether the labelled answer was in front of the agent; `answered` is
whether the facts an answer needs were; tokens are per task.

| condition | sourced | answered | facts | tokens/task | p50 |
| --- | --- | --- | --- | --- | --- |
| `ferret-surface-kinds` — an agent that reaches for search | 0% → **93%** | 0% → **57%** | 2/26 → **19/26** | 17 143 → **2 659** | 256 → 17 ms |
| `ferret-surface-tool` — an agent that reads the tool list | 100% → 93% | 64% → 64% | 21/26 → 20/26 | 2 999 → 2 612 | 83 → 85 ms |
| `ferret-search` *(habit, control)* | 0% → 0% | 0% → 0% | 2/26 → 2/26 | 17 143 → 17 143 | 266 → 186 ms |
| `ferret-search-context` *(oracle, control)* | 93% → 93% | 57% → 57% | 19/26 → 19/26 | 2 659 → 2 659 | 28 → 17 ms |
| `ferret-pack` *(control)* | 93% → 93% | 64% → 64% | 20/26 → 20/26 | 2 612 → 2 612 | 129 → 94 ms |
| `ferret-find` *(control)* | 100% → 100% | 64% → 64% | 21/26 → 21/26 | 2 999 → 2 999 | 87 → 57 ms |

The notes conditions never touch the store and are unchanged in both runs; they
are omitted. Isolation holds 6/6 and the resume probe is identical in both runs.

**The search path was closed and is now open, at the oracle's price.**
`ferret-surface-kinds` after the change is identical to `ferret-search-context`
**task by task** — the same ranked lists, the same returned counts, the same
sourced and facts figures, the same 2 659 tokens. The argument an agent derives
from the description is now exactly the argument someone who had read
`src/context/durable.ts` would pass. Before the change it was identical, task by
task, to unrestricted `ferret-search`. Both identities were checked rather than
assumed.

**The controls hold, and they hold harder than expected.** The two runs index
trees that differ in `src/mcp/server.ts`, so a condition reading repository
content could have moved for that reason alone. None did: `ferret-search`,
`ferret-search-context`, `ferret-pack` and `ferret-find` are identical across the
two runs, task by task, on every field. The arms therefore differ by the surface
and by nothing else — measured, not argued.

**The tool-list path moved, and it is a trade rather than a win.** Before the
change the rule landed on `ferret_context_find`; after it, `ferret_context_pack`
also names durable context and accepts a question, so the rule prefers it. That
costs **7 points of `sourced`** — one task's labelled answer is outside the
pack's budget where a whole-store read returns it — for 13% fewer tokens at this
store size. The case for it is scale rather than this table: across the 5.6×
store sweep in the previous report, the pack grew 14% and a whole-store read grew
nearly fivefold, ending at 1 259 tokens a task against 14 694. `answered` is
unchanged at 64%, which is the figure a model would act on.

## 7. What the evidence says

**Proven.**

- **A fresh agent could already reach durable context, and now can by either
  route.** `ferret_context_find` was published, described in terms of durable
  context, and needs nothing an agent has to have read the source to know —
  100% sourced, before the change. The question's answer was already *yes* for
  an agent that reads the tool list.
- **The search route was genuinely closed, and the fix opens it fully.** 0% →
  93% sourced, 0% → 57% answered, 2 of 26 facts → 19, and 6.4× cheaper per
  task. Identical to the oracle condition, task by task.
- **Nothing else moved.** Four control conditions identical across two runs on
  every field, task by task; isolation 6/6 in both; the resume probe identical.
  Retrieval semantics, provenance, permissions and lifecycle are untouched
  because no code that implements them was touched.

**Not proven.**

- **That a model reads a tool description and acts on it.** The surface-derived
  conditions show the routing is stated where an agent is looking and that
  acting on it works. No model is in this loop, here or anywhere in either
  benchmark, and this is the assumption the whole change rests on.
- **That the routing sentence is the best wording.** One wording was measured.
  Whether a different one would be followed more often by a real model is not
  something a fourteen-task harness with no model in it can say.

**Disproven, or corrected.**

- **That the previous report's finding meant durable context was unreachable to
  a fresh agent.** It was reachable, by a tool published since EPIC-129 and
  described in the words a fresh agent would search the tool list for. The
  finding was about one surface, and this report narrows it to that.
- **That the gap needs a large corpus to appear.** Dogfooded against a store
  holding three durable records, two of three questions returned five files and
  no durable context unrestricted, and returned the statement restricted.

## 8. Remaining product decisions

**One this change created.** The tool-list route now prefers
`ferret_context_pack` over `ferret_context_find`, at −7 points of `sourced` and
in exchange for growth that is 14% rather than 400% across a 5.6× store. That
trade was made by a description, and an owner who wanted completeness ahead of
scale would word it the other way. It is visible in one table cell rather than
buried, which is the point of measuring it.

**Three the previous report left, unchanged by this one.** Durable context
carries no reasoning and promotion drops it; promotion's granularity is the whole
session; convergence is lexical and does not reach a genuine reword. Nothing here
touched any of them.

**And the limit this phase could not cross.** Every number above says a surface
states something and that acting on the statement works. The thing an owner
actually wants to know — whether an agent that has read the description reaches
for the right argument — needs a model in the loop, and neither benchmark has
one. That is the next measurement, and it is a different kind of harness from
either of these.
