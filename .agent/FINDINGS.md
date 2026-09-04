# FINDINGS — triage index

Full evidence: `docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`.
Full triage: `docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`.
All 100 findings were re-verified against `0407618` before being recorded.

**Statuses below describe the combined remediation tree at
`c696dacff7e9b0ea57329b5b106367764d544ff2`, branch `integration/p1a-remediation`** — the first
ref that has ever held both the forensic branch's seven batches and F-23, validated as one tree.
`main` is `0407618` and contains **none** of these fixes. See "Where the remediation lives",
below.

## P0 (1) — CLOSED in Batch 1
- **F-01** *(fixed)* history capped at 1 000 commits, watermark advanced to the newest of a newest-first page → permanent silent loss on any larger repository; `--full` cannot recover.

## P1-A — production blockers (24; **24 closed**)
> **Roster and count reconciled at `c696dac6`.** The authoritative severity assignment is the
> triage's own §9 table — 25 blockers, 1 P0 + **24 P1-A** — and the roster below is that table,
> enumerated so the count and the rows agree. Two long-standing record defects are corrected
> here without changing what any finding means:
>
> - **F-71 was listed under both P1-A and P1-B.** The triage classifies it **P1-B**
>   (`FERRET-POST-FORENSIC-TRIAGE.md:13` — "F-65, F-67, F-71 → P1-B") and it is absent from the
>   §9 blocker table. It is P1-B, listed once, below. Its closure in Batch 6 is unaffected.
> - **F-94 appeared twice**, under "Untrusted input" and again under "Enumeration". One finding,
>   one entry. It is a member of both the untrusted-input bound and the credential/safety
>   enumeration, and the dependency line at the foot of this file already records that.
>
> **F-96 and F-97 are not P1-A.** The triage rates them P2 (small correctness, §384-385) and
> promoted them into Batch 3 because they are the same defect class as F-95. They were closed
> there; they are recorded in the P2 group, not here. The final audit's §3 table listed them
> under a P0/P1-A heading, which is corrected in that document.

The 24, by the triage's own grouping, all **CLOSED**:

