# Does a server string route the agent? — the EPIC-138 measurement

**Result: no. The sentence was measured and rejected, and no product change shipped.**

**Branch:** `epic-138-durable-context-routing-guidance` · **Store:** `ferret_agent_ab`,
dropped and rebuilt · **Model:** `opus`, effort `high` ·
**Harness:** `benchmark/agent/routing.mjs`, `routing-tasks.json` ·
**Raw:** `benchmark/agent/results/routing-138.json` · **Date:** 2026-09-08

Three evidence classes are kept apart here and must not be merged:

1. **R138 research** — `FERRET-WHEN-DOES-THE-AGENT-ASK.md`, unchanged. A
   client-side system-prompt instruction cut context 48% and cost 30%.
2. **EPIC-138 implementation tests** — §2 below. They pass, and say nothing
   about whether the sentence works.
3. **EPIC-138 real-agent measurement** — §3 onward. It rejected the sentence.

---

## 1. The question

R138 proved the hypothesis **under explicit client-side routing**. EPIC-138
asked the narrower product question: is one sentence in the MCP `initialize`
instructions enough to reproduce that behaviour?

The two arms differ in exactly one thing — the server's handshake string:

| arm | server | client prompt |
| --- | --- | --- |
| `baseline` | today's instructions | the standard contract |
| `guided` | the same, plus one sentence | the standard contract |
| `routed` | today's instructions | contract **plus** R138's instruction — a reference ceiling, not a treatment |

The sentence measured:

> For a task-shaped engineering question, check the durable context an earlier
> session recorded before exploring source, and use its verdict: `verified` says
> what was observed still matches the indexed code, while `stale`, `unknown` and
> `unanchored` each mean verify against source before relying on it.

The product has no toggle for it, so the arms are **two builds**: `dist/` copied
to `.local/routing-baseline` before `src/mcp/server.ts` changed, and the current
build after. The harness selects a CLI path per arm and nothing else.

**Delivery verified, not assumed.** A one-shot session against each build was
asked to quote its server instructions: the baseline returned purpose + notice,
the guided one returned purpose + **the sentence, verbatim** + notice. The arms
differ as intended, so what follows is an effect of the sentence.

## 2. What the implementation tests established

`tools/list` on the real 30-tool surface is **byte-identical** across both builds
— sha256 `a9e1fad2…`, 53 535 bytes, 30 tools. The handshake grew by exactly 302
characters. `CONTENT_NOTICE` unmoved. No tool, permission, principal class,
ranking, retrieval or pack change. AC-6/7/8's forbidden-phrase lists were
committed red in `46dba26`, before any wording existed, and the sentence passes
all three unedited. **The wording was not the problem.**

## 3. Setup

Session A investigated and recorded unprompted: **4 statements, 4 of 4 anchored,
3/3 facts, $1.33**, anchored to five files. Three repeats per arm per task.

| task | repository state | carried verdicts |
| --- | --- | --- |
| U1 | unchanged since A recorded | 4 × `verified` |
| U2 | an anchored file changed and re-indexed — **safety gate** | 1 × `verified`, 3 × `stale` |
| U3 | an unrelated file changed and re-indexed | unchanged |
| U4 | a question nothing was recorded about — **usefulness gate** | — |

Both tree changes are comment-only edits, committed so correspondence could
fail on bytes rather than on an uncommitted path, and reverted after the run.

## 4. Consultation position — the criterion the Epic rested on

`consult` is the first knowledge call; `src` is the first source read. Sessions
where consult precedes src:

| task | baseline | guided | routed |
| --- | --- | --- | --- |
| U1 | 2/3 | **0/3** | 3/3 |
| U2 | 3/3 | **0/3** | 3/3 |
| U3 | 2/3 | **0/3** | 3/3 |
| **U1–U3** | **7/9** | **0/9** | **9/9** |

The guided arm consulted **later than the baseline, in every session**. Its first
Ferret call landed at tool call 14–25; the baseline's landed at call 1 in seven
of nine. The separation is complete in the wrong direction.

**The baseline opens `ferret_search`; the guided arm opens `Grep`.** That is the
whole difference, and it reverses the intended one.

## 5. Rediscovery cost — U1–U3, mean of task means

