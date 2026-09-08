# EPIC-138 — Durable-Context Routing Guidance: architecture decisions

Recorded before implementation, per Governance §22.

**1 — Forbidden-phrase lists precede the wording (§16 D1).**
`tests/unit/mcp-instructions.test.ts` committed red in `46dba26`, before
`src/mcp/server.ts` changed. A list written afterwards is one the sentence passes
by construction. Accepted consequence: the negative lists pass vacuously while
guidance is absent, so the first test asserts it is non-empty.

**2 — The shipped sentence is §7's proposal, verbatim.** Checked against the §1
lists after they were fixed; passed unedited.
Rejected: R138's research sentence (three sentences, silent on verdicts — it was
built to leave trust unmeasured); "consult Ferret first" (fails AC-6 and AC-7);
naming a tool (couples the handshake to a surface EPIC-136 §4a froze).

**3 — The verdicts are named, not gestured at (§16 D2).** An agent that has not
called a tool has not met the vocabulary, so "check the verdict" routes it to a
field whose values it first sees in a result it is deciding whether to trust.
`superseded` omitted: not a drift verdict, outranks all others, needs no routing
advice. Cost 302 chars — ~64 tokens at 4.7 chars/token, ~76 at 4. Ferret's
`estimateTokens` says 124; that is its whitespace correction misreading prose,
recorded not quoted. §20 budgets ~60.

**4 — The string varies by nothing.** No branch, config key or env var.
Per-principal variation would be §5's routing infrastructure in disguise;
EPIC-068 already returns an informative refusal. AC-12 asserts it.
Consequence for §14: the two arms are two **builds** — baseline `dist/` copied
before the change, guided built after — and the harness picks a CLI path per arm.

**5 — Nothing branches on whether a client obeyed.** No signal exists and none is
added. Guards the failure of a product that rewards its own advice, which is what
§15's refusal to count Ferret calls as success is for.

**6 — `CONTENT_NOTICE` keeps its bytes and its position.** Last, so it frames
what follows. The guidance routes to a verdict Ferret computed, never to a
statement's content.

**7 — Corpus exclusions extended before the run.** This Epic's spec, this record,
the R138 report, and this Epic's evidence report and validation record all state
the result in prose and all sit in the indexed tree. R138 §9 already found that
publishing an evidence report contaminates the next run of the suite that
produced it.
