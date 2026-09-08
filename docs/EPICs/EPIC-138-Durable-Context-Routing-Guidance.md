# EPIC-138 — Durable-Context Routing Guidance

**Status:** MEASURED AND REJECTED · **Priority:** P1 · **Domain:** MCP Surface · **Classification:** CONTINUATION

Approved 2026-09-08 on the R138 research result. Implemented, measured against
real agents under §14, and **not shipped** — the guided arm consulted before its
first source read in 0 of 9 sessions against the baseline's 7 of 9, and read 28%
more source lines. §15 conditions 1 and 2 failed; 3 and 4 held.

`src/mcp/server.ts` is byte-identical to `main`. The specification below is kept
as written, unamended, because it is what was tested.

Outcome: [validation](validation/EPIC-138-VALIDATION.md) ·
[evidence](../evidence/FERRET-DOES-A-SERVER-STRING-ROUTE.md) ·
[decisions](../Architecture/EPIC-138-DECISIONS.md). Research this rested on:
[report](../evidence/FERRET-WHEN-DOES-THE-AGENT-ASK.md), which stands and is not
amended — R138 proved the hypothesis under explicit client-side routing; EPIC-138
disproved that one `initialize` sentence reliably creates that routing.

One sentence is added to the MCP `initialize` instructions. Nothing else ships.

## 1. Objective

The one string every MCP client shows before a session's first turn tells the
agent to check for relevant durable engineering context before beginning source
exploration on a task-shaped engineering question, and to verify against source
where the context does not establish the answer.

## 2. Problem

EPIC-137 proved the anchor mechanism correct and safe and found **no reduction in
rediscovery**. R138 established why, and that the cause is fixable.

**The agent asks last.** Across the ten EPIC-137 sessions the first Ferret call
landed at tool call 12–20 of 17–24; the first source read landed at call 3 in 9
of 10. The opening move was `Grep` or `git log` in 10 of 10. The rediscovery was
already paid before Ferret was asked.

**It is ordering behaviour, not discoverability.** The control reproduces it
against a plain `HANDOVER.md` in the working directory: consulted after the first
source read in 4 of 5 sessions, and never in the fifth — in two of those the
session had already run `ls` and seen the file on call 1.

**The pack already answers on call one.** Probed on the product path at the
default budget, `ferret_context_pack` returned all four recorded statements with
`verdict`, anchor paths and both hashes, 3 470 of 4 000 estimated tokens.

**And nothing tells the agent when to ask.** `ferret_context_pack`'s description
says "Prefer this to `ferret_search` for a task-shaped question" — a choice
between tools, not a position in a session. The `initialize` instructions name
"commits, files, branches, worktrees, developers and the evidence behind each
fact"; **durable context is not in the capability sentence at all**.

## 3. Value

R138 measured what the ordering is worth. Routed against the current Ferret
surface, over R1/R2/R5, five sessions per arm:

| | existing treatment | routed |
| --- | --- | --- |
| context tokens / task | 525 k | **271 k** (−48%) |
| tool calls / task | 19.6 | **10.8** (−45%) |
| wall clock / task | 129 s | **90 s** (−30%) |
| cost / task | $0.82 | **$0.57** (−30%) |
| verdict correct | 5/5 | **5/5** |
| unsupported citations | 0 | **0** |
| first consult | never before source | **call 1, 5 of 5** |

Correct verdict in **13 of 13** sessions across all three arms. Zero stale
assertions and zero false drift throughout.

**Not claimed:** that the wording in §7 reproduces this. R138's routing lived in
the experiment's system prompt, which is a client convention rather than a
server string, and it told the routed arm that durable context exists — an effect
this Epic must isolate and cannot assume. §14 is what decides.

## 4. Goal

`initialize.instructions` gains one concise sentence carrying the §7 principle.
The tool set, tool descriptions, ranking, retrieval, pack semantics, permissions,
refusals and EPIC-137 verification semantics are byte-identical before and after.

## 5. Non-scope

No new MCP tool. No ranking, reranking, freshness or authority change
(EPIC-056/057/130). No search change. No context-pack change — including the
`items: []` displacement R138 §4 observed, which is EPIC-131's and is **not**
opened here. No permission, scope or authorization change (EPIC-068/083). No
change to any refusal contract. No database, schema or migration change. No
change to EPIC-137's verification semantics, verdict set, or correspondence
rules. No change to security, redaction or the content-notice boundary
(EPIC-084/135). No tool-description rewrite, and no revisiting EPIC-136 §4a.

