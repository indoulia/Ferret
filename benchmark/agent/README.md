# Does a real agent do better work with Ferret?

The two benchmarks beside this one both closed on the same admitted limit.

> **Reasoning.** No model is in this loop. Whether an agent handed the right
> evidence writes the right answer is not observed. `sourced` is a necessary
> condition for a correct answer, not a sufficient one.

So neither could tell **Ferret does not help** apart from **Ferret helps and the
agent cannot use it** — and those imply opposite next steps. This one puts a
real agent in the loop and changes one thing between the arms.

```
node benchmark/agent/run.mjs                      # 8 tasks, both arms
node benchmark/agent/run.mjs --task macos-runner
node benchmark/agent/run.mjs --repeats 3          # variance
node benchmark/agent/run.mjs --plan               # what each arm holds, call nothing
```

It needs `npm run build`, a working `claude` CLI with a signed-in account, and
the Ferret index `scripts/dogfood-db.mjs` builds. It writes nothing to that
store: the principal is granted `read` and Ferret refuses the rest itself.

## The agent is Claude Code, not a loop this harness wrote

The first draft of this harness drove the Messages API directly with a
hand-rolled tool loop and five tools of its own. That would have measured an
agent nobody runs. What runs is Claude Code, so each session is a real headless
Claude Code session — `claude -p`, its own system prompt, its own `Read`,
`Grep`, `Glob` and `Bash`, its own agent loop — and Ferret arrives the way a
user would actually install it, as an MCP server in `--mcp-config`.

That also means the harness measures the **published** surface end to end: the
tool list, the descriptions, the server instructions, the schemas. Nothing is
paraphrased into something more findable.

## The two arms

| arm | what it is |
| --- | --- |
| `control` | `Read`, `Grep`, `Glob`, `Bash` over this repository — no MCP servers at all |
| `treatment` | the same four tools, plus every tool Ferret's MCP server publishes |

Held identical: the model, the effort level, the question, the answer schema,
the built-in tool set, the corpus, the working directory, the wall-clock and
spend ceilings. `--setting-sources ""` and `--strict-mcp-config` mean **no**
user, project or local settings are loaded and no MCP server exists that this
harness did not write — without the second of those, the control would have
silently picked Ferret up from `.mcp.json` and there would have been no
comparison at all.

### The control is not made weak

It has ripgrep over the whole tree, glob, `git log`, `git show`, `git grep`, and
a model deciding what to look for. That is the tool set most engineering agents
have and it is a genuinely strong baseline: the retrieval benchmark's `baseline`
condition beat `ferret_context_pack` on `sourced` (42% to 26%), and nothing here
is arranged to prevent that happening again.

### The treatment is not made easy

**The treatment is never told to use Ferret.** Not in the prompt, not in the
appended contract, not in a description this harness wrote. It is handed thirty
tools with Ferret's own names and Ferret's own descriptions and left to work out
whether any of them is worth calling. Whether the discoverability work in
`docs/evidence/FERRET-CAN-A-FRESH-AGENT-FIND-IT.md` is enough for that is the
thing being measured, and **an agent that ignores Ferret is a result, not a run
to rescue.** Which surfaces it actually called is recorded per task.

Ferret's own `instructions` from `initialize` are passed through, because an MCP
client shows them. They are recorded verbatim in every report so a reader can
see exactly what the treatment was told. They describe what Ferret indexes and
do not mention durable context.

## What is withheld, and from both arms

`benchmark/` states every question's answer; `results/` holds previous runs; the
evidence reports state their benchmarks' answers in prose. `lib/corpus.mjs`
holds the list — `benchmark/lib/identity.mjs`'s, imported rather than copied,
plus this benchmark's own report and the continuity benchmark's, which the task
benchmark does not exclude and which this phase is not entitled to add there.

It is enforced twice, because there are two ways in:

- **On disk**, by a `PreToolUse` deny hook (`hooks/corpus-guard.mjs`), which
  refuses out loud with the reason — a tool that silently returns nothing
  teaches the model the file does not exist.
- **Through Ferret**, by the same list in the principal's `exclude`
  configuration, and `assertAnswerKeyUnreachable` probes all five paths through
  `ferret_find` before anything is measured.

The guard also confines both arms to the repository and refuses anything that
writes. Both of those were added because of what the first smoke run did, and
neither was anticipated:

