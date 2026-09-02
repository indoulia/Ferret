# EPIC-098 — Retrieval Quality Harness

**Status: IMPLEMENTED | Priority: P0 | Domain: Evaluation & Quality**

> **Specification note.** The registry approved this Epic by name, domain and
> priority (`README.md:212`); no specification was ever written. This document
> supplies one.
>
> Four records park work here: `validation/EPIC-042-VALIDATION.md:98` and
> `validation/EPIC-044-045-VALIDATION.md:100` both name this Epic as the owner of
> a measurement they could not make, and EPIC-096 §4 and §16 assign it both the
> metrics and the threshold decision. Governance §19 is the requirement.
>
> §2 measures `594d858` and describes the repository as it is.

## 1. Objective

Turn the golden dataset into a **number**: measured precision, recall and ranking
for Ferret's retrieval, reproducible from a checkout and citing the dataset it was
measured against.

## 2. Problem, measured

Governance §19: "'Perfect' parsing or retrieval is not an acceptable quality claim
without measurable validation."

Measured on `594d858`, Ferret has a dataset and still has no number.

**EPIC-096 supplied the labels and deliberately measured nothing.** Its §4 excludes
computing any metric and assigns precision, recall and ranking here; its §16 says
"EPIC-098 inherits an unmeasured product and a way to measure it, not a target to
hit." `validation/EPIC-096-VALIDATION.md:96` states the position plainly: "Ferret's
precision and recall remain unknown, and EPIC-098 is what will produce them."

**Two earlier Epics recorded a measurement they could not make.**
`validation/EPIC-042-VALIDATION.md:96` — the decision-extraction phrasings "were
chosen for precision on the examples tested, not measured against a corpus; a
quality harness for them is EPIC-098's shape of problem."
`validation/EPIC-044-045-VALIDATION.md:100` — source-authority rules were never
"validated against retrieval quality, which is EPIC-098's shape of problem."

**The retrieval surface a harness must drive.** `RetrievalPort`
(`src/retrieval/query.ts:186`) exposes `findEntities`, `getEntity`, `neighbours`
and `search`. The exact-lookup path a golden `exact` label describes is
`byIdentifier`, which is **not** on that port — it is on `ExactStrategy`
(`src/retrieval/planner.ts:28`) and on `RetrievalStore`
(`src/storage/retrieval.ts:242`). A harness therefore needs a narrow port of its
own rather than either widening `RetrievalPort` or importing storage.

**A search hit's score is not comparable across queries.**
`src/retrieval/query.ts:150` says so: `ts_rank` is "comparable within one result
set and nowhere else … treating it as one across queries is how a threshold gets
hard-coded that means nothing." Any metric here must therefore be computed from
**rank order**, never from the score.

## 3. Scope

1. **Metrics, as pure functions** — precision@k, recall, reciprocal rank and
   nDCG@k, computed from rank order and the dataset's graded relevance.
2. **A harness** that runs every golden query against a retrieval implementation
   and produces a per-query and aggregate report.
3. **A report that cites its dataset** — version and checksum — so a figure can
   never be compared against one measured on different labels.
4. **The first measurement, recorded** as validation evidence.
5. **A threshold decision, raised with data** — EPIC-096 §4 deferred it here and
   §16 of this document answers it.

## 4. Non-scope

- **Parser quality** — EPIC-097. **Provider conformance** — EPIC-099. **Security
  regression** — EPIC-100. Each owns its own harness over the same dataset.
- **Changing the dataset.** If a label turns out to be wrong, that is a change to
  EPIC-096 with a recomputed checksum, not a fix here. A harness that could edit
  its own labels measures nothing.
- **Improving ranking** — EPIC-056/057, both P1. This Epic reports what ranking
  does; it does not touch it. Measuring and fixing in one change makes the
  measurement unfalsifiable.
- **Semantic retrieval quality.** Ferret ships no embedding provider, so there is
  nothing to measure and the dataset carries no semantic labels (EPIC-096 §4).
- **Performance** — EPIC-101. Quality and speed are different numbers.
  **Delivered 2026-09-03**, and the split held: EPIC-101 measures milliseconds
  and asserts query plans; this Epic still owns precision and recall.
- **A score-based threshold.** §2 records why `ts_rank` cannot carry one.

## 5. Inputs

- `loadGoldenDataset`, `resolveIdentity`, `CORPUS_SCOPE`, `Relevance`,
  `GoldenQuery` (EPIC-096).
- `SearchResult`, `SearchHit`, `AccessContext`, `PUBLIC_ACCESS` (EPIC-052/053/058).
- A real `RetrievalStore` and a real PostgreSQL, for the measurement itself.

## 6. Outputs

- `precisionAtK`, `recallOf`, `reciprocalRank`, `ndcgAtK` — pure, exported.
- `measureRetrievalQuality(dataset, retrieval, bindings)` → `RetrievalQualityReport`.
- The first recorded figures for Ferret's retrieval, in
  `validation/EPIC-098-VALIDATION.md`.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-096 Golden Evaluation Dataset | IMPLEMENTED | the labels and the identity contract |
| EPIC-052/053 Retrieval | VALIDATED | the thing being measured |
| EPIC-058 Permission-Aware Retrieval | IMPLEMENTED | the access context every read takes |

## 8. Contracts

- **Metrics are computed from rank order, never from a score.** `src/retrieval/query.ts:150`
  states that `ts_rank` is not comparable across queries; a metric that used it
  would be a number with no meaning.
- **A report cites the dataset version and checksum.** Without it "precision
  improved" cannot be distinguished from "the labels changed", which is the whole
  reason EPIC-096 checksums itself.
