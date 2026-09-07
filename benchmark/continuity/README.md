# Is what one session learned worth anything to the next one?

The task benchmark in `benchmark/` answered *"is an agent holding Ferret better
off than one holding `git`"* and closed by naming four things it could not
reach. Two of them are this benchmark's subject, in its own words:

> **Durable context in its intended state.** Ferret's third tier holds what
> agents recorded. On the index this runs against it holds almost nothing, so
> most of what the pack can return is the repository — the same corpus the
> baseline greps.
>
> **Cross-session continuity between real sessions.** `resume-dogfood` asks the
> question; nothing here observes a second session actually resuming.

So this one fills that tier and measures it.

```
npm run bench:continuity
node benchmark/continuity/run.mjs --padding 0
node benchmark/continuity/run.mjs --task macos-runner-now --keep
```

It needs `npm run build` and the Docker container `scripts/dogfood-db.mjs`
starts. It does **not** need the dogfood index, and never touches it.

## What is being measured

Twenty-seven statements of real Ferret engineering knowledge are replayed as
**eight sessions run by two agents**, in the order they were learned, through
the MCP surface. Then fourteen questions are asked in sessions that hold no
transcript of the work that learned the answer. Alpha recorded eighteen of the
statements and beta nine, and **eleven of the fourteen questions are answered by
a statement the asking agent never recorded**, so what the benchmark reports is
almost entirely cross-agent.

Each statement carries a `basis`: the file, the pull request or the owner
decision it was drawn from. Nothing here is invented, and a statement that could
not be sourced was left out. `scenario.json` is checkable rather than
trustworthy, and `tests/unit/continuity-tasks.test.ts` fails if a label stops
naming something the scenario holds.

The history contains what a real one contains: three reversed decisions, one
narrow rule later widened, one decision restated in nearly the same words and
another restated in completely different ones, and one session's private working
state that was deliberately never promoted.

## The baseline is an agent that writes things down

This is the part most easily made dishonest. Comparing a populated Ferret
against an agent that remembers nothing would be a demonstration, not a
measurement — the second session would lose by having been handed nothing.

What an agent without a knowledge layer actually does is keep notes: `CLAUDE.md`,
`.ai/knowledge/`, a `NOTES.md` in the repository, the eleven markdown files this
project's own agent was maintaining outside the product before EPIC-128. So the
baseline is a **shared, committed notes file**, given exactly the same statements
Ferret is given, at the same moment, in the same order, **with the same
reasoning**. Nothing is withheld from it. `lib/notes.mjs` holds the whole
baseline and every constant in it.

Three habits, because picking one would decide the result:

| condition | what it is |
| --- | --- |
| `notes-append` | every statement appended, nothing ever revisited |
| `notes-curated` | a superseded statement is removed when its replacement arrives |
| `notes-full` | the whole curated file read into context, no retrieval at all |

and the three Ferret surfaces that answer the same shape of question:

| condition | what it is |
| --- | --- |
| `ferret-pack` | `ferret_context_pack` — the tool built for a task question |
| `ferret-search` | `ferret_search` — the tool an agent reaches for by habit |
| `ferret-find` | `ferret_context_find` — everything the store currently holds |

They pair up deliberately: `notes-full` and `ferret-find` are the same habit on
two mechanisms — read everything, rank nothing — and the grep conditions pair
with the two query-driven ones.

**The curated baseline is handed, for free, the one thing Ferret's mechanism
exists to supply**: the knowledge of what supersedes what. It therefore cannot
fail the supersession measurement, by construction. That is the point of
including it. If Ferret only matches a perfectly disciplined agent, the honest
result is that Ferret costs nothing to be disciplined *without the discipline* —
and the report says so rather than quietly omitting the condition that shows it.

Ranking over the notes is the **same** algorithm `benchmark/lib/baseline.mjs`
uses — the same term extraction, the same stop list fixed before any task was
written, the same damping, the same weight for a name hit, imported rather than
copied. The unit ranked is the note rather than the file, because a notes file
is one file and ranking files would rank one thing.

## Two headline measures, not one

