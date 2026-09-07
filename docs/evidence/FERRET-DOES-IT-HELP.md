# Does Ferret help? — the measurement, and what it says

**Tree:** `ee62884` (`main`) · **Index:** `ferret-dogfood`, Ferret's own
repository, 914 tracked files, 10 excluded · **Command:** `npm run bench` ·
**Date:** 2026-09-06

Every Epic before this was validated against its own acceptance criteria. That
proves each feature does what it says and says nothing about the question the
product exists to answer: **is an agent holding Ferret better off than one
holding `git`?**

This is the answer, measured. It is not the answer anyone building Ferret would
have hoped for, and the parts that are good are good for reasons worth being
precise about.

---

## 1. The benchmark

`benchmark/` — nineteen real questions about Ferret, drawn from decisions this
repository actually took: an owner decision reversing a CI matrix, a defect found
while proving another Epic, a rejected design and why it was rejected, a
credential ignored in one file and absent from another.

Three conditions answer each one:

| condition | what it is |
| --- | --- |
| `baseline` | `git grep` and `git log --grep`, ranked — `benchmark/lib/baseline.mjs` |
| `ferret-search` | `ferret_search` over MCP |
| `ferret-pack` | `ferret_context_pack` over MCP, budget 4 000 |

**What is measured is evidence location, not prose.** Ferret retrieves,
assembles and cites; it never writes an answer. Grading the wording of a reply
would grade it against a design it does not have. The headline is `sourced`: the
share of tasks where every artefact the answer must rest on came back inside the
first ten results. Both conditions then read what they were pointed at, and both
are charged for it under the same estimator.

`benchmark/README.md` holds the method, the baseline's every constant, and the
corrections. Two consecutive runs are byte-identical.

---

## 2. What it found

| condition | sourced | recall | nDCG@10 | MRR | irrelevant in top 5 | context | per sourced task | p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | **8/19 (42%)** | 0.36 | 0.34 | 0.41 | 4.1 | 793 k | 99 k | 1 017 ms |
| `ferret-search` | **8/19 (42%)** | 0.33 | 0.30 | 0.29 | 4.2 | 1 060 k | 133 k | 199 ms |
| `ferret-pack` | 5/19 (26%) | 0.24 | 0.22 | 0.23 | 3.6 | 712 k | 143 k | 109 ms |

Per task, `yes` meaning every artefact the answer needs came back:

| task | kind | base | search | pack | base | search | pack |
| --- | --- | --- | --- | --- | --- | --- | --- |
| macos-runner | decision | 1/2 | 1/2 | 1/2 | 33k | 33k | **10k** |
| durable-context-key | rationale | 0/2 | 0/2 | 0/2 | 25k | 26k | 23k |
| merger-boundary | constraint | 1/2 | 0/2 | 0/2 | 34k | 47k | 45k |
| dogfood-skip | rationale | **yes** | **yes** | 0/2 | 52k | 58k | 26k |
| session-ownership | security | 1/2 | 0/2 | 0/2 | 33k | 41k | 39k |
| postgres-coverage | constraint | **yes** | **yes** | 1/2 | 22k | 67k | 20k |
| score-comparability | rationale | **yes** | **yes** | **yes** | 56k | 39k | **37k** |
| pack-standing | prior-decisions | **yes** | **yes** | 1/2 | 49k | 62k | 60k |
| ci-concurrency | rationale | 0/1 | 0/1 | 0/1 | 58k | 75k | 56k |
| dogfood-db-separate | rationale | **yes** | **yes** | **yes** | 25k | 31k | 28k |
| settings-local-ignored | gotcha | 0/1 | 0/1 | 0/1 | 47k | 85k | 63k |
| writing-a-provider | constraint | 0/2 | 0/2 | 0/2 | 44k | 40k | 38k |
| token-estimate | rationale | 0/1 | 0/1 | 0/1 | 59k | 70k | **28k** |
| required-groups | rationale | **yes** | **yes** | **yes** | 31k | 58k | **18k** |
| epic-125-gap | supersession | **yes** | **yes** | **yes** | 44k | 46k | **27k** |
| resume-dogfood | continuity | 0/3 | 1/3 | 0/3 | 26k | 83k | 41k |
| where-decisions-live | supersession | 0/2 | 0/2 | 0/2 | 52k | 67k | 64k |
| macos-ever-measured | supersession | 1/3 | 1/3 | 1/3 | 56k | 94k | 54k |
| nightly-run | rationale | **yes** | **yes** | **yes** | 48k | 38k | **35k** |

### Where Ferret wins, and by how much

