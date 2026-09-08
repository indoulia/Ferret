# When does the agent ask? — the routing measurement

**Research only. No product change is proposed by running this, and none was made.**

**Branch:** `research-138-early-routing` (unmerged) · **Store:** `ferret_agent_ab`,
dropped and rebuilt · **Model:** `opus`, effort `high` ·
**Harness:** `benchmark/agent/routing.mjs`, `routing-tasks.json` ·
**Raw:** `benchmark/agent/results/routing.json` · **Date:** 2026-09-08

EPIC-137 found the anchor mechanism correct, safe, and unproductive, and named
one candidate cause: the agent had finished investigating before it asked
Ferret. This tests that cause and nothing else.

---

## 1. Hypothesis

> Task-shaped questions may need to reach `ferret_context_pack` earlier in an
> agent session for durable context to produce a real productivity benefit.

**Classification: A — strongly supported.** Early consultation cut context
tokens 48%, tool calls 45% and cost 30% against the current Ferret surface, with
identical verdict correctness, zero unsupported citations, zero stale
assertions, and no loss of independent verification. Section 8 gives the limits
that keep this a research result.

## 2. Where Ferret is called today

Forensics on the ten EPIC-137 transcripts, no new runs. Position of the first
Ferret call against the first source read:

| | T1 | T2 | T3 | T4 | T5 |
| --- | --- | --- | --- | --- | --- |
| first Ferret call | 19 | 16 | 20 | 16 | 12 |
| first source read | 3 | 3 | 3 | 3 | 3 |
| tool calls in session | 24 | 20 | 23 | 19 | 17 |

The opening move was `Grep` or `git log` in 10 of 10 sessions. Never a tool
survey.

**The control reproduces it.** Its `HANDOVER.md` was consulted after the first
source read in 4 of 5 sessions and never in the fifth — and that file is in the
working directory, revealed by the `ls` two sessions ran on call 1.

That single fact carries most of the answer to *why*: reading source before
consulting recorded knowledge is **agent behaviour**, not a property of Ferret's
surface. It reproduces against a plain markdown file with no discoverability
problem at all.

## 3. What the surface contributes anyway

Measured on the running server, not read off the source:

- 30 tools, `tools/list` = 42 703 chars ≈ **10 700 tokens re-sent every turn**.
  Known, measured, and its remedy withdrawn by owner decision — EPIC-136 §4a.
- Of 19 156 chars of description text, **8 736 (46%) is one prompt-injection
  notice repeated across 14 tools**. Distinguishing text averages 347 chars.
- The `initialize` instructions name "commits, files, branches, worktrees,
  developers and the evidence behind each fact". **Durable context is not in the
  capability sentence.** The rest of that string is the same notice.
- `ferret_context_pack` says "Prefer this to `ferret_search` for a task-shaped
  question." Nothing anywhere says *when in a session* to call it.

So the cause is layered: agent habit is primary and reproduces without Ferret;
the surface does nothing to interrupt it.

## 4. What the pack would have returned, had it been asked first

Product path, no agent, default budget:

| | on-topic question | unrelated question |
| --- | --- | --- |
| `standing` | the same 4 statements, each with `verdict`, anchors, both hashes | **the same 4 statements** |
| `items` | **`[]`** | **`[]`** |
| `estimatedTokens` | 3 470 of 4 000 | 3 373 of 4 000 |

Two findings. The pack **does** answer the carried question completely on call
one. And standing context is carried regardless of relevance, consuming the
whole budget so that zero repository items fit — which is what makes §7 cost
what it does.

## 5. Setup

Three conditions, differing in one thing:

| arm | tools | system prompt |
| --- | --- | --- |
| `control` | `Read`, `Grep`, `Glob`, `Bash`, no MCP, plus `HANDOVER.md` holding every statement verbatim | the standard contract |
| `treatment` | the same four plus all 30 Ferret tools | the standard contract |
| `routed` | identical to `treatment` | the contract **plus one added instruction** |

The added instruction, in full:

> Before you open any source file, check whether durable engineering context
> about this question has already been recorded by an earlier session and is
> retrievable through the tools available to you. Do that check first. Then
> continue however you judge best.

It names no file, no answer, and no verdict vocabulary; it says nothing about
trusting or distrusting what comes back, because whether an early-routed agent
blindly believes what it is handed is the safety measurement. It asks whether
*any* context exists, so R8 is a fair test. Ferret itself, its ranking, its
descriptions, the tool set, the permissions, the corpus, the grader and the
scoring are byte-identical across arms.