| Group | Findings | Closed by |
| --- | --- | --- |
| Ingestion completeness | F-02, F-03, F-04 | Batch 1 |
| Backup and recovery | F-17, F-29 | Batch 2 |
| Install integrity | F-16 | Batch 2 |
| Credential exposure | F-30 | Batch 2 |
| Untrusted-input bounds | F-60, F-61, F-95 | Batch 3 |
| | F-94 | Batch 6 |
| Answer truthfulness | F-05, F-06, F-24, F-28, F-31 | Batch 4 |
| | F-25, F-25b, F-27 | Batch 7 (F-27's read half at `c696dac`) |
| | F-23 | `896bcaa` |
| Prompt-injection boundary | F-32, F-64, F-66 | Batch 5 |
| Identity integrity | F-11 | Batch 7 |

3 + 2 + 1 + 1 + 4 + 9 + 3 + 1 = **24**. Rows and count agree.

Detail on each group is unchanged from the batch records: Batch 1 ingestion; Batch 2
storage/install; Batch 3 untrusted input; Batch 4 truthfulness; Batch 5 the injection boundary
as one defence rather than three patches; Batch 6 credential and safety enumeration judged by
what a thing is rather than what it is called; Batch 7 code intelligence and identity. Each
batch's evidence file records its red-first fixtures and its second-order defects.

**F-23 — CLOSED at `896bcaa05c889c2de6af9c67db364121bcd61217`.** It was carried as CLOSED from
Batch 3 onwards without a line of code having changed, corrected to OPEN in the record
correction at `8faa0c1`+, and is now closed for real. What the commit does, and the evidence:

- `rootStructure` (`src/parsers/sheet/xlsx.ts:181-186`) checks a part is the document it claims
  to be **before** the regex scanner reads it — opening root, and the closing tag too, so
  *"this is not a worksheet"* (`unreadable-sheet`) and *"this worksheet did not finish
  arriving"* (`truncated-sheet`) stay different facts. A self-closing root is the one form
  excused from a closing tag.
- `xl/workbook.xml` had the same hole one level up: §8.5 refused an *absent* part, and a part
  that was present but was not a workbook walked past that refusal into a successful parse of
  zero sheets. It now takes the existing refusal path, naming the part.
- **The parser version moved `1.0.0` → `1.1.0`** (`src/parsers/sheet/provider.ts:39`), and that
  is not bookkeeping: the silently-empty extractions are cached artefacts, and EPIC-031
  re-extracts when producer identity moves. The chain is two links, both asserted —
  `sheet-corruption.test.ts` pins the version off `1.0.0`, and `content-gate.test.ts:264`
  ("re-reads when the parser version changed — AC-7") drives exactly `1.0.0 → 1.1.0`.
- **Regression coverage: 15 new cases** in `tests/unit/sheet-corruption.test.ts` — not a
  worksheet, not XML at all, empty part, cut off mid-file, the sheet named in the warning,
  sibling sheets still read, prefixed roots accepted, and the corrupt-workbook cases through
  the parser framework. **45 focused sheet tests green** (15 new + 30 existing
  `sheet-parser.test.ts`), independently re-run.
- A genuinely empty sheet stays warning-free. Zero rows is an answer, and the control asserting
  so is what keeps the caveat meaningful.

One departure from the triage's prescribed remedy is recorded rather than glossed: it asked to
*"refuse a part with no recognisable root; **warn when a present part yields zero rows**"*, and
only the first shipped — a warning on every empty sheet is the always-on caveat F-66 already
taught us not to add. The residual that the second half would also have caught is recorded
separately as **F-102**, below.

**F-27 — CLOSED. Both halves, and they were closed in two different batches.** It is recorded
as two halves because that is how it was delivered and because the second half is the one that
carried the harm:

- **Persistence half — Batch 7 (`cd3ca85`).** `FileReferenceResolution` (extracted, resolved,
  and unresolved by reason) written onto the `file` entity, replayed through the re-parse gate
  so an unchanged second run writes no rows, and asserted end to end against a real database by
  `tests/integration/indexing/reference-intervals.test.ts`.
- **Read / presentation half — `c696dac` on this branch.** Persisting a measurement nobody reads
  leaves the dangerous answer exactly as dangerous. `NeighbourResult` and `TraversalResult` now
  carry a `ReferenceCompleteness`, aggregated by the store from those persisted counts, bounded
  by the subject's repository and by the caller's scope grants; `ferret_neighbours` renders it
  on both the depth-1 and depth>1 branches.

**The false-completeness regression, and its result.** The defect was that `count: 0`,
`truncated: false` and `withheld: 0` — three fields that between them *assert an answer is
whole* — were returned over a graph Ferret had declined to finish resolving. That was
reproduced before any implementation and is now green:

- Tool surface (`tests/integration/mcp/tools.test.ts`): **6 of 7 assertions red**, the first
  reading `an empty reference answer carried no completeness at all: expected undefined to be
  defined`. The one green was the noise control — a verdict must *not* appear on a question that
  is not about references — which correctly passes on both sides.
- Real store, real PostgreSQL, real `git`, real grammars
  (`tests/integration/indexing/reference-intervals.test.ts`): **2 of 4 red**, the two defect
  cases. The other two are controls (noise, and read idempotency across a second index run) and
  are not claimed as red-first.
- Green after, and re-verified in the final combined run.

**The five states are kept apart, which is the property the finding is really about:**

| State | How the surface says it |
| --- | --- |
| genuinely no relationships | `count: 0` with `references.completeness: "complete"` |
| unresolved references | `completeness: "incomplete"` + `unresolved.{total, refused, byReason}` |
| withheld relationships | `withheld: n` — unchanged, EPIC-058 |
| truncated results | `truncated: true` + `more` — unchanged, F-28 |
| unmeasured completeness | `completeness: "unknown"`, `filesMeasured: 0` — never `complete` |

`unknown` is a third verdict rather than a shading of `complete`: an index built before F-27, or
one whose content stage never ran, has earned no verdict, and issuing a clean bill of health it
never sat for would be this same finding one layer along.

The verdict is derived from the **reasons**, not the total, and that is the part worth arguing.
`ambiguous`, `receiver-unknown` and `imported` are refusals over candidates Ferret holds, so any
one could have been the missing edge — `imported` most of all, since an import names a symbol
the repository very probably declares and §8.4 does not follow it. Only `not-found` is a true
absence: no declaration Ferret holds carries the name, so it cannot be a missing edge to one.
Counting it would mark every honest index incomplete for referring to `console.log`. Every
reason is still reported; the derivation is Ferret's and the numbers let a caller disagree.

Two second-order defects found by re-auditing the fix, both corrected: a comment claiming a
drift-guard test that did not exist (now written — `code-reference-truth.test.ts` asserts the
duplicated edge-type strings equal the registered names, and that every `UnresolvedReason` is
deliberately a refusal or an absence), and a verdict computed on every unfiltered traversal,
which is the default path — now gated on the subject being an end of a reference edge.

## P1-B — deferrable (15; 1 closed, 14 open)
**F-07**, **F-08**, **F-09**, **F-10**, **F-12**, **F-13**, **F-14**, **F-15**, **F-18**,
**F-19**, **F-22**, **F-26**, **F-65**, **F-67** — 14, all open.
**F-71 — P1-B, CLOSED in Batch 6.** This is its single classification: the triage assigns it
P1-B (`FERRET-POST-FORENSIC-TRIAGE.md:13`) and the §9 blocker table does not list it. It was
previously also carried under P1-A, which double-counted it; that entry is removed and its
severity is unchanged. 14 + 1 = **15**.
Most of the open 14 are unreachable today; fix at the moment their code is wired.

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

## Candidates — recorded, unclassified, outside the remediation set (1)

**F-102 — namespace-prefixed SpreadsheetML reads as an empty spreadsheet.** *(new; takes the
count of recorded findings to 102.)*

**Severity: unassigned. Deliberately not P1-A**, and not part of the closed set above.

`rootStructure` accepts a prefixed root (`<x:worksheet>`, `<x:workbook>`) so that legitimate
prefixed workbooks are not refused — the right call, and F-23's own test file records the
consequence verbatim: the extractors one level down are not prefix-aware
(`xlsx.ts:197` `/<sheet/`, `:295` `/<row/`, `:300` `/<c/`), so the structural guard says
"this is a valid worksheet" and the extractor then reads nothing from it.

**Code reachability: proved, not inferred.** Executed against the built parser at `896bcaa`:

| Case | Result |
| --- | --- |
| `<x:workbook>`/`<x:sheet>` + `<x:worksheet>`/`<x:row>` | `{"sheets":[],"truncated":false,"warnings":[]}` |
| `<workbook>`/`<sheet>` + `<x:worksheet>`/`<x:row>`, one real cell | `{"sheets":[{"name":"Q1","rows":[],"cellCount":0}],"truncated":false,"warnings":[]}` |
| control — the corrupt worksheet F-23 fixes | `warnings:[{"code":"unreadable-sheet", ...}]` ✓ |

The first two are F-23's exact signature — real data, zero rows, zero warnings, cached — on
files that are **not corrupt**.

**Not a regression from F-23.** The gap pre-dates it; `sheet-corruption.test.ts` documents it in
a doc comment rather than concealing it. One asymmetry is recorded honestly: for the second case
a *stricter* fix with no prefix tolerance would have warned, so the tolerance trades that
hypothetical warning against refusing genuine prefixed files.

**Why severity is unassigned.** Code reachability is proved; **input** reachability is not.
Excel, SheetJS and Apache POI all emit unprefixed SpreadsheetML. Classifying it needs: (i) a
survey of `.xlsx` producers in the target corpus — ERP/reporting exporters and XSLT pipelines
are the plausible sources; (ii) a scan of `datasets/` and any real corpus for a prefixed root;
(iii) a decision on whether "silently empty on a file we chose not to refuse" is acceptable at
all — if it is not, the triage's unshipped F-23 remedy half (*warn when a present part yields
zero rows*) is the cheaper and more general fix than prefix-aware regexes.

