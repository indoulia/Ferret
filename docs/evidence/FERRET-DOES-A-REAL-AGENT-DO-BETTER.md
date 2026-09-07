# Does a real agent do better engineering work with Ferret? — the measurement

**Question:** does giving a fresh AI agent access to Ferret materially improve
its ability to perform real engineering work?

**Harness:** `benchmark/agent/` · **Store:** the dogfood index · **Date:**
2026-09-07 · **Agent:** headless Claude Code (`claude -p`), one fresh session per
task per arm.

This report is on the corpus exclusion list, for the reason
`benchmark/lib/identity.mjs` gives: it states every task's answer in prose, and
`docs/evidence/FERRET-DOES-IT-HELP.md` cost a condition five points of `sourced`
by being indexed before anyone noticed that. It was added to the list before it
was written rather than after its numbers had been published.

---

## 1. Why this phase exists

Both earlier benchmarks closed on the same admitted limit, in nearly the same
words.

> **Reasoning.** No model is in this loop. Whether an agent handed the right
> evidence writes the right answer is not observed. `sourced` is a necessary
> condition for a correct answer, not a sufficient one.

That limit is not a detail. Without a model in the loop, a weak result cannot
distinguish three situations that imply opposite next steps:

1. Ferret does not help.
2. Ferret helps, and the agent cannot discover or use it.
3. The task never needed accumulated context.

So this phase puts a real agent in the loop.

## 2. What was held constant, and what was not

One thing differs between the arms: whether Ferret's MCP server is configured.

| arm | tools |
| --- | --- |
| `control` | `Read`, `Grep`, `Glob`, `Bash` — no MCP servers at all |
| `treatment` | the same four, plus the thirty tools Ferret publishes |

Held: the model, the effort level, the question, the answer schema, the built-in
tool set, the permitted tool list, the corpus, the working directory, the
wall-clock and spend ceilings, and the working tree.

`--setting-sources ""` means no user, project or local settings are loaded — no
`CLAUDE.md`, no personal preferences about how many files to read.
`--strict-mcp-config` means no MCP server exists that the harness did not write;
without it the control would have picked Ferret up from `.mcp.json` and there
would have been no comparison at all.

**The treatment is never told Ferret exists.** Not in the question, not in the
appended answer contract, not in a description the harness wrote. It is handed
thirty tools with Ferret's own names and Ferret's own descriptions and left to
work out whether any of them is worth calling. Ferret's `initialize`
instructions are passed through because an MCP client shows them; they are
recorded verbatim in the report.

**The control is not weak.** Ripgrep over the whole tree, glob, `git log`,
`git show`, `git grep`, and a frontier model deciding what to look for. That is
the tool set a working engineering agent actually has, and in the retrieval-only
benchmark the equivalent baseline beat `ferret_context_pack` on `sourced`, 42% to
26%.

## 3. Correctness is an equality check, not a judgement

Each session ends by emitting one JSON object against a per-task schema, the
same schema in both arms. The field that decides correctness is `verdict`: one
option from a fixed set the task defines, in the task's own order, none phrased
more fully than the others. `verdictCorrect` is `picked === expected`.

No second model grades prose. `unsupportedCitations` is defined by the trace — a
citation naming something that appears in no tool argument and no tool result of
that session — so a hallucinated citation is caught mechanically. Where
staleness could be expressed as a verdict option it is; where it could not, it
is a pattern over prose, which is the weakest measurement here and is reported
as such.

Five of the eight questions and **all** of their evidence labels are the task
benchmark's own, written from cited repository sentences before any condition
was run and corrected twice since. Reusing them means this phase cannot be
accused of inventing labels that suit it.

---

## 4. What the harness found before it measured anything

Four defects, all found by running it. Two were the harness's and two were
Ferret's; the harness's are recorded here because a benchmark that hides its own
false starts is not evidence.

### 4.1 An exclusion written `secrets/` excluded nothing — Ferret

