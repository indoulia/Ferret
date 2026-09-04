# F-73 — the release gate reports on tests it did not run

One focused cycle, on the three release blockers left by the forensic pass. No
broad audit was reopened, no finding was re-litigated, nothing was deployed and
nothing was merged.

| Blocker | Outcome |
| --- | --- |
| **F-73** — 34 packaging tests hidden behind a 300 s hook timeout | **Fixed.** Root cause is contention, not the budget. Both halves addressed: the cause, and the reporting. |
| **F-44 / F-45** — backup fidelity | **Investigated, quantified, not implemented.** Two product decisions isolated in `docs/Architecture/EPIC-089-DECISIONS.md`. |
| **Human review** | Prepared. §7. |

**F-72 was fixed as a prerequisite**, because the triage's own §399 says so:
"F-72 must be fixed before F-73 can be judged, and both before the packaging
gate can be trusted on a developer machine."

---

## 1. F-73 — root cause

Three layers, and only the third is what the finding's one-line summary
describes.

### 1.1 The hook's work is irreducible, and it is expensive

`tests/integration/packaging.test.ts` prepares its subject in one file-scope
`beforeAll` with a 300 s budget. Measured on this machine, idle:

| Step | Time | What it does |
| --- | --- | --- |
| `npm pack --json --ignore-scripts` | **2.9 s** | builds the tarball, 1.47 MB |
| `npm install --global --prefix <tmp>` | **29.9 s** | resolves and writes **155 packages, 138 MB** |
| **total** | **~33 s** | |

The install is not incidental. Four of the 34 tests run the *installed* binary
through its generated launcher, which needs the production dependency closure on
disk. Removing it would remove the guarantee, so the cost stays.

### 1.2 Contention multiplies it tenfold — this is the actual cause

The same hook, in a full run alongside the other 177 files, several of which are
themselves spawning `git`, subprocesses and containers:

```
❯ tests/integration/packaging.test.ts (34 tests | 34 skipped) 319836ms
  Error: Hook timed out in 300000ms.
```

**33 s alone, 320 s under contention.** That is a tenfold amplification on a
disk-bound hook, and it is the whole of the defect's precondition. The 300 s
budget is nearly ten times the work; a budget that generous is not the problem,
and raising it would buy one run and lose the next. The finding was recorded as
intermittent because contention is intermittent — it is not.

The existing configuration comment already documented ~4× amplification for
CPU-bound tests at fifty files. At 178 files, on a task bounded by disk rather
than CPU, it is 10×.

### 1.3 Vitest reports a dead hook as *skips*, in the same bucket as deliberate ones

This is the part that made a failed gate look acceptable. Reproduced in isolation
before anything was changed, with a hook that blocks the event loop the way
`execFileSync` does:

```
❯ sync.test.ts (2 tests | 2 skipped) 5011ms
     ↓ sync one
     ↓ sync two
 Test Files  1 failed | 1 passed (2)
      Tests  1 passed | 3 skipped (4)
EXIT=1
```

The exit code was never wrong. What was wrong is the `Tests` line: a suite whose
hook died contributes **skips**, and Vitest has one bucket for "did not run" and
"chose not to run". On the real repository that read as

```
Tests  3366 passed | 41 skipped (3407)
```

— the packaging gate's 34 assertions inside the 41, alongside the 7 genuinely
conditional ones (4 docker, 3 signals) — and it was recorded in Batch 2's
evidence as "**Zero failing tests.**" That sentence is the defect. Nothing in the
output said a required group had not executed, so nothing stopped a reader from
concluding it had.

**So: the cause is contention, and the reason it was survivable is that the
harness had no way to say a required group did not run.** Both are fixed.

---

## 2. F-73 — the fix

Three changes. `packaging.test.ts` itself is **untouched** — no assertion was
relaxed, no budget moved, no test deleted.

### 2.1 The packaging suite stops competing with the suite that starved it — `vitest.config.ts`

Two Vitest projects with distinct `sequence.groupOrder`: `suite` (everything
else) at `0`, `packaging` (one file) at `1`. Projects sharing a group order run
together; different orders run lowest to highest. The expensive hook therefore
runs alone, after the rest.

This is the root-cause fix, and it is not a timeout increase — the budget is
still 300 s against 33 s of work. `npm test` is still one command and CI is
unchanged.

### 2.2 A required group that did not execute fails the run, by name — `tests/required-groups.ts`

A reporter registered at root level, holding one declared group: the packaging
suite, with the guarantee it carries. At the end of a run it judges that group
and fails the run when it did not execute, naming the cause:

```
⎯⎯⎯⎯⎯⎯ Required test groups did not execute ⎯⎯⎯⎯⎯⎯

 tests/integration/packaging.test.ts
   34 of 34 tests did not execute (0 passed, 0 failed)
   cause: Hook timed out in 300000ms.
   unverified: the shipped bytes carry no credential, the tarball is
               reproducible, and the installed package starts

A skipped test is not a passing test. This run is reported as failed.
```