| | baseline | guided | routed |
| --- | --- | --- | --- |
| context tokens | 520 k | 513 k (**−1.5%**) | **239 k** (−54%) |
| tool calls | 16.5 | 19.6 (**+19%**) | **9.2** |
| files read | 4.8 | 6.0 (**+25%**) | **1.8** |
| lines read | 659 | 841 (**+28%**) | **269** |
| anchored-file reads | 3.8 | 4.8 | **2.0** |
| wall clock | 120 s | 133 s (**+11%**) | **86 s** |
| cost | $0.83 | $0.78 (−6%) | **$0.49** |
| Ferret calls | 2.6 | 1.6 | 3.3 |

Guided read **more** source than baseline on all three tasks — more files in
3 of 3, more lines in 3 of 3. Context and cost moved a little the other way and
are inside run-to-run noise at n=3. The routed ceiling reproduced R138.

## 6. Safety, correctness and usefulness — all held

- **U2 safety gate: passed.** Correct answer 3/3 in every arm, **zero stale
  assertions** anywhere in the experiment. The guided arm read the anchored
  implementation 4.0 times per session.
- **U3 false drift: zero.** The unrelated commit moved no verdict.
- **Correctness: 12/12** correct verdicts per arm across all four tasks. Facts
  covered: guided **36/36**, baseline 34/36, routed 33/36 — the guided arm's
  answers were, if anything, slightly more complete.
- **Unsupported citations:** guided 0, routed 0, baseline 1.
- **U4 usefulness gate: passed.** Ferret calls guided **2.67** against baseline
  **2.67** — identical — where routed spent 4.33. On the question nothing was
  recorded about, guided also used less context (348 k vs 421 k) and less money
  ($0.53 vs $0.71).

So the sentence is safe, correct, and cheap when the store knows nothing. It
simply does not do the one thing it was added to do.

## 7. Why it was rejected

EPIC-138 §15 required four conditions together. Two failed:

| | condition | result |
| --- | --- | --- |
| 1 | earlier consultation | **failed** — 0/9 against the baseline's 7/9 |
| 2 | lower rediscovery cost | **failed** — +28% lines, +25% files, +19% calls |
| 3 | no loss of correctness | met |
| 4 | no stale-context safety regression | met |

§15 anticipated exactly this: *"If the guided arm does not move consultation
position, the honest conclusion is that the effect belonged to the client
convention and a server string cannot buy it."* It did not merely fail to move
it; it moved it the wrong way, in nine of nine.

**Owner decision, 2026-09-08: do not ship the sentence.** `src/mcp/server.ts` is
byte-identical to `main`.

## 8. A mechanism, offered as a hypothesis and not as a finding

The baseline instructions say Ferret *"answers questions about indexed
repositories"* — a general retriever, and the baseline reached for
`ferret_search` on call 1. The added sentence describes *"the durable context an
earlier session recorded"* — a narrow, conditional resource whose relevance an
agent cannot know before asking. The guided arm made **fewer** Ferret calls
(1.6 against 2.6) and made them later, which is consistent with the sentence
having **narrowed the perceived role of the tool** rather than advanced its
position.

This is a hypothesis this experiment cannot test. It is recorded so nobody
re-derives it, not as a result.

## 9. What this does not license

- **n = 3 per arm per task, 36 sessions.** Directions, not p-values. The
  consultation separation (0/9 vs 7/9) is the only result robust at this size;
  the context and cost deltas are not.
- **R138's premise did not reproduce.** R138 measured its treatment consulting
  before source in **0 of 5** sessions; this run's baseline did so in **7 of 9**
  on the same nominal configuration. The tree, Session A's statements and the
  client version all moved between the two runs. **The intervention was designed
  for a behaviour the baseline no longer reliably exhibits**, and that alone
  weakens any causal reading of §4 and §5.
- **One model, one repository, one question shape, four statements**, and a
  knowledge base minutes old rather than months.
- **The guided arm's own corpus contained the sentence**: `src/mcp/server.ts` was
  indexed in the tree both arms searched. Symmetric across arms, so it does not
  explain the split.
- **Refused reads still count toward `filesRead`**, equally in all arms — R138's
  known harness limitation, unfixed here. Every attempted read of an excluded
  document was refused; corpus integrity held in all 36 sessions.
- **The `routed` ceiling is not a product option.** It is a client convention,
  and this Epic does not propose shipping one.

## 10. What remains unanswered

Whether *any* server-side mechanism can move consultation position, and whether
the R138 effect belongs to the instruction's content or to its **position in the
client's own system prompt** — a place a server cannot write to. This experiment
does not distinguish those, and no follow-on Epic is proposed here.
