# EPIC-136 — MCP Delivery Cost

**Status: APPROVED | Priority: P1**
**Domain:** Context Assembly & Delivery · MCP Surface
**Classification:** CORRECTIVE

> **Approved by the owner on 2026-09-07**, as the whole of the next phase and
> with scope explicitly capped at §4: *"Remove the measured delivery-cost
> barriers, then rerun the same agent A/B … Address only the capabilities
> explicitly defined by EPIC-136."* The owner also directed that
> statement-to-tree binding — the other Phase 5 finding — is **not** in this
> phase, and becomes a candidate only if this experiment shows Ferret is
> otherwise valuable.
>
> All three defects were found on 2026-09-07 by the real-agent benchmark
> (`benchmark/agent/`) and were **deliberately not fixed** in that work, on the
> precedent EPIC-135 set — see [§12](#12-why-this-was-deferred).

## 1. Objective

What Ferret sends an agent costs what Ferret says it costs, and an agent can ask
for less.

Ferret's retrieval is not the subject. The real-agent benchmark measured a
treatment arm that read **less than half** as much of the repository as the
control (2.9 files against 6.1, 355 lines against 807) and reached the same
answers. It then spent **more** total context than the control anyway — 433 908
tokens a task against 417 075. Everything in this Epic is about that gap.

## 2. Problem, observed

Measured on 2026-09-07 against a running `ferret mcp` server on the dogfood
store, through the MCP surface rather than from source.

### 2.1 A context pack overshoots the budget it reports keeping

`ferret_context_pack` is described as *"a bounded pack … sized to a token
budget"*, and reports `estimatedTokens` against `budget` in its response.

| Request | Reported | Sent |
| --- | --- | --- |
| `budget: 4000` | `estimatedTokens: 3971` of `budget: 4000` | 17 059 characters ≈ **5 438 tokens** |
| `budget: 4000`, different question | `estimatedTokens: 2671` of `budget: 4000` | 12 087 characters ≈ **3 812 tokens** |

The sum of the per-item estimates equals the reported figure exactly, so the
items are counted correctly. What is not counted is the **envelope**:
`contentNotice` (624 characters), `formatVersion`, `producer`,
`producerVersion`, `builtAt`, `question`, `omitted`, `contentSafety`,
`estimatedTokens`, `budget`, `withheld`, and the JSON structure around the item
array. That is **1 467 tokens uncharged on the first case — 37% over a budget it
reported keeping.**

This is the same defect class the file already fixed once, for items rather than
for the envelope. `src/context/pack.ts` records that fix in its own words:

> Measured on one real pack: five items charged 3 669 tokens against a 4 000
> budget and estimated 5 169 as sent, with the whole response at 6 724 — 68 per
> cent over a budget it reported keeping.

And `src/context/budget.ts` states which direction the error may not run:

> Under-counting means the client truncates the pack itself, silently … and the
> thing that gets cut is not the thing Ferret would have chosen to cut.

**`format: 'text'` is within budget** — the same request renders to 6 238
characters ≈ 2 800 tokens. So the budget describes the rendered form while the
default response is JSON, and JSON is what an MCP client receives when it does
not pass `format`. A caller asking for 4 000 gets 5 438 and is not told.

### 2.2 `ferret_search` has no compact form, and a result was lost to it

`ferret_search` takes `query`, `kinds` and `limit`. `limit` controls how many
hits come back; nothing controls how much each carries, and there is no `format`
argument.

| Request | Response |
| --- | --- |
| `limit: 5` | 11 223 characters ≈ 4 158 tokens |
| `limit: 20` | 79 571 characters ≈ **32 152 tokens** |

Observed consequence, in a real session: a treatment agent called
`ferret_search` with `limit: 20`, and the result was large enough that the client
truncated it to a file on disk — which the benchmark's containment guard then
refused to open, because it is outside the repository. **The agent asked one
question, paid for it, and received nothing usable.** That is precisely the
failure `budget.ts` names: the client truncated, and what got cut was not what
Ferret would have chosen to cut.

### 2.3 Thirty tool definitions are re-sent every turn

| | value |
| --- | --- |
| tools published | 30 |
| tool definitions, serialized | 36 818 characters |
| descriptions carrying the content-safety notice | 14, ~8 700 characters |
| `initialize` instructions | 760 characters |

A tool list is part of the request prefix, so it is paid **once per turn**, not
once per session. Measured on one task (`macos-runner`) over fourteen turns with
everything else held constant:

| arm | cached input tokens |
| --- | --- |
| control | 156 273 |
| treatment | 268 125 |

**72% more context before a single Ferret result is counted**, ≈ 8 000 tokens a
turn. Across the eight-task run the treatment's file-reading saving was real and
the tool-list overhead consumed all of it.

The dollar difference is small because those are cache reads ($6.06 against
$6.33 for the whole run). The context difference is not, and context is the
scarce resource: 268 k of a window spent on one question.

## 3. Value

An agent's context window is the budget the product competes for. Ferret already
demonstrably reduces how much of a repository an agent has to open; on the
measurement above, none of that reached the window. This Epic is what converts a
measured retrieval win into a measured context win.

It is also a correctness matter for §2.1: a tool that reports keeping a budget
it does not keep cannot be reasoned about by a client trying to manage its own
window.

## 4. Scope

1. **Charge the envelope.** `ferret_context_pack` accounts for everything it
   sends, not only its items, so `estimatedTokens` describes the response and
   `budget` bounds it. Applies to whichever `format` is returned.
2. **A compact form for search.** A way for a caller to ask `ferret_search` for
   hits without full content — a `format` argument, a per-hit content cap, or
   both. The default may stay as it is.
3. ~~**A smaller default tool surface.**~~ **Withdrawn by owner decision on
   2026-09-07 — see [§4a](#4a-why-the-tool-surface-was-withdrawn).** The
   measurement stands and the cost is real; the mechanism this Epic named for
   reducing it conflicts with four accepted contracts, and choosing a different
   one is a design decision outside this Epic.

## 4a. Why the tool surface was withdrawn

Implemented, measured, and reverted the same day. Recorded because the
measurement is worth keeping and the reason it cannot ship is worth more.

**It worked, and it was large.** Publishing a tool only to a principal that
holds its permission cut the surface for the principal the benchmark's answering
sessions run as — granted `read` and nothing else — from thirty tools to
fifteen, and from ~14 984 estimated tokens to ~8 398. Measured through
`tools/list` on a running server by `benchmark/agent/surface.mjs`:
`results/surface-before.json` and `results/surface-after.json` are both kept.
That is ~6 600 tokens a turn, on every turn.

**And it breaks four accepted contracts.** Each of these independently requires
that a tool be *callable* and *informatively refusable* by a principal lacking
its permission. An unpublished tool answers `MCP error -32602: Tool not found`,
which names no permission and cannot be told from a missing feature:

| Epic | criterion | the test that failed |
| --- | --- | --- |
| EPIC-066 | AC-6 | `refuses a write to a caller granted only CONFIG_READ` — expects `E_NOT_PERMITTED` |
| EPIC-067 | AC-12 | `refuses the recovery without INDEX` |
| EPIC-068 | AC-5, AC-6 | `refuses every read tool with NOT_PERMITTED`, `names the missing permission and leaks no configuration` |
| EPIC-117 | AC-5, D-117.3 | `refuses every writing tool to a principal holding only READ` — expects `record` named |

The first attempt patched this by always publishing `read` tools, on the
argument that a caller without `read` can call nothing anyway. That fixed one
family of four; the full suite found the other three. **§9 of this Epic already
forbade it** — *"Nothing in this Epic may reduce what a caller is told about what
was withheld"* — and those four Epics are where that rule is actually written
down.

**So the thirty-tool surface is the price of a diagnostic guarantee**, not an
oversight. The deferred finding, in one sentence:

> The MCP tool surface has a measurable per-turn context cost, but reducing that
> surface while preserving informative authorization failures requires a
> different design decision than EPIC-136 currently scopes.

Three mechanisms remain open, and **none was chosen**: consolidating related
tools behind fewer entry points, shortening what a description carries, or
client-side deferred tool loading where a client offers it. The owner explicitly
declined to weaken the permission model, to accept "Tool not found" as a
replacement, or to broaden this Epic into any of them.

## 4b. A fourth delivery cost, recorded and not acted on

Found while diagnosing §2.1 and **deliberately not fixed**: every MCP tool
result is serialized by `src/mcp/guards.ts` as
`JSON.stringify(result, null, MCP_JSON_INDENT)` — pretty-printed. The
indentation is roughly **17% of every JSON response Ferret sends**, and it was
the whole of the gap between what a pack estimated and what it delivered: the
estimate counted compact JSON, the transport sent indented JSON.

A model does not need the indentation. Removing it would save that 17% across
every tool, not only the pack. But §5 puts *"changing the default `format` of any
tool"* out of scope, and the owner capped this phase at §4, so the estimate now
counts the indentation honestly instead — one shared `MCP_JSON_INDENT` constant
between the serializer and the estimator, so the two cannot drift again.

Recorded as a future design option, with the same standing as §4a: real,
measured, and needing a decision this Epic does not carry.

## 5. Non-scope

- **Changing what retrieval selects or how it ranks.** Nothing here touches
  relevance. EPIC-130 and EPIC-131 own that.
- **Removing the content-safety notice.** It is EPIC-133's prompt-injection
  boundary and it works; ~2 200 tokens of the tool-definition cost is that
  notice, and paying it is a deliberate trade. Its *repetition* across fourteen
  descriptions may be reducible; its presence is not in question.
- **Changing the default `format` of any tool.** That is a breaking change to a
  published surface and needs its own decision.
- **Anything about EPIC-135's read-versus-storage semantics.**

## 6. Acceptance criteria

- **AC-1** For every `format`, a pack's `estimatedTokens` is within 5% of the
  serialized response it accompanies, measured on at least three real questions.
- **AC-2** A pack never exceeds the `budget` it reports, in the form returned.
  **Restated during implementation**: the original wording — "never exceeds its
  *requested* budget" — is unachievable, because a pack's fixed fields cost
  ~470 estimated tokens before an item is in it and a caller may ask for less.
  A request below `MIN_BUDGET` is therefore raised to it and told so, and
  `budget` reports what was applied. The promise `estimatedTokens <= budget`
  then holds for every request, which is what a client can act on.
- **AC-3** `ferret_search` offers a caller a way to bound its response, and the
  bound is respected.
- **AC-4** A regression test pins each of AC-1 to AC-3 against a measured
  worked example, on the pattern `tests/unit/context-pack.test.ts` already uses.
- **AC-5** The tool-definition cost of a default server is measured and
  recorded through `tools/list` on a running server. **Kept despite §4a**: the
  measurement is the evidence the deferred finding rests on, and
  `benchmark/agent/surface.mjs` produces it reproducibly for three principals.
- **AC-6** `benchmark/` and `benchmark/agent/` are re-run and the movement is
  recorded. Both are expected to move: charging the envelope reduces what fits
  in a given budget, so `ferret-pack`'s recall at budget 4 000 will fall and its
  reported cost will become accurate. **A number moving against Ferret here is
  the fix working**, and the benchmark is not adjusted to compensate for it.

## 7. Contracts

`ContextPack.estimatedTokens` changes meaning: from "what the items cost" to
"what the response costs". `PACK_FORMAT_VERSION` is the place that is recorded.

## 8. Test requirements

The measurements in §2 were all taken through the MCP surface, and the
regression tests must be too, for the reason `scripts/dogfood.mjs` gives: *"a
defect that only SQL can see is not a defect a client will ever hit."* §2.1 is
invisible from the pack object; it only appears once the response is serialized.

## 9. Security requirements

None changed. The content-safety notice, containment markers, permission
withholding, exclusion reporting and provenance are all preserved exactly.
Nothing in this Epic may reduce what a caller is told about what was withheld —
`omitted` and `withheld` are part of the envelope being charged for, and
charging for them must not become a reason to send fewer of them.

## 10. Observability

The before-and-after numbers of §2.1 and §2.3 are the evidence this Epic is
judged on, and both are cheap to reproduce: one `tools/list` call and one
`ferret_context_pack` call against a running server.

## 11. Dependencies

- EPIC-060 / EPIC-131 own the pack and its budget.
- EPIC-052-053 own search.
- EPIC-059-061-064-065 own the MCP surface.
- EPIC-133 owns the content notice, which §5 puts out of scope.

## 12. Why this was deferred

On the precedent EPIC-135 set, and for the same reasons.

**A benchmark must not change what it is measuring.** All three findings came
out of the real-agent A/B, and §2.1 and §2.3 are load-bearing in its results.
Fixing the pack's budget accounting mid-phase would have meant the sixteen
sessions already run described a build that no longer existed, and the honest
alternative — re-running them — costs real money for a change nobody had
approved.

**Two of the three are product decisions rather than defects.** A compact search
form and a smaller tool surface are both changes to a published surface with
users' expectations attached. §2.1 alone is an unambiguous defect; the other two
are the owner's call.

**The measurement is the deliverable either way.** Phase 5's job was to answer
whether an agent does better work with Ferret. It did, and the answer includes
these three numbers. They are more useful as an approved Epic with evidence
behind it than as an unreviewed change to `pack.ts`.

## 13. Definition of Done

- AC-1 to AC-6 met and recorded.
- `docs/evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md` §5 gains an after column,
  so the same table shows what the change bought.
- Neither existing benchmark is redesigned; both are re-run and their movement
  is explained in their own `Corrections` sections.
