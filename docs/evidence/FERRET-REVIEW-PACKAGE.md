# Review package — `forensic/post-merge-remediation`

For a human reviewer. Nothing here is new work; it is the branch described so it
can be read in one sitting.

| | |
| --- | --- |
| **Branch** | `forensic/post-merge-remediation` |
| **Base** | `10531e003acc38aff3a656b368cf438580d6dd0f` — current merged `main`, PR #153 |
| **Commits ahead / behind** | 18 ahead, **0 behind** — no rebase pending |
| **Working tree** | clean |
| **Pushed** | yes, local and remote at the same SHA |
| **Merged** | no. **Deployed** — no. |

**Three cycles are on this branch**, and §11 covers the third:

1. Ten commits of post-merge forensic remediation — twelve findings.
2. Three commits of F-73 release-gate work — §1-§10 below.
3. Five commits implementing the **D1/F-44** and **D2/F-45** product decisions
   the owner took on 2026-09-04, plus the CI fix that running them exposed —
   **§11**, the newest work and the part most worth a reviewer's time.

**CI is green on all five jobs** — Ubuntu, Windows, macOS, PostgreSQL 17 +
pgvector, and the dependency audit. It was not green on the first attempt, and
§11.9 is that story.

---

## 1. Commit list

Oldest first. Ten commits of post-merge forensic remediation, three of F-73
release-gate work, then three implementing the D1/D2 decisions (§11).

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
| `c1aa6c9` | docs(evidence,decisions): the F-73 cycle, the backup decision, and the review package | F-44 / F-45 briefs |
| `53d0880` | docs(evidence): record the corpus regression the final check caught | — |
| `e32853a` | feat(export,import): a faithful document, and a restore that says what it lost | **F-44, F-45** |
| `3bf1ffa` | test(storage): the two contracts, and the four controls that caught the change | **F-44, F-45** |
| `90cd7a1` | docs(decisions,epic): D1 and D2 decided and implemented | F-44 / F-45 |
| `ab6a760` | test(harness): the gate’s own test asserted styling, not content | §11.9 |
| _(this one)_ | docs(evidence): the CI evidence for the D1/D2 cycle | — |

**`c1aa6c9` was rewritten once, and the reason is worth a reviewer's
attention.** Its first version quoted the fixture's filename literally — an
AWS-key-shaped string — in the commit message. `tests/unit/secrets.test.ts`
scans this repository's last 400 commit messages for exactly that shape, and it
failed: `expected [ 'aws-access-key-id' ] to strictly equal []`. The message now
describes the filename instead of quoting it, and the corpus is clean again
(24/24). The tree content is unchanged between the two versions; only the
message differs. Two things follow. The commit was **force-pushed**, so anyone
holding `50eb9c1` should reset to `c1aa6c9`. And the test worked — it caught a
credential-shaped string entering the repository, from the one source nobody
lints.

**One correction worth stating.** `0ae5328` recorded F-73 as "re-verified as
already closed" on the strength of a passing run. It was not closed. It
reproduced on this machine at `Hook timed out in 300000ms` with a file duration
of 319 836 ms, and `4a5fecb` is what actually fixes it. This is a reconciliation
of the record, not a reopened finding.

## 2. Files changed — cycles 1 and 2

Grouped by what a reviewer needs to look at, not alphabetically. **§11.2 covers
the D1/D2 cycle separately**; the whole-branch total is 53 files, +4198 / −208.

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

**Deliberately *not* touched by cycles 1 and 2:** `src/security/`,
`src/authorization/`, `src/errors/redact.ts`, `src/storage/export.ts`,
`src/storage/import.ts`. The last two are the subject of cycle 3 — see §11.3,
which is where the security discussion for this branch now lives.
`src/security/`, `src/authorization/` and `src/errors/redact.ts` are untouched
across all three cycles.

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

All on this branch's tip, this machine, against a real PostgreSQL 17 + pgvector
container except where noted. The normal-conditions figure below was re-measured
on the final commit after the message rewrite, not carried over.

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
- ~~**F-44 and F-45 are open by instruction.**~~ **Decided by the owner on
  2026-09-04 and implemented in cycle 3** — see §11 and
  [`EPIC-089-DECISIONS.md`](../Architecture/EPIC-089-DECISIONS.md) §Decided. The
  limitation this line described is gone: a restored index no longer reports
  itself tampered with, and its hashes describe its rows. The limitations that
  *remain* are stated in the decision record — chiefly that a faithful export of
  an index holding a credential contains it, and that a restore has no vectors
  until an embedding provider exists.
