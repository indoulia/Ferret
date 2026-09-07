# Does durable context carry? — the measurement, and what it says

**Tree:** `7a04411` (`bench/continuity-benchmark`), clean · **Store:** `ferret_continuity`,
created and dropped by the harness, 27 graded statements + 0/40/123 padding ·
**Command:** `npm run bench:continuity` · **Date:** 2026-09-07

The task benchmark measured whether an agent holding Ferret answers a repository
question better than one holding `git`. It closed by naming what it could not
reach, and two of those were the same gap seen twice: the durable tier held two
records, so nothing it measured said anything about **knowledge carried between
sessions, or between agents**. That is what Ferret is for, and it had never been
measured.

This is that measurement. The result is mixed, and the parts that are bad are
bad for reasons worth being precise about.

---

## 1. The benchmark

`benchmark/continuity/` — twenty-seven statements of real Ferret engineering
knowledge, replayed as **eight sessions run by two agents** through the MCP
surface, then fourteen questions asked in sessions holding no transcript of the
work that learned the answer. Alpha recorded eighteen of the statements and beta
nine, and **eleven of the fourteen questions are answered by a statement the
agent asking never recorded** — so the headline figures are almost entirely
cross-agent figures.

Every statement cites where it came from — a source file and its decision
number, a pull request, an owner decision. The history contains what a real one
contains: three reversed decisions, a rule later widened, one decision restated in
nearly the same words and another restated in completely different ones, and one
session's private working state that was never promoted.

**The baseline is an agent that writes things down.** Not one that forgets —
that would be a demonstration rather than a measurement. It keeps a shared,
committed notes file and is given exactly the same statements at the same
moment in the same order, **with the same reasoning**. Three habits are
measured, against Ferret's three surfaces for the same shape of question:

| | grep it | read all of it |
| --- | --- | --- |
| **notes** | `notes-append`, `notes-curated` | `notes-full` |
| **Ferret** | `ferret-pack`, `ferret-search` | `ferret-find` |

The ranking over notes is the *same* algorithm, stop list and constants as the
task benchmark's `git grep` baseline, imported rather than copied.

`benchmark/continuity/README.md` holds the method, every constant, and the
corrections. Two consecutive runs are identical apart from wall-clock timings
and the session identifiers Ferret mints.

---

## 2. What it found

At the smallest store, 27 statements — a knowledge base a week old:

| condition | sourced | answered | facts | stale ranked first | tokens/task | p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `notes-append` | 100% | **100%** | 26/26 | **60%** | 903 | 0 ms |
| `notes-curated` | 100% | **100%** | 26/26 | 0% | **883** | 0 ms |
| `notes-full` | 100% | **100%** | 26/26 | 0% | 3 349 | 0 ms |
| `ferret-pack` | 93% | 64% | 20/26 | 0% | 1 102 | 37 ms |
| `ferret-search` | 93% | 57% | 19/26 | 0% | 2 659 | 15 ms |
| `ferret-find` | 100% | 64% | 21/26 | 0% | 2 999 | 42 ms |

### The one measurement that separates the mechanisms

**`notes-append` ranks a reversed decision above the decision that reversed it on
three of the five tasks that have one, and no Ferret surface ever does.** An
agent asking whether to add a macOS job is handed the decision to keep one,
first; one asking whether two queries' scores are comparable is handed the rule
that says never; one asking whether a green pull request can still hide a
Windows failure is handed the arrangement that was later reversed. All three
answers are confident and wrong, and all three are what an agent with an
append-only notes file actually gets.

That is the failure durable context exists to prevent, and it prevents it.

**But `notes-curated` never fails it either**, because it is handed for free the
one thing Ferret's mechanism supplies: the knowledge of what supersedes what.
That condition exists precisely so this cannot be hidden. The honest statement of
the win is narrow and real: *Ferret is a disciplined notes file without requiring
the discipline* — the supersession link is recorded once, at the moment the
reversal happens, by the agent that has the reason in front of it, and everything
downstream follows. Nobody has to remember to go back and delete.

### Where it scales, and where it does not

| store | notes-curated | notes-full | ferret-pack | ferret-find |
| --- | --- | --- | --- | --- |
| 27 statements | 883 | 3 349 | 1 102 | 2 999 |
| 67 statements | 874 | 5 452 | 1 131 | 6 779 |
| 150 statements | 867 | **9 888** | **1 259** | **14 694** |

tokens per task, at three store sizes.

**Reading everything does not scale and asking a question does.** `notes-full`
triples and `ferret-find` grows nearly fivefold across a 5.6× store;
`ferret-pack` grows 14%. That is the product's central claim about a growing knowledge base, and on
this evidence it holds.

