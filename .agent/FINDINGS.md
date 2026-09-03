# FINDINGS — triage index

Full evidence: `docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`.
Full triage: `docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`.
All 100 findings were re-verified against `0407618` before being recorded.

## P0 (1) — CLOSED in Batch 1
- **F-01** *(fixed)* history capped at 1 000 commits, watermark advanced to the newest of a newest-first page → permanent silent loss on any larger repository; `--full` cannot recover.

## P1-A — production blockers (24; 3 closed)
Ingestion — **CLOSED in Batch 1**: **F-02** (all branches share one watermark), **F-03** (future-dated commit stalls ingestion for ever), **F-04** (back-dated merge -> parentless stub commits).
Storage/install: **F-16** (migrate before pgvector; unrepairable, version lies), **F-17** (backup that import refuses), **F-29** (document-supplied column names interpolated into SQL), **F-30** (DB password to stdout, exit 0).
Untrusted input: **F-60** (zip bound trusts the declared size), **F-61** (docx bypasses the bounded reader), **F-94** (`i18n.logOutputEncoding` fabricates commits under chosen SHAs), **F-95** (undatable commit desyncs the parser, fabricates file entities).
Truthfulness: **F-05** (deleted entity answered as current), **F-06** (supersession collapses multi-valued fields), **F-23** (corrupt xlsx = successful empty parse, cached), **F-24** (spans name the wrong bytes), **F-25** (+**F-25b**) (same-file homonym edges; duplicate open intervals), **F-27** (unresolved references discarded), **F-28** (traversal truncation unreported), **F-31** (withheld rows dropped, `truncated: false`).
Boundary: **F-32** (trim cuts the closing delimiter), **F-64** (containment top-level only), **F-66** (notice last in default JSON).
Identity: **F-11** (non-address author strings merge distinct humans irreversibly).

## P1-B — deferrable (15)
**F-07**, **F-08**, **F-09**, **F-10**, **F-12**, **F-13**, **F-14**, **F-15**, **F-18**, **F-19**, **F-22**, **F-26**, **F-65**, **F-67**, **F-71**.
Most are unreachable today; fix at the moment their code is wired.

## Demoted to documentation (2)
- **F-20** Session & Agent Memory unreachable — every Epic excludes persistence *by name*; the Epics deliver their scope. Registry note only. **Do not build a store.**
- **F-21** GitHub/Jira ingestion unreachable — every Epic excludes transport and persistence *by name*. Registry note + `PLANNED_COMMANDS`/README. **Do not build `ferret sync`.**

## P2/P3 (60)
Groups: documentation drift (highest value) · identity hardening · retention lifecycle · provider platform · audit/observability · session values · benchmark honesty · test integrity · small correctness. Detail in the triage §4.

## Key dependencies
F-03 ⊂ F-04 · F-44 ⊂ F-17 · F-41 masked by F-42 · F-45 moot until F-16 · F-88 latent on F-63 · F-32+F-64+F-66 one defence · F-30+F-71+F-94 one enumeration · F-95+F-96+F-97 one isolation story · F-18+F-19+F-53 one trust story.