**Not implemented, and out of scope for the integration and F-27 batch.** No XLSX file was
touched by that work.

## P2/P3 (60)
Groups: documentation drift (highest value) · identity hardening · retention lifecycle · provider platform · audit/observability · session values · benchmark honesty · test integrity · small correctness. Detail in the triage §4.

## Key dependencies
F-03 ⊂ F-04 · F-44 NOT closed by F-17 (per-value redaction kept the control) · F-41 masked by F-42 · F-45 moot until F-16 · F-88 latent on F-63 · F-32+F-64+F-66 one defence (all three CLOSED in Batch 5) · F-30+F-71+F-94 one enumeration (all three CLOSED: F-30 in Batch 2, F-71+F-94 in Batch 6; F-30 and F-94 are P1-A, F-71 is P1-B — one defence, two severities) · F-95+F-96+F-97 one isolation story (all three CLOSED in Batch 3) · F-18+F-19+F-53 one trust story.

## Where the remediation lives

**It is not on `main`.** Until `c696dac6` it was not on any single ref either: the seven
forensic batches and F-23 were developed as **siblings off the same base**, never integrated,
so no tree had ever held both and neither branch's suite total described the combination.

```
main                            0407618  ← contains NONE of these fixes
├── forensic/post-roadmap-audit  6439449  ← Batches 1-7 (22 P1-A) + evidence
├── fix/f-23-…                   896bcaa  ← F-23 only
└── integration/p1a-remediation  c696dac  ← 23b92c7 + 3dc8181 merges, then F-27's read half
```