**Emphatically not:** automatic routing infrastructure, a pre-flight call, a
scheduler, a watcher, an agent-specific integration, a client shim, or any
mechanism that calls Ferret on the agent's behalf. This Epic ships **text**. If
the implementation acquires a code path that decides when to retrieve, it has
left scope.

**Not a generalised agent-routing system.** No EPIC-139 follows from this one.

## 6. Architecture

One string literal in `src/mcp/server.ts:319`, in the `instructions` field of the
`McpServer` construction, composed the same way it is today: purpose sentence,
then the new sentence, then `CONTENT_NOTICE` unchanged and unmoved.

No new module, constant export, dependency, injection point or branch. The
string is identical for every principal — it is not permission-varying, because
a caller lacking a context permission still receives an informative refusal
(EPIC-068), and varying the instructions by principal would be the routing
infrastructure §5 forbids.

## 7. The wording principle

The shipped sentence must communicate approximately:

> Before beginning source exploration for a task-shaped engineering question,
> check whether relevant durable engineering context is available. Use it to
> reduce unnecessary rediscovery, but verify against source when the context is
> stale, unknown, unanchored, or otherwise requires verification.

**Proposed wording** (§16 Decision 1 — the exact text is the one open decision):

> For a task-shaped engineering question, check the durable context an earlier
> session recorded before exploring source, and use its verdict: `verified` says
> what was observed still matches the indexed code, while `stale`, `unknown` and
> `unanchored` each mean verify against source before relying on it.

Constraints the wording must satisfy, each testable in §13:

- It does **not** prescribe a number of calls, a call sequence, or a call on
  every question. *Check early, not call endlessly.*
- It does **not** say Ferret is authoritative, correct, complete, or preferable
  to source.
- It does **not** license skipping source verification because durable context
  exists — `verified` is described as a byte claim about indexed code, which is
  what EPIC-137 §8 makes it, and not as a reason to stop.
- It carries no answer, no file path, no repository fact.
- It is one sentence, and it precedes the unmodified `CONTENT_NOTICE`.

## 8. The R8 limitation, and why it constrains the wording

R138 ran a fourth task on a question nothing durable had been recorded about.
Both arms held Ferret:

| | treatment | routed |
| --- | --- | --- |
| Ferret calls | 2 | **6** |
| wall clock | 83 s | **119 s** |
| cost | $0.83 | $0.81 |
| verdict | right | right |

Early routing produced **three times the Ferret calls, +36 s, and no correctness
change**. The first call is not free either: the pack returns the same ~3 400
tokens of standing context for an unrelated question, and no repository items.

So the instruction is a *check*, not a *policy of querying*. §13 AC-6 and §14's
usefulness gate exist to hold that line, and §15's success criterion refuses a
result that buys rediscovery savings with useless calls.

## 9. Data and model

None. No entity, relationship, lifecycle state, attribute, index, table or
migration. Nothing is persisted, read or derived. `initialize` is a protocol
handshake field; the change is inert to storage, retrieval and authorization.

## 10. Inputs and outputs

**In:** nothing new. The instructions are a compile-time literal and take no
configuration, principal, scope or store state.
**Out:** `initialize.result.instructions` gains one sentence. No tool result, no
entity, no file, no log line and no metric changes shape.

## 11. Dependencies

EPIC-059/061/064/065 (the MCP surface that owns the string), EPIC-137 (the
verdict vocabulary the sentence names), EPIC-084 (the notice it must not
displace), EPIC-068/083 (refusals it must not alter), EPIC-131 (the pack it must
not change). **None requires amendment.** EPIC-136 §4a is honoured, not extended.

## 12. Contracts

- The instructions are guidance to a client, never a claim of authority. Nothing
  in Ferret may branch on whether a client followed them.
- `CONTENT_NOTICE` remains present, unmodified, and after the guidance.
- The instruction string is identical for every principal and every store state.
- No verdict named in the guidance changes meaning; EPIC-137 §8 is the only
  definition of `verified`.
- Ferret gains no expectation that a caller consults context, and refuses,
  ranks, filters and answers identically whether it did or not.

## 13. Acceptance criteria

- **AC-1** `initialize.instructions` contains the guidance, asserted against the
  running server through a real MCP client, not against the source literal.
- **AC-2** `CONTENT_NOTICE` is still present in the instructions, unmodified, and
  positioned after the guidance.
- **AC-3** `tools/list` is byte-identical before and after: same 30 tools, same
  names, same descriptions, same schemas. Asserted as a snapshot equality, not a
  count.
- **AC-4** No tool, permission, scope or principal class is introduced. The
  EPIC-068/083 permission matrix is unchanged.
- **AC-5** Every existing MCP refusal returns the same category, wording and
  shape. EPIC-066 AC-6, EPIC-067 AC-12, EPIC-068 AC-5/AC-6, EPIC-117 AC-5 and
  EPIC-133's contracts still pass unmodified.
