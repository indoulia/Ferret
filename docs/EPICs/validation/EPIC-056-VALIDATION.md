# EPIC-056 — Ranking & Reranking · Validation Evidence

**Assessed against:** working tree on top of `a4acc5e`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, the golden corpus indexed end to
end with content and symbols, exactly as `ferret index --content` composes it.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires for every Epic from 011
> onward. Scope was drawn from the registry entry — "EPIC-056 — Ranking &
> Reranking — P1" — and from the two P0 Epics that disclaim ranking by name.

## The measurement

Same dataset (`1.0.0`), same 8 labels, k = 10, **labels unchanged**. The before
column is the figure `docs/Architecture/EPIC-087-DECISIONS.md` §D1 recorded on
`5293434` and the P0 closure pass re-measured.

| | mean p@10 | mean recall | mean RR | mean nDCG | false positives |
| --- | --- | --- | --- | --- | --- |
| before — `5293434` | 0.2639 | 0.9167 | 0.5972 | 0.6698 | 0 |
| **after — this Epic** | **0.3611** | **0.9167** | **0.6806** | **0.7313** | **0** |

Per query:

| label | p@10 | recall | RR | nDCG |
| --- | --- | --- | --- | --- |
| `exact-invoice-path` | 0.25 | 1.00 | 0.33 | 0.50 |
| `exact-login-path` | 0.33 | 1.00 | 0.50 | 0.63 |
| `text-invoice` | 0.33 | 0.50 | **1.00** | **0.83** |
| `text-authentication` | 0.25 | 1.00 | 0.25 | 0.43 |
| `text-refund` | **0.50** | 1.00 | **1.00** | **1.00** |
| `text-onboarding` | **0.50** | 1.00 | **1.00** | **1.00** |
| `absent-kubernetes` | — | — | — | — (0 returned) |
| `absent-graphql` | — | — | — | — (0 returned) |

And the line the whole Epic is about — the entity kinds each text query reaches:

```
before  text-refund  "refund"  reached: code_symbol, file, commit, file_version
after   text-refund  "refund"  reached: file, commit

before  text-invoice "invoice" reached: file, code_symbol, code_symbol, commit, commit, file_version
after   text-invoice "invoice" reached: file, commit, commit
```

Nothing was excluded to achieve that. `refund` still matches the symbol and the
version; both are now credited to the file that contains them, and the file is
returned first. `text-refund` went from nDCG 0.63 to **1.00** — a perfect
ranking of that label.

**Recall is identical at 0.9167.** That is the number to check first, because it
is the one a filter masquerading as a ranker would move. Issue #98's diagnosis
was that ordering had degraded while recall stayed still; the fix moves ordering
back and leaves recall exactly where it was.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 score in `[0,1)`, exact = 1.0 | **MET** | `tests/unit/retrieval-rank.test.ts` "keeps every ranked score inside [0, 1]", "leaves an exact identifier match at 1.0"; integration "returns each entity once, with a comparable score and a breakdown" asserts `< 1` against a live index |
| AC-2 deterministic order | **MET** | unit "ranks a pool identically however it arrives, including ties" — same pool reversed, same order |
| AC-3 symbol folds into its file | **MET** | unit "folds a symbol into the file that declares it"; integration "folds a symbol and a file version into the file, and says so" against the real corpus |
| AC-4 file version folds the same way | **MET** | unit "folds a file version into its file by entity id"; same integration test |
| AC-5 unfolded constituent is returned | **MET** | unit "returns a symbol whose file is not in the pool, on its own relevance" |
| AC-6 `kinds: ['code_symbol']` returns symbols | **MET** | integration "returns symbol hits when the caller asks for symbols" |
| AC-7 name + body beats either alone | **MET** | unit "scores an entity reached by name and by body above either alone", checked against `1 - (1 - 0.5)² = 0.75` on paper |
| AC-8 twenty evidence records contribute once | **MET** | unit "lets twenty evidence records contribute the best one, once" — the better-matching entity still wins |
| AC-9 no entity twice | **MET** | unit "returns an entity once however many ways it was reached"; integration asserts distinct ids over a live query |
| AC-10 overfetch, return `limit` | **MET** | unit "fetches more candidates than it returns, bounded by MAX_LIMIT"; integration "reads more candidates than it returns" — `limit: 1` returns the best of the wider pool, not the first row of a page of one |
| AC-11 output ⊆ pool | **MET** | unit "returns no entity the pool did not contain"; `tests/security/retrieval-scope.test.ts` asserts the filter runs before the ranker and that the ranker has no way to read a row it was not handed |
| AC-12 mean p@10 > 0.32 | **MET** | **0.3611**, labels unchanged, `falsePositives` 0 — asserted, not only printed |
| AC-13 MRR and nDCG above baseline | **MET** | **0.6806** > 0.5972 and **0.7313** > 0.6698 |
| AC-14 recall ≥ 0.9167 | **MET** | **0.9167**, unchanged |
| AC-15 `text-refund` returns the file at rank 1 | **MET** | integration "answers `refund` with the file itself, first"; RR 1.00 in the harness |

