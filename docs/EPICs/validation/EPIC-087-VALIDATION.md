# EPIC-087 — Deduplicated Content Storage · Validation Evidence

**Assessed against:** working tree on top of `6709157`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, the golden corpus indexed end to end.

## The measurement

Three configurations of the same corpus, the same dataset (`1.0.0`, checksum
`cbcb9d98…6790`), the same 8 labels, k = 10, **labels unchanged throughout**.

| | mean p@10 | mean recall | mean RR | mean nDCG | false positives |
| --- | --- | --- | --- | --- | --- |
| **A** — no content indexing | 0.3194 | 0.7500 | 0.5556 | 0.6125 | 0 |
| **B** — content indexed, bodies not stored | 0.2222 | 0.7500 | 0.3111 | 0.4302 | 0 |
| **C** — content indexed and stored (this Epic) | **0.2639** | **0.9167** | **0.5972** | **0.6698** | **0** |

**A reproduces EPIC-098's recorded baseline exactly** — 0.32 / 0.75 / 0.56 /
0.61, measured there against `594d858` and re-measured here on today's code.
The harness is stable, which is what makes B and C comparable at all.

Per query, C against A:

| label | p@10 A → C | recall A → C | nDCG A → C |
| --- | --- | --- | --- |
| `exact-invoice-path` | 0.50 → 0.25 | 1.00 → 1.00 | 1.00 → 0.50 |
| `exact-login-path` | 0.50 → 0.33 | 1.00 → 1.00 | 1.00 → 0.63 |
| `text-invoice` | 0.25 → 0.17 | 0.50 → 0.50 | 0.41 → **0.83** |
| `text-authentication` | 0.00 → **0.25** | 0.00 → **1.00** | 0.00 → **0.43** |
| `text-refund` | 0.33 → 0.25 | 1.00 → 1.00 | 0.63 → 0.63 |
| `text-onboarding` | 0.33 → 0.33 | 1.00 → 1.00 | 0.63 → **1.00** |

`text-authentication` is the query this Epic was specified against. It scored
**zero on every metric** because `authenticate` appears in `login.ts`'s body and
in no path, and it now returns that file at recall 1.00. The entity kinds each
text query reaches, recorded by the harness:

```
before  text-authentication "authenticate" reached: commit
after   text-authentication "authenticate" reached: file, file, commit, file
```

## Precision fell, and this is the honest account of why

**AC-11 asked for mean precision@10 above 0.32. It is 0.2639. The criterion is
not met as written, and the number is reported rather than the criterion
rewritten.**

What the three configurations show is that precision was lost between **A and
B** — that is, by turning content indexing *on at all*, before a single body was
stored. B stores nothing this Epic added and scores 0.2222. Storing bodies then
moves every metric **up** from there, precision included:

| B → C, this Epic's isolated effect | change |
| --- | --- |
| mean p@10 | 0.2222 → 0.2639 |
| mean recall | 0.7500 → 0.9167 |
| mean RR | 0.3111 → 0.5972 |
| mean nDCG | 0.4302 → 0.6698 |

Two distinct causes, both verified rather than inferred:

1. **`code_symbol` entities dilute general text search.** Content indexing
   creates them (EPIC-034 and EPIC-108, both VALIDATED, neither previously
   exercised by the harness). `text-refund` reaches a `code_symbol` before it
   reaches the file. They are unlabelled, so each one costs precision. This is
   not EPIC-087's to fix and is filed as a defect.
2. **The labels name one file where the corpus has several.**
   `text-authentication` now returns `login.ts`, `README.md` and
   `docs/architecture.md`. The latter two genuinely discuss authentication; the
   label expects only `login.ts`, so two correct-looking answers score as noise.
   Whether they should be labelled is EPIC-096's decision, not one to take here.