On success it makes the positive statement the summary never did — `✓ required
group tests/integration/packaging.test.ts — 34/34 tests executed` — because "no
failures" and "the gate ran" are different claims and only the first was ever
printed.

Two failure modes, deliberately treated differently:

- **The group ran, its tests did not.** Vitest already exits non-zero; what was
  missing was a statement of which guarantee went unverified.
- **The group was not collected at all.** Nothing fails, because nothing ran.
  This is caught too — but only for a *whole* run. A narrowed run
  (`vitest run tests/unit`, `--changed`, `-t <pattern>`) is narrower by request,
  and a guard that failed those would be switched off within a day, which is the
  usual way a gate stops being one. Whatever *did* run is held to full execution
  either way.

`process.exitCode` is set after Vitest has already decided its own — verified
against `cli-api`, where the only assignments raise it and none clears it.

### 2.3 F-72 — the suite packs what the suite built — `tests/global-setup.ts`

`global-setup` ran `tsc` and `copy-migrations`; `npm run build` also runs
`copy-grammars` and `copy-datasets`. So `packaging.test.ts` asserted that the
tarball ships four tree-sitter grammars and the golden dataset **against
whatever a previous build had left in `dist/`** — spuriously failing on a clean
tree, and proving stale bytes on a dirty one. All three asset steps now run.
`clean` deliberately does not: the guarantee is that what the suite packs is
what the suite built, not that it rebuilds from nothing.

---

## 3. Proof that the 34 packaging tests execute

### 3.1 The failure, reproduced on the real module before and after

Not only in a fixture. The real `beforeAll`, with its budget temporarily
shortened to 5 s and then restored (`packaging.test.ts` is unmodified in the
diff — verified with `git diff --quiet`):

```
 Test Files  1 failed (1)
      Tests  34 skipped (34)

⎯⎯⎯⎯⎯⎯ Required test groups did not execute ⎯⎯⎯⎯⎯⎯
 tests/integration/packaging.test.ts
   34 of 34 tests did not execute (0 passed, 0 failed)
   cause: Hook timed out in 5000ms.
EXIT=1
```

`Tests 34 skipped (34)` — zero failing tests, the exact shape that was read as
green — now followed by a block that names it.

And the same condition arose **for real, unprovoked**, in the full run taken
before the scheduling fix: `Hook timed out in 300000ms`, file duration
319 836 ms, `Tests 1 failed | 3536 passed | 41 skipped`, exit 1 with the block
printed. F-73 is not intermittent on this machine; it is reliable.

### 3.2 The 34 tests executing

```
 ✓ |packaging| tests/integration/packaging.test.ts (34 tests) 36730ms
 Test Files  178 passed (178)
      Tests  3571 passed | 7 skipped (3578)
 ✓ required group tests/integration/packaging.test.ts — 34/34 tests executed
```

Three things in that output are the proof, and the third is the one worth
naming:

1. `(34 tests)`, not `(34 tests | 34 skipped)`.
2. `36 730 ms` — the hook doing its 33 s of work with no contention, inside a
   300 s budget it now has ten times the headroom for.
3. **The skip count fell from 41 to 7.** Seven is the number Batch 3 predicted
   for a run where F-73 does not fire — four docker cases and three signals
   cases. The 34 moved into `passed`. Skipped and passed are now different
   numbers describing different things, which is what the requirement asked for.

---

## 4. Full validation results

| Gate | Result |
| --- | --- |
| `npm run lint` | **pass** (exit 0) |
| `npm run typecheck` | **pass** (exit 0) |
| `npm run build` | **pass** (exit 0) |
| Full suite, normal conditions | **178/178 files, 3571 passed, 7 skipped, exit 0** |
| Full suite, loaded conditions | §4.2 |
| Packaging tests executed | **34/34**, asserted by the harness, not by a reading of the summary |
| PostgreSQL 17 + pgvector | Real server throughout — the whole storage suite, `migrations`, `compatibility`, `schema-agreement`, `init-cli`, `upgrade-cli`, `backup-fidelity`, `embedding-provisioning` |
| Migration / upgrade | Inside the above; `upgrade` and `embedding-provisioning` green |
| Security / regression | `tests/security/*` (9 files) green, including `injection-boundary`, `credential-surface`, `credential-containment`, `credential-isolation`, `git-output-integrity`, `control-reachability` |
| New regression test | `tests/integration/required-groups.test.ts` — 5 tests, green |

### 4.1 Before and after, same machine, same tree apart from the fix

