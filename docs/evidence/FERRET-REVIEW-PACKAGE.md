# Review package — `forensic/post-merge-remediation`

For a human reviewer. Nothing here is new work; it is the branch described so it
can be read in one sitting.

| | |
| --- | --- |
| **Branch** | `forensic/post-merge-remediation` |
| **Base** | `10531e003acc38aff3a656b368cf438580d6dd0f` — current merged `main`, PR #153 |
| **Commits ahead / behind** | 13 ahead, **0 behind** — no rebase pending |
| **Working tree** | clean |
| **Pushed** | yes, local and remote at the same SHA |
| **Merged** | no. **Deployed** — no. |

---

## 1. Commit list

Oldest first. Two cycles: ten commits of post-merge forensic remediation, then
three of F-73 release-gate work.

| SHA | Subject | Findings |
| --- | --- | --- |
| `7024d42` | fix(audit,test): the MCP surface is audited, and a refusal is journalled as one | F-101, F-63, F-88 |
| `ba86bdd` | fix(parsers): a CRLF document and a prefixed workbook are the same documents | F-22, F-102 |
| `e928f3d` | fix(events,retrieval,config): three branches that decided nothing | F-78, F-86, F-84 |
| `94f265d` | fix(retrieval): relaxation must not invert a negation | F-65 |
| `4190e36` | docs(readme): the tool catalogue lists every tool, and a control keeps it that way | F-87 |
| `0c89322` | feat(cli): say which capabilities exist as libraries and are not wired | F-20 / F-21 |
| `fea26ce` | test(storage): verify the deployment path, not just the migration step | §11.6 deployment gap |
| `742fb86` | fix(identity): a merge that failed records that it failed | F-12 |
| `0ae5328` | docs(evidence): reconcile the records to merged main and the post-merge cycle | — |
| `429de14` | docs(readme): list the two planned commands in the command table | F-21 |
| `fecfffc` | test(packaging): the suite packs what the suite built, not what a build left | **F-72** |
| `4a5fecb` | test(harness): a packaging gate that did not run cannot report a green run | **F-73** |
| `50eb9c1` | docs(evidence,decisions): the F-73 cycle, and the backup decision it did not take | F-44 / F-45 briefs |

**One correction worth stating.** `0ae5328` recorded F-73 as "re-verified as
already closed" on the strength of a passing run. It was not closed. It
reproduced on this machine at `Hook timed out in 300000ms` with a file duration
of 319 836 ms, and `4a5fecb` is what actually fixes it. This is a reconciliation
of the record, not a reopened finding.

## 2. Files changed — 35 files, +2443 / −153

Grouped by what a reviewer needs to look at, not alphabetically.

**Product code (`src/`) — 11 files, all from the first cycle.** No `src/` file
was touched by the F-73 cycle.

```
src/cli/commands/mcp.ts          src/mcp/guards.ts
src/cli/commands/planned.ts      src/parsers/sheet/provider.ts
src/config/index.ts              src/parsers/sheet/xlsx.ts
src/config/paths.ts              src/parsers/text/markdown.ts
src/events/signature.ts          src/retrieval/rank.ts
src/storage/identities.ts        src/storage/retrieval.ts
```

**Test harness — 3 files + 1 config.**

```
vitest.config.ts                 tests/global-setup.ts
tests/required-groups.ts         tests/fixtures/required-groups/ (3 files)
```

**Tests — 9 files.**

```
tests/integration/required-groups.test.ts       (new, 5 tests)
tests/integration/storage/upgrade-deployment-path.test.ts (new, pre-0013 upgrade)
tests/integration/domain/identity-store.test.ts
tests/integration/mcp/tools.test.ts
tests/integration/storage/scale.test.ts
tests/unit/authorization-logging.test.ts        tests/unit/cli.test.ts
tests/unit/markdown-parser.test.ts              tests/unit/sheet-corruption.test.ts
tests/unit/webhook-events.test.ts
```

**Docs and state — 7 files.** `README.md`, three under `.agent/`, three under
`docs/`.

## 3. Security-sensitive changes

Three, and all three tighten rather than relax. **None changes an authorization
decision or a credential path.**

| Change | Why it is security-relevant | Commit |
| --- | --- | --- |
| `src/mcp/guards.ts`, `src/cli/commands/mcp.ts` — **F-63/F-88** | The MCP composition root never built an `AuditWriter`, so every guard called `audit?.record` against `undefined`: EPIC-085's journal recorded nothing any real client did, on the only surface an AI client has. And the `CONFIRMATION` event was written *before* `consume()` with `PERMITTED`/`consumed` hard-coded, so **every refusal was journalled as a consumed confirmation**. The writer is now wired the way `export`/`import`/`prune` already do it, and the decision is taken before the event records its result. | `7024d42` |
| `src/events/signature.ts` — **F-78** | `scheme === GITHUB_SHA256 ? 'sha256=' : 'sha256='` — two identical branches in webhook signature verification, plus a `{64}` hex literal re-encoding the digest length. Replaced with an exhaustive `Record<SignatureScheme, …>` and a derived length. No verification outcome changes; the dead branch could not have been made to differ safely later. | `e928f3d` |
| `vitest.config.ts`, `tests/required-groups.ts` — **F-73** | The packaging suite is the gate that scans the bytes the package actually ships for credential shapes. It could previously be reported as acceptable without having run. It now cannot. | `4a5fecb` |