`src/config/exclusions.ts` expands a bare directory name into four patterns so
that `node_modules` means "that directory and everything under it", which its
own comment says is *"what a user means by it"*. The expansion is applied only
when the pattern holds no glob metacharacter — and a trailing slash is not one.
So `benchmark/` expanded to `benchmark/`, `benchmark//**`, `**/benchmark/` and
`**/benchmark//**`, and matched no path at all.

The harness hit it because it wrote its corpus rule from
`benchmark/lib/identity.mjs`, where the prefixes carry a trailing slash because
they are string prefixes. Ferret accepted the rule, `ferret_config_exclusions`
reported the path as excluded, and the answer key stayed readable. **The failure
mode is silence**, which is the worst one available to a rule whose whole job is
to withhold: an operator who writes `secrets/` gets no exclusion and no
complaint.

Fixed by stripping trailing slashes before the expansion, with a regression test
that names where the defect was found. It widens what an exclusion covers, so it
strengthens the boundary rather than moving it; EPIC-135's read-versus-storage
semantics are untouched.

### 4.2 Every Ferret call was denied, and the run looked normal — harness

The first full Opus run set `--permission-mode dontAsk` and named only the
built-in tools as available. `dontAsk` denies anything not permitted, and MCP
tools were not permitted, so **every Ferret call in every treatment session came
back** *"Permission to use mcp__ferret__… has been denied"*. The treatment was a
control with a broken MCP server, and some `Bash` calls were denied on both
sides for the same reason.

Nothing in the summary said so. `ferretCalls` counted the attempts, not the
successes, and both arms scored identically — which reads as "Ferret makes no
difference" rather than "Ferret was never called". That run is kept.

It did produce one clean measurement, because each task is a fresh session and
the first attempt in each is uncontaminated by knowing Ferret is unavailable:
**the agent reached for Ferret unprompted on three of the five tasks it got to,
and reached for `ferret_context_pack` first on two of them.** That is a
discoverability result the working run cannot produce as cleanly.

### 4.3 The agent read the answer out of a file nobody had declared — harness

Claude Code's system prompt advertises the session's memory directory. The
treatment agent went there and read
`…/memory/no-macos-ci.md`, a one-line note reading *"owner decision: don't add a
macOS runner"* — the answer to task one, from outside the repository, in a file
no corpus list mentioned.

Containment is now the rule rather than a longer deny list: outside the
repository is exactly where an answer key nobody declared lives. The guard also
refuses `Write`, `Edit` and mutating shell verbs, so a benchmark run cannot
change the repository it measures.

### 4.4 An exclusion written `!keep` excluded everything except `keep` — Ferret

This one was not found by the harness. It was found **by an agent using Ferret**,
in Session A of experiment two (§7.1), which was asked to establish how `exclude`
behaves and reported, unprompted:

> a leading `!` is handed to picomatch as a negation, which compiles to
> `^(?!...).*$` — so a rule like `!keep` excludes every path except `keep`.

Verified directly. `!keep` excludes `src/index.ts`, `a.log`, `secrets/key.pem`
and `README.md`, and excludes `keep` alone from exclusion. **One character turns
an exclusion list into an allow-list, silently**, in a configuration key whose
documented purpose is withholding.

Nothing a negation could mean here is correct. `ExclusionScope` documents
exclusion as one-way — *"a narrower scope may add exclusions but never remove one
a broader scope imposed"* — so a pattern that un-excludes almost everything has
no valid reading. It is refused at schema validation with a remediation naming
the reason, and a `!` anywhere other than the first character stays an ordinary
filename character.

---

## 5. What Ferret costs an agent before it answers anything

Measured directly against the running server, not inferred.

| | value |
| --- | --- |
| tools published | 30 |
| tool definitions, serialized | 36 818 characters |
| descriptions carrying the content-safety notice | 14, ~8 700 characters of notice |
| `initialize` instructions | 760 characters |
| `ferret_search`, `limit: 20` | 79 571 characters (~32 000 tokens) in one result |
| `ferret_search`, `limit: 5` | 11 223 characters (~4 200 tokens) |
| `ferret_context_pack`, `budget: 4000`, default format | 17 059 characters (~5 400 tokens) |
| `ferret_context_pack`, `budget: 4000`, `format: 'text'` | 6 238 characters (~2 800 tokens) |