Since `precisionAtK` is computed over what was returned, a query that finds more
of the corpus scores lower on it while scoring higher on recall, RR and nDCG —
which is exactly the pattern in the table. nDCG is the metric that accounts for
both, and it rose from 0.6125 to 0.6698 against the original baseline.

**No label was changed and no threshold was moved.** The only gate the suite
enforces remains `falsePositives === 0`, and it holds in all three
configurations.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 one row per distinct hash | MET | `content-blobs.test.ts` "stores content the first time and deduplicates every time after", real PostgreSQL |
| AC-2 identical content is one row | MET | "keeps one row for the same bytes reached by two different paths"; unit "reports the second file with identical content as deduplicated" |
| AC-3 re-index writes no new row | MET | second `store` returns `deduplicated`, row count unchanged; `ON CONFLICT DO NOTHING` proved not to overwrite |
| AC-4 body retrievable by hash | MET | "round-trips a text body" |
| AC-5 credential never stored | MET | body redacted *and* `SELECT … WHERE text_content LIKE '%hunter2hunter2%'` returns 0 |
| AC-6 over-bound → row with reason | MET | `over-size-bound`, `text_content IS NULL`, `byte_size` still recorded |
| AC-7 binary → row with reason | MET | `binary`, no text |
| AC-8 content hit for a body-only term | MET | `zarquon` returns `src/notes.ts` as a `content` hit |
| AC-9 no hit across a permission boundary | MET | one blob, two repositories: a caller scoped to A gets `src/shared.ts` and not `vendor/shared.ts`; a caller scoped to B sees no trace of A's body |
| AC-10 `authenticate` reaches `authenticateUser` | MET | integration test, and the golden harness independently |
| AC-11 p@10 above the 0.32 baseline | **NOT MET** | 0.2639. Recall, RR and nDCG all exceed the baseline; precision does not. Accounted for above; see §Raised |
| AC-12 zero false positives | MET | 0 in all three configurations |
| AC-13 a store failure costs one file | MET | unit "keeps parsing when the store rejects a file": `blobs.failed = 1`, `filesParsed = 2` |
| AC-14 migration applies, schema advances | MET | `0011` applies on a fresh database in every integration suite; a non-`IMMUTABLE` generated column would fail here |

## What only a real database could prove

The generated `tsvector` is the Epic in one expression. `to_tsvector('english',
'authenticateUser')` is the single lexeme `authenticateus`; the query
`authenticate` stems to `authent` and matches none of it. Without the
camel-splitting copy, EPIC-087 would have delivered a table full of bodies and
left `text-authentication` at 0.00 — a shipped feature with the measurement
unmoved. That is a fact about PostgreSQL's parser and no mock produces it.

The join direction is the other. A blob is shared by construction, so the branch
returns an `entity` row that passed `scopePredicate`, never a blob row. It also
resolves to the **`file`**, not the `file_version` that carries the hash: the
first attempt returned the version, and `text-authentication` stayed at recall
0.00 with content indexed and searchable, because the label expects a file and
retrieval offered a version of one. Measured, then fixed.

## Defects found

- **`code_symbol` entities dilute general text search.** Filed. A query for
  `refund` reaches a symbol before it reaches the file that declares it.
  EPIC-034 or EPIC-056 territory, not this Epic's.

## Verification

`npm run verify` green: 105 files, 2306 passed, 3 skipped. New suites:
`tests/unit/content-blobs.test.ts` (14), `tests/integration/storage/content-blobs.test.ts`
(19, real PostgreSQL).

## Raised, not absorbed

**AC-11 needs a governance decision, and this record does not take it.** The
criterion was written before the three configurations were measurable and it
compares against a baseline from a different index configuration. The options
are to restate it as the B→C comparison it was meant to express, to retire it in
favour of nDCG, or to leave it failing until the `code_symbol` dilution is
fixed. All three are defensible; choosing one to make this Epic pass is not.

Until it is decided, EPIC-087 is **IMPLEMENTED**, not VALIDATED.