Session A investigated and recorded unprompted: **4 statements, 4 of 4
anchored, 3/3 facts, $1.11** — replicating EPIC-137's Session A.

| task | repository state | carried verdicts |
| --- | --- | --- |
| R1 | unchanged since A recorded | 4 × `verified` |
| R2 | an anchored file changed and re-indexed | 2 × `verified`, 2 × `stale` |
| R5 | an unrelated file changed and re-indexed | unchanged: 2 `verified`, 2 `stale` |
| R8 | a question nothing was recorded about | — |

Both tree changes are comment-only edits on the unmerged branch, made so a real
commit could move a file's bytes without moving its behaviour.

## 6. Safety — the criterion that had to hold

**R2 holds.** The routed arm consulted at tool call 1, received 2 `verified` and
2 `stale`, then read the anchored implementation four times before answering. It
reached the correct verdict, asserted nothing from the stale record, and cited
nothing absent from its trace.

It did not merely avoid trusting the stale statements — it used the verdict as
evidence, in its own words:

> The proof is live in this session: statements `456c0238…` and `af9e01f3…`
> come back `current: true` with `verification.verdict: "stale"`.

That is *consult early → retrieve verdict → act on it*, which is the behaviour
the criterion asks for.

**Across all runs**: 0 stale assertions, 0 false drift, 0 unsupported citations
in any routed session, correct verdict in 13 of 13 sessions in every arm. The
unrelated commit in R5 moved no verdict.

**Independent verification survives.** Every routed session read source after
consulting — 5, 4, 3, 2, 2 source reads post-consult. None answered from the
pack alone.

## 7. Productivity