- **F-92 is open** and classified as environment/load, not a release blocker.
  It asserts a wall-clock budget, which is a legitimate thing to assert and
  legitimately contention-sensitive. It passed in the normal run; that does not
  close it.
- **F-10 is open** and is not a release blocker.
- **P2/P3 deferred findings are untouched**, including the Batch 8 record
  corrections.
- ~~**This branch has had no CI run of any kind.**~~ **It has now** — see
  §11.9. Dispatched via `workflow_dispatch`, so Windows and macOS ran too
  despite `ci.yml` keeping them off the pull-request gate. Green on all five
  jobs at `ab6a760`, and the first attempt failed for a reason no local run
  could have surfaced.
- **No human review has occurred.** That is what this document is for.

## 10. Reviewer's shortlist

If time is short, read these five in order:

1. `vitest.config.ts` — the projects change, §6.
2. `tests/required-groups.ts` — the guard, and the `process.exitCode` note.
3. `src/mcp/guards.ts` — the audit journal, §3.
4. `src/storage/retrieval.ts` — the negation inversion, §4.
5. `src/storage/export.ts` — the D1 change, §11.3. This is the one place a
   reviewer is asked to accept a deliberate security trade, and the reasoning
   is in `EPIC-089-DECISIONS.md` §Decided.
6. `src/storage/migrations/0014_instance_restore.sql` — the only migration on
   the branch, §11.5.

Nothing on the branch now needs a **decision**; D1 and D2 were the last two and
they are answered. What it needs is a review.

---

## 11. The D1 / D2 cycle — backup contract

The owner decided F-44 and F-45 on 2026-09-04. This section is that
implementation. The decisions, rationale and stated limitations are in
[`EPIC-089-DECISIONS.md`](../Architecture/EPIC-089-DECISIONS.md) §Decided;
`EPIC-089-Backup-And-Export.md` §17 carries the specification amendment.

### 11.1 Commits

| SHA | Subject |
| --- | --- |
| `e32853a` | feat(export,import): a faithful document, and a restore that says what it lost |
| `3bf1ffa` | test(storage): the two contracts, and the four controls that caught the change |
| `90cd7a1` | docs(decisions,epic): D1 and D2 decided and implemented |
| `ab6a760` | test(harness): the gate’s own test asserted styling, not content — §11.9 |
| _(this one)_ | docs(evidence): the CI evidence for this cycle |

### 11.2 Files changed — 18 files, +1428 / −55

**Product code — 11 files.**

```
src/storage/export.ts        +305   D1 detection and refusal, D2 exclusions and source identity
src/storage/import.ts        +124   D2 provenance, exclusion reporting
src/storage/bookkeeping.ts    +46   readLatestRestore
src/storage/schema/provenance.ts  new   the instance_restore Drizzle declaration
src/storage/migrations/0014_instance_restore.sql  new
src/storage/migrator.ts       +17   SchemaReport.restoredFrom
src/storage/index.ts           +5   barrel
src/errors/codes.ts           +12   E_EXPORT_REFUSED
src/cli/exit-codes.ts          +5   its exit mapping
src/cli/commands/export.ts    +69   --strict, disclosures, partial-file removal
src/cli/commands/import.ts    +36   exclusions and both identities on the restore
```

**Tests — 7 files.** Two new (19 tests), five updated.

### 11.3 Security-sensitive changes

**One, and it is the substance of D1.** Export-time redaction no longer
substitutes values.

This is **not** a weakening, and the reviewer should satisfy themselves of each
part: insert-time redaction is untouched (EPIC-087 §8.2 remains the primary
control); the scanner runs over exactly the values it ran over before, via the
same `redactSecrets` oracle, so no surface's redaction behaviour drifts; a match
is now reported in the trailer and printed by the CLI rather than applied; and
`--strict` fails closed with `E_EXPORT_REFUSED`.

**What the reviewer is being asked to accept**, stated plainly: a faithful
export of an index that holds a credential now contains that credential. That is
the trade the decision makes. It was made because the alternative was measured to
be worse — rewriting the value left `content_hash` describing a row that no
longer existed, so a restored index reported *itself* tampered with and
`export | import` scrubbed nothing while reporting success. The document was
already "everything Ferret knows, in cleartext, in one file" (EPIC-089 §4).

`E_EXPORT_REFUSED` maps to the generic error exit rather than a storage exit, on
purpose: the database is healthy and the index intact.

### 11.4 Data-integrity changes