Fifteen of fifteen MET. No criterion was restated, and none is carried as
PENDING or BLOCKED.

## Tests

- **Unit** — `tests/unit/retrieval-rank.test.ts`, 19 tests: the `[0,1]` bound,
  noisy-or against worked arithmetic, container resolution for both constituent
  kinds, the unfolded constituent, tie determinism, the subset invariant, the
  twenty-evidence case, overfetch arithmetic at `limit = 1` and `MAX_LIMIT`, and
  four malformed-pool cases (no scope, a scope pointing at nothing, a `NaN`
  score, an empty pool) — none of which throws.
- **Integration (real PostgreSQL)** —
  `tests/integration/evaluation/golden-dataset.test.ts`, six tests added,
  sharing EPIC-096's corpus for the reason that file already gives.
- **Security** — `tests/security/retrieval-scope.test.ts`: filter before rank,
  and `rank.ts` free of `storage/`, of `sql`, and of `await`.
- **Regression** — `npm run verify` green: 126 files, 2601 passed, 3 skipped.

## Found while implementing, and fixed here

**The headline did not cover the text the vector indexes.** Migration 0007's
`search_vector` includes a `translate` of the path's separators, so `connection`
reaches `src/connection-pool.ts`; `ts_headline` in the entity branch was
computed over a shorter field list that omitted it, along with `description`,
`ref` and `title`. A hit could therefore come back with *nothing marked* — a
highlight that explains nothing.

It surfaced because §8.5 changed which row of an entity is the one shown, and it
would have surfaced for any other reason too: `tests/integration/retrieval/
retrieval.test.ts` "shows why something matched" was passing on the luck of which
row happened to sort first. The headline now mirrors the generated column field
for field. This belongs to EPIC-053 and was fixed in place rather than filed,
per the Epic-execution rule that a defect belonging to an existing Epic is fixed
there.

## What this closes elsewhere

**Issue #98** — `code_symbol` entities diluting general text search — is closed
by AC-3 and AC-15 with the measurement above. Its diagnosis was correct and its
ownership, settled in EPIC-087 §D1, was correct.

**EPIC-087 AC-11** asked for `text-authentication` recall > 0 **and** mean p@10
strictly above 0.32, labels unchanged. Both halves now hold: recall 1.00 and
p@10 0.3611. Recorded as a dated addendum on EPIC-087's own record, whose
original rows and paragraphs are left exactly as written, and EPIC-087 moves to
**VALIDATED** in the registry.

That is a status change to another Epic, so the reasoning is worth stating
plainly. It is not a governance decision between the three options EPIC-087 and
the P0 closure pass put on the table — the criterion is **met as written**, no
label was touched and nothing was restated, which is the third of those options
("leave it failing until the `code_symbol` dilution is fixed") reaching its
conclusion. The precedent is the same pass's own handling of EPIC-048 AC-11 and
EPIC-080 AC-5: a criterion closed by evidence a later Epic produced becomes MET
by dated addendum, with the original record intact. If governance reads it
otherwise, the addendum and the registry line are the only two places to revert.

## Limitations, recorded

- **The golden labels still understate the corpus.** `text-authentication`
  returns `login.ts`, `README.md` and `docs/architecture.md`; the label names
  one file, and the other two do discuss authentication. Its p@10 of 0.25 is
  therefore a floor rather than a measurement of retrieval. EPIC-096 owns the
  labels and this Epic did not touch them — AC-12 was written to be met against
  them as they stand.
- **`text-invoice` recall is 0.50.** `src/billing/tax.ts` is labelled relevance
  1 for `invoice` and is not retrieved; it does not contain the term, so this is
  reach rather than ranking, and it is unchanged from the baseline.
- **Eight labels over eleven files is a small corpus.** Every figure here moved
  in the direction the mechanism predicts and the per-query table shows where,
  but a 0.0972 gain on six scored labels is not a claim about a large
  repository. EPIC-101 owns scale.
- **`fuse` still combines strategy lists by rank.** §8.1 makes lexical scores
  comparable to each other, not to a cosine distance, so RRF remains correct in
  the planner. Not claimed as changed.
