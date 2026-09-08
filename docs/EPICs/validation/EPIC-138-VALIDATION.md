# EPIC-138 — Durable-Context Routing Guidance: validation

**Status: MEASURED AND REJECTED.** The sentence was implemented, tested,
measured against real agents, and **not shipped**. `src/mcp/server.ts` is
byte-identical to `main`; the only production difference is a comment recording
the rejection.

**This is not an implementation success.** It is a negative product result.

| | |
| --- | --- |
| Implementation commit (reverted) | `60773de` |
| Wording tests, committed red first | `46dba26` |
| Decisions record | [EPIC-138-DECISIONS.md](../../Architecture/EPIC-138-DECISIONS.md) |
| Evidence report | [FERRET-DOES-A-SERVER-STRING-ROUTE.md](../../evidence/FERRET-DOES-A-SERVER-STRING-ROUTE.md) |
| R138 research (separate, unchanged) | [FERRET-WHEN-DOES-THE-AGENT-ASK.md](../../evidence/FERRET-WHEN-DOES-THE-AGENT-ASK.md) |
| Raw §14 results | `benchmark/agent/results/routing-138.json` |

## Exact wording measured

> For a task-shaped engineering question, check the durable context an earlier
> session recorded before exploring source, and use its verdict: `verified` says
> what was observed still matches the indexed code, while `stale`, `unknown` and
> `unanchored` each mean verify against source before relying on it.

302 characters. §7's proposal, verbatim and unedited.

## Acceptance criteria

Every AC was exercised against the implementation before it was reverted. The
tests that survive assert the **absence** of the sentence and the constraints any
future wording would have to meet.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 instructions carry the guidance, via a real client | **Met, then reverted** | `instructions.test.ts` now asserts absence; delivery confirmed by a live session quoting the string verbatim |
| AC-2 notice present, unmodified, after the guidance | Met | `mcp-instructions.test.ts`, `instructions.test.ts` |
| AC-3 `tools/list` byte-identical | **Met** | Real 30-tool surface, both builds: sha256 `a9e1fad2…`, 53 535 bytes; snapshot `tests/fixtures/mcp/knowledge-tools.json` captured from the pre-change build |
| AC-4 no tool, permission, scope or principal class added | Met | `instructions.test.ts` |
| AC-5 refusal contracts unchanged | Met | Full suite, 4293 passing |
| AC-6 no call count, no unconditional call | Met | Forbidden list committed red in `46dba26` |
| AC-7 no authority claim | Met | Same |
| AC-8 stale/unknown/unanchored require verification | Met | Same |
| AC-9 EPIC-137 semantics unchanged | Met | `code-state-verification.test.ts` and EPIC-137 suites unmodified |
| AC-10 ranking, retrieval, pack unchanged | Met | No code path touched; `tools/list` byte equality; full suite |
| AC-11 security and redaction unchanged | Met | `tests/security` unmodified and green |
| AC-12 string invariant across principal, permission, store | Met | `instructions.test.ts`, six compositions |
| AC-13 measurable by `benchmark/agent/` | Met | Arms select a build, not a flag |
| AC-14 `boundaries.test.ts` holds | Met | Full suite |

## §14 real-agent measurement

36 sessions, `opus` at effort `high`, 3 repeats per arm per task. Consultation
before first source read:

| task | baseline | guided | routed (ceiling) |
| --- | --- | --- | --- |
| U1 unchanged tree | 2/3 | **0/3** | 3/3 |
| U2 anchored file changed | 3/3 | **0/3** | 3/3 |
| U3 unrelated file changed | 2/3 | **0/3** | 3/3 |
| U4 nothing recorded | 3/3 | 3/3 | 3/3 |

U1–U3, mean of task means:

| | baseline | guided | routed |
| --- | --- | --- | --- |
| context tokens | 520 k | 513 k (−1.5%) | 239 k |
| tool calls | 16.5 | 19.6 (+19%) | 9.2 |
| files read | 4.8 | 6.0 (+25%) | 1.8 |
| lines read | 659 | 841 (+28%) | 269 |
| wall clock | 120 s | 133 s (+11%) | 86 s |
| cost | $0.83 | $0.78 (−6%) | $0.49 |
| Ferret calls | 2.6 | 1.6 | 3.3 |