| | Before | After |
| --- | --- | --- |
| Test files | 2 failed \| 176 passed | **178 passed** |
| Tests | 1 failed \| 3536 passed \| **41 skipped** | 3571 passed \| **7 skipped** |
| Packaging | 34 skipped, hook timed out at 300 s | **34 passed** in 36.7 s |
| Duration | 481 s | **359 s** |
| Exit | 1 | **0** |

The 25% drop in wall-clock while running one file serially is corroboration
rather than a bonus: the contention was real and the whole suite was paying for
it. The other pre-existing failure — `discovery.test.ts > walks a wide tree
within budget`, which is **F-92**, open and untouched — also passed. That is
consistent with the same cause and is **not** claimed as fixed: F-92 is recorded
as intermittent and one green run does not close it, exactly the reasoning the
final audit applied to F-73 itself.

### 4.2 Under load

**The "previously failing loaded condition" is §4.1.** On this machine the full
suite *is* the load that broke F-73 — it reproduced the 300 s hook timeout
unprovoked, twice in the forensic pass and again here. That condition is now
green.

So this section is a stress run *beyond* it: the full suite with eight CPU
spinners and a process rewriting 64 MB in a loop, for the whole run, on a
16-core machine. Deliberately harsher than anything CI does.

```
 ✓ |packaging| tests/integration/packaging.test.ts (34 tests)
 Test Files  4 failed | 174 passed (178)
      Tests  3 failed | 3568 passed | 7 skipped (3578)
   Duration  546.21s
 ✓ required group tests/integration/packaging.test.ts — 34/34 tests executed
EXIT=1
```

**This run is not green, and that is reported rather than smoothed over.** Four
files failed. Every one is a database test starved past its budget by the
synthetic load:

| File | Failure |
| --- | --- |
| `diagnostics/health-database.test.ts` | `afterAll` (`db.drop()`) timed out at 90 s |
| `storage/compatibility.test.ts` | one of 29 version-upgrade cases timed out at 120 s |
| `storage/init-cli.test.ts` | timed out at 90 s |
| `storage/upgrade-cli.test.ts` | timed out at 180 s |

Three things about that list are the actual result:

1. **Packaging executed 34/34 anyway** — under load eight times harsher than the
   condition that used to kill it, because it no longer runs while the suite is
   running.
2. **Every starved test failed by name.** Three failed tests and one failed
   suite, with the file, the test and the budget in the output. That is the
   opposite of F-73: a starved test that fails loudly is the behaviour this
   cycle was asked to produce.
3. **The skip count stayed at 7.** Not one starved test became a skip. Skipped
   and did-not-run are no longer the same number.

These four are not new defects and are not claimed as passing: they are the same
class as F-92 and F-101 — timing budgets on a contended machine — and they are
what the harness now looks like when it is genuinely overloaded. No conclusion
is drawn from this run about the product.

### 4.3 Narrowed runs still work

```
npm run test:unit → 90 files, 2199 passed, exit 0
 ✓ required group tests/integration/packaging.test.ts — not selected by this filtered run
```

Checked because the guard could plausibly have broken the fast iteration loop,
and a gate that breaks the loop gets switched off.

### 4.4 What is not claimed

- **The packaging hook can still overrun** if something starves it hard enough.
  What changed is that it can no longer do so *silently*, and that it is no
  longer being starved by Ferret's own suite.
- **F-92 and F-101 remain open.** Neither was touched.
- **Nothing here is a claim about release readiness.** §8.

---

## 5. The F-44 / F-45 decision required

Full engineering evidence and the decision record:
[`docs/Architecture/EPIC-089-DECISIONS.md`](../Architecture/EPIC-089-DECISIONS.md).
Both were measured through the real CLI against PostgreSQL 17 + pgvector. **No
code was changed for either.**

Summary of what was measured:

- **Exported:** 9 of the schema's 13 tables. `schema_migrations` and
  `schema_migration_failures` are correctly omitted. **`embedding` and
  `instance` are not.**
- **Vector loss: 100%, unconditional.** Denominator today is **0 rows**, because
  no `EmbeddingProvider` implementation exists anywhere in `src/`. The loss
  becomes total the day one is wired.
- **Instance identity:** not preserved and not reported; a restore keeps the
  identity `ferret init` minted for the target.
- **Redaction:** `redactSecrets` is idempotent, so the export-time pass changes a
  value only where a producer omitted insert-time redaction. A file path is one
  such field. `AKIAAAAAAAAAAAAAAAAA.txt` exports as
  `[redacted: aws-access-key-id].txt` **under the original `content_hash`**.
- **Consequence:** `ferret verify` on the restored index reports **five
  findings** — 1 `identity-mismatch`, 2 `content-hash-mismatch`, 2
  `evidence-tampered` — and every one names a cause that is false, with a
  remediation ("re-read from source") that is unavailable in the only case a
  restore exists for.
