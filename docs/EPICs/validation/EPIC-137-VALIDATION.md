# EPIC-137 — validation record

**Branch:** `epic-137-code-state-anchors` · **Store:** `ferret_agent_ab` (benchmark), `ferret` (dogfood)
**Suites:** `tests/unit/code-state-verification.test.ts` (16), `tests/integration/storage/code-state-anchors.test.ts` (22)

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
| AC-20 verification cost flat in store size | PARTIAL | per-statement cost is one file + one version lookup per anchor plus one cached worktree read per scope; **not** measured at 27/67/150 statements |
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

## Defects found and fixed during implementation

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| 1 | A re-anchored observation deduped onto the old row and kept the old hash | reading `evidenceKey` while writing the spec | `sourceId` carries the anchor-set hash; `evidenceKey` unchanged |
| 2 | Correspondence compared the **default** branch, so every verdict on a feature branch was `unknown` | dogfood | compare the checked-out branch; detached HEAD and unindexed branch stay `unknown` |
| 3 | The `repository` entity carries no `path`, and four live worktrees sit on four commits | dogfood | resolve the checkout from worktrees plus the caller directory; ambiguity is `unknown` |
| 4 | A changed file keeps **two open** `file_has_version` edges, so `stale` was unreachable | dogfood | take the newest open edge; matching any would verify against superseded bytes |
| 5 | `locator.detail` was not redacted | AC-18 test, observed failing first | `redactSecrets` |
| 6 | Benchmark: verdict key was `correct`, not `expected`, so T1 graded both arms wrong | inspecting T1 answers | key corrected, T1 regraded from kept transcripts |

## Out of scope, surfaced

**The indexer never retires a superseded `file_has_version` edge.** Measured on
the dogfood store: `src/context/code-state.ts` held two open edges after one
content change. EPIC-032 owns interval closure; EPIC-137 works around it by
taking the newest edge and records the gap here rather than changing indexing.

## Limitations

- AC-20 is partial: the per-read cost is bounded by construction but was not
  measured across store sizes.
- `ferret_context_find` computes one verdict per listed statement; at
  `MAX_CONTEXT_PAGE` = 200 that is 200 verdicts in one call. Bounded by the page,
  not by the store, and not benchmarked at that page size.
- Verification is file-granular. An unrelated edit inside an anchored file
  reports `stale`. Deliberate: over-reporting costs a re-verification.