**Latency.** 109 ms against 1 017 ms, a factor of nine, and the gap is
structural rather than incidental: the baseline runs one `git grep` per question
term over the whole tracked tree, and Ferret asks an index one question.

**Cost, when it finds the answer.** On the five tasks both the baseline and the
pack source, the pack costs **0.71×** what grep-and-read costs — 145 k against
203 k tokens. It is cheaper than the baseline on **12 of 19** tasks, sometimes by
a factor of three (`required-groups` 18 k against 31 k, `macos-runner` 10 k
against 33 k). That is the product's central claim, and it holds.

**It does not degrade on a long question the way grep does.** `nightly-run` and
`score-comparability` are both cheaper *and* better ranked through Ferret.

### Where it does not

**`ferret-search` matches the baseline on tasks sourced and loses on rank.**
Equal at 8 of 19, but nDCG 0.30 against 0.34 and MRR 0.29 against 0.41: it finds
the same things and puts them lower. It also spends 34% more context doing it,
because it returns ten results where the baseline's ranking concentrates earlier.

**`ferret-pack` — the purpose-built tool — is the weakest of the three**, and the
cause is measured rather than guessed. Its list is a *prefix* of the search's on
most tasks: it returns three to eight artefacts where a search returns ten,
because each item carries an entity, its evidence, and the account of why that
evidence was cited. At a 4 000-token budget that provenance costs slots. A budget
sweep on the same questions:

| pack budget | tasks sourced |
| --- | --- |
| 4 000 | 3 |
| 6 000 | 4 |
| 8 000 | 5 |
| 12 000 | 5 |

**The pack needs roughly twice the budget to source what a search sources, and
buys provenance with the difference.** That is a product trade-off, not a defect,
and it is not this phase's to decide.

**Eleven of nineteen tasks defeat all three conditions**, and that is the most
useful number here. For most of them — `token-estimate`,
`settings-local-ignored`, `ci-concurrency`, `writing-a-provider`,
`durable-context-key` — the answer is a comment inside a source or config file
and no condition ranks it. Nothing there is a Ferret defect; it is the limit of
lexical retrieval, and Ferret ships no embedding provider by design.

The rest fail for a more interesting reason: they need **two** artefacts that no
single query reaches together. `macos-ever-measured` needs the record that macOS
passed and the workflow that stopped running it; `session-ownership` needs the
Epic that closed the hole and the file that enforces it. Every condition found
one and stopped. A single retrieval per question cannot answer a question with
two halves, and none of the three conditions models the second look.

**Supersession is measured and nothing failed it, which proves less than it
sounds.** Two of nineteen tasks label a superseded artefact, and no condition
ranked one above the document that superseded it. On the one task where the traps
were actually retrieved, the baseline ranked the current record first — by keyword
coincidence, not by any understanding. **No condition models supersession
between documents.** Ferret's lifecycle machinery applies to durable context
records, and this repository's knowledge does not live in them; it lives in prose
in markdown.

---

## 3. What was fixed

Seven pull requests. Every one has an observable reason, and every measurement
below was taken before the change.

