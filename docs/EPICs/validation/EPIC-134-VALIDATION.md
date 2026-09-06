# EPIC-134 — Continuous Self-Dogfooding: validation evidence

**Status: VALIDATED** · the oracle runs clean against Ferret's own index, and
every defect dogfooding found across EPIC-126 to EPIC-133 is a shipped
regression test. **No framework, no scheduler, no second harness.**

## Environment

| | |
| --- | --- |
| Tree | `7899ef7` (`main`) + EPIC-133 + this Epic |
| Host | Windows 11, Node v22.23.2 |
| Index | `ferret-dogfood`, Ferret's own repository — 901 tracked files |
| Command | `npm run dogfood -- --check` |
| Date | 2026-09-06 |

## The oracle, run

```
  ok    content notice
  ok    repository indexed  (Ferret)
  ok    the file list is complete  (915 entities over 2 page(s))
  ok    no phantom files  (901 active)
  ok    no missing files  (901 tracked)
  ok    commits carry content
  ok    exact lookup filters
  ok    change kind is visible
  ok    durable context converges  (4 wordings → 2 records)
  ok    replay adds nothing  (2 record(s) unchanged)
  ok    every statement stays reachable  (2 of 2)
  ok    a statement can say why it is believed
  ok    a proposal is not current context
  ok    the notice precedes the content
  ok    health reflects the index

Ferret agrees with the repository on every question asked.
```

Six of those fifteen are new, and each has an answer the script computes for
itself — the arithmetic of normalization, the ids it just wrote, byte offsets in
the rendered response. Ferret is asked; it is not believed.

## The acceptance, measured

> Dogfooding can expose defects that ordinary fixture-based tests miss.

**Nine defects across this queue. Every one found by running the system or
tripping one of its own controls. None found by writing a test against the
design.** Every one now has a regression test.

| # | Defect | Found by | Regression test |
| --- | --- | --- | --- |
| 1 | Near-duplicate detection used an AND query, so it could never find the duplicate differing in the one word that mattered | the EPIC-126 contradiction test on real data | `storage/durable-context.test.ts` |
| 2 | `ferret verify` read **4 of 4** durable context rows as `schema-invalid` — a composition gap its own comment already documented for `code_symbol` | dogfooding EPIC-126 | `storage/verify-cli.test.ts` — *proven against the unfixed code* |
| 3 | A comma left one decision as two records | the first EPIC-126 dogfood run | `unit/durable-context.test.ts` |
| 4 | **112 relationship rows** reported corrupt on the real index; issue #118's fix had landed on one of three closing paths | the EPIC-126 integrity sweep | `storage/lifecycle-hash.test.ts` — *proven against the unfixed code*, both paths |
| 5 | Promotion computed a confidence and dropped it — the exact defect `confidence.ts` exists to document, reproduced one layer up | the EPIC-129 dogfood printing `null` | `unit/context-promotion.test.ts` |
| 6 | The duplicate fold returned **zero** context hits — `splice(-1, 1)` deleting an unrelated survivor | the EPIC-130 measurement | `unit/retrieval-rank.test.ts` |
| 7 | A task question reached **none** of seven statements about it | the EPIC-131 dogfood | `retrieval/task-assembly.test.ts` |
| 8 | `ferret_context_promote` let any agent publish **another agent's** private session | running two agents (EPIC-132) | `mcp/multi-agent-context.test.ts` — *proven against the unfixed code* |
| 9 | `ferret_session_recall` and `show` enforced no ownership | recorded by EPIC-132, closed by EPIC-133 | `security/context-governance.test.ts` — *proven against the unfixed code* |

Four of the nine were **proven against the unfixed code**: the fix was reverted
and the test observed to fail, so the coverage is known to bite rather than
assumed to.

## Controls that rejected a change, and were right

Dogfooding is not the only discipline that caught things. Ferret's own controls
refused five first drafts across this queue:

| Control | What it refused |
| --- | --- |
| `mcp-destructive-tools.test.ts` | a `PERMISSIONS` map — a tool must name its permission at its call site |
| `mcp/tools.test.ts` | a second content notice, and tools registered when their dependency was absent |
| `retrieval-scope.test.ts` | a step inserted between authorization and ranking — **strengthened, not relaxed** |
| `idempotence.test.ts` | a write method with no double-write proof, and it knew only one of three new transitions |
| `retention.test.ts` + `prune-cli.test.ts` | a retention target the CLI could name and never age |

## A change tried, measured, and reverted

EPIC-131's first fix wired the pack builder to `QueryPlanner`. The dogfood said
it did not work — the planner relaxes only on an empty result, and one incidental
commit had matched. It was reverted rather than shipped with a motivation the
measurement had disproved.

## Environmental failures, diagnosed rather than hidden

| Observed | Diagnosis | Action |
| --- | --- | --- |
| `reconcile.test.ts` failing at `JSON.parse('')` | a 30 s CLI timeout reported as an unparseable envelope — issue #61's *"the reason is discarded"*, one layer up | timeout **not** raised; `CliResult` now carries `timedOut` and `signal`, and `parseEnvelope` names both streams |
| `records evidence in under 250 ms at p95` at **311 ms** | host running a 19-container workload including a k8s cluster; full runs 710–790 s against a ~520 s baseline; passes in isolation | budget **not** relaxed; clean re-run confirms |

Neither threshold was moved. In both cases the instrumentation changed and the
control did not.

## Reproducing this

```bash
npm run build
node scripts/dogfood-db.mjs            # a database with this repository in it
ferret config set authorization.permissions '["read","record","mutate","index"]'
npm run dogfood -- --check
```

Without the grant, the durable-context checks report themselves **skipped with
the remediation** rather than failing or crashing — a check that quietly did not
run reads exactly like one that passed.