`sourced` is the task benchmark's: every statement the answer must rest on came
back inside the window. It is carried over unchanged, from the same
`benchmark/lib/score.mjs`.

**`answered` is new, and this benchmark needs it.** Artefact recall cannot
separate a condition that returned the right record from one that returned the
right record *with the reasoning stripped out* — and the second is cheaper on
every cost measure, so a benchmark reporting only recall and tokens would rank
it higher for carrying less. That is not hypothetical here:
`ferret_context_record` takes a statement and has no field for the reasoning
behind it, and promotion drops the `rationale` the session tier collected.

Checking it is possible here in a way it was not in the task benchmark. There an
artefact was a path the agent still had to open. Here the artefact **is** the
text — it arrives in the response — so the facts a complete answer needs are
matched against what the condition actually put in front of the agent, with no
model in the loop and nothing inferred. `lib/facts.mjs`, pinned against worked
examples in the unit test, because a headline figure whose definition is
undefined behaviour is not evidence.

The rest are kept separate, per the task benchmark's rule. There is no composite
score.

| measurement | what it catches |
| --- | --- |
| `sourced` | the statements the answer needs came back |
| `answered` | what came back actually said them |
| `staleAboveCurrent` | a reversed decision ranked above the one that reversed it |
| `wordings` | how many restatements of one answer the reader was handed |
| `retrievalTokens`, `readTokens*` | context spent |
| isolation probes | what must cross does; what must not, does not |
| continuity probes | a second session actually resuming a first |

## Cost is charged the same way on both sides

A durable statement arrives in the response, so there is nothing further to
open and charging a second read for it would invent a cost. A grep over notes
returns matching lines, so that condition is charged for the listing *and* for
opening its top three notes, under the same two reading habits
`benchmark/lib/baseline.mjs` charges. `notes-full` and `ferret-find` are charged
for everything they deliver, which is the whole measurement for those two.

`estimateTokens` from `src/context/budget.ts` counts both sides, so no
difference between conditions comes from a difference in how they were counted.
Containment markers are counted where Ferret emits them: they are tokens a
client receives.

## It is measured at more than one size

A store holding twenty-seven statements is a week old, and at that size a notes
file is a page that can simply be read. The claim durable context makes is about
a knowledge base months old, so the same questions are asked again with the
store padded by **real** statements drawn from this repository's Epics — one per
Epic, from its title and status line. `lib/padding.mjs`.

Three properties keep padding from being a way of getting a result. Both sides
get the identical padding in the identical order. Padding is never labelled, so
a condition that returns one is scored as having returned something irrelevant —
which understates precision on whichever side retrieves well, a bias in the safe
direction. And it is checked before anything is measured: `assertNoOverlap`
fails the run if a padding statement contains a phrase a task requires.

Padding is **interleaved across the sessions** rather than loaded in front of
them. Loading it first would make every graded statement the newest thing in the
store, which flatters any condition that reads newest-first.

## Contamination is impossible here by construction

The task benchmark had to correct for searching its own answer key twice, both
times after numbers had been published, and the fix was an exclusion list
applied to both conditions.

This benchmark needs no exclusion list. The Ferret side runs against a database
this harness creates, migrates and drops, holding nothing but the scenario; the
notes side is generated at run time. No repository is indexed, so there is
nothing for a question to match except the statements it is being scored
against. `scenario.json` and `tasks.json` sit under `benchmark/`, which the
task benchmark's `EXCLUDED_PREFIXES` already covers, so they cannot leak into
*that* benchmark either.

The isolated store is also why this can be run at all without consequence: the
dogfood index is what the task benchmark measures and what an agent working on
this repository actually reads, and writing an invented history into it would
move that benchmark's numbers and put fictional sessions in front of a real
agent.

**This benchmark is unaffected by the exclusion defect recorded in
[EPIC-135](../../docs/EPICs/EPIC-135-Exclusion-Enforcement-At-Ingestion.md).**
That defect is that a configured `exclude` rule filters reads rather than
preventing a path being indexed and stored. Nothing here relies on an exclusion:
the store holds the scenario and nothing else, no repository is indexed into it,
and it is dropped at the end of every run. The task benchmark's own guard is
clarified in `benchmark/README.md` — it proves the answer key is not *returned*,
not that it is absent from storage.

