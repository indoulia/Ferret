# PLAN

Batches are ordered and independently shippable. Batches 1-7 are complete, and two pieces of
work outside them have since closed the last two P1-A findings. Batch 8 is not started.

> **Record correction, superseded and kept.** F-23 was never in any batch's scope — the table
> below has always said so, and Batch 3's row lists F-60, F-61, F-95, F-96, F-97 and not F-23.
> The claim that Batch 3 closed it appeared only in `.agent/FINDINGS.md` and was repeated by the
> first audit; it was corrected to OPEN in both. **That correction was right, and it is now
> itself overtaken by work:** F-23 is closed at `896bcaa`, and F-27 — recorded here as partially
> closed once Batch 7 delivered its persistence half — is closed at `c696dac`, which added the
> read half. Both rows are below. The history is left standing because it is how the conclusion
> was reached, and because the process lesson it carries outlived the defect.

Each batch: failing test first, then fix, then the record it restores.

| # | Batch | Findings | Gate |
| --- | --- | --- | --- |
| 1 | Ingestion completeness | F-01, F-02, F-03, F-04 | **DONE** — fixture red for four reasons, then green; see `docs/evidence/FERRET-BATCH-1-INGESTION-COMPLETENESS.md` |
| 2 | Small self-contained blockers | F-30, F-29, F-17, F-16 | **DONE** — four fixtures red then green; see `docs/evidence/FERRET-BATCH-2-BLOCKERS.md` |
| 3 | Untrusted-input bounds | F-60, F-61, F-95, F-96, F-97 | **DONE** — five fixtures red then green; see `docs/evidence/FERRET-BATCH-3-UNTRUSTED-INPUT-BOUNDS.md` |
| 4 | Answer truthfulness | F-05, F-31, F-28, F-06, F-24 | **DONE** — see `docs/evidence/FERRET-BATCH-4-ANSWER-TRUTHFULNESS.md`. F-27 was deferred here and taken up in Batch 7 |
| 5 | Prompt-injection boundary | F-32, F-64, F-66 | **DONE** — 8 of 9 fixture assertions red then green, six second-order defects corrected; see `docs/evidence/FERRET-BATCH-5-PROMPT-INJECTION-BOUNDARY.md` |
| 6 | Credential and safety enumeration | F-94, F-71 | **DONE** — 11 of 17 and 29 of 31 fixture assertions red then green, eight second-order defects corrected; see `docs/evidence/FERRET-BATCH-6-CREDENTIAL-AND-SAFETY-ENUMERATION.md` |
| 7 | Code-intelligence and identity truth | F-25, F-25b, F-27, F-11 | **DONE** — 12 of 20 fixture assertions red then green, six second-order defects corrected; see `docs/evidence/FERRET-BATCH-7-CODE-INTELLIGENCE-TRUTH.md`. F-25, F-25b and F-11 closed; **F-27 partially closed** (persistence only). **Final implementation batch.** |
| 8 | Record correction (no code) | F-74, F-75, F-87, EPIC-028 AC-14, EPIC-035 AC-4, EPIC-090 §11, F-20/F-21 registry notes | **NOT STARTED** — each corrected record cites the finding |

Two pieces of work sit outside the numbered batches, because neither was in any batch's scope
and saying otherwise is the error this plan already had to correct once:

| # | Work | Findings | Gate |
| --- | --- | --- | --- |
| — | **F-23 — a corrupt worksheet is not an empty one** (`896bcaa`, branch `fix/f-23-corrupt-worksheet-silent-empty`, off `main`) | F-23 | **DONE** — structural root check before the regex scanner, workbook part refused on the existing path, `SHEET_PARSER_VERSION` 1.0.0 → 1.1.0 so cached silent-empty artefacts are re-extracted. 15 new cases in `tests/unit/sheet-corruption.test.ts`; 45 focused sheet tests green |
| — | **Integration + F-27's read half** (`23b92c7`, `3dc8181`, `c696dac`, branch `integration/p1a-remediation`, off `main`) | F-27 | **DONE** — the two sibling branches merged into one tree and validated together for the first time, then `ReferenceCompleteness` carried from the persisted counts to `ferret_neighbours`. 6 of 7 tool-surface and 2 of 4 store assertions red first; full gate green at `c696dac6` |

**The remediation set is complete at `c696dac6` and lives only there.** `main` is `0407618` and
contains none of it. Nothing has been pushed, no PR opened, nothing merged, nothing deployed.

**Deferred, gated on a product decision:** everything behind F-21 (F-07, F-08, F-09, F-10,
F-13, F-14, F-15, F-18, F-19, F-37–F-40, F-53–F-59) and behind F-20 (F-46–F-48).
F-49 (reachability sweep scope) is worth doing regardless — it is the control that would
have caught F-20's class.

**Learned in Batch 5, and it bears on Batch 6.** All three findings were the same failure
mode: an *enumeration* that fails towards exposure. A prose allowlist keyed by attribute
name, a traversal that descended only into what it recognised, and a notice test carrying a
hand-written list of four tools. Each was replaced by something derived — shape rather than
key name, recursion over whatever is there, `listTools()` rather than a list. Batch 6 is
that same correction applied to the safety and credential lists, so the argument is already
made.

**Learned in Batch 6, and it bears on Batch 7.** The correction held, and one thing sharpened
it: a derived rule needs its own control against over-reach. Judging a variable by name-shape
stripped `PWD` from every child process — solving disclosure by destroying the environment —
found by measuring against a real machine's environment, not by reasoning about the rule. So
a derived rule added from here carries a preserved-half assertion in the same table as its
stripping half, and neither can be improved at the other's expense. Second lesson, cheaper:
two of the eight second-order defects were found by Ferret's own controls
(`control-reachability`, the packaging secret scan) rather than by re-reading the diff, and
one architectural regression by `boundaries.test.ts` — run the full suite before believing a
re-audit is finished.

**Not to be done:** build a session store or a `ferret sync` command (F-20, F-21); implement
import following (F-26 — correct the AC record instead); tune benchmarks (F-50, F-51, F-91);
half-fix the committer field (F-98); repair `isInside` rather than delete it (F-84); change
any test merely to make it green.