Three things follow.

**A tool list is a per-turn cost.** Tool definitions are re-sent on every
request in the session, so thirty of them are paid once per turn rather than
once per session. On `macos-runner` the same question over fourteen turns cost
the control 156 273 cached input tokens and the treatment 268 125 — **72% more
context, before counting a single Ferret result.** The dollar difference is
small because those are cache reads ($0.43 against $0.47); the context
difference is not, and context is the scarce resource.

**`ferret_search` has no compact form.** `limit` controls how many hits come
back, not how much each carries, and there is no `format` argument. At
`limit: 20` the result was large enough that Claude Code truncated it to a file
— and the file is outside the repository, so the containment guard then refused
to open it. The agent asked one question, paid for it, and received nothing
usable.

**The pack overshoots the budget it is asked for, in the format a client gets by
default.** `budget: 4000` returns ~2 800 tokens rendered and ~5 400 as JSON, and
JSON is what an MCP client receives when it does not pass `format`. The
description says the pack is *"sized to a token budget"*. A caller asking for
4 000 gets 36% more than that and is not told.

None of these is a defect in what Ferret retrieves. All three are costs of
delivery, and all three are inside Ferret's boundary.

---

## 6. Experiment one: eight repository questions

`benchmark/agent/results/opus.json` as measured, and
`results/opus-regraded.json` after the one scoring correction described in §6.4.
Sixteen sessions, Claude Opus 5 at high effort, one repeat.

### 6.1 The summary

| measure | control | treatment |
| --- | --- | --- |
| **verdict correct** | **8 / 8** | **8 / 8** |
| facts complete | 6 / 8 | 7 / 8 |
| facts covered | 92% | 92% |
| evidence sourced (every relevance-3 artefact cited) | 7 / 8 | 6 / 8 |
| stale belief asserted | 0 / 7 | 0 / 7 |
| unsupported citations | 0 | 0 |
| tool calls per task | 20.9 | 17.8 |
| **files read per task** | **6.1** | **2.9** |
| **lines read per task** | **807** | **355** |
| searches per task | 10.0 | 7.9 |
| Ferret calls per task | 0 | 3.0 |
| context tokens per task | 417 075 | 433 908 |
| context per correct answer | 476 657 | 495 895 |
| median seconds | 105 | 110 |
| median turns | 21 | 18.5 |
| dollars, all eight tasks | $6.06 | $6.33 |

### 6.2 Per task

| task | control | treatment |
| --- | --- | --- |
| `macos-runner` | right · 3/3 facts · 2/2 evidence · 162 k | right · 3/3 · 2/2 · 272 k · 2 Ferret calls |
| `macos-ever-measured` | right · 2/2 · 3/3 · 169 k | right · 2/2 · 3/3 · 432 k · 1 |
| `exclusion-storage` | right · 4/4 · 2/2 · 293 k | right · 4/4 · 2/2 · 648 k · 2 |
| `exclusion-reason` | right · 3/3 · 2/2 · 274 k | right · 3/3 · 2/2 · 201 k · **0** |
| `where-decisions-live` | right · 2/3 · **0/2** · 453 k | right · **1/3** · **0/2** · 444 k · 1 |
| `nightly-schedule` | right · 2/2 · 1/1 · 227 k | right · 2/2 · 1/1 · 372 k · 2 |
| `score-comparability` | right · 3/3 · 1/1 · 313 k | right · 3/3 · 1/1 · **199 k** · 2 |
| `resume-dogfood` | n/a · 3/4 · 3/3 · **1 445 k** | n/a · **4/4** · **1/3** · **903 k** · 14 |

### 6.3 What that says

**No correctness difference, because there was no room for one.** Both arms
reached the right verdict on all eight questions. These are questions the
repository answers — five of them come from the task benchmark, where the
`git`-only baseline already beat `ferret_context_pack` on `sourced` — and a
frontier model with ripgrep and `git log` reaches them. **This is a ceiling, not
a tie.** The measurement it supports is that Ferret did not *break* anything,
and no more than that.

