# FINDINGS — triage index

Full evidence: `docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`.
Full triage: `docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`.
All 100 findings were re-verified against `0407618` before being recorded.

## P0 (1) — CLOSED in Batch 1
- **F-01** *(fixed)* history capped at 1 000 commits, watermark advanced to the newest of a newest-first page → permanent silent loss on any larger repository; `--full` cannot recover.

## P1-A — production blockers (24; 22 closed, 1 partial, 1 OPEN)
> Re-verified at `cd3ca85` with every batch present — see
> `docs/evidence/FERRET-POST-FORENSIC-FINAL-AUDIT.md` §3.
>
> **The count changed in the record correction at `8faa0c1`+.** F-23 was carried as CLOSED
> from Batch 3 onwards. It is not closed and never was: no batch modified
> `src/parsers/sheet/xlsx.ts` (`git log 0407618..HEAD -- src/parsers/sheet/xlsx.ts` is
> empty), and the finding's mechanism is that file's `readSheet`. Corrected to OPEN below,
> with the evidence, rather than left as an unsupported claim.
Ingestion — **CLOSED in Batch 1**: **F-02** (all branches share one watermark), **F-03** (future-dated commit stalls ingestion for ever), **F-04** (back-dated merge -> parentless stub commits).
Storage/install — **CLOSED in Batch 2**: **F-16** (migrate before pgvector; unrepairable, version lies), **F-17** (backup that import refuses), **F-29** (document-supplied column names interpolated into SQL), **F-30** (DB password to stdout, exit 0).
Untrusted input — **CLOSED**: **F-60** (zip bound trusts the declared size), **F-61** (docx bypasses the bounded reader), **F-95** (undatable commit desyncs the parser, fabricates file entities) in Batch 3; **F-94** (`i18n.logOutputEncoding` reshapes `git log`) in Batch 6.
Truthfulness — **F-05, F-06, F-24, F-28, F-31 CLOSED** (Batch 4).

**F-23 — OPEN. Not closed in Batch 3 or in any batch.** A corrupt spreadsheet is still
reported as a successful parse of an empty one, and the content gate still caches that result
permanently. Evidence, all of it from the source rather than from a report:

- `git log 0407618..HEAD -- src/parsers/sheet/xlsx.ts` returns **nothing**. No batch touched
  the module the finding is about. Batch 3 changed `src/parsers/sheet/zip.ts` — the archive
  bound, which is F-60 — and `sheet-parser.test.ts` for that.
- `readSheet` (`xlsx.ts:237-271`) is still the regex scanner the finding cites at `:243`,
  `:247` and `:270`, with no validity check. A truncated, garbage or non-XML worksheet part
  still yields zero rows and the same return shape as a genuinely empty sheet.
- Neither half of the triage's remedy is present: no refusal for a part with no recognisable
  root, and no warning when a present part yields zero rows.

**Why the earlier evidence note was itself wrong.** The final audit at `8faa0c1` recorded
F-23 as "closed, evidence chain broken", citing `sheet-parser.test.ts:182` — the AC-9 test
that a missing `xl/workbook.xml` is refused by name. That test is real and passes, but it is
**not** evidence for this finding: the finding's own text says *"Only a missing
`xl/workbook.xml` throws (`:80-88`)"* and names that as the pre-existing behaviour the rest
of the module fails to match. Citing it conflated the one case that already worked with the
five that did not. Corrected here.

Severity unchanged: **P1-A, silent permanent omission.** Not fixed, and deliberately not
fixed in this record-correction task.
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
Code intelligence and identity — **CLOSED in Batch 7**: **F-25** (a member call resolved to a
same-file homonym at the top confidence band; the receiver now corroborates, so `this.has()`
resolves and `map.has()` does not), **F-25b** (`line` removed from edge identity, and the
indexer closes what a re-derived endpoint no longer asserts), **F-27** (per-file resolution
counts persisted on the `file` entity — *persistence only*; the read-side notice on
`ferret_neighbours` is **not** delivered — see the F-27 entry below), **F-11** (an
address that is not an address mints no actor; the commit records `unattributedAuthor`
instead, after the mailmap rather than before it). Six second-order defects found by
re-auditing and corrected — see `docs/evidence/FERRET-BATCH-7-CODE-INTELLIGENCE-TRUTH.md` §4.

**F-27 — PARTIALLY CLOSED. Not CLOSED.** The two halves are recorded separately because they
have different statuses and only one is done:

- **Persistence half — CLOSED and verified.** `FileReferenceResolution` (extracted, resolved,
  and unresolved by reason) is written onto the `file` entity, replayed through the re-parse
  gate so an unchanged second run writes no rows, and asserted end to end against a real
  database by `tests/integration/indexing/reference-intervals.test.ts` — "records the file's
  resolution counts, rather than logging and dropping them", "names the reasons, so 'refused'
  and 'not there' stay apart", and "survives a gate skip, so a second run still writes no rows".