| Change | Effect |
| --- | --- |
| Faithful export | `content_hash` continues to describe the row it labels. `ferret verify` on a restored index reports the index's real condition — measured at 5 false findings before, 0 after. |
| `sameContent` semantics unchanged, but now truthful | An `unchanged` verdict means the document and the row agree on content, not merely on the hash. Asserted directly, not inferred from a count. |
| Provenance is append-only | A second restore does not erase the first — Governance §6. Asserted. |

### 11.5 Migration changes

**One new migration: `0014_instance_restore.sql`** — additive, forward-only,
creates one table and one descending index. Nothing existing is altered, and no
prior migration was edited or renumbered.

Exercised by: `compatibility.test.ts` (upgrade from every version 0 to current,
29 tests), `upgrade-deployment-path.test.ts` (populated **pre-0013** upgrade),
`upgrade-cli.test.ts`, `migrations.test.ts`, `embedding-provisioning.test.ts` —
59 tests, all green. The table is declared in Drizzle, so
`schema-agreement.test.ts` compares its columns against the live schema.

**Behaviour on an older schema is deliberate:** importing into a database at
schema 13 or earlier succeeds, and the report says provenance could not be
recorded and names `ferret upgrade`. The restore is not failed for it.

### 11.6 Backup / export / restore behaviour, as implemented

| Question | Answer |
| --- | --- |
| Does a normal export rewrite values? | No. Never. Asserted three ways, including that no redaction substitution appears anywhere in a document. |
| What happens when the scanner fires? | The row is exported as it is; the finding goes in `ExportTrailer.credentialShaped` and is printed. The finding names the row with the key **redacted**, so it cannot republish what it warns about. |
| Can an operator refuse instead? | `ferret export --strict` gives `E_EXPORT_REFUSED`, no trailer, and the CLI removes the partial file. |
| Are vectors carried? | No. Declared in the manifest's first line with a reason and a recovery, repeated by `ferret import`. |
| Are vectors fabricated? | No. Asserted: 0 rows after a restore, not zero-filled. |
| How are vectors regenerated? | Re-index with an embedding provider. The manifest states that **none ships**, so nothing implies a command that does not exist. |
| Does a restore adopt the source identity? | No. The target keeps its own. Asserted before and after. |
| Is the source identity lost? | No. `manifest.sourceInstanceId` reaches `ferret.instance_restore`, with the document digest, source version, export instant and row count. Surfaced as `SchemaReport.restoredFrom` and printed by `ferret import`. |
| Can two installations share an identity? | Not through the export. Asserted: one document restored into two databases yields two identities, both tracing to the same source. (`pg_dump` copies an identity — that is its semantic, and §8.1 is where it belongs.) |
| A pre-D2 document? | Reported as *not saying* what it omits — never as omitting nothing. |

### 11.7 The four controls that fired

Each is a control this repository built deliberately, and each was answered with
the measurement it asked for rather than adjusted to pass. Worth checking that
the reviewer agrees with all four.

| Control | What it caught | Response |
| --- | --- | --- |
| `schema-agreement` | `instance_restore` neither declared nor exempt | Declared in Drizzle (`schema/provenance.ts`), with the reason the `ferret.instance` exemption does not apply |
| `scale` | a 28th unexercised index | Pin moved 27 to 28, with why it is unexercised *here* and where its reader is exercised |
| `packaging` | the size bound crossed by 0.04% | Bound moved 2 950 000 to 3 040 000, **measured first on both sides** against the pre-cycle tip in a second worktree: +37 311 bytes, attributed per directory in the comment |
| `unit/export` | the fake database's positional call count | The manifest now needs the instance identity before it is written, so two prologue reads; the AC-12 interleaving assertion updated and still pinning the property |

`tests/integration/packaging.test.ts` is therefore **no longer byte-identical to
`main`** — it was in the F-73 cycle. The change is the size bound and its
measurement comment, nothing else.

### 11.8 Validation on this cycle

