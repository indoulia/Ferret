# EPIC-137 — validation record

**Branch:** `epic-137-code-state-anchors` · **Store:** `ferret_agent_ab` (benchmark), `ferret` (dogfood)
**Suites:** `tests/unit/code-state-verification.test.ts` (16), `tests/integration/storage/code-state-anchors.test.ts` (23)

Correctness evidence only. Productivity measurements are in
[the evidence report](../../evidence/FERRET-DOES-AN-ANCHOR-CARRY.md).

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 anchored recording persists `locator` + `sourceContentHash` | PASS | integration `AC-1, AC-2` |
| AC-2 path resolves to the current version | PASS | integration `AC-1, AC-2` |
| AC-3 unresolvable anchor reported per anchor | PASS | integration `AC-3`; dogfood `unresolvable=[…failure:"anchor-does-not-resolve"]` |
| AC-4 statement identity unchanged, merge converges | PASS | integration `AC-4` (`outcome: merged`, same id) |
| AC-5 producer from the composition root | PASS | pre-existing `context-tools` contract, unchanged; integration `AC-1` records `ferret.dogfood` |
| AC-6 matching anchor + correspondence → verified | PASS | unit `AC-6`; integration `AC-6`; dogfood `verdict=verified` |
| AC-7 changed anchored file → stale, lifecycle active | PASS | unit `AC-7`; integration `AC-7…`; dogfood `verdict=stale` with both hashes |
| AC-8 unrelated file changed → still verified | PASS | unit `AC-8`; integration `AC-8`; T5 |
| AC-9 revert → verified again, no write | PASS | unit `AC-9`; integration `AC-7, AC-9, AC-14` (evidence count unchanged) |
| AC-10 commit id changed, content identical | PASS | integration `AC-10` — `matches: true`, verdict `unknown`, reason `index-does-not-correspond` |
| AC-11 five unknown categories | PASS | unit ×4; integration dirty path, detached HEAD, unindexed branch |
| AC-12 unanchored ≠ unknown, never verified | PASS | unit `AC-12`; integration `AC-12`; dogfood on two pre-existing statements |
| AC-13 prose creates no anchor | PASS | unit; integration `AC-13` |
| AC-14 drift mutates no lifecycle and writes nothing | PASS | integration `AC-7, AC-9, AC-14` |
| AC-15 supersession outranks a matching anchor | PASS | unit ×2; integration `AC-15`; dogfood `retired: superseded` |
| AC-16 scoped anchor resolution, no disclosure | PASS | integration ×2 — `anchor-excluded-by-rule` vs `anchor-not-permitted`, `currentHash` withheld |
| AC-17 MCP refusal contracts unchanged | PASS | `tests/integration/mcp/` 217 pass |
| AC-18 `locator.detail` redacted | PASS | integration `AC-18` — observed failing first; `redactStatement` did not cover free text, `redactSecrets` does |
| AC-19 both surfaces render, pack charges it | PASS | `context-pack` and `context-standing` suites; T1 pack carried `verification` with 3 verdicts |
| AC-20 verification cost flat in store size | PARTIAL | per statement: one file + one version lookup per anchor. One working-tree read **per call**, memoised for the call only — measured at 122 ms per `git status`, so a 200-statement page costs one read rather than 200 (~24 s avoided). **Not** measured at 27/67/150 statements |
| AC-21 re-anchor at a new hash → second observation, verified | PASS | integration `AC-21`; `--phase maintain` re-verified two stale statements with no supersession |
| AC-22 re-anchor at an unchanged hash dedupes | PASS | integration `AC-22` |
| AC-23 `evidenceKey` inputs unchanged | PASS | integration `AC-23` — fixed-input key pinned |

## Gates