U4, the usefulness gate — Ferret calls **guided 2.67, baseline 2.67**, routed
4.33; guided context 348 k against baseline 421 k; cost $0.53 against $0.71.
**Passed:** the sentence caused no useless-call regression.

Safety and correctness, all arms and tasks: **0 stale assertions, 0 false drift,
12/12 correct verdicts per arm.** Unsupported citations: guided 0, routed 0,
baseline 1. Facts covered: guided 36/36, baseline 34/36, routed 33/36. Guided
read the anchored implementation 4.0 times per session on U2.

## §15 success criterion

| | condition | result |
| --- | --- | --- |
| 1 | earlier consultation | **failed** — 0/9 against baseline 7/9 |
| 2 | lower rediscovery cost | **failed** — +28% lines, +25% files, +19% calls |
| 3 | no loss of correctness | met |
| 4 | no stale-context safety regression | met |

Two of four failed, so the Epic fails. §15 named this outcome in advance and
required it be reported rather than iterated on.

## R138 versus EPIC-138 — the distinction that must not blur

**R138 proved the hypothesis under explicit routing.** A client-side
system-prompt instruction moved consultation to call 1 in 5 of 5 and cut context
48% and cost 30%.

**EPIC-138 disproved the hypothesis that a single MCP `initialize` sentence is
sufficient to reliably create that routing behaviour.** The same repository, the
same harness, the same grader, the same model — and 0 of 9.

The R138 result stands as historical evidence and is not amended.

## Gates

`npm run lint`, `npm run typecheck`, `npm run build` — **exit 0** each, after the revert.

Three full-suite runs, reported in full rather than the best of them:

| run | tree | command | exit | result |
| --- | --- | --- | --- | --- |
| 1 | `60773de`, sentence present | `npm test` | 0 | 4293 passed, 7 skipped, **1 failed** — `git/discovery.test.ts` "walks a wide tree within budget", 30 021 ms against a 30 000 ms ceiling. **2 006 ms when run alone**: contention against a regression ceiling, not this change |
| 2 | after the revert | `npm test` | **1** | 6 failed across 18 files, **every one a "real PostgreSQL" suite**. Rancher Desktop's WSL backend died mid-run — `could not dial Hyper-V socket … lacked sufficient buffer space`. An environment failure caused by the benchmark's container load, not a code failure |
| 3 | after the revert | `FERRET_SKIP_DOCKER_POSTGRES=1 npm test` | **0** | **3391 passed, 910 skipped, 0 failed**; required packaging group 34/34 executed |

Run 3 is exactly what CI's Windows `verify` job runs. The 910 skipped are the
real-PostgreSQL suites, which CI's Ubuntu `storage` job owns and runs against
PostgreSQL 17 + pgvector — **that job, not this local run, is the coverage claim
for them.** Run 1 exercised them against a live database with the sentence in
place and they passed; the reverted tree's production code is byte-identical to
`main`, so nothing in that layer moved.

The security suite is unmodified. Its non-database tests passed in run 3; its
one database test, `security/context-governance.test.ts`, passed in run 1 and is
covered by the `storage` job.

## Limitations

- **n = 3 per arm per task.** Only the 0/9 vs 7/9 consultation separation is
  robust at this size. Context and cost deltas are inside noise.
- **R138's premise did not reproduce.** Its treatment consulted before source in
  0 of 5; this run's baseline did so in 7 of 9 on the same nominal
  configuration. The intervention was designed for a behaviour the baseline no
  longer reliably exhibits, which weakens any causal reading of the deltas.
- One model, one repository, one question shape, four statements, a store
  minutes old.
- Refused reads still count toward `filesRead` — R138's harness limitation,
  unfixed, equal across arms. Every excluded document read was refused; corpus
  integrity held in all 36 sessions.
- `guided` in `benchmark/agent/routing.mjs` now reproduces `baseline` against
  today's `dist/`, since no build carries the sentence.

## What remains unanswered

Whether any server-side mechanism can move consultation position, and whether
R138's effect belongs to the instruction's content or to its position in the
client's own system prompt — somewhere a server cannot write. Not proposed as
follow-on work.