**Rediscovery cost fell by half.** The treatment read **2.9 files** per task
against the control's 6.1, and **355 lines** against 807 — it opened less than
half as much of the repository to reach the same answers, ran fewer searches
(7.9 against 10.0) and made fewer tool calls (17.8 against 20.9). That is the
clearest signal in the experiment and it is in Ferret's favour.

**And the saving did not reach the context window.** Total context per task went
*up*: 433 908 against 417 075. The reason is §5: thirty tool definitions
re-sent every turn cost more than the file reading they saved. **Ferret halved
the work and the tool list ate the whole saving**, which is a delivery problem
rather than a retrieval one, and the most actionable finding here.

**On the hardest task the ordering reverses.** `resume-dogfood` is
open-ended — "what does a new session need to know to continue this work" — and
it is the task both arms spent most on. The control spent **1.44 M tokens, 46
tool calls, 272 seconds and $2.00** and still covered 3 of 4 facts. The
treatment made 14 Ferret calls, covered **4 of 4**, and spent **903 k** — 38%
less context, on the one question shaped like the thing Ferret is for. It also
cited **1 of 3** primary artefacts against the control's 3 of 3, because what it
had in hand were Ferret entities and durable statements rather than the file
paths the labels name. Better facts, worse citations, on the same task.

**Agent uptake was high, and unprompted.** The treatment called Ferret on **7 of
8** tasks — 24 calls across ten distinct tools, most often `ferret_search` (6)
then `ferret_context_pack` (4). Nothing told it Ferret existed. The one task it
ignored Ferret on entirely, `exclusion-reason`, is the one where it was cheapest
and fastest.

The earlier permission-denied run adds a cleaner reading of the same thing, for
the reason §4.2 gives: it reached for Ferret on three of the five tasks it got
to, and reached for `ferret_context_pack` *first* on two of them. **So the Phase
4 discoverability work is sufficient.** An agent handed the published tool list
with no hint does find Ferret and does prefer the task-shaped surface. That
question is answered, and answered yes.

### 6.4 The one scoring correction

`macos-runner` carried a prose stale trap matching `macos is (?:verified|
covered|validated)`. **Both arms tripped it on the same correct sentence.**
EPIC-115's surviving obligation is worded *"do not pretend macOS is validated
unless the packaging path actually ran on macOS"*, and an answer that quotes that
clause contains the literal string.

The pattern was withdrawn and the reason recorded in `tasks.json` beside it. It
fired identically on both arms, so it moved no comparison — `staleAsserted` went
from 14% to 0% on **both** — and the run it fired on is kept as `results/opus.json`
beside the re-graded `results/opus-regraded.json`, with `regrade.mjs --against`
printing the difference. Full traces are persisted for every session precisely so
a scoring correction costs nothing and can be checked against the numbers it
changes.

## 7. Experiment two: five sessions over one store

Experiment one measured questions the repository answers, and a strong control
reached all of them. That says nothing about the product claim, which is about
knowledge accumulated across sessions. This measures that.

`benchmark/agent/results/continuity.json`. A store this harness created, indexed
(724 s, content on) and dropped; Session A wrote to it, so it is never the
dogfood store. The question is chosen so **the control cannot grep it**: whether
a pattern written `secrets/` excludes anything is stated in no document, and
follows only from `matcherFor`'s four-form expansion and what picomatch does
with the doubled separator that produces.

The change between sessions is real and is this phase's own: commit `70bcfca`,
the §4.1 fix. Session A ran before it; the fix landed as an ordinary commit; the
store was re-indexed (42 s, incremental) keeping what A had recorded.