**Deliberately *not* touched:** `src/security/`, `src/authorization/`,
`src/errors/redact.ts`, `src/storage/export.ts`, `src/storage/import.ts`.

## 4. Data-integrity changes

Four, each fixing a case where Ferret asserted something untrue about its own
data.

| Change | Defect | Commit |
| --- | --- | --- |
| `src/storage/identities.ts` — **F-12** | The supersession write sat in a `finally`, which runs on the way out of a rethrowing `catch` — so a **rolled-back merge still recorded that it happened**, in the one subsystem that cannot correct itself afterwards. Moved to the success path. Red first: "a failed merge recorded a supersession: expected '1' to be '0'". | `742fb86` |
| `src/parsers/text/markdown.ts` — **F-22** | `linesOf` split on `\n`, leaving CR on every line. Measured: identical document, LF → 2 headings / 1 outline node; CRLF → **0 and 0**. On a Windows checkout that is every Markdown file Ferret indexes. CR now stripped from content but still counted in offsets, so spans stay honest. | `ba86bdd` |
| `src/parsers/sheet/xlsx.ts`, `provider.ts` — **F-102** | F-23 taught the root check to accept a namespace prefix; the eleven extractors beneath it stayed prefix-blind, so a **valid** prefixed workbook read as `{"sheets":[],"warnings":[]}` — F-23's own signature on an uncorrupted file. Prefix defined once, all eleven derived from it, with an over-reach control. Parser version → 1.2.0. | `ba86bdd` |
| `src/storage/retrieval.ts` — **F-65** | Relaxation ran `replace(' & ', ' \| ')` over a rendered tsquery, **inverting negation**: `a & !b` → `a \| !b`, selecting documents *because* they lacked the excluded term. Measured at the time: strict 0 rows, relaxed 3 775 of 3 777, all scoring 0. Relaxation now applies only to a flat conjunction. | `94f265d` |

`src/retrieval/rank.ts` (**F-86**) is adjacent: four tiebreaks used
`localeCompare` with no locale, making result order a property of the host.
Now code-unit ordering on machine identifiers.

## 5. Migration changes

**None.** No file under `src/storage/migrations/` is touched anywhere on the
branch, and no migration was added, edited or renumbered. `drizzle.config.ts` is
untouched.

What *did* change is migration **verification**: `fea26ce` adds
`tests/integration/storage/upgrade-deployment-path.test.ts` (233 lines), which
closes the deployment gap the audit's §11.6 recorded as unexercised. It upgrades
a **populated pre-`0013`** database, asserts its rows survive, indexes a real
repository into it and reads it back, and compares the upgraded schema against a
fresh install with data carried across. Green in every run below.

## 6. Test-harness changes — the largest change on the branch

`vitest.config.ts` (+127/−32 net) is the one thing most likely to have a subtle
consequence, and it deserves the reviewer's attention first.

- **Moves to Vitest projects.** Two projects with distinct `sequence.groupOrder`:
  `suite` (177 files) at `0`, `packaging` (1 file) at `1`. The packaging hook no
  longer runs while the suite that starved it is running. **This is the
  root-cause fix and it is not a timeout increase** — the budget is still 300 s
  against 33 s of measured work.
- **Worth checking:** `globalSetup` stays at root and its `provide` still reaches
  project tests (proved by the whole storage suite passing against a real
  server); root-level `reporters` are the ones consulted, project-level are not.
- **`tests/required-groups.ts` sets `process.exitCode` from a reporter.**
  Unusual and deliberate. Verified against Vitest's own exit logic in `cli-api`
  rather than assumed: every assignment there raises the code and none clears
  it, and the reporter runs after Vitest has already decided. If a future Vitest
  starts reporting a dead hook's tests as *failed* rather than *skipped*, the
  second test in `required-groups.test.ts` fails **on purpose**, so the guard is
  reconsidered on evidence instead of removed on a guess.
- **The guard does not enforce presence on a narrowed run** — a deliberate hole,
  reasoned in the code. A reviewer who disagrees should say so: the alternative
  is `npm run test:unit` failing for not running the packaging suite. Confirmed
  still green: 90 files, 2199 passed.
- **`tests/global-setup.ts` (F-72)** now runs all three asset steps `npm run
  build` runs. It previously ran `tsc` + `copy-migrations` only, so
  `packaging.test.ts` asserted the tarball ships four grammars and the golden
  dataset **against whatever a previous build left in `dist/`**. `clean` is
  deliberately still not run.