| # | Defect | How it was found | Evidence |
| --- | --- | --- | --- |
| [#211](https://github.com/indoulia/Ferret/pull/211) | The dogfood oracle read a **configured exclusion** as a missing file — it compared `git ls-files` against the index and nothing else | excluding a directory the benchmark needed excluded | `FAIL no missing files — 10 tracked file(s) absent` → `ok (914 tracked, 10 excluded)` |
| [#212](https://github.com/indoulia/Ferret/pull/212) | `ferret_context_pack` returned an **empty pack** where `ferret_search` returned ten for the same string, with `omitted: []` — its own statement that it was complete | the benchmark, on 4 of 16 questions | empty packs 4 → 0 |
| [#213](https://github.com/indoulia/Ferret/pull/213) | A widened search spent **1 128 ms of 1 139 ms** in `ts_headline` over file bodies, marking up rows the `LIMIT` discarded | timing every question | widened queries 1 054–1 226 ms → 152–258 ms; strict 95–120 ms → 42–74 ms |
| [#214](https://github.com/indoulia/Ferret/pull/214) | **One incidental match suppressed the widening** — the fallback fired only on an empty result | 5 of 16 questions filled one or two of ten slots | `ferret-search` sourced 25% → 31%, recall 0.20 → 0.25 |
| [#215](https://github.com/indoulia/Ferret/pull/215) | The pack **charged its budget for a third less than it sent**, and cited every observation twice by construction | comparing the charge with the response | 5 items: charged 3 669 / sent 5 169 → charged 3 978 / sent 3 958; response 6 724 → 5 346 |
| [#216](https://github.com/indoulia/Ferret/pull/216) | `metrics.ts` justified its rank-order rule with a claim EPIC-056 had **reversed**, citing a line number that now holds a traversal bound | it made the benchmark's own label wrong | — |
| [#210](https://github.com/indoulia/Ferret/pull/210) | The benchmark, and two defects in it | — | see §4 |

Two changes were **measured and reverted**, per the loop's own rule:

- **Partial-fill widening inside `ContextPackBuilder`.** Recall 0.19 → 0.20 and
  nDCG 0.19 → 0.20, for 23% more context and p50 85 ms → 401 ms, sourcing no
  additional task. Tried twice — once before and once after items became 34%
  cheaper, in case the trade-off had flipped. It had not.
- **Routing the pack through `QueryPlanner`** stays rejected, as EPIC-131
  recorded. The pack's deficit is budget, not retrieval: its results are a prefix
  of the search's.

### Tests

| | `271be92` | `ee62884` |
| --- | --- | --- |
| test files | 207 | **208** |
| tests | 4 074 | **4 189 passed, 7 skipped** |

The seven skipped are the deliberately conditional ones, and
`tests/required-groups.ts` confirms the packaging group executed 34 of 34 —
a run that had not cleared that gate would say so rather than reporting a skip
count that reads as a pass.

Two of the new cases were **proven against the unfixed code** — the fix reverted
and the test observed to fail: the pack's widening on an empty strict result, and
the planner's partial fill. The rest are guards on behaviour that was already
correct, and saying which is which matters more than the count.

### Security

No control was weakened and none was bypassed. Two things are worth recording
because both could have gone the other way:

- **The deferred highlight resolver runs no permission predicate, deliberately.**
  The blob hashes reach it only from hits that already passed `scopePredicate`
  and `visibleEntities`. Filtering `content_blob` would also be filtering the
  wrong thing — a blob is shared by definition, which is why the ranked query
  does not scope on it either. The reasoning is at the call site so the next
  reader does not have to re-derive it.
- **A security case failed rather than passing quietly.**
  `injection-boundary.test.ts` proves F-32 by making a message not fit; under the
  honest budget charge the *trimmed* item no longer fit in 400 tokens, so the pack
  dropped it and the case stopped exercising a trim. It failed on its own guard —
  *"the budget did not force a trim, so this proves nothing"* — which is the whole
  reason that assertion exists. The budget was raised to the smallest value that
  still forces one, with the reason recorded.

`tests/security` — 166 tests, all passing. `npm audit --omit=dev` clean on every
run.

### Performance

The only threshold touched was raised in a *test*, for the reason above. No CLI
timeout, p95 limit, package-size gate or security limit was loosened. One
performance defect was found and fixed in the implementation rather than
absorbed: `ts_headline` over file bodies, §3 #213.

---

## 4. The benchmark's own defects

Recorded here because a benchmark that hides its corrections is not evidence.
All three are in `benchmark/README.md` with their measurements.

**It searched its own answer key.** `tasks.json` holds every question *and* the
artefacts that answer it. On the run after the first commit, **ten of sixteen**
tasks had a `benchmark/` file in the baseline's top ten. Ferret was unaffected
only because its index predated that commit — so the two conditions were being
scored against different trees, and the contamination was one re-index away from
arriving on the other side. Fixed by one exclusion list applied to both
conditions, with what each returned from the harness counted rather than dropped.

**A label stated the very answer it was meant to catch.**
`score-comparability` asked why a score must never be compared between queries,
because `metrics.ts` said so. `metrics.ts` was wrong. The stale claim reached the
benchmark through the person writing the labels — which is the failure mode
`staleAboveCurrent` exists to measure, arriving by the one route it cannot see.
Both were corrected, and fixing the comment *removed* the trap rather than
preserving it.

**This document contaminated the corpus the day it was written.** It is an
ordinary file in `docs/evidence/`, real repository knowledge, and it states every
task's answer in prose. Indexed, it appeared **twelve times** across the three
conditions and cost `ferret-pack` five points of `sourced` — 26% to 21% — by
displacing the documents it describes. It is now on the exclusion list beside
`tasks.json`; every other document in `docs/evidence/` stays corpus. The numbers
in §2 are measured with it excluded and are unchanged from what was first
published.

**What the exclusion guard proves, precisely.** Measured on 2026-09-07 against
the dogfood store at merge `b8ea20c`: excluded paths **are present in storage**
after a re-index. `benchmark/` has been excluded since 2026-09-06, and
`benchmark/continuity/` was created on 2026-09-07 and indexed by that day's run
anyway, with its content retained — so a Ferret `exclude` rule currently filters
reads rather than preventing acquisition.

The read path holds completely: `ferret_find` on an exact path, `ferret_search`
on three queries worded to match the harness (0 of 30 results) and
`ferret_context_pack` (0 of 5 items) all return nothing from the excluded set.

So this benchmark's guard proves the answer key **is not returned through the
surfaces it measures**. It does not prove the answer key is absent from the
database, and nothing here ever claimed the stronger thing. Every number in this
report is produced through those surfaces, so the guarantee they give is the one
the results need. No scoring, condition or semantic changed.

The storage behaviour is a separate defect and is deferred to
[EPIC-135](../EPICs/EPIC-135-Exclusion-Enforcement-At-Ingestion.md) by owner
decision on 2026-09-07, rather than fixed inside benchmark work.

**A run measured a build that was not the working tree.** The harness ran against
`dist/` and never checked it had been built from the tree it reported on. A run
made after a failed rebase measured a build predating a merged fix, and those
numbers were committed as current — `ferret-search` at 32% where the build under
test scores 42%. It now refuses to start when `dist/` is older than `src/`, and
every report carries the commit it measured and whether the tree was dirty.

---

## 5. Dogfood

`npm run dogfood -- --check` against `ee62884`, on Ferret's own index:

```
15 checks, 0 findings, 0 skips
914 tracked, 10 excluded · 918 entities · 904 active · 0 phantom
durable context converges (4 wordings → 2 records)
```

Every benchmark question went through the **MCP surface**, over stdio against a
built CLI, exactly as `.mcp.json` wires it — the discipline `scripts/dogfood.mjs`
established, for its own reason: *"a defect that only SQL can see is not a defect
a client will ever hit."* Three of the six product defects above were invisible
from SQL and visible from the tool surface.

**Cross-agent and cross-session evidence is thin, and that is a real gap rather
than an omission.** The durable-context tier holds **two** records on this index,
both probes. The knowledge these nineteen questions are about lives in `docs/`,
in commit messages and in PR bodies — the same gap EPIC-126 measured as *"one
engineering memory for 208 commits, 139 pull requests and 49 issues"*, unchanged.
Every result above is therefore a measurement of Ferret's **acquire → retrieve →
assemble** path over a repository, with the curate tier empty. A Ferret whose
durable context had been populated by real use would be measuring something else,
and would have to say so.

---

## 6. What the evidence says

**Proven.**

- Ferret answers a real engineering question about **nine times faster** than
  grepping the repository, and the gap is structural.
- When the context pack finds the answer, it costs **0.71×** what grep-and-read
  costs, and it is cheaper on 12 of 19 tasks. The "fits a context window" claim
  holds.
- The MCP surface finds defects the test suite does not. Four defects in product
  code, one in the acceptance oracle and one stale rationale in a source comment
  — none of which 4 074 passing tests had caught.
- `ferret_search` now matches a strong grep baseline on evidence recovered
  (8 of 19 each), having started this phase behind it.

**Not proven.**

- That an agent using Ferret *answers better*. No model is in this loop.
  `sourced` is necessary for a correct answer, not sufficient, and the benchmark
  says so in its own README.
- That Ferret handles superseded information better than grep. Two tasks, no
  failures, and no condition models supersession between documents.
- Anything about cross-session or cross-agent continuity in practice. The tier
  that would carry it is empty.

**Disproven, or at least not supported.**

- That the purpose-built assembly surface beats a general search for task
  questions. It does not, at its default budget, and the reason is arithmetic:
  provenance costs slots.

### Remaining gaps

**Product.** Superseded *documents* are not modelled — only durable context
records are, and the knowledge is not in them. Ranking degrades on a long
question relative to a short one, and there is no phrase or proximity handling.
The pack's provenance-per-slot trade-off is unresolved and is an owner decision.
Whether a pack's budget should cover its content notice (257 tokens) and report
fields (362) is the same kind of decision.

**Engineering.** The pack does not share the planner's routing, so an exact
identifier in a task question is handled differently by the two surfaces. No
performance budget guards full-text search, which is why #213's regression could
have shipped unnoticed.

**Measurement.** No model reads the evidence, so correctness is inferred from
recovery. One retrieval per question — the search, read, search again loop both
conditions would improve under is not modelled. Nineteen tasks is enough to find
defects and not enough to report a rate to two significant figures. The benchmark
measures a repository this work also modified, which is why every run records its
commit.

**Deliberate non-goals.** No model inside Ferret. No embedding provider. The
merger still decides nothing on a score, retrieval still does no reasoning,
assembly still plans nothing, and the durable-context corpus is still written by
agents rather than inferred.