- **AC-6** The guidance prescribes no call count and no unconditional call: the
  string contains no imperative to query on every question and no numeric
  quantifier. Asserted as a property of the text against a fixed forbidden-phrase
  list fixed **before** the wording is chosen.
- **AC-7** The guidance does not assert Ferret's authority: it contains no claim
  that Ferret is correct, complete, authoritative, or preferable to reading
  source. Same fixed-list method as AC-6.
- **AC-8** The guidance names `stale`, `unknown` and `unanchored` as requiring
  source verification, and never presents any of them as permission to skip it.
- **AC-9** EPIC-137 verification is unchanged: the six conditions, the five
  verdicts, correspondence, and the derived-at-read-time rule. EPIC-137's full
  unit and integration suites pass unmodified, including AC-21/22/23.
- **AC-10** Ranking, retrieval, selection and pack composition are unchanged
  against a fixed store: identical results, identical order, identical
  `estimatedTokens`, identical `omitted` reasons.
- **AC-11** Security and redaction are unchanged: EPIC-084's injection-boundary
  suite, EPIC-135's exclusion tests and `redactStatement` behaviour all pass
  unmodified, and the guidance discloses nothing about any store.
- **AC-12** The instruction string does not vary by principal, permission set,
  scope, store contents or configuration.
- **AC-13** The change is measurable by `benchmark/agent/` with no harness change
  beyond selecting the arm — §14.
- **AC-14** `boundaries.test.ts` holds; no new import crosses a layer.

## 14. Real-agent validation

Reuse the R138 experiment. Same corpus, same grader, same scoring, same tasks,
same store construction, same model and effort. **The benchmark is not changed to
favour the new behaviour**, and no scoring rewards Ferret usage.

The only difference between arms is the server's `initialize` string:

| arm | server |
| --- | --- |
| `baseline` | today's instructions |
| `guided` | the §7 sentence added |

The R138 `routed` arm — the client-side system-prompt instruction — is re-run as
a **reference ceiling**, not as a treatment. It is what a client convention
already achieves; the question is how much of it a server string buys.

**Tasks, minimum:**

| task | state | gate |
| --- | --- | --- |
| U1 | tree unchanged since recording | productivity |
| U2 | an anchored file changed and re-indexed | **safety gate** |
| U3 | an unrelated file changed and re-indexed | false drift |
| U4 | a question nothing durable was recorded about | **usefulness gate** |

**Measured per arm and task:** correctness; context tokens; tool calls; wall
clock; cost; position of the first Ferret consultation; position of the first
source read; source files and lines read; anchored-file reads; Ferret calls, and
of those how many returned nothing on point; stale assertions; false-drift
assertions; unsupported citations; source reads occurring after the first
consultation.

**U2 is the safety gate.** The guided arm must reach the correct current answer
and must verify from source rather than assert from a `stale` record. Zero stale
assertions in every task and every arm. R138's routed arm passed this by citing
the `stale` verdict as evidence and reading the anchored implementation four
times; that is the behaviour to reproduce.

> If U1 saves rediscovery but U2 causes stale knowledge to be trusted, EPIC-138
> fails regardless of every other metric.

**U4 is the usefulness gate.** Ferret calls in the guided arm must not exceed the
baseline's by more than R138's routed arm did, and correctness must not fall. A
guided arm that queries repeatedly on a question the store knows nothing about
fails, however well U1 reads.

**U3 guards false drift**, which must stay zero.

Repeats: at minimum three per arm on one task, so a direction is not read off a
single session. A negative result is a valid outcome and must be reported as one.

## 15. Success criterion

All four, together:

1. **Earlier consultation** — the guided arm's first knowledge call precedes its
   first source read, in a clear majority of sessions, where the baseline's does
   not.
2. **Lower rediscovery cost** — context tokens, tool calls and source lines read
   fall materially against the baseline.
3. **No loss of correctness** — verdict correctness and unsupported citations no
   worse than baseline.
4. **No stale-context safety regression** — §14's U2 gate and zero stale
   assertions.

**A benchmark improvement is not sufficient** if U4 shows the instruction causes
excessive useless calls. And the Epic does not optimise for Ferret usage:
a rise in Ferret calls is not a result, and must never be reported as one.

If the guided arm does not move consultation position, the honest conclusion is
that the effect belonged to the client convention and a server string cannot buy
it. That is a valid outcome, it closes the question, and it is reported rather
than iterated on.

## 16. Open decisions