- **`tests/integration/packaging.test.ts` is byte-identical to `main`** —
  verified with `git diff --quiet`. No assertion relaxed, no budget moved,
  nothing deleted.

## 7. Major forensic fixes

Twelve findings closed in the first cycle, per `.agent/FINDINGS.md`, plus two in
the second. The three highest-consequence:

1. **F-63 / F-88** — the MCP audit journal recorded nothing, and journalled
   every refusal as a consumed confirmation. The audit trail on the only AI
   client surface was fiction.
2. **F-65** — full-text relaxation inverted negation, returning 3 775 of 3 777
   documents *because* they lacked the excluded term.
3. **F-73** — the release gate could be reported green having not run. Measured
   root cause: 33 s of work alone, 320 s under contention with 177 other files
   — contention, not an undersized budget.

Also closed: F-101 (a test asserting a planner choice, which failed merged-`main`
CI and was therefore a wrong test, not a flaky environment), F-12, F-22, F-102,
F-78, F-86, F-84, F-87, F-20/F-21, F-72.

## 8. Validation evidence

All on `50eb9c1`, this machine, against a real PostgreSQL 17 + pgvector
container except where noted.

| Gate | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| **Full suite, normal** | **178/178 files, 3571 passed, 7 skipped, exit 0** |
| Full suite, **loaded** (8 CPU spinners + continuous disk writer) | exit 1 — packaging 34/34, 4 database tests starved past budget. §9. |
| `npm run test:unit` | 90 files, 2199 passed, exit 0 |
| Packaging gate | **34/34 executed**, asserted by the harness, not inferred from the summary |
| Migration / upgrade | `migrations`, `compatibility`, `upgrade`, `init-cli`, `upgrade-cli`, `embedding-provisioning`, `upgrade-deployment-path` green |
| Security / regression | all 9 `tests/security/*` files green — `injection-boundary`, `credential-surface`, `credential-containment`, `credential-isolation`, `git-output-integrity`, `control-reachability` |
| New regression test | `required-groups.test.ts`, 5 tests, green |

**F-73 before and after, same machine, same tree apart from the fix:**

| | Before | After |
| --- | --- | --- |
| Test files | 2 failed \| 176 passed | **178 passed** |
| Tests | 1 failed \| 3536 passed \| **41 skipped** | 3571 passed \| **7 skipped** |
| Packaging | 34 skipped, hook timed out at 300 s | **34 passed** in 36.7 s |
| Duration | 481 s | **359 s** |
| Exit | 1 | **0** |

The skip count falling 41 → 7 is the substantive proof: 7 is the number Batch 3
predicted for a run where F-73 does not fire (4 docker, 3 signals), and the 34
moved into `passed`. Skipped and did-not-run are now different numbers.

Full detail: [`FERRET-F73-RELEASE-GATE-INTEGRITY.md`](FERRET-F73-RELEASE-GATE-INTEGRITY.md).

## 9. Known limitations

Stated rather than smoothed over.

- **The loaded run is not green.** Under eight CPU spinners and a continuous disk
  writer on a 16-core machine — deliberately harsher than CI — four database
  tests were starved past their budgets: `health-database` (`afterAll` at 90 s),
  `compatibility` (1 of 29 upgrade cases at 120 s), `init-cli` (90 s),
  `upgrade-cli` (180 s). Packaging executed 34/34 through it, **every starved
  test failed by name**, and the skip count stayed at 7. That is the harness
  behaving correctly under genuine overload, and it is the opposite of F-73 —
  but the run failed and is not presented otherwise.
- **The packaging hook can still overrun** if something starves it hard enough.
  What changed is that it can no longer do so silently, and that it is no longer
  starved by Ferret's own suite.
- **F-44 and F-45 are open by instruction** — two product decisions, briefed in
  [`EPIC-089-DECISIONS.md`](../Architecture/EPIC-089-DECISIONS.md). Until D1 is
  answered, `ferret export` writes a document whose restore reports itself
  tampered and whose hashes do not describe its rows.
- **F-92 is open** and classified as environment/load, not a release blocker.
  It asserts a wall-clock budget, which is a legitimate thing to assert and
  legitimately contention-sensitive. It passed in the normal run; that does not
  close it.
- **F-10 is open** and is not a release blocker.
- **P2/P3 deferred findings are untouched**, including the Batch 8 record
  corrections.
- **Windows CI is post-merge**, by the arrangement recorded in `ci.yml`. This
  branch has had no CI run of any kind — every figure above is local.
- **No human review has occurred.** That is what this document is for.

## 10. Reviewer's shortlist

If time is short, read these five in order:

1. `vitest.config.ts` — the projects change, §6.
2. `tests/required-groups.ts` — the guard, and the `process.exitCode` note.
3. `src/mcp/guards.ts` — the audit journal, §3.
4. `src/storage/retrieval.ts` — the negation inversion, §4.
5. `docs/Architecture/EPIC-089-DECISIONS.md` — the decision-ready brief at the
   top. This is the only thing on the branch that needs a **decision** rather
   than a review.