- **Read / presentation half — OPEN.** `ferret_neighbours` can still return an empty inbound
  list with no completeness caveat, so "nothing references this" and "we refused to resolve
  the references that would have answered you" remain the same answer at the tool surface.
  Verified at `cd3ca85`: `referenceResolution` appears nowhere under `src/mcp/`,
  `src/retrieval/` or `src/context/`, and the depth-1 neighbours response carries
  `count`, `truncated`, `withheld` and no resolution field.

Follow-on work, not repaired here. The counts a notice would need are already persisted and
readable, so what remains is presentation rather than measurement.

## P1-B — deferrable (15; 1 closed)
**F-07**, **F-08**, **F-09**, **F-10**, **F-12**, **F-13**, **F-14**, **F-15**, **F-18**, **F-19**, **F-22**, **F-26**, **F-65**, **F-67**. **F-71 CLOSED in Batch 6.**
Most are unreachable today; fix at the moment their code is wired.

## Infrastructure findings — kept separate, not fixed in any batch (3)
> **None reproduced in the final audit run** — packaging ran all 34 tests, the wide-tree walk
> passed, and `scale.test.ts` passed. All three stay **OPEN**: a passing run does not disprove
> an intermittent condition.
- **F-73** packaging's `beforeAll` exceeds its 300 s hook timeout under contention, skipping all 34 tests inside a single aggregate `skipped` figure. Did not fire in Batch 5's run.
- **F-92** `discovery.test.ts > walks a wide tree within budget` exceeds its 30 s ceiling under full-suite contention; passes in isolation. Did not fire in Batch 5's run.
- **F-101** *(new, Batch 5's run)* `scale.test.ts > scans rather than indexes when the whole table is wanted` — PostgreSQL chose `Index Only Scan using entity_lifecycle_idx` over a sequential scan for `SELECT count(*)` after a full-suite run; passes in isolation both with Batch 5's changes and with them stashed. A visibility-map and statistics artifact, F-92's class. The test asserts a *planner choice*, which is the questionable part: an index-only scan of the whole table is not a wrong plan.

## Demoted to documentation (2) — both still OPEN as documentation work
- **F-20** Session & Agent Memory unreachable — every Epic excludes persistence *by name*; the Epics deliver their scope. Registry note only. **Do not build a store.**
- **F-21** GitHub/Jira ingestion unreachable — every Epic excludes transport and persistence *by name*. Registry note + `PLANNED_COMMANDS`/README. **Do not build `ferret sync`.**

**Neither remedy has been applied.** `PLANNED_COMMANDS` is `[]`
(`src/cli/commands/planned.ts:49`), so `program.ts:96` adds no planned command and nothing in
the CLI advertises a capability as forthcoming. What the evidence establishes, stated so the
gap is not mistaken for either a defect or a delivery:

- **Reachable and shipped:** fourteen commands, registered at `src/cli/program.ts:82-95` —
  `version`, `config`, `doctor`, `env`, `index`, `init`, `mcp`, `status`, `verify`,
  `prune`, `export`, `import`, `reconcile`, `upgrade`. Each is exercised by the suite.
- **Library-only, and correctly so:** the GitHub and Jira providers, project modelling
  (EPIC-072), event and webhook verification (EPIC-077), and the session and memory modules
  (EPIC-039–043). Each is real, tested and reachable *as a module*; none has transport,
  persistence or a client surface, and each Epic excluded those **by name**. They are not
  half-built features — they are the scope their Epics declared.
- **The gap is the absence of a statement, not of code.** Nothing tells an operator that
  GitHub ingestion or session memory is not wired, because the mechanism intended to say so
  (`PLANNED_COMMANDS`) is empty and the registry notes were never written.

That work is **Batch 8 — record correction, no code**, and it is unstarted. Writing entries
into `PLANNED_COMMANDS` is documentation; building `ferret sync`, a session store, transport
or client wiring is **not** in scope for it and was explicitly ruled out by the triage.

## P2/P3 (60)
Note: F-101 above is new and takes the count of recorded findings to 101.
Groups: documentation drift (highest value) · identity hardening · retention lifecycle · provider platform · audit/observability · session values · benchmark honesty · test integrity · small correctness. Detail in the triage §4.

## Key dependencies
F-03 ⊂ F-04 · F-44 NOT closed by F-17 (per-value redaction kept the control) · F-41 masked by F-42 · F-45 moot until F-16 · F-88 latent on F-63 · F-32+F-64+F-66 one defence (all three CLOSED in Batch 5) · F-30+F-71+F-94 one enumeration (all three CLOSED: F-30 in Batch 2, F-71+F-94 in Batch 6) · F-95+F-96+F-97 one isolation story (all three CLOSED in Batch 3) · F-18+F-19+F-53 one trust story.
