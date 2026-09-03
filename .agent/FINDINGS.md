# FINDINGS — triage index

Full evidence: `docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`.
Full triage: `docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`.
All 100 findings were re-verified against `0407618` before being recorded.

## P0 (1) — CLOSED in Batch 1
- **F-01** *(fixed)* history capped at 1 000 commits, watermark advanced to the newest of a newest-first page → permanent silent loss on any larger repository; `--full` cannot recover.

## P1-A — production blockers (24; 18 closed)
Ingestion — **CLOSED in Batch 1**: **F-02** (all branches share one watermark), **F-03** (future-dated commit stalls ingestion for ever), **F-04** (back-dated merge -> parentless stub commits).
Storage/install — **CLOSED in Batch 2**: **F-16** (migrate before pgvector; unrepairable, version lies), **F-17** (backup that import refuses), **F-29** (document-supplied column names interpolated into SQL), **F-30** (DB password to stdout, exit 0).
Untrusted input — **CLOSED**: **F-60** (zip bound trusts the declared size), **F-61** (docx bypasses the bounded reader), **F-95** (undatable commit desyncs the parser, fabricates file entities) in Batch 3; **F-94** (`i18n.logOutputEncoding` reshapes `git log`) in Batch 6.
Truthfulness — **F-05, F-06, F-23, F-24, F-28, F-31 CLOSED** (F-23 in Batch 3, rest in Batch 4). Still open: **F-25** (+**F-25b**) (same-file homonym edges; duplicate open intervals), **F-27** (unresolved references discarded — needs a second symbol write after cross-file resolution).
Boundary — **CLOSED in Batch 5**: **F-32** (trim cut the closing delimiter), **F-64** (containment reached top-level strings of one field only), **F-66** (notice last, under a key no other tool used). One boundary, not three patches: the fence survives truncation, containment recurses and counts, the prose/token line is drawn by shape rather than key name, and untrusted records are contained where they *enter* the pack and answer builders. Six second-order defects found by re-auditing and corrected — see `docs/evidence/FERRET-BATCH-5-PROMPT-INJECTION-BOUNDARY.md` §4.
Enumeration — **CLOSED in Batch 6**: **F-94** (repository-controlled Git configuration
reshapes `git log`; after Batch 3's record marker it produced *silence* — three commits in,
zero out — rather than the fabrication first measured), **F-71** (`FERRET_DATABASE_URL` in
every `git` subprocess). Not two longer lists: the output shape is now *verified* and an
unreadable region makes the page incomplete, and a variable is judged a credential by what it
is as well as by what it is called. Eight second-order defects found by re-auditing and
corrected — a `gpg.program` execution vector, `GIT_CONFIG_GLOBAL`/`_SYSTEM` unstripped,
unredacted stderr on `incomplete.reason`, a one-shape `redactVector`, `PWD` stripped from
every child, two spawners with two policies, a dead barrel export and a credentialled URI in
a shipped comment. See `docs/evidence/FERRET-BATCH-6-CREDENTIAL-AND-SAFETY-ENUMERATION.md`.
Identity: **F-11** (non-address author strings merge distinct humans irreversibly).

## P1-B — deferrable (15; 1 closed)
**F-07**, **F-08**, **F-09**, **F-10**, **F-12**, **F-13**, **F-14**, **F-15**, **F-18**, **F-19**, **F-22**, **F-26**, **F-65**, **F-67**. **F-71 CLOSED in Batch 6.**
Most are unreachable today; fix at the moment their code is wired.

## Infrastructure findings — kept separate, not fixed in any batch (3)
- **F-73** packaging's `beforeAll` exceeds its 300 s hook timeout under contention, skipping all 34 tests inside a single aggregate `skipped` figure. Did not fire in Batch 5's run.
- **F-92** `discovery.test.ts > walks a wide tree within budget` exceeds its 30 s ceiling under full-suite contention; passes in isolation. Did not fire in Batch 5's run.
- **F-101** *(new, Batch 5's run)* `scale.test.ts > scans rather than indexes when the whole table is wanted` — PostgreSQL chose `Index Only Scan using entity_lifecycle_idx` over a sequential scan for `SELECT count(*)` after a full-suite run; passes in isolation both with Batch 5's changes and with them stashed. A visibility-map and statistics artifact, F-92's class. The test asserts a *planner choice*, which is the questionable part: an index-only scan of the whole table is not a wrong plan.

## Demoted to documentation (2)
- **F-20** Session & Agent Memory unreachable — every Epic excludes persistence *by name*; the Epics deliver their scope. Registry note only. **Do not build a store.**
- **F-21** GitHub/Jira ingestion unreachable — every Epic excludes transport and persistence *by name*. Registry note + `PLANNED_COMMANDS`/README. **Do not build `ferret sync`.**

## P2/P3 (60)
Note: F-101 above is new and takes the count of recorded findings to 101.
Groups: documentation drift (highest value) · identity hardening · retention lifecycle · provider platform · audit/observability · session values · benchmark honesty · test integrity · small correctness. Detail in the triage §4.

## Key dependencies
F-03 ⊂ F-04 · F-44 NOT closed by F-17 (per-value redaction kept the control) · F-41 masked by F-42 · F-45 moot until F-16 · F-88 latent on F-63 · F-32+F-64+F-66 one defence (all three CLOSED in Batch 5) · F-30+F-71+F-94 one enumeration (all three CLOSED: F-30 in Batch 2, F-71+F-94 in Batch 6) · F-95+F-96+F-97 one isolation story (all three CLOSED in Batch 3) · F-18+F-19+F-53 one trust story.
