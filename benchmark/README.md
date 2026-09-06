# Does Ferret help?

Every Epic in this repository was validated against its own acceptance criteria.
That proves each feature does what it says and says nothing about the question
the product exists to answer: **is an agent holding Ferret better off than one
holding `git`?**

This directory answers it by measurement rather than by argument.

```
npm run bench            # every task, three conditions
node benchmark/run.mjs --task macos-runner
```

It needs `npm run build` and an index of this repository — the database
`node scripts/dogfood-db.mjs` builds, which is the one the MCP server in
`.mcp.json` already points at.

## What is measured, and what is not

**Evidence location, not prose.** Ferret retrieves, assembles and cites; it
never writes an answer, and the product boundary keeps reasoning on the agent's
side. Grading the wording of a reply would be grading Ferret against a design it
does not have. What can be checked is whether the artefacts an answer must rest
on arrived, in what order, alongside what else, and at what cost — and an answer
given without them is unsourced whatever it happens to say.

So the headline figure is **sourced**: the share of tasks where every artefact
the answer must rest on came back inside the first ten results. It is the
nearest thing to correctness this harness can honestly report, and the
[remaining gaps](#what-this-does-not-measure) say plainly what it leaves out.

## The three conditions

| condition | what it is |
| --- | --- |
| `baseline` | `git grep` and `git log --grep` over the tracked tree, ranked |
| `ferret-pack` | `ferret_context_pack` — the tool built for a task question |
| `ferret-search` | `ferret_search` — the tool an agent reaches for by habit |

`lib/baseline.mjs` holds the whole baseline algorithm and every constant in it,
because that is the file where a benchmark gets rigged. It is deliberately
generous: it greps the *whole* tracked tree including everything Ferret's
exclusions drop, it matches literally so an exact identifier is found exactly,
it weights a filename hit at three content hits because that is what `Glob` is,
and it ranks on how many of the question's words a document contains rather than
on raw frequency — the stronger of the two, and the one that makes it harder to
beat. The stop list was fixed before any task was written and has not been
touched since.

Both Ferret tools are reported because both are plausible and picking one
quietly would decide the result. If the general-purpose tool beats the
purpose-built one, that is a finding.

## Cost is charged the same way on both sides

Neither condition returns the text of a document. A pack names the artefacts and
carries their provenance; a grep names paths. In both cases the agent then
**opens what it was pointed at**, so both are charged for the response *and* for
reading their own top three, under two reading habits that are both real:

- **full** — the agent opens the file. The usual habit, and the one that makes a
  40 kB Epic document expensive.
- **frugal** — the agent reads twenty lines either side of each match. Cheaper,
  and strictly less informative.

Both are reported and neither is called *the* cost. `estimateTokens` from
`src/context/budget.ts` counts both sides, so no difference between the
conditions comes from a difference in how they were counted.

**Cost is never read on its own.** In the first run two conditions were cheapest
exactly where they returned an empty list. `tokensPerSourcedTask` exists so that
cannot read as a win.

## The measurements

Kept separate, per the brief. There is no composite score.

| measurement | what it catches |
| --- | --- |
| `sourced` | every artefact the answer needs, inside the window |
| `recall`, `precision5`, `precision10`, `ndcg10` | how much, how clean, how well ordered |
| `mrrPrimary` | how far down the first artefact that answers it sits |
| `staleAboveCurrent` | a reversed decision ranked above the one that reversed it |
| `irrelevant5PerTask` | what the agent reads that bears on nothing |
| `retrievalTokens`, `readTokens*`, `tokensPerSourcedTask` | context spent |
| `medianMs` | wall clock for the retrieval step |

`staleAboveCurrent` is the one this exists to catch. An agent reading top-down
and stopping when it has an answer gets the reversed decision, and the answer it
then gives is confident and wrong. It is `undefined` — not `false` — on tasks
that label no trap, so those cannot dilute the rate.

The rank-order metrics are `src/evaluation/metrics.ts`, imported from the build.
They are already tested, they already return `undefined` where a number would be
a fabrication, and a second copy would be a second thing to keep correct.

## The tasks

`tasks.json`. Sixteen real questions about Ferret, drawn from decisions this
repository actually took — an owner decision reversing a matrix, a defect found
while proving another Epic, a rejected design and why it was rejected, a
credential that is ignored in one file and absent from another.

Every expectation carries a `basis`: the sentence in the repository that makes
that artefact the answer. A reviewer checks the label rather than trusting it.
`tests/unit/benchmark-tasks.test.ts` fails if a labelled path stops existing, so
the task set cannot rot into fiction while continuing to produce numbers.

Labels were written **before** any condition was run, and the results were not
used to revise them. Correcting a label after seeing a result is how a benchmark
stops measuring anything; if one is wrong the correction goes in with the reason
it was wrong, in its own commit.

## Corrections

Kept here rather than quietly folded in.

**The benchmark was searching itself.** `tasks.json` holds every question *and*
its answer key, and `results/` holds the ranked artefact names of previous runs.
Both live in the repository the harness greps. On the run immediately after the
first commit, **ten of sixteen** tasks had a `benchmark/` file in the baseline's
top ten — matching, of course, the words of the question it had been written
from. Ferret was unaffected only because its index predated that commit, so the
two conditions were being scored against different trees and the same
contamination was one re-index away from arriving on the other side.

The fix is `EXCLUDED_PREFIXES` in `lib/identity.mjs`, applied to both conditions
by the same list: the baseline never greps those paths, Ferret's returns are
filtered to the same corpus, and what each condition returned from the harness is
**counted** rather than dropped, so a contaminated run says so. Ferret still pays
the tokens it spent retrieving them; they are not refunded.

The related leak is narrower and was closed at the source rather than by widening
the list: a regression test and a source comment that quoted a task question
verbatim would have ranked themselves for that task, from files no exclusion of
the benchmark directory covers. Both now paraphrase, and say why.

Results measured before the exclusion are not comparable with results after it.
The first committed run is one of them.

**A label stated the answer it was supposed to catch.** `score-comparability`
asked why a retrieval score must never be compared between queries, and gave as
its basis that a `SearchHit.score` is PostgreSQL's `ts_rank`, *"comparable within
one result set and nowhere else"*. That has been false since EPIC-056 normalised
every branch to `[0, 1]`; `SearchHit.score` now documents itself as comparable
across queries.

The label was wrong because `src/evaluation/metrics.ts` said so, citing
`src/retrieval/query.ts:150` — a line which by then held a traversal bound. The
task was written from that citation, which is precisely the failure the task set
exists to measure, arriving through the person writing the labels.

Both are corrected: the task now asks whether the score *is* comparable and
grades `query.ts` as the answer, and the stale rationale in `metrics.ts` was
fixed as a defect in its own right. Correcting it removed the trap, so the task
carries none — a benchmark records the repository as it is, and a stale claim is
not preserved for the sake of a measurement.

**A run measured a build that was not the working tree.** The harness runs
against `dist/` and nothing made it check that `dist/` had been built from the
tree it was reporting on. A run made after a rebase failed measured a build from
before a merged retrieval fix, and its numbers were committed as current:
`ferret-search` was recorded as sourcing 32% of tasks where the build under test
sources 37%. Nothing was wrong with the run. It measured what it was pointed at
and said nothing about what that was — and a stale result is indistinguishable
from a regression.

`run.mjs` now refuses to start when `dist/` is older than `src/`, and every
report carries the commit it measured and whether the tree was dirty.

**Three tasks were added for supersession.** `staleAboveCurrent` is the
measurement this exists for and one task in sixteen exercised it, which is not
enough evidence to report a rate from. `where-decisions-live`,
`macos-ever-measured` and `nightly-run` were added from real reversals in this
repository. No existing label was touched, and the three are reported separately
from the original sixteen wherever the difference could matter.

## What this does not measure

Stated here rather than discovered later.

- **Reasoning.** No model is in this loop. Whether an agent handed the right
  evidence writes the right answer is not observed. `sourced` is a necessary
  condition for a correct answer, not a sufficient one.
- **Multi-turn work.** One question, one retrieval. An agent that searches,
  reads, and searches again with what it learned is not modelled, and that is
  the habit both conditions would improve under.
- **Durable context in its intended state.** Ferret's third tier holds what
  agents recorded. On the index this runs against it holds almost nothing, so
  most of what the pack can return is the repository — the same corpus the
  baseline greps. A run against a curated index measures a different and more
  favourable thing, and would have to say so.
- **Cross-session continuity between real sessions.** `resume-dogfood` asks the
  question; nothing here observes a second session actually resuming.

## Results

`results/latest.json` is the most recent run: the full ranked list per
condition, the per-task scores and the summary. Runs kept as evidence are named
for what they were measuring.
