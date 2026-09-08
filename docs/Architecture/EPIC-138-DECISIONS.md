# EPIC-138 — Durable-Context Routing Guidance: architecture decisions

Recorded before implementation, per Governance §22.

**In one sentence:** one sentence is added to `initialize.instructions`, it names
the verdict vocabulary rather than gesturing at it, it is fixed against
forbidden-phrase lists written before it, and nothing in the product ever
branches on whether a client obeyed it.

## What already existed

The string. `src/mcp/server.ts:319` has composed `instructions` as *purpose
sentence + `CONTENT_NOTICE`* since EPIC-059, and `CONTENT_NOTICE`
(`src/context/pack.ts:305`) has been the one place the data-not-instructions rule
lives since EPIC-084 widened it for durable context rather than adding a second
notice. Nothing is rebuilt, nothing is exported, no module is added.

## 1 — The forbidden-phrase lists precede the wording (§16 Decision 1)

> AC-6, AC-7 and AC-8's lists are written and committed before the shipped
> sentence exists.

`tests/unit/mcp-instructions.test.ts` was committed red, against a server with no
guidance in it, and `git log` on that file against `src/mcp/server.ts` is the
evidence. **Why:** a forbidden-phrase list written after the sentence is a list
the sentence passes by construction. It would prove nothing about this wording
and nothing about the next person to edit it, which is the only reader such a
control has.

The consequence is accepted: with no guidance present the negative lists pass
vacuously in the red run. The first test in that file asserts the guidance is
non-empty, so vacuity is itself a failure once the sentence exists.

## 2 — The shipped sentence is §7's proposal, verbatim

> For a task-shaped engineering question, check the durable context an earlier
> session recorded before exploring source, and use its verdict: `verified` says
> what was observed still matches the indexed code, while `stale`, `unknown` and
> `unanchored` each mean verify against source before relying on it.

Checked against the §1 lists after they were fixed, and it passes all three
unchanged. It was not edited to pass them.

**Why this shape.** It is an *ordering* instruction with a *verdict* clause and
nothing else. The ordering half is what R138 measured; the verdict half is what
keeps the ordering safe, because R138's own routing text deliberately said
nothing about trust and therefore could not be shipped as-is — a server string
that tells an agent to look early and nothing about what it finds is the
stale-context failure §14's U2 gate exists to catch.

**Rejected:** R138's research sentence (three sentences, says nothing about
verdicts, written to leave trust unmeasured — a research control, not a product
string); "consult Ferret first" (an authority claim and a call policy, failing
AC-6 and AC-7 together); anything naming a tool by name (couples a handshake
string to a tool surface EPIC-136 §4a froze, and dates the moment a tool is
renamed).

## 3 — The verdicts are named, not gestured at (§16 Decision 2)

> The sentence enumerates `verified`, `stale`, `unknown` and `unanchored`.

The alternative — "check the verdict" without naming values — is shorter by
about 40 characters and strictly weaker. **Why named:** an agent that has not yet
called a tool has not seen the vocabulary, so an unenumerated "verdict" is an
instruction to consult a field whose values it will meet for the first time in a
result it is deciding whether to trust. Naming the three that mean *verify* is
the whole safety content of the sentence, and AC-8 asserts each one is followed
by the requirement to verify.

`superseded` is deliberately absent: it is not a drift verdict, it outranks every
other, and adding it would trade budget for a case that needs no routing advice.

**Cost, measured not assumed:** 302 characters — one sentence, sent once at
`initialize`, zero per turn. That is ~64 tokens by BPE-typical 4.7 characters per
token and ~76 by a flat 4. Ferret's own `estimateTokens` reports 124, which is
the pessimistic whitespace correction (`src/context/budget.ts:47`) misreading
prose; it is the wrong instrument here and the number is recorded rather than
quoted as the cost. §20 budgets "~60 tokens"; this is at that boundary, and the
enumeration in §3 is what it was spent on.

## 4 — The string does not vary, by anything

> One literal, identical for every principal, permission set, scope, store state
> and configuration.

No `if`, no configuration key, no environment variable, no per-principal
composition. **Why:** varying it by principal would be the routing infrastructure
§5 forbids, in the smallest possible disguise, and a caller lacking a context
permission already receives an informative refusal (EPIC-068) rather than
silence. AC-12 asserts it.

This also decided how §14 gets two arms. A configuration toggle would have made
the benchmark trivial and the product wrong, so the arms are **two builds** — the
baseline `dist/` copied before the source change, the guided one built after —
and the harness selects a CLI path per arm. Nothing in the product knows which
arm it is.

## 5 — Nothing branches on whether a client followed the guidance

Ferret refuses, ranks, filters, retrieves and answers identically whether an
agent consulted durable context or not. There is no signal to branch on and none
is added. **Why it is worth recording:** the failure this forbids is a product
that rewards its own advice — measuring the advice by the behaviour it caused
rather than by the work it improved, which is exactly what §15's refusal to count
Ferret calls as success is guarding.

## 6 — The notice keeps its position and its bytes

`CONTENT_NOTICE` stays last, unmodified, appended by the same `+`. **Why last:**
a model reads in order, and the notice is what frames everything that arrives
afterwards. The guidance goes *before* it and says nothing that weakens it: it
tells an agent to read a verdict Ferret computed, never to act on a statement's
content. Recorded statements remain data to cite, never instructions to obey.

## 7 — The benchmark corpus is extended before it is run, not after

EPIC-138's specification, this record, the R138 evidence report and this Epic's
own evidence report and validation record all state the routing result in prose,
and all of them are in the tree the §14 store indexes. They go on
`benchmark/agent/lib/corpus.mjs`'s exclusion list **before** the run, including
the two documents that do not exist yet.

**Why in advance:** R138 §9 already found that adding an evidence report to the
tree contaminates the next run of the suite that produced it, and reported it as
a limitation rather than fixing it. A list extended after the numbers are
published is a list that describes what was measured instead of governing it.