| session | what it is | verdict | facts | tool calls | Ferret calls | context | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A** | investigate and record, pre-fix | n/a | 3/3 | 35 | 6 | 1 004 904 | $1.40 |
| **B** control | notes file, pre-fix | right | 1/3 | 23 | 0 | 331 555 | $0.73 |
| **B** treatment | Ferret, pre-fix | right | 2/3 | 15 | 2 | 413 790 | $1.04 |
| **C** control | notes, post-fix, record now stale | right | 2/2 | 13 | 0 | 139 452 | $0.46 |
| **C** treatment | Ferret, post-fix, record now stale | right | 2/2 | 16 | 1 | 390 223 | $0.63 |
| **maintain** | bring the record up to date | n/a | 2/2 | 16 | 5 | 358 318 | $0.56 |
| **D** control | notes, supersession recorded | right | 2/2 | 18 | 0 | 230 676 | $0.49 |
| **D** treatment | Ferret, supersession recorded | right | 2/2 | 19 | 1 | 412 885 | $0.59 |

### 7.1 Session A: the extraction the continuity benchmark had to assume

`benchmark/continuity/README.md` names its own largest assumption:

> **Extraction.** Every statement was recorded deliberately. Whether an agent
> *would* have recorded the right twenty-six sentences is the question this
> assumes an answer to, and it is the largest assumption in the design.

Session A removes it. Asked to investigate `exclude` and record what it
established, with no instruction naming any tool, it:

- **found the trailing-slash defect independently**, and traced it into the
  library — *"picomatch 4.0.7 pushes a trailing `/` as a plain SLASH_LITERAL
  token (lib/parse.js:989) and only appends an optional `/?` when the last token
  is a star or bracket (lib/parse.js:1313)"*;
- **found a hazard this phase had not**: a pattern containing a metacharacter
  gets no depth expansion, so `*.log` matches only a top-level `a.log`; and a
  leading `!` reaches picomatch as a negation, so `!keep` excludes **everything
  except** `keep`. Verified directly, and fixed — §4.4;
- recorded four cited statements through `ferret_context_record`, choosing the
  `fact` and `gotcha` kinds itself.

**So extraction works.** A real agent, unprompted, found the right things and
wrote them down in the right place. That is the strongest single result in this
phase, and it is about Ferret's write surface rather than its read surface.

### 7.2 The maintenance session: the lifecycle works when it is used

After the fix landed, a session was asked to bring the recorded knowledge up to
date. It called `ferret_context_find` (2), `ferret_context_trust` (1) and
`ferret_context_record` (2): it **superseded two statements and recorded two
replacements**, and corrected a line number that the fix had moved (`:98` →
`:104`). The store afterwards held four active records and two superseded.

Nothing named those tools either. EPIC-127's lifecycle and EPIC-129's capture
both do what they claim, driven by an agent that worked it out from the
published surface.

### 7.3 And none of it was read

This is the finding of the phase, and it is the same in all three answering
sessions.

- **The control never opened the notes file.** `HANDOVER.md` sat in the
  repository root holding exactly what Session A recorded. Sessions B, C and D
  touched it **zero** times. In Session B the control ran `ls` at the root, so it
  saw the file listed, and did not read it.
- **The treatment never read the durable tier.** `ferret_context_find` was
  called **zero** times in B, C and D. Its one or two Ferret calls per session
  were `ferret_config_exclusions` and, in B, a single `ferret_search`.
- **And Ferret had delivered the answer.** That `ferret_search` — query
  *"exclusion pattern trailing slash directory not matched"*, unrestricted, no
  `kinds` argument — returned **Session A's recorded gotcha ranked first**, ahead
  of fourteen repository files. The agent read it, then went and read
  `src/config/exclusions.ts` and `node_modules/picomatch/lib/parse.js` and
  re-derived the whole finding from source anyway.

So the Phase 4 discoverability concern did not bite: durable context ranked
first on an ordinary query. What happened instead is that **the agent treated a
recorded statement as a lead rather than as an answer.**

**It was right to.** The system prompt asks it to ground claims in what it
retrieved and to distinguish current from superseded — and in Session C that
verification is exactly what saved it: the record said "matches nothing", the
repository had changed under it, and the agent caught it. The behaviour that
prevented the saving in B is the behaviour that prevented the error in C. Every
session in this experiment reached the right verdict, and `staleAsserted` is
false everywhere, including Session C where the store and the notes both held a
statement that was no longer true.