**And a grep over a notes file scales just as well** — 883 to 867, flat — while
costing less than the pack at every size: 20% less at the smallest store, 31%
less at the largest, so the gap widens rather than closing. That is the result that matters
most here, and it is not the one Ferret would have hoped for. Against a
*disciplined* agent with a *grep-able* notes file, Ferret's durable tier is not
cheaper and not more complete. It is doing the same job at a slightly higher
price, and buying provenance, lifecycle and cross-agent reach with the
difference.

### Cross-agent transfer works, and isolation holds

Six probes, all six hold, at every store size — and both directions are checked,
because a build that refused everyone would pass a benchmark that only checked
refusals:

| probe | expected | observed |
| --- | --- | --- |
| beta reads durable context alpha recorded | allowed | 23 statements readable |
| beta recalls alpha's session | refused | *"No session you own has that identifier."* |
| beta inspects alpha's session | refused | same answer, deliberately |
| beta promotes alpha's session | refused | same answer |
| alpha recalls its own session | **allowed** | 15 memories |
| alpha's unpromoted working state reaches beta | refused | 0 of 2 reachable |

Twenty-three rather than twenty-seven because a whole-store read returns only
current statements: the four superseded ones are already excluded without being
asked for. That is also why `ferret-find` cannot rank a reversed decision first —
it never returns one — and it is a genuine property rather than an artefact of
how the condition was written.

Eleven of the fourteen questions are answered by a statement the asking agent
never recorded. On those, `ferret-pack` sources 10 of 11 and answers 6 of 11 —
which are, within rounding, the whole benchmark's figures, because they are
almost the whole benchmark. The three questions an asker could answer from its
own recording score 3 of 3 on both, and that sample is far too small to compare
against.

So the claim is not "cross-agent retrieval is as good as same-agent retrieval",
which three tasks cannot support. It is the simpler one the numbers do carry:
**every figure in this report is a cross-agent figure, and durable context
crossed the boundary intact while session state did not cross it at all.** That
is EPIC-132 and EPIC-133 measured rather than asserted.

### A second session actually resuming a first

The gap the task benchmark named and could not close. `ferret_session_recall` on
a session four deep in a parent chain returns the checkpoint and fifteen
memories, and both phrases a resumption needs — the open question and the next
task — come back. It costs 3 176 tokens and **does not grow with the store**, at
any of the three sizes.

Re-reading the notes costs 845 tokens by grep and 9 888 by reading the file at
the largest size. So recall is four times a grep and a third of a full read, and
alone among the three it is flat. The honest reading: recall is not cheap, and
what it buys is that the price does not move as the project does.

### Convergence folds a rewording, and only a small one

| restatement | notes | `ferret-pack` | `ferret-find` |
| --- | --- | --- | --- |
| near-identical wording | 2 wordings | **1** | 2 |
| completely reworded | 2 wordings | 2 | 2 |

EPIC-130's claim — four records saying one thing are one answer — holds for a
restatement that shares vocabulary and does not reach one that does not. Nothing
is wrong with that: convergence is lexical and Ferret ships no embedding provider
by design. It is worth stating plainly because the claim as written sounds
stronger than what it does.

Two further facts are visible in the same measurement. All twenty-six records
were `created` and none `merged`, and promotion then merged every memory onto
the record already holding it — so **the fold is a property of retrieval, not of
the store**. And `ferret_context_find`, which bypasses retrieval, returns both
wordings even in the case the ranked surfaces fold. A reader who lists the store
sees two records; a reader who asks a question sees one.

---

## 3. The defect this found

One, and it needed this benchmark to be visible.

**The context pack reported a result limit it never hit, on fourteen of fourteen
packs**, and the count was exactly the number of durable statements it had just
delivered — 2/2, 3/3, 5/5, 9/9, and so on through the set. `renderPack` prints
the detail into the prose the model reads, so every pack said *"result-limit:
stopped after 20 results"* while being complete.

The cause is arithmetic. A durable statement reaches the pack's `standing`
section through the same `hits` list the items are drawn from and is marked seen
so it is not sent twice, and the limit's effect was then *inferred* by
subtracting items from hits — a subtraction with no term for a hit delivered
somewhere other than `items`. It is the inverse of the defect the widening
fallback fixed: that pack claimed completeness while empty, this one claimed
truncation while complete, and either way a client that cannot believe `omitted`
has lost the field EPIC-048 AC-7 exists for. A careful agent reading it re-asks
with a larger budget and spends the context for nothing.

**Why the task benchmark could not find it.** It ran against a store whose
durable tier held two records, so the record search almost never returned one and
the standing section was filled by the separate widened query — whose hits are
not in `hits` and do not distort the subtraction. Measured: **0 of 19** packs
claimed a false limit there; **14 of 14** here. The defect requires durable
context to be a real share of the corpus, which is exactly the state the first
benchmark said it could not create.

