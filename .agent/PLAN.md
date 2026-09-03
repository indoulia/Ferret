# PLAN

Batches are ordered and independently shippable. Batches 1 and 2 are complete; nothing after them is started.
Each batch: failing test first, then fix, then the record it restores.

| # | Batch | Findings | Gate |
| --- | --- | --- | --- |
| 1 | Ingestion completeness | F-01, F-02, F-03, F-04 | **DONE** — fixture red for four reasons, then green; see `docs/evidence/FERRET-BATCH-1-INGESTION-COMPLETENESS.md` |
| 2 | Small self-contained blockers | F-30, F-29, F-17, F-16 | **DONE** — four fixtures red then green; see `docs/evidence/FERRET-BATCH-2-BLOCKERS.md` |
| 3 | Untrusted-input bounds | F-60, F-61, F-95, F-96, F-97 | Lying ZIP header (fixture generator must be able to express it); a `.docx` capped before allocation; an undatable commit isolated and recorded |
| 4 | Answer truthfulness | F-05, F-31, F-28, F-27, F-06, F-24 (+ F-07, F-25b if readable) | A deleted subject answers `partial`; a withheld row surfaces; N resolutions leave N current rows; a span slices the bytes it names |
| 5 | Prompt-injection boundary | F-32, F-64, F-66 | Balanced delimiters after trimming; a nested/array leaf counted and wrapped; `notice` first on every tool via `listTools` enumeration |
| 6 | Credential and safety enumeration | F-94, F-71 | Hostile `.git/config` cannot reshape `git log` output; no credential-bearing variable reaches a child process |
| 7 | Code-intelligence truth | F-25, F-11 | Requires a re-index; schedule accordingly |
| 8 | Record correction (no code) | F-74, F-75, F-87, EPIC-028 AC-14, EPIC-035 AC-4, EPIC-090 §11, F-20/F-21 registry notes | Each corrected record cites the finding |

**Deferred, gated on a product decision:** everything behind F-21 (F-07, F-08, F-09, F-10,
F-13, F-14, F-15, F-18, F-19, F-37–F-40, F-53–F-59) and behind F-20 (F-46–F-48).
F-49 (reachability sweep scope) is worth doing regardless — it is the control that would
have caught F-20's class.

**Not to be done:** build a session store or a `ferret sync` command (F-20, F-21); implement
import following (F-26 — correct the AC record instead); tune benchmarks (F-50, F-51, F-91);
half-fix the committer field (F-98); repair `isInside` rather than delete it (F-84); change
any test merely to make it green.
