# Does removing the measured delivery overhead help a real agent? — the measurement

**Question:** after making a context pack cost what it says and letting a search
be bounded, does a fresh AI agent do materially better engineering work with
Ferret?

**Epic:** EPIC-136 §4.1, §4.2 · **Harness:** `benchmark/agent/` unchanged from
Phase 5 · **Date:** 2026-09-07

**Answer: no — and this experiment cannot detect an effect of the size the
change makes.** That second clause is the finding. It is stated first because a
reader who takes only the headline should take the limitation with it.

This report is on both corpus exclusion lists, before it was written, for the
reason `benchmark/lib/identity.mjs` gives.

---

## 1. What Phase 6 was, and what it was not

Phase 5 measured a fresh agent with and without Ferret and found no correctness
difference, a halving of rediscovery cost, and a **context cost that cancelled
the halving**. Three delivery defects were recorded as EPIC-136 rather than
fixed inside benchmark work, on EPIC-135's precedent.

The owner approved EPIC-136 as the whole of Phase 6, capped at §4, and directed
that the same A/B be re-run afterwards to answer one question: **does removing
the measured delivery overhead produce an agent-level advantage?**

It does not, on this evidence — but §4.3, the item that carried almost all of
the overhead, was withdrawn mid-phase (§3), so what was actually tested is the
smaller two-thirds.

## 2. What shipped, measured directly

Not through an agent. `benchmark/agent/delivery.mjs` and
`benchmark/agent/surface.mjs` produce these reproducibly against a running
server, and both write their results beside this report.

### 2.1 A pack now costs what it says — §4.1, AC-1 and AC-2

| question, `budget: 4000` | before | after |
| --- | --- | --- |
| "Should a macOS runner be added?" | claims 3971, sends **5438** | claims 3783, sends **3779** |
| "Where does a session decision become readable…?" | — | claims 3818, sends 3812 |
| "What does the exclude configuration key do?" | — | claims 3890, sends 3886 |

Drift falls from **37% over** to **0.1–0.2%**, and every pack now lands inside
the budget it was given. Two causes, both fixed: the envelope around the items
— content notice, provenance, omission list, safety report — was never charged
for, and the transport pretty-prints while the estimate counted compact JSON.
One `MCP_JSON_INDENT` constant is now shared between the serializer and the
estimator so they cannot drift again.

**AC-2 was restated during implementation, because I wrote it wrong.** "Never
exceeds its *requested* budget" is unachievable: a pack's fixed fields cost ~470
estimated tokens before an item is in it, and a caller may ask for less.
`tests/integration/retrieval/task-assembly.test.ts` asked for 400 and was being
sent 599 — silently — before this change. A request below `MIN_BUDGET` (800) is
now raised to it and **told so**; asking for 100 returns a pack reporting
`budget: 800`, delivering 658, carrying an omission that says the budget was
raised. The promise that holds for every request is `estimatedTokens <= budget`.

### 2.2 A search can be bounded — §4.2, AC-3

| `ferret_search`, `limit: 20` | delivered | results | dropped |
| --- | --- | --- | --- |
| unbounded (default, unchanged) | 32 152 tokens | 20 | 0 |
| `maxTokens: 4000` | **2 295** | 4 | 16, reported |
| `maxTokens: 8000` | 4 274 | 5 | 15, reported |

The default is deliberately unchanged — §5 puts changing a published default out
of scope. What this fixes is that a Phase 5 session asked one question at
`limit: 20`, had the 32 000-token result truncated to a file by its client, and
could not open the file. `budget.ts` names that failure exactly: *"the client
truncates … and the thing that gets cut is not the thing Ferret would have
chosen to cut."* Now Ferret does the cutting, from the bottom of the ranking,
and says how much.

## 3. What was withdrawn, and why it matters most

**§4.3 — the tool surface — was implemented, measured, and reverted the same
day.** Publishing a tool only to a principal holding its permission cut the
surface for a read-only principal from **30 tools to 15**, and from **~14 984 to
~8 398 estimated tokens** — ~6 600 tokens on *every turn*, since a tool list is
part of the request prefix.

It also breaks four accepted contracts. EPIC-066 AC-6, EPIC-067 AC-12, EPIC-068
AC-5/AC-6 and EPIC-117 AC-5 each independently require that a tool be **callable
and informatively refusable** by a principal lacking its permission. An
unpublished tool answers `MCP error -32602: Tool not found`, which names no
permission and cannot be told from a missing feature. My first attempt patched
this by always publishing `read` tools; that fixed one family of four, and the
full suite found the other three.

EPIC-136 §9 already forbade it — *"Nothing in this Epic may reduce what a caller
is told about what was withheld"* — and those four Epics are where that rule is
written down.

**So the thirty-tool surface is the price of a diagnostic guarantee.** The owner
declined to weaken the permission model, to accept "Tool not found", or to
broaden the Epic into consolidation or deferred loading. Recorded as EPIC-136
§4a:

> The MCP tool surface has a measurable per-turn context cost, but reducing that
> surface while preserving informative authorization failures requires a
> different design decision than EPIC-136 currently scopes.

**This is why Phase 6's agent-level result is close to a foregone conclusion.**
The item withdrawn was worth ~6 600 tokens a turn; the items that shipped are
worth ~1 750 tokens per pack call, and the treatment made 3.3 pack-and-search
calls a task against ~470 000 context tokens. Under 2%.

## 4. A fourth delivery cost, recorded and not acted on

Every MCP tool result is serialized `JSON.stringify(result, null, 2)`. The
indentation is roughly **17% of every JSON response Ferret sends** — it was the
whole of the gap between what a pack estimated and what it delivered. A model
does not need it. Removing it would save that 17% across every tool, not only
the pack, but §5 excludes changing a default format, so the estimate now counts
the indentation honestly instead. EPIC-136 §4b, for a decision this Epic does
not carry.

## 5. The retrieval benchmarks moved as predicted — AC-6

Predicted in writing before the runs, and recorded rather than tuned.

| | Phase 5 | after §4.1 |
| --- | --- | --- |
| task bench, `ferret-pack` sourced | 26% | **21%** |
| task bench, `ferret-pack` recall | 0.22 | 0.18 |
| task bench, `baseline` | 42% | 42% |
| task bench, `ferret-search` | 42% | 42% |
| continuity, `ferret-pack` sourced / answered | 93% / 64% | **93% / 64%** |

At budget 4000 over a repository the pack used to fit six items by delivering
5 438 tokens against a claimed 3 971. It now fits three or four and delivers
what it says, so `sourced` — which needs every relevance-3 artefact inside the
window — falls. **The 26% was never real; it was 37% of unbilled context.**
EPIC-136 AC-6 says a number moving against Ferret here is the fix working, and
the benchmark was not adjusted to recover it.

On the continuity store nothing moves, and the reason is worth keeping: that
store holds short durable statements and no repository, so its packs were
already far under budget and the envelope charge displaces nothing. **The fix
costs nothing where the pack was not at its ceiling.**
## 6. The eight-task A/B, re-run identically

Same questions, same rubric, same verdict option sets, same control, same corpus
guard, same `regrade.mjs` so scoring cannot drift. Sixteen sessions, Claude
Opus 5 at high effort, one repeat — as in Phase 5.

| measure | control P5 → P6 | treatment P5 → P6 |
| --- | --- | --- |
| **verdict correct** | 100% → **100%** | 100% → **100%** |
| facts complete | 75% → 88% | 88% → 75% |
| evidence sourced | 88% → 88% | 75% → 63% |
| primary artefacts cited | 88% → 94% | 75% → 75% |
| stale asserted | 0% → 0% | 0% → 0% |
| unsupported citations | 0 → 0 | 0 → 0 |
| tool calls / task | 20.9 → 25.3 | 17.8 → 21.8 |
| files read / task | 6.1 → 5.4 | 2.9 → 4.1 |
| lines read / task | 807 → 617 | 355 → 412 |
| searches / task | 10.0 → 13.3 | 7.9 → 8.0 |
| Ferret calls / task | 0 → 0 | 3.0 → 3.3 |
| context tokens / task | 417 075 → **471 392** | 433 908 → 510 527 |
| cost, all eight | $6.06 → $6.98 | $6.33 → $7.69 |

### 6.1 The control is the finding

**The control arm has no MCP server configured at all.** Nothing in EPIC-136 can
reach it. Between the two phases it moved **+13.0% on context per task**, **+13
points on facts complete**, and **+33% on searches per task**, with an identical
harness, identical questions and an identical rubric.

That is this experiment's noise floor, established by an arm that is a negative
control by construction.

Against it, what §4.1 and §4.2 can buy: a pack call saves ~1 750 tokens, and the
treatment made 3.3 Ferret calls a task against ~470 000 context tokens. **Under
2%, against noise of 13% — roughly a seventh of the variance.**

So no reading of the treatment's movement is supportable. The evidence drop from
75% to 63% is one task in eight and sits inside the noise; I am not attributing
it to §4.1, and I would not have been entitled to attribute a rise to it either.
The correctness parity — 100% in both arms in both phases — is the only figure
stable enough to state, and it says the change broke nothing.

**One repeat cannot separate a sub-2% effect from 13% noise, and more repeats
would be chasing it rather than measuring it.** The honest report is that the
experiment is underpowered for the effect that survived §4.3's withdrawal.

## 7. The continuity experiment, and why it is not the Phase 5 one

**Phase 5's five-session experiment could not be reproduced, and Session A
proved it rather than my inferring it.**

Phase 5 created its supersession by holding back an *uncommitted* fix: at Session
A time the trailing-slash fix existed nowhere — not in the tree, not in history.
In Phase 6 it is merged, so reverting the one line that applies it leaves
`withoutTrailingSlash` defined and commit `70bcfca` in `git log`. The first
Session A found both and recorded, as its opening statement:

> "On branch phase6-epic-136 the trailing-slash fix in src/config/exclusions.ts
> is reverted…"

alongside a second statement describing the *fixed* behaviour. Its record was a
contradiction rather than a truth that later becomes false, so grading sessions
against it would have been grading a doctored tree. That run was discarded, at a
cost of $2.05, and the tree restored.

Reproducing it faithfully needs genuine historical checkouts — a worktree at
`144d478` for the early sessions and the current tree for the later ones — which
means parameterising the harness's root and building two content indexes.
Phase 6's question does not hinge on it: §4.1 and §4.2 touch pack sizing and
search bounding, not supersession. So it was not done, and this is the record of
why.

**Session B's rubric is likewise pre-fix and does not apply to this tree.** It
expects `it-matches-nothing`, which was true only before the fix. Both arms
answered *"it excludes that directory and everything under it"* — correct for the
tree they were given — and were scored WRONG and STALE by a rubric written for a
tree that no longer exists. The failure is the rubric's, and it is reported here
rather than corrected after the fact.

### 7.1 What did reproduce, exactly

Session C's rubric matches this tree, and it re-tests Phase 5's central finding.

| | control | treatment |
| --- | --- | --- |
| verdict | right | right |
| facts | 2/2 | 2/2 |
| evidence | 1/1 | 1/1 |
| tool calls | 15 | 13 |
| context | 217 577 | 277 659 |
| **`HANDOVER.md` read** | **0 times** | — |
| **`ferret_context_find` called** | — | **0 times** |

Both arms reached the right answer by reading `src/config/exclusions.ts` and
re-deriving it. **Neither consulted the knowledge Session A had spent $1.62 and
1.48 M tokens establishing and recording.** The treatment's single Ferret call
was `ferret_config_exclusions` — configuration, not knowledge.

This is Phase 5's finding, unchanged, and §4.1 and §4.2 do not touch it. What
stops a careful agent trusting a recorded statement is that the record cannot say
which tree it was true of, and that is not what this Epic changed.

## 8. The eight measurements, recorded separately

As directed, kept apart rather than combined.

| # | measurement | result |
| --- | --- | --- |
| 1 | **pack budget correctness** | drift 37% over → **0.1–0.2%**; every pack inside its budget; a sub-floor request raised to 800 and told |
| 2 | **search response bounding** | 32 152 tokens unbounded → **2 295** at `maxTokens: 4000`, 16 dropped and reported; default unchanged |
| 3 | **agent context cost** | control 417 075 → 471 392; treatment 433 908 → 510 527. Both arms rose; the control cannot be affected by the change |
| 4 | **task correctness** | 100% both arms, both phases. Unchanged |
| 5 | **evidence quality** | control 88% → 88% sourced; treatment 75% → 63%. One task in eight, inside the noise floor |
| 6 | **rediscovery cost** | control 6.1 → 5.4 files; treatment 2.9 → 4.1 files. Treatment's advantage narrowed, within noise |
| 7 | **context/token cost** | see 3. §4.1 saves ~1 750 tokens per pack call, <2% of a task |
| 8 | **Ferret usage** | 3.0 → 3.3 calls/task; `ferret_search` 9, `ferret_context_pack` 5, `ferret_context_find` 3 across the run. Uptake unchanged |

## 9. The answer

> **Does removing the measured delivery overhead give a real agent a material
> advantage?**

**Not measurably — and this experiment cannot detect an effect of the size that
survived §4.3's withdrawal.**

The change is worth keeping on its own terms, and those terms are not
agent-level:

- **A pack now costs what it says.** 37% over → 0.1–0.2%. A client managing its
  own window can now believe the number, which it could not before.
- **A search can be bounded**, so a large result is cut by Ferret, from the
  bottom of the ranking, with the cut reported — rather than cut by the client,
  arbitrarily, in silence.
- **`ferret-pack` sourced fell 26% → 21%** on the task benchmark, and that is
  the fix working: the 26% was bought with 37% of unbilled context.

What did **not** change: correctness (100% both arms, both phases), staleness (0
throughout), unsupported citations (0 throughout), Ferret uptake, and the
continuity behaviour — neither mechanism's carried knowledge was read.

**Per the phase's terms, Phase 6 stops here.** The result is "no material
improvement", so no further optimisation phase follows from it. The two findings
that would change the picture are both recorded and both need a decision this
Epic does not carry: the tool surface (§4a, EPIC-136) and binding a durable
statement to the tree it was true of (Phase 5 §7.4). Neither is started.

### 9.1 What this does not license

One repeat, one model, one repository, eight questions and three continuity
sessions, with a measured noise floor of 13% on an arm the change cannot touch.
These are directions, not effect sizes. A negative result at this power is a
reason to fix the measurement or the capability before measuring again — not
evidence that delivery cost does not matter, and not evidence that it does.