### 7.4 Why a careful agent cannot cheaply trust a record

Because the record cannot tell it whether it still holds. Asked for the
provenance of Session A's statement, `ferret_why` returns the statement as its
own evidence: `held: true`, `count: 1`, and one `evidence` entry whose
`statement` is the sentence being asked about. `ferret_get_entity` adds
`source: { system: 'ferret', id: <hash of the statement> }` and
`lifecycle: 'active'`. A durable record carries `id`, `statement`,
`contextKind`, `state` and `current` — and **no relationship to the commit, file
version or tree it was true of.**

Session A's statement cited `src/config/exclusions.ts:96` and was true at
`144d478`. After `70bcfca` it was false, and nothing in the record said which
tree it described. Ferret's answer to "is this still true?" is `current: true`,
which means "nobody has superseded it", not "it still holds". For a question
about code, those are different, and only the second is worth skipping the
verification for.

That is the highest-value missing capability this phase found, and §9 returns to
it.

### 7.5 What the experiment cost, and what it saved

Nothing. Session A spent **$1.40 and 1.0 M tokens** establishing and recording
the finding. Sessions B, C and D then re-derived it, in both arms, at a further
$3.94. The rediscovery cost the durable tier exists to eliminate was **paid in
full, twice over, by both mechanisms**, and the treatment paid 1.2–2.8× the
control's context to do it — the tool-list overhead of §5 again.

### 7.6 What this shares with the retrieval-only benchmark

The continuity benchmark found that a *curated* notes file matched Ferret on
every headline measure, and said so plainly: *"If Ferret only matches a
perfectly disciplined agent, the honest result is that Ferret costs nothing to
be disciplined without the discipline."* This experiment agrees and sharpens it:
with a real agent in the loop, **neither** mechanism was consulted, so the two
were equal by both being ignored.

## 8. Failure classification

Per the phase brief, every weak result classified by cause.

| # | finding | class |
| --- | --- | --- |
| 1 | No correctness difference on the eight repository questions | **Benchmark limitation** — ceiling. A frontier model with ripgrep answers them; the tasks do not require accumulated context. Five come from a benchmark where the `git` baseline already beat the pack. |
| 2 | Treatment spent more total context than the control despite reading half as much | **Ferret defect (delivery)** — 30 tool definitions × every turn. EPIC-136 §2.3. |
| 3 | `ferret_context_pack` overshoots its stated budget by 37% | **Ferret defect** — EPIC-136 §2.1. |
| 4 | A `ferret_search` result was truncated by the client and lost | **Missing Ferret capability** — no compact form. EPIC-136 §2.2. |
| 5 | Treatment cited fewer primary artefacts (75% against 88%), worst on `resume-dogfood` (1/3 against 3/3) | **Benchmark limitation** — the labels name files; Ferret handed it entities and statements, which it cited instead. The answer was not worse; the citation vocabulary differed. |
| 6 | Neither arm read the carried knowledge in B, C or D | **Agent limitation**, not discoverability. Ferret ranked the statement first on an ordinary query and the agent read it; it chose to verify from source. Correct behaviour, and it is what caught the stale record in C. |
| 7 | A recorded statement cannot say which tree it was true of | **Missing Ferret capability** — §7.4, and the one that would change #6. |
| 8 | An exclusion written `secrets/` excluded nothing, silently | **Ferret defect** — §4.1, fixed. |
| 9 | An exclusion written `!keep` excluded everything except `keep`, silently | **Ferret defect** — §4.4, fixed. Found by an agent using Ferret. |
| 10 | `where-decisions-live`: both arms cited 0 of 2 primary artefacts | **Benchmark limitation** — all three conditions of the retrieval benchmark also score 0/2 on it. A hard label, not an arm difference. |
| 11 | Every Ferret call denied in the first Opus run | **Benchmark defect** — mine. §4.2, fixed, run kept. |
| 12 | An agent read the answer from a memory file outside the repository | **Benchmark defect** — mine. §4.3, fixed. |