`git merge-base` of the two source branches is `0407618`. Both merges were `--no-ff` and
**conflicted in nothing**: the changed-file sets are 88 and 3 with **zero overlap**, checked
before merging rather than discovered during it. Merges rather than cherry-picks, so each
batch's commit and its evidence survive with its own SHA.

The one semantic interaction worth naming was tested rather than assumed: F-23's new structural
guard in `xlsx.ts` reads parts through `zip.ts`, which Batch 3 rewrote for F-60. They agree.

## Validation — the combined tree

**These are the first valid numbers for the remediation set.** Every earlier total is stale by
construction: 3 513/175 was the forensic branch without F-23, 3 395/164 was F-23 without the
batches.

| | At `3dc8181` (integration) | At `c696dac6` (with F-27) |
| --- | --- | --- |
| Test files | 176 passed (176) | **176 passed (176)** |
| Tests | 3 528 passed, 7 skipped | **3 542 passed, 7 skipped (3 549)** |
| Failures | **0 failed** — exit 0 | **0 failed** — exit 0 |
| Lint | clean | **clean** (`eslint .`) |
| Typecheck | clean | **clean** (`tsc --noEmit`) |
| Build / package | clean | **clean** — 13 migrations, 4 grammars, datasets; `packaging.test.ts` all 34 ran |

The integration totals are **exactly additive** — 175 + 1 files, 3 513 + 15 tests — which is the
useful result rather than the reassuring one: the two remediation sets do not interact.

The 7 skips are structural and pre-existing: `docker.test.ts` (4, registry-dependent) and
`signals.test.ts` (3, POSIX signals on Windows). No database suite skipped. **F-73, F-92 and
F-101 did not fire** in any of these runs, which — as those findings themselves record — does
not disprove an intermittent condition.

No new migration was added by the integration or by F-27; the schema is Batch 2's `0013`.