| Gate | Result |
| --- | --- |
| `test:unit` | 2 526 pass / 102 files |
| `tests/security` | included above, 111 files total pass |
| `tests/integration` | 1 608 pass, 7 skipped, 1 fail → fixed (package-size gate raised with accounting) |
| lint, typecheck, build | clean |
| `boundaries.test.ts` | 125 pass — core still imports no `storage/` |
| full suite, local | 212 files, **4 280 pass**, 7 skipped, run twice |
| CI `verify (windows-latest, node 22)` | pass, 9m05s |
| CI `dependency audit` | pass |
| CI `storage integration (PostgreSQL 17 + pgvector)` | **1 failure in 4 287** — [issue #21](https://github.com/indoulia/Ferret/issues/21), see below |

### The one CI failure

`tests/integration/domain/relationship-store.test.ts > performance > asserts a
relationship in under 300 ms at p95` failed with
`PostgreSQL is not accepting work: Failed query: begin`
([run 34164259008](https://github.com/indoulia/Ferret/actions/runs/34164259008)).

This is [issue #21](https://github.com/indoulia/Ferret/issues/21), the open
intermittent recorded during EPIC-019/020, EPIC-052/053, EPIC-057 and
EPIC-059–065: a connection refusal under a high parallel file count, in a test
this Epic does not touch. `tests/support/postgres.ts:100` documents the same
signature and the pool cap that mitigates it. 4 282 of 4 287 passed in that run,
and the same suite passed twice locally.

Recorded rather than dismissed, per the precedent EPIC-057 set: *"a green figure
quoted from a run that had a red line in it should say which line."* It is not
attributed to this Epic, and this Epic did not attempt to fix it.

## Defects found and fixed during implementation

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| 1 | A re-anchored observation deduped onto the old row and kept the old hash | reading `evidenceKey` while writing the spec | `sourceId` carries the anchor-set hash; `evidenceKey` unchanged |
| 2 | Correspondence compared the **default** branch, so every verdict on a feature branch was `unknown` | dogfood | compare the checked-out branch; detached HEAD and unindexed branch stay `unknown` |
| 3 | The `repository` entity carries no `path`, and four live worktrees sit on four commits | dogfood | resolve the checkout from worktrees plus the caller directory; ambiguity is `unknown` |
| 4 | A changed file keeps **two open** `file_has_version` edges, so `stale` was unreachable | dogfood | take the newest open edge; matching any would verify against superseded bytes |
| 5 | `locator.detail` was not redacted | AC-18 test, observed failing first | `redactSecrets` |
| 6 | Benchmark: verdict key was `correct`, not `expected`, so T1 graded both arms wrong | inspecting T1 answers | key corrected, T1 regraded from kept transcripts |
| 7 | Correspondence was memoised per `CodeStateStore`, and the composition root builds one per server — a session that committed would keep being told `verified` against the head the process first saw | self-review of the diff while CI ran | cache removed; correspondence is now memoised **per call** (`ContextRead.correspondence`), so a page costs one read and nothing is remembered between calls. Regression test observed failing against a reintroduced cross-call cache (5 tests fail) |

## Out of scope, surfaced

**The indexer never retires a superseded `file_has_version` edge.** Measured on
the dogfood store: `src/context/code-state.ts` held two open edges after one
content change. EPIC-032 owns interval closure; EPIC-137 works around it by
taking the newest edge and records the gap here rather than changing indexing.

## How the tests were arrived at

Not uniformly red-green, and the record says which:

- `tests/unit/code-state-verification.test.ts` was written **after**
  `src/context/code-state.ts`, so it was never observed failing against absent
  code. It was instead mutation-checked: forcing the correspondence gate open
  (`if (true)`) fails 2 of its cases, so the gate is genuinely covered.
- AC-18's redaction case was observed failing first, and is the reason
  `redactSecrets` replaced `redactStatement` there.
- Defect 7's regression case was mutation-checked the same way: reintroducing a
  cross-call cache fails 5 cases.
- The remaining integration cases were written alongside the behaviour they
  cover and pass on first run; the four dogfood defects each produced a failing
  observation on the real store before a fix.

## Limitations

- AC-20 is partial: the per-read cost is bounded by construction but was not
  measured across store sizes.
- `ferret_context_find` computes one verdict per listed statement; at
  `MAX_CONTEXT_PAGE` = 200 that is 200 verdicts in one call, sharing one
  working-tree read. The per-statement database lookups are not batched and were
  not benchmarked at that page size.
- Verification is file-granular. An unrelated edit inside an anchored file
  reports `stale`. Deliberate: over-reporting costs a re-verification.