## Corrections

Kept here rather than quietly folded in. All three were found by running it.

**Three statements were duplicated by the harness, not by the product.** A
`fact` is a durable context kind and is *not* a session memory kind —
`MEMORY_KINDS` is EPIC-042's five and durable context added `fact` on top of
them. An early draft carried facts into the session tier as `decision`s so their
rationale had somewhere to live; the merger keys on the statement *and its
kind*, so promoting them produced a second record of the same sentence, three
times. The harness now records a statement only in the tier its kind belongs to.
The duplication was the harness's. The seam it exposed — that the rationale of a
fact has nowhere in Ferret to live — is not, and it is reported as a finding.

**A refused call was scored as an empty answer.** The whole-store read asked for
a page of 500 where the tool serves 200. Every call was refused, and the
condition scored zero on every task at every store size — which reads as
"durable context returned nothing" rather than as "the harness asked wrongly".
`call` now refuses to return an error as though it were an answer, and the limit
is read from the build rather than written down here. A refusal *inside* a
successful call — `found: false` on a session that is not yours — still passes
through, because that distinction is the whole of the isolation measurement.

**A statement was recorded as current that this repository had reversed.** The
scenario claimed Windows continuous integration runs only on push to `main`, so
a Windows-only break appears after a merge. That was true from pull request #105
and was reversed by an owner decision on 2026-09-05: Windows now runs on every
event including a pull request, and Ubuntu and macOS are dropped from the verify
matrix entirely. The claim reached the scenario from a **working memory that was
never updated after the reversal** — which is precisely the failure this
benchmark exists to measure, arriving through the one route it cannot see, the
person writing the labels. It is the same correction the task benchmark had to
make, for the same reason, and it was caught here only by reading
`.github/workflows/ci.yml` while waiting for that workflow to run.

Corrected as the supersession it actually is rather than by editing the
statement: the reversed claim stays, marked superseded, and the owner decision
that replaced it is recorded against it. That added a fifth supersession task and
moved two headline figures — `notes-append` ranks a stale statement first on 60%
of them rather than 50%, and `ferret-pack` answers 64% rather than 71%, because
what the reinstatement cost is recorded only in a rationale. Both moved against
the conclusion the earlier numbers supported, which is the direction a correction
should be allowed to move them.

**A worked example asserted the wrong winner.** The unit test pinned a notes
ranking that the ranker does not produce, and the ranker was right. The example
was replaced with a constructed pair that pins the actual rule — a term in a
note's heading outweighs one in its body — plus a guard that the baseline still
retrieves the labelled answer for every real question, so a baseline that
quietly stopped working could not make every Ferret condition look good.

## What this does not measure

Stated here rather than discovered later.

- **Reasoning.** No model is in this loop. `answered` checks that the facts an
  answer needs were in front of the agent, not that the agent used them.
- **A repository alongside the durable tier.** The store holds statements and
  nothing else, so how standing context and file results compete for one budget
  is not measured here. The task benchmark measures the opposite extreme.
- **Extraction.** Every statement was recorded deliberately. Whether an agent
  *would* have recorded the right twenty-six sentences is the question this
  assumes an answer to, and it is the largest assumption in the design.
- **More than two agents**, and no adversarial one. Both agents here are
  honest; neither tries to poison what the other reads.
- **Real elapsed time.** Eight sessions are replayed in seconds. Nothing here
  observes a store that has been running for a year, or a statement that
  quietly stopped being true without anyone recording that it had.

## Results

`results/latest.json` is the most recent run: every condition's ranked list, the
per-task scores at each store size, the isolation and continuity probes, and the
summary. `results/notes-append.md` and `results/notes-curated.md` are the files
the baseline was actually given, written out so a reader can check what it had
rather than take this document's word for it.

`results/before-omission-fix.json` is kept deliberately: it is the run that
found the pack reporting a result limit it never hit, on fourteen of fourteen
packs, and it is the measurement the fix is justified by.