1. **The exact sentence.** §7 gives the principle and a proposal. The shipped
   text is chosen against §7's constraints and AC-6/7/8's fixed forbidden-phrase
   lists, which must be written **before** the wording is settled so the wording
   cannot be fitted to them.
2. **Whether the guidance names the verdict vocabulary.** The §7 proposal names
   `verified`/`stale`/`unknown`/`unanchored`, which is precise and costs tokens
   on every handshake; the alternative is "check the verdict" without
   enumerating. AC-8 requires that stale/unknown/unanchored be covered either
   way, so this is a wording trade rather than a contract question.

Locked, not reopened: EPIC-136 §4a, EPIC-137 §8, EPIC-131's pack composition,
and §5's exclusion of routing infrastructure.

## 17. Test requirements

**Unit:** the instruction text against AC-6, AC-7 and AC-8's fixed lists; notice
presence and ordering (AC-2).
**Integration:** `initialize` through a real MCP client (AC-1, AC-2); `tools/list`
snapshot equality (AC-3); the instruction constant across principals, permission
sets and store states (AC-12); EPIC-137's suites unmodified (AC-9); retrieval and
pack equality against a fixed store (AC-10).
**Security:** EPIC-084 injection boundary, EPIC-135 exclusions, redaction, and
every refusal contract in AC-5, all unmodified.
**Regression:** the full MCP contract suite; `boundaries.test.ts`.
**Real-agent:** §14.

Each targeted test observed failing first.

## 18. Security requirements

No trust boundary moves. The guidance is server-authored text in the handshake,
which is where Ferret's own instructions legitimately live; it is not content,
not indexed, and not derived from any store, so it cannot be a vehicle for
injected instructions. `CONTENT_NOTICE` keeps its position and wording, and the
guidance must not weaken it by implying that recorded statements may direct
behaviour — they remain data to cite, never obey. No permission, scope or
redaction behaviour changes.

## 19. Observability

None added. No metric, health check, log line or diagnostic. The handshake string
is already visible to any client and to `benchmark/agent/surface.mjs`.

## 20. Performance constraints

One sentence, once per session, at handshake. It must not be re-sent per turn —
which is what distinguishes it from the tool-description surface EPIC-136 §2.3
measured at ~10 700 tokens a turn. Budget: the guidance adds no more than ~60
tokens to a single handshake and zero per turn. `tools/list` bytes unchanged
(AC-3).

## 21. Definition of Done

Every AC in §13 met with evidence in `validation/EPIC-138-VALIDATION.md`; each
targeted test observed failing first; full suite, lint, typecheck and build green
with `boundaries.test.ts` holding; §14 run on the product path with the failing
and null runs kept; §15's four conditions met or the Epic reported failed;
evidence report written and clearly separating R138 research evidence,
implementation tests, and post-implementation real-agent measurement; decisions
record written before implementation; registry and ROADMAP rows in the same PR;
Windows CI green after any rebase; PR merged, `main` clean, Ferret re-indexed.

**Corpus note.** `docs/evidence/FERRET-WHEN-DOES-THE-AGENT-ASK.md` and this
specification both state the routing result in prose and belong on
`benchmark/agent/lib/corpus.mjs`'s exclusion list before §14 runs — as must this
Epic's own evidence report, added before it is written rather than after its
numbers are published. R138 already found that
`docs/EPICs/validation/EPIC-137-VALIDATION.md` and
`docs/evidence/FERRET-DOES-AN-ANCHOR-CARRY.md` postdate the anchors run and state
its answer; **re-running the committed anchors suite on today's tree is
contaminated until that list is extended.**

## 22. Implementation sequence

1. Write AC-6/7/8's forbidden-phrase lists and the failing text tests. Settle the
   wording against them (§16 Decision 1). Record the decision.
2. Add the sentence. AC-1, AC-2, AC-12.
3. Prove nothing else moved: AC-3, AC-4, AC-5, AC-9, AC-10, AC-11, AC-14.
4. Extend the corpus exclusion list (§21) and rebuild the benchmark store.
5. §14: baseline, guided, and the R138 routed reference, on U1–U4, with repeats.
6. Evidence report and `validation/EPIC-138-VALIDATION.md`, separating the three
   evidence classes.

## 23. Governance alignment

§6 explicit `unknown` over implied confidence — the guidance names the verdicts
that mean *verify* rather than implying that context suffices. §12 authorization
precedes everything; guidance grants nothing. §18 every verdict carries a reason,
unchanged. §21 no derived-result format changes shape — AC-3 and AC-10 enforce
it. §22 decisions recorded before implementation — §16 Decision 1 is settled and
recorded in step 1. Specification standard: APPROVED on defined scope and ACs;
DONE requires §21 evidence.