- **Consequence:** re-import into the original index reports `9 unchanged,
  0 written` and scrubs nothing, so **EPIC-090 §8.7's named scrubbing mechanism
  does not work as written**.

**The decisions required are exactly two**, and they are stated with options and
consequences in the record:

- **D1** — Are exported backups expected to preserve usable, unrewritten
  content? The *direction* is determined by Governance §6, EPIC-087 §8.2,
  EPIC-089 §8.5 and EPIC-090 §8.7, which all say an export must not silently
  rewrite. The *remedy* is not: four options, three of which move the security
  posture of a document EPIC-089 §4 already flagged as cleartext-in-one-file.
- **D2** — Are vectors part of backup fidelity, and should a restore preserve or
  mint instance identity? Genuinely undetermined: EPIC-089 §3's scope list omits
  both while §1 promises "everything Ferret knows", and instance identity has no
  contract text at all.

These were not guessed at, and the reason is recorded: option A for D1 removes a
security control, and choosing to do that is not an engineering call.

---

## 6. Scope actually touched

```
 M tests/global-setup.ts                            F-72, 8 lines
 M vitest.config.ts                                 F-73, projects + reporter
 A tests/required-groups.ts                         F-73, the guard
 A tests/integration/required-groups.test.ts        F-73, the regression test
 A tests/fixtures/required-groups/                  F-73, the harness fixture
 A docs/Architecture/EPIC-089-DECISIONS.md          F-44/F-45, decision record
 A docs/evidence/FERRET-F73-RELEASE-GATE-INTEGRITY.md  this record
```

No source file under `src/` was modified. `tests/integration/packaging.test.ts`
is byte-identical to `main`. No unrelated cleanup, no formatting pass, no
finding reopened.

---

## 7. For human review

**Security-sensitive changes: none to the product.** Nothing under `src/`
changed, so the shipped bytes are identical to `main` apart from the version
already there. The security-*relevant* change is that the packaging gate — which
scans the shipped bytes for credential shapes — now cannot be reported as
acceptable without having run. That is a strengthening, and it is the point.

**Migrations: none.** No file under `src/storage/migrations/` was touched.

**Backup / restore changes: none.** F-44 and F-45 were investigated and left
open by instruction. `src/storage/export.ts` and `src/storage/import.ts` are
unmodified.

**The three things worth a reviewer's attention:**

1. **`vitest.config.ts` moves to Vitest projects.** This is the largest change
   and the one most likely to have a subtle consequence. It was validated by a
   complete run against a real database — 178 files, 3571 tests — plus lint,
   typecheck and build. Worth checking: `globalSetup` stays at root and its
   `provide` still reaches project tests (proved by the whole storage suite
   passing), and root-level `reporters` are the ones consulted.
2. **The guard sets `process.exitCode` from a reporter.** Unusual, deliberate,
   and verified against Vitest's own exit logic rather than assumed. If a future
   Vitest starts reporting a dead hook's tests as *failed* rather than *skipped*,
   the second test in `required-groups.test.ts` fails on purpose, so the guard
   can be reconsidered on evidence instead of removed on a guess.
3. **The guard does not enforce presence on a narrowed run.** A deliberate hole,
   with its reasoning in the code. A reviewer who disagrees should say so: the
   alternative is that `npm run test:unit` fails for not running the packaging
   suite.

**Evidence linked to each finding:**

| Finding | Change | Test |
| --- | --- | --- |
| F-73 (cause) | `vitest.config.ts` — projects, `groupOrder` | Full run §3.2, §4.1 |
| F-73 (reporting) | `tests/required-groups.ts` | `required-groups.test.ts`, 5 tests; real-module reproduction §3.1 |
| F-72 | `tests/global-setup.ts` | `packaging.test.ts` grammar and dataset assertions, now against what the suite built |
| F-44 | none — decision required | `EPIC-089-DECISIONS.md` D1, measured round trip |
| F-45 | none — decision required | `EPIC-089-DECISIONS.md` D2, measured round trip |

---

## 8. Is the branch release-ready?

**Technically, for what this cycle owned: yes.** Lint, typecheck, build and the
complete suite against a real PostgreSQL are green; the packaging gate
demonstrably executes all 34 of its assertions and the harness now asserts that
rather than leaving it to be read; no required test is merely skipped.

**Release-ready overall: no, and two things are outstanding rather than done.**

1. **Human review** of this branch. Not substitutable, not attempted here.
2. **The D1 and D2 product decisions.** Until D1 is answered, `ferret export`
   writes a document whose restore reports itself tampered and whose hashes do
   not describe its rows. That is a defect in the recovery path, and the
   recovery path is the feature. Whether it blocks a release is a call for
   whoever owns the release, with the measured consequences in front of them —
   it is not a call this cycle should make quietly.

F-92 and F-101 remain open and untouched. Nothing was deployed and nothing was
merged.