Nothing here is classified as a non-goal, and nothing was fixed merely because
the benchmark would look better for it. Of the Ferret findings, two are fixed in
this branch (#8, #9) and three are deferred to EPIC-136 (#2, #3, #4) on
EPIC-135's precedent, because they change a published surface mid-measurement.

## 9. The answer

> **Does giving a fresh AI agent access to Ferret materially improve its ability
> to perform real engineering work?**

**On this evidence: no — not yet, and not for the reason the product claim
assumes.**

Thirteen sessions, eight repository questions plus a five-session continuity
scenario, one model, one variable. Every session in both arms reached the
correct verdict. No measure of correctness, evidence quality, unsupported
inference or staleness separated the arms in Ferret's favour, and total context
went **up** with Ferret in both experiments.

### What does improve, measurably

- **Rediscovery cost.** The treatment opened **2.9 files and 355 lines** a task
  against the control's **6.1 and 807** — less than half the repository read to
  reach the same answers, with fewer searches and fewer tool calls. On the one
  open-ended task, `resume-dogfood`, it covered 4 of 4 facts against 3 of 4 and
  spent **38% less context** than a control that burned 1.44 M tokens and $2.00.
- **Extraction and lifecycle.** Unprompted, one agent found a real undocumented
  defect and recorded four cited statements; another later superseded two of them
  and corrected a moved line number. Both worked the surface out from what Ferret
  publishes. The continuity benchmark had to assume this; it holds.
- **Discoverability.** Ferret was called on **7 of 8** tasks with nothing
  pointing at it, `ferret_context_pack` was reached for first twice, and durable
  context ranked **first** on an unrestricted search. **The Phase 4 work is
  sufficient.** That question is closed, and closed yes.

### Where Ferret still fails

1. **Delivery cost cancels the retrieval win.** Thirty tool definitions re-sent
   every turn cost ~8 000 tokens a turn — 268 k against 156 k on one question.
   Ferret halved the reading and the tool list ate the whole saving. **This is the
   single highest-value fix**, it is entirely inside the product boundary, and it
   is EPIC-136 §2.3.
2. **A durable statement cannot say which tree it was true of.** `current: true`
   means "unsuperseded", not "still holds". A careful agent therefore re-derives
   a recorded claim rather than trusting it, and it is right to — which makes the
   third tier a lead-generator rather than an answer. Binding a statement to the
   commit or file version it was recorded against, so a later session can ask
   "has anything under this changed since", is **the highest-value missing
   capability** this phase found. §7.4.
3. **A pack that reports keeping a budget it exceeds** by 37% in the format a
   client gets by default, and a search with no compact form, one of which lost a
   real session its result. EPIC-136 §2.1, §2.2.

### The three readings, separated

The brief asks these be distinguished. They are:

- **"Ferret does not help"** — true of correctness on these tasks, and false of
  rediscovery cost, which halved.
- **"Ferret helps but the agent cannot discover or use it"** — **false** of
  discovery: uptake was 7 of 8, unprompted, and retrieval put the right statement
  first. **True** of *use*, for a reason that is Ferret's to fix rather than the
  agent's: a record it cannot date against the code is a record it must check.
- **"The task did not require accumulated context"** — true of experiment one by
  construction, and the reason the continuity experiment exists. In that
  experiment the accumulated context existed, was correct, was current, and was
  retrieved first — and was still not relied on.

### What this does not license

These numbers are one model, one repository, one harness, eight questions and
five sessions, at one repeat. They are directions and magnitudes, not p-values,
and a store holding four to six durable statements is not the months-old
knowledge base the product claim is about. A negative result at this size is a
reason to fix the two capabilities named above and measure again — not a reason
to conclude the product does not work.

Nothing here was changed to make the benchmark say something better. The one
scoring correction moved both arms identically (§6.4), the two defects fixed in
this branch make Ferret's exclusions cover *more*, and the three delivery
findings are recorded as an Epic whose own acceptance criterion says a number
moving against Ferret is the fix working.