- **An absence label is counted, not scored.** Precision is undefined when the
  expected set is empty. What is measurable is how many results came back when
  none should have, and that is reported as a count of false positives rather
  than folded into a mean that would hide it.
- **The harness never writes.** It reads a dataset and queries a retrieval
  implementation. It cannot edit labels, and it cannot index.
- **The harness names a narrow port.** `RetrievalPort` lacks `byIdentifier` and
  this Epic does not widen it; a two-method port that `RetrievalStore` satisfies
  structurally keeps the harness out of `storage/` — the same shape `EvidenceReader`
  uses.
- **A measurement is reported, never asserted, until a threshold is argued.** The
  first run's job is to produce a number, not to pass.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | `precisionAtK`, `recallOf`, `reciprocalRank` and `ndcgAtK` are pure and correct against worked examples computed by hand. | Gov §19 |
| AC-2 | nDCG uses the dataset's graded relevance, so a right answer ranked ninth scores below the same answer ranked first. | EPIC-096 AC-5 |
| AC-3 | Every metric is derived from rank order; no metric reads `SearchHit.score`. | §8; `query.ts:150` |
| AC-4 | The harness runs every golden query and reports per-query and aggregate figures. | §3 |
| AC-5 | An absence label contributes a false-positive count and is excluded from the precision mean. | §8 |
| AC-6 | The report carries the dataset version and checksum. | §8; EPIC-096 AC-8 |
| AC-7 | The harness runs against a real `RetrievalStore` and a real PostgreSQL, over the indexed golden corpus. | §5 |
| AC-8 | The harness performs no write and reaches no indexing or storage module. | §8 |
| AC-9 | A measured figure is recorded in validation evidence, whatever it is. | Gov §19 |
| AC-10 | A deliberately broken retrieval (returning nothing) scores zero rather than erroring, so the harness is shown to be able to fail. | §8 |
| AC-11 | Metrics are undefined-safe: a query with no expected results and no returned results does not produce `NaN`. | AC-5 |

## 10. Test requirements

- Unit: each metric against hand-computed worked examples, including the nDCG case
  where order alone changes the score.
- Unit: a stub retrieval returning nothing scores zero across the board (AC-10),
  and one returning everything scores full recall with poor precision — so the
  harness is demonstrably capable of reporting both failure modes.
- Integration, real PostgreSQL: index the golden corpus, run the harness, assert
  the report is well-formed and cites the dataset checksum. **Assert the shape,
  not the figures** — an assertion on a number would make improving retrieval a
  test failure.
- The suite must fail if the dataset has no queries, so a perfect score cannot be
  the score of an empty run.

## 11. Security

The harness reads a corpus authored for this repository and runs under
`PUBLIC_ACCESS`. It adds no new data path. A report names query ids and metric
values, never statements, so a future scoped corpus cannot leak through a quality
figure.

## 12. Observability

The report is the observable artefact. It names the dataset, every query id, and
each figure, so a regression can be attributed to a query rather than to
"retrieval".

## 13. Performance constraints

Eight queries against an indexed corpus of eleven files. The measurement must stay
inside a normal test timeout; if it ever does not, the dataset has grown and
EPIC-101 owns the question.

## 14. Definition of Done

All acceptance criteria pass; the harness runs against real PostgreSQL; the first
measured figures are recorded in `validation/EPIC-098-VALIDATION.md` whatever they
say; the threshold question is answered in §16 with the data.

## 15. Governance alignment

- **§19 Testing and Quality** — the requirement, discharged: after this Epic there
  is a measured figure rather than a claim.
- **§6** — a measurement is evidence, so it is recorded with the version and
  checksum that make it reproducible rather than restated later from memory.
- **§2** — four pure functions and one loop. No framework.

## 16. Raised, not absorbed

**The threshold, decided with the data.** EPIC-096 §4 deferred this here because
"the first measurement is what makes a threshold arguable". The first measurement,
over 8 labels and 11 corpus files:

| metric | value |
| --- | --- |
| mean precision@10 | 0.32 |
| mean recall | 0.75 |
| mean reciprocal rank | 0.56 |
| mean nDCG@10 | 0.61 |
| false positives on absence labels | 0 |

**Decision: gate the absence count at zero, and gate nothing else yet.** A result
returned for a term that appears nowhere in the corpus is a defect under any
threshold anyone would later choose, so it is safe to fail a build on. The other
four are not: 8 labels over 11 files is too small a sample to turn into a
requirement, and one of the five figures is depressed by a *known missing
capability* rather than by ranking — see below. Freezing 0.32 as a floor would
enshrine a number nobody argued for, which is the failure EPIC-096 refused in
advance.

A real threshold becomes arguable when the corpus is large enough for a figure to
move meaningfully and when file content is indexed. Both are on record: EPIC-096
§16 calls its coverage "a starting set", and content indexing is EPIC-087.

**What the low precision actually measures.** `text-authentication` scored zero on
every metric, and the cause is not ranking. Measured: the query `authenticate`
reaches **only a commit entity**, because the word appears in a commit message and
in no file path — and Ferret does not index file *bodies* (EPIC-087). The label
expects the file that commit touched, which text retrieval has no path to today.
`text-invoice` loses half its recall the same way.

That is the honest reading, and it is why the labels were **not** adjusted to suit
the result. A label rewritten to expect what already scores well is a label shaped
by the answer, and a golden dataset does not survive that. The number is low
because a capability is missing, and now it is a measured 0.32 rather than an
impression.