**The agent read the answer out of a file nobody had thought of.** Claude Code's
system prompt advertises the session's memory directory. The treatment agent
went there and read `…/memory/no-macos-ci.md`, a one-line note whose content is
*"owner decision: don't add a macOS runner"* — the answer to task one, from a
file outside the repository that no corpus list mentioned. Containment is
therefore the rule rather than a longer deny list: outside the repository is
exactly where an answer key nobody declared lives.

**An answering agent has no business writing.** `Write`, `Edit` and the
mutating shell verbs are refused, so a benchmark run cannot change the
repository it is measuring.

## The answer contract

Each session ends by emitting one JSON object against a per-task schema
(`--json-schema`), the same schema in both arms:

- `verdict` — one option from a fixed set the task defines. **This is what
  correctness is scored on**, and it makes correctness an equality check rather
  than a regular expression over English. The options are in the task's own
  order and none is phrased more fully than the others.
- `conclusion`, `key_facts` — prose, scored against the task's fact patterns.
- `citations` — scored against the labelled artefacts, and against the trace.
- `confidence`.

## The tasks, and where their labels came from

Eight questions in `tasks.json`, in four groups: a decision to take, a
historical fact with a trap on both sides, an investigation into current
behaviour, and a change-impact question about a recent fix.

**Five of the eight, and all of their evidence labels, are the task benchmark's
own.** They were written from cited repository sentences before any condition
was run, and have been reviewed and corrected twice since. Reusing them rather
than writing new ones is deliberate: it means this phase cannot be accused of
inventing labels that suit it, and it lets a weak result here be compared
against the retrieval-only number for the same question. What is new is the
verdict option sets, the fact patterns and the stale traps — neither earlier
benchmark had a model to grade.

## The measurements

Kept separate. There is no composite score, on the rule both earlier benchmarks
set, and the interesting results in this phase are exactly the ones where a gain
on one axis is paid for on another.

| measurement | what it is |
| --- | --- |
| `verdictCorrect` | the picked option equals the expected one |
| `factsCovered`, `factsComplete` | the claims a complete answer states |
| `evidenceSourced`, `primaryCited` | every relevance-3 artefact was cited |
| `staleAsserted` | the superseded belief was asserted as current |
| `unsupportedCitations` | a citation naming something no tool ever returned |
| `toolCalls`, `filesRead`, `searches`, `linesRead` | rediscovery cost |
| `contextTokens`, `costUsd` | context spent, and what it cost |
| `medianElapsedMs`, `medianTurns` | latency |
| `ferretSurfaces` | which Ferret tools were called, and how often |

Two of these are worth stating precisely.

**`staleAsserted` prefers an equality check.** On five of the eight tasks the
superseded belief *is* one of the verdict options — "macOS still runs", "an
exclusion is enforced at ingestion" — so asserting it is exact. Where it cannot
be expressed that way it is a pattern over prose, which is the weakest
measurement here; both components are reported so a reader can see which fired.

**`unsupportedCitations` is defined by the trace, not by taste.** A citation is
unsupported when the thing it names appears in no tool argument and no tool
result of that session. That catches an answer citing a document the agent never
opened, mechanically. It does **not** catch a claim that is merely unwarranted by
evidence the agent did retrieve, and it does not claim to.

**Cost is never read on its own.** `contextTokensPerCorrect` exists because the
first run of the retrieval benchmark had two conditions come out cheapest
exactly where they returned nothing.

## The second experiment: three sessions over one store

`node benchmark/agent/continuity.mjs --phase setup|a|b|c|report|drop`

The A/B above runs against the dogfood index, whose durable tier holds almost
nothing — the limit the task benchmark declared. So most of what Ferret can
return there is the repository, which is the same corpus the control greps, and
the questions are ones a strong control reaches by grepping. That measures
retrieval. It does not measure the product claim, which is about knowledge
accumulated across sessions.

This experiment measures that, on a store this harness creates, indexes and
drops — never the dogfood one, because Session A **writes** to it.

| session | what happens |
| --- | --- |
| A | a fresh agent investigates Ferret's `exclude` key and records what it establishes. Its principal may `read` and `record`, nothing else. |
| B | a fresh agent, no transcript of A, is asked a question A's finding answers — in both arms |
| C | the same question after the repository changed under the answer — in both arms |