Fixed in `src/context/pack.ts` by counting what the limit actually cut off where
it happens. Proven against the unfixed code — the test observed to fail before
the change — and paired with a case that a genuine limit is still reported.

| | before | after |
| --- | --- | --- |
| false `result-limit` claims | 14 of 14 | **0 of 14** |
| `ferret-pack` tokens, smallest store | 15 594 | 15 102 |
| `ferret-pack` tokens, largest store | 17 729 | 17 299 |
| `sourced` / `answered` | 93% / 71% | 93% / 71% |

Both halves of that pair were measured on a 25-statement scenario, before a
twenty-sixth statement was added to locate where convergence stops. They are
comparable with each other and not with §2's table, which is the current
scenario. `results/before-omission-fix.json` is the *before* run, kept.

Retrieval quality is unchanged, which is what should happen: the fix corrects a
report, not a result. The task benchmark re-run after it is unchanged on every
condition's ranked set; its baseline nDCG moves 0.339 → 0.331 because that
condition greps the working tree and this work edited a file it ranks — the
caveat that benchmark records its own commit for.

---

## 4. What the evidence says

**Proven.**

- **Durable context crosses agents and sessions.** An agent that recorded none
  of the knowledge answers as well as the one that recorded it, and session
  state does not cross with it. Six isolation probes, both directions, all
  holding.
- **A second session resumes a first**, four deep in a parent chain, for a cost
  that does not grow with the store. The gap the task benchmark named is closed.
- **Asking a question scales; reading everything does not.** 15% growth against
  200% and 400% across a 5.7× store.
- **No Ferret surface ranks a reversed decision above the one that reversed
  it**, where an append-only notes file does so on half the tasks that have one.

**Not proven.**

- **That Ferret beats a disciplined notes file.** It does not, on cost or on
  completeness. `notes-curated` is 30% cheaper at every store size and answers
  more. What Ferret provides over it is that the discipline is not required.
- **That an agent using Ferret answers better.** No model is in this loop.
  `answered` says the facts were in front of the agent, not that it used them.
- **That the right twenty-six sentences would have been recorded at all.** Every
  statement here was recorded deliberately, and that is the largest assumption
  in the design.

**Disproven, or at least not supported.**

- **That durable context carries the reasoning.** It does not, and this is the
  sharpest finding. `answered` is 100% for every notes condition and **64% for
  `ferret-pack`, 64% for `ferret-find`, 57% for `ferret-search`**. On five of
  fourteen questions Ferret returned the right statement and not the reason for
  it. Four of those five are pure rationale gaps: *why* the owner dropped macOS,
  *what* the narrow exclusion rule missed, *what measurement* makes a testing
  practice worth following, and *what* reinstating Windows on every pull request
  costs.

  This is by design, twice over. `ferret_context_record` has no rationale field,
  and its schema says the statement is *"not a transcript, not a plan, not
  reasoning."* `ferret_session_remember` does have one, described as *"what it
  was chosen over is the part a later reader cannot reconstruct"* — and
  `planPromotion` drops it when the memory becomes durable context. So the field
  the product identifies as the part a later reader cannot reconstruct is
  dropped precisely when it crosses to the tier later readers use. The session
  tier keeps it, and the session tier is private to one agent, so the reasoning
  is reachable by the agent that already knows it and by nobody else.

  Nothing was changed for this. It is a product decision with an argument behind
  it, the argument is now measurable, and whether it is the right one is an
  owner decision rather than this phase's.

- **That convergence collapses restatements.** It collapses a rewording that
  shares vocabulary, at retrieval, and neither collapses a genuine reword nor
  affects what the store lists.

### Remaining gaps

**Product.** Durable context carries no reasoning and promotion drops it.
Promotion's granularity is the whole session, so an agent holding four memories
of which it wants to publish two cannot say so — here that was worked around by
declining to promote a session at all. A `fact` is a durable kind and not a
memory kind, so a fact recorded by a session cannot be promoted and its
reasoning has nowhere to live. Convergence is lexical and does not reach a real
reword. The one lexical retrieval miss — a question about which permission
archiving needs, answered by a statement that names the permission but never the
word *archive* — is the same limit the task benchmark found, unchanged.

**Engineering.** Nothing measured here competes standing context against file
results for one budget; the two benchmarks sit at opposite extremes and neither
covers the middle.

**Measurement.** Fourteen tasks and twenty-six statements are enough to find
defects and not enough to report a rate to two significant figures. No model
reads the evidence. Both agents are honest, and neither tries to poison what the
other reads. Nothing here observes a store that has been running for a year, or
a statement that quietly stopped being true without anyone recording that it
had — which, on this evidence, is the failure mode with no defence in either
condition.