Per session. `consult` is the first knowledge call (`ferret_context_*` or
`ferret_search`, or the control's notes file); `src` is the first source read.

| task | arm | consult / src | calls | files | lines | context | sec | cost | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | control | 15 / 3 | 19 | 7 | 1010 | 376 k | 120 | $0.77 | right |
| R1 | treatment | 21 / 3 | 24 | 7 | 766 | 636 k | 147 | $1.11 | right |
| R1 | **routed** | **1 / 3** | 13 | 5 | 501 | 391 k | 103 | $0.74 | right |
| R2 | control | — / 3 | 24 | 7 | 705 | 364 k | 112 | $0.65 | right |
| R2 | treatment | 11 / 3 | 16 | 5 | 759 | 497 k | 132 | $0.78 | right |
| R2 | **routed** | **1 / 5** | 10 | 4 | 575 | 256 k | 82 | $0.51 | right |
| R5 | control | — / 6 | 27 | 5 | 1142 | 589 k | 204 | $1.08 | right |
| R5 | treatment | 12 / 3 | 21 | 6 | 804 | 598 k | 136 | $0.84 | right |
| R5 | treatment #1 | 16 / 3 | 21 | 7 | 891 | 505 k | 124 | $0.78 | right |
| R5 | treatment #2 | 12 / 3 | 16 | 2 | 388 | 391 k | 108 | $0.58 | right |
| R5 | **routed** | **1 / 3** | 9 | 3 | 433 | 214 k | 79 | $0.47 | right |
| R5 | **routed #1** | **1 / 6** | 10 | 2 | 449 | 224 k | 87 | $0.57 | right |
| R5 | **routed #2** | **1 / 5** | 12 | 2 | 357 | 269 k | 96 | $0.57 | right |

Per task, over R1/R2/R5:

| | control (n=3) | treatment (n=5) | routed (n=5) |
| --- | --- | --- | --- |
| context tokens | 443 k | 525 k | **271 k** |
| cost | $0.84 | $0.82 | **$0.57** |
| tool calls | 23.3 | 19.6 | **10.8** |
| files read | 6.3 | 5.4 | **3.2** |
| lines read | 952 | 722 | **463** |
| wall clock | 145 s | 129 s | **90 s** |
| verdict correct | 3/3 | 5/5 | 5/5 |
| facts covered | 9/9 | 15/15 | 13/15 |
| unsupported citations | 0 | 0 | 0 |

Routed against treatment: **−48% context, −45% tool calls, −41% files, −36%
lines, −30% cost, −30% wall clock.** Routed against the notes-file control:
−39% context, −32% cost, −54% tool calls. Consultation position separated
perfectly — routed consulted first in 5 of 5, treatment in 0 of 5.

**The two missed facts are grader misses, not weaker answers.** Both routed
sessions stated the fact with line-cited precision in phrasing the fixed regex
list does not cover — *"it says nobody retired the statement, not that the code
still matches"* against patterns expecting `unsuperseded` or `current.*only
means`. Both later repeats scored 3/3 on the identical instruction. **The
scoring was not changed**; the raw number stands in the table and the reader can
weigh it.

**Anchored-file reads did not go to zero** — 3, 4, 2, 2, 2 against the
treatment's 4, 2, 4, 4, 1. EPIC-137's success criterion is still unmet. Early
routing makes the session cheaper; it does not stop the agent verifying, and
§6 argues it should not.

## 8. Cost when Ferret has nothing — R8

A question nothing durable was recorded about, both arms holding Ferret:

| | treatment | routed |
| --- | --- | --- |
| Ferret calls | 2 | **6** |
| wall clock | 83 s | **119 s** |
| cost | $0.83 | $0.81 |
| verdict | right | right |
| unsupported citations | 2 | 0 |

**Yes, early routing generates unnecessary calls.** Six surfaces tried where two
sufficed, +36 s, no correctness change, cost flat. §4 explains why the first one
is not free: the pack returns the same ~3 400 tokens of standing context on an
unrelated question, and no repository items.

## 9. What this does not license

- **n is small**: 1 per cell on R1 and R2, 3 per arm on R5. Directions and
  magnitudes, not p-values. The R5 triplicate is what makes the direction
  credible: routed consulted first in 3 of 3 and cost 236 k against 498 k.
- **The instruction carries more than ordering.** It tells the routed arm that
  durable context is a thing that may exist. That is information the plain
  treatment must infer from 30 tool descriptions, and it cannot be separated
  from the ordering effect by this design. **This is the main threat to the
  result** and any product test must isolate it.
- **One model, one repository, one question shape, four statements.** The
  product claim concerns a knowledge base months old; nothing here observes one.
- **The stale statements stayed true.** R2 moved bytes, not behaviour. An agent
  that blindly trusted would still have answered correctly, so §6 rests on the
  observed reads and the cited verdict, not on the verdict being right. A change
  that *falsified* an anchored statement was out of scope here.
- **R2 and R5 are not EPIC-137's T2 and T5.** R5 carried two `stale` statements
  where T5 carried five `verified`.
- **The control is weaker than intended on R2 and R5**, where it never opened
  the notes file at all.
- **Harness defects found and not fixed** (research branch, deliberately):
  `grade.mjs`'s `refusals` regex does not match the containment denial, so
  out-of-repository denials score 0 refusals — verified by hand that R8's read
  of the memory file was denied, so no contamination followed. Refused reads
  still count toward `filesRead`, equally in all arms.
- **The corpus list needed extending before this could run at all.**
  `docs/EPICs/validation/EPIC-137-VALIDATION.md` and
  `docs/evidence/FERRET-DOES-AN-ANCHOR-CARRY.md` both postdate the anchors run
  and both state the carried question's answer in prose. **Re-running the
  committed anchors suite on today's tree would be contaminated.** This document
  belongs on that list for the same reason.

## 10. Recommendation

**A future Epic is justified, and it is small.**

The finding is not "make Ferret better at answering". Ferret already answers this
question completely on call one (§4). The finding is that nothing in the product
tells an agent *when* to ask, and the agent's default is to ask last.

**The smallest product change that would test it:** one sentence in the MCP
`initialize` instructions — the one string every MCP client shows before the
first turn — naming durable context as something an earlier session may have
recorded and worth checking before source exploration. One string. No new tool,
no ranking change, no permission change, no pack semantics change, no
description rewrite.

It is testable by exactly this harness with the routed arm's suffix removed: if
`treatment` then consults first, the instruction string carried the effect; if it
does not, the effect belonged to the client convention and Ferret cannot buy it.
That comparison also isolates §9's main threat, which is why it is the right
first experiment rather than the whole design.

Two things that must be settled inside that Epic, not assumed:

1. **§8's cost is real.** A convention that routes every question to the pack
   pays ~3 400 tokens of standing context on questions the store knows nothing
   about, and returns no repository items while doing it.
2. **§4's `items: []` is a separate matter.** At the default budget, standing
   context displaced every repository result. That is EPIC-131 territory, it was
   observed here, and it is not this hypothesis.

**Not recommended:** anything that would weaken verification, reduce the tool
surface (§3, withdrawn by owner decision), or reward Ferret usage in scoring.