| Gate | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run build` | pass — 14 migrations shipping |
| **Full suite** | **180/180 files, 3591 passed, 7 skipped, exit 0** |
| Packaging group | **34/34 executed**, asserted by the harness |
| PostgreSQL 17 + pgvector | real server throughout |
| Migration / upgrade incl. pre-0013 | 59 tests green |
| Backup / export / import | `export`, `import`, `backup-fidelity`, `export-cli`, plus the two new suites — 53 tests |
| Security / regression | all 9 `tests/security/*` green |
| Regression pins verified red-first | 3 of the 9 D1 tests confirmed failing against the old behaviour before it was replaced |

### 11.9 CI — run, observed, and it found something local runs could not

**CI was available and was run.** No PR was opened and nothing was merged: the
workflow declares `workflow_dispatch`, so it was dispatched against the branch
directly. No GitHub billing or infrastructure limit was encountered.

| Run | Commit | Result |
| --- | --- | --- |
| [33904857924](https://github.com/indoulia/Ferret/actions/runs/33904857924) | `90cd7a1` | **failure** — 4 of 5 jobs. One cause. |
| [33906098585](https://github.com/indoulia/Ferret/actions/runs/33906098585) | `ab6a760` | **success** — 5 of 5 jobs |

**The first run failed, and the failure is worth reading rather than
skipping.** It failed identically on Ubuntu, Windows, macOS *and* the storage
job while the full suite was green locally — and it was not the D1/D2 work. It
was `required-groups.test.ts`, the F-73 guard's own regression test from the
previous cycle, asserting against Vitest's coloured output.

Vitest colours when it believes the terminal supports it. GitHub Actions is such
a terminal; a redirected local run is not. Coloured, the summary reads `Tests`
then an escape then a styled `2 skipped`, and both halves of
`/Tests\s+[^\n]*\b2 skipped\b/` break on it — `\s+` because what follows
`Tests ` is an escape rather than whitespace, and `\b2` because the character
before the `2` is the `m` ending the escape. The assertion was about styling and
merely agreed with the content on the one platform it was written on. Worse, its
negative twin was passing *vacuously*, so the half meant to guard against a
future Vitest reporting these as failures was guarding nothing.

Fixed in `ab6a760` by stripping ANSI before matching, and verified locally by
forcing colour in the child rather than by waiting for CI. **This is the case
for running CI rather than reasoning about it**, and it is why the previous
cycle's conclusion — reached without any CI run — was premature.

**Final CI results, per job:**

| Job | Result |
| --- | --- |
| storage integration (PostgreSQL 17 + pgvector) | **180/180 files**, packaging 34/34 |
| verify (ubuntu-latest, node 22) | 133 passed \| 47 skipped (180), packaging 34/34 |
| verify (windows-latest, node 22) | 133 passed \| 47 skipped (180), packaging 34/34 |
| verify (macos-latest, node 22) | 133 passed \| 47 skipped (180), packaging 34/34 |
| dependency audit | success |

The 47 skipped *files* on the three `verify` jobs are the database suites, which
`ci.yml` skips there by design (`FERRET_SKIP_DOCKER_POSTGRES=1`) and the
`storage` job owns against a pinned service container — the arrangement
`ci.yml` documents, and the reason a skip there is recorded as a skip rather
than a pass. **The F-73 guard printed `34/34 tests executed` on all four
platforms**, which is the packaging gate confirming itself on hardware this
machine is not.

### 11.10 Operator-level validation

Through the real CLI against PostgreSQL 17 + pgvector, two databases, with a
repository containing a file whose *path* matches an AWS access-key shape.

```
ferret export --strict   E_EXPORT_REFUSED, exit 1, no file left on disk
ferret export            exit 0; five exclusions declared; the vectors recovery
                         statement printed; 4 credential-shape findings named
                         with redacted row keys
in the database          AKIA…567.txt  36ed3a23…9cc7
in the document          AKIA…567.txt  36ed3a23…9cc7      ← identical
ferret import --yes      exclusions repeated; both identities named; provenance
                         recorded in ferret.instance_restore
ferret verify            "No problems found."  exit 0
source instance          48af8e67-f643-4e25-8e4f-7d9c7568eeb4
target instance          c1acef2d-e183-4bb0-97f3-3b8f01917c70   ← different
provenance row           source 48af8e67…, version 0.1.0, 31 rows
vectors in target        0                                      ← not fabricated
```

The line that matters most is `ferret verify` → **"No problems found", exit 0**.
Before D1 the same round trip produced five findings and exit 1, every one of
them naming a cause that was false.

One detail worth noting: the faithful export reported **four** findings from one
credential-shaped path — `entity.attributes`, `entity.canonical_key`,
`evidence.locator` and `evidence.source_id`. That is the same amplification the
original measurement found, and it is why rewriting one string corrupted four
rows.

### 11.11 Remaining non-blocking findings, unchanged

**F-92** (wall-clock budget, environment/load — not a release blocker),
**F-10**, and the P2/P3 deferred set including the Batch 8 record corrections.
None was touched. No forensic audit was reopened.

**Newly *recorded*, not newly found:** when an embedding provider eventually
lands, D2 option **C** — exporting the vectors' inputs so a restore knows what
to re-embed and with which model — becomes worth taking. That is a note in the
decision record, not an open defect: today there is no provider and therefore no
vector to lose.