**The question is chosen so the control cannot simply grep it.** Whether a
pattern written `secrets/` excludes anything is stated in no document: it
follows from `matcherFor` expanding a metacharacter-free pattern into four
forms, and from what picomatch does with the doubled separator that produces. An
agent has to read the code and reason about a library to get it right. That is
the kind of finding a previous session is worth having recorded — and it is a
real one: it is the defect §4.1 of the evidence report describes, found by this
harness.

**Session C's change is real, and it is this phase's own.** Session A runs
against the tree *before* the trailing-slash fix, so what it records is true when
recorded. The fix then lands as an ordinary commit, the store is re-indexed, and
Session C is asked the same question. The correct verdict moves from one option
to another inside the same fixed option set, and **Session B's correct answer
becomes Session C's stale one.** Nothing about the rubric changes between them.

**The control is an agent that writes things down.** It is handed `HANDOVER.md`
holding exactly what Session A recorded — same statements, same order, rationale
and status included, nothing withheld — written immediately before the control
session and deleted immediately after; the treatment session refuses to start if
the file is still there. That is the same argument
`benchmark/continuity/README.md` makes for its own baseline, and for the same
reason: comparing a populated Ferret against an agent that remembers nothing
would be a demonstration rather than a measurement.

What this inherits from that benchmark is its largest assumption, halved.
Extraction is no longer assumed — Session A is a real agent deciding what to
record, and what it recorded is reported. What is still assumed is that mirroring
those records into a notes file is a fair baseline: an agent *keeping notes* from
the start might have written different ones.

## What this does not measure

- **Extraction.** Nothing here observes an agent deciding what is worth
  recording. Every durable statement the treatment can retrieve was recorded by
  earlier work, and on the dogfood store there is very little of it — which is
  the same limit the task benchmark declared, and it means most of what Ferret
  can return here is the repository.
- **A knowledge base months old.** The store is a week of real work.
- **Multi-agent handover.** One agent, one question, one session.
- **Anything about a different agent harness.** These numbers are Claude Code's.
  A different harness with different tools would produce different ones.
- **Statistical significance.** Eight tasks and a handful of repeats. Directions
  and magnitudes; not p-values.

## The anchors experiment — EPIC-137

`anchors.mjs` asks a narrower question than the rest of this harness: does an
*anchored* durable statement let a fresh agent skip the investigation, and does
it refuse to when the code moved?

```
npm run bench:agent:anchors -- --phase setup --no-content
npm run bench:agent:anchors -- --phase a          # investigate and record
npm run bench:agent:anchors -- --phase t1         # both arms, tree unchanged
npm run bench:agent:anchors -- --phase reindex    # after a real commit
npm run bench:agent:anchors -- --phase t2         # the anchored file changed
npm run bench:agent:anchors -- --phase maintain   # re-anchor against new bytes
npm run bench:agent:anchors -- --phase t3
npm run bench:agent:anchors -- --phase supersede
npm run bench:agent:anchors -- --phase t4
npm run bench:agent:anchors -- --phase t5         # an unrelated file changed
npm run bench:agent:anchors -- --phase report
```

**The harness synthesises no anchor and no verdict.** Session A passes whatever
anchors it chooses to `ferret_context_record`; every verdict comes from
`trust()` against the real index and the real working tree. An earlier design
that derived an anchor from a statement's prose was rejected: a harness that
manufactures the mechanism under test measures the harness.

`anchoredFileReads` is the primary measurement — how many times an arm opened a
file Session A anchored. The control is the same notes file this harness already
uses, holding every statement verbatim, and **without** the verdict: a notes file
has no mechanism for saying whether the code still matches, and that absence is
the capability under test.

The result is in
[`docs/evidence/FERRET-DOES-AN-ANCHOR-CARRY.md`](../../docs/evidence/FERRET-DOES-AN-ANCHOR-CARRY.md):
safe, correct, and no reduction in rediscovery.

## Results

`results/` holds each run, with the commit measured, whether the tree was dirty,
the model, the effort, the exact tool list Ferret published, its instructions
verbatim, and every session's per-task scores and tool trace. The full traces,
including what each tool returned, are written to
`.local/agent-benchmark-run/transcripts/` so a run can be re-graded without
paying for it again.
