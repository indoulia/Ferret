# EPIC-096 — Golden Evaluation Dataset

**Status: IMPLEMENTED | Priority: P0 | Domain: Evaluation & Quality**

> **Specification note.** The registry approved this Epic by name, domain and
> priority (`README.md:210`); no specification was ever written. This document
> supplies one.
>
> Unlike EPIC-083, this Epic has **almost nothing parked on it by name**. Two
> records describe the gap it fills — `validation/EPIC-042-VALIDATION.md:96` and
> `validation/EPIC-044-045-VALIDATION.md:100` — and both name EPIC-098, the
> harness, rather than the dataset a harness would need. The requirement itself
> comes from Governance §19, quoted in §2. Where this specification decides
> something no record dictated, §16 says so.
>
> §2 measures `faa8334` and describes the repository as it is.

## 1. Objective

A committed, versioned, self-consistent corpus with labelled expectations, so
retrieval and parsing quality can be **measured** rather than asserted.

## 2. Problem, measured

Governance §19 is unambiguous:

> Golden datasets must be used to measure retrieval precision, recall, ranking,
> evidence correctness, and completeness. "Perfect" parsing or retrieval is not
> an acceptable quality claim without measurable validation.

Measured on `faa8334`, none of that exists.

**Nothing computes a retrieval metric.** A search of `src/` and `tests/` for
precision, recall, nDCG, MRR or F1 returns five hits: four are the
`doublePrecision` column type and the fifth is a comment about regex precision. There is no
measured retrieval quality figure for Ferret, and no code that could produce one.

**Every retrieval Epic was validated by example.** EPIC-052, EPIC-053 and
EPIC-055 are VALIDATED, and their evidence demonstrates that specific queries
return specific rows. That is a correctness demonstration and it is worth having;
it is not a rate. Nothing states what fraction of answerable questions Ferret
answers, or what fraction of what it returns is relevant.

**Two records already name the gap.** `validation/EPIC-042-VALIDATION.md:96` —
the decision-extraction phrasings "were chosen for precision on the examples
tested, **not measured against a corpus**". `validation/EPIC-044-045-VALIDATION.md:100`
records source-authority rules never "validated against retrieval quality". Both
assign the harness to EPIC-098 and neither supplies what a harness would measure
against.

**The only corpus that exists is not usable here.** `spikes/corpus` holds 2,039
generated files, and `spikes/README.md` is explicit: "This is **not Ferret**.
Nothing here ships." It is `.gitignore`d at `.gitignore:19`, regenerated from a
seed, and belongs to EPIC-005's technology evaluation. A dataset that is not in
the repository cannot be a golden dataset.

**What does exist, and is load-bearing.** Entity identity is already
deterministic: `canonicalKey(kind, sourceSystem, scope, sourceId)` at
`src/domain/identity.ts:54`, hashed to a UUIDv8 by `canonicalId`, documented as
"stable across re-ingestion" (`src/domain/entity.ts:110`). An expectation can
therefore be written against source identity and resolved to an id by the same
function the indexer uses — which is what makes labels survive a re-index.

## 3. Scope

1. **A committed, deterministic corpus** — in the repository, reproducible byte
   for byte, and small enough that running against it is not a chore.
2. **A labelled expectation set** — questions with known-correct answers, graded
   where ranking is the thing being judged.
3. **Labels keyed on source identity**, resolved through `canonicalId`, so a
   label and the index cannot disagree about what an answer *is*.
4. **A loader and a schema**, shipped in the package, so EPIC-097 through
   EPIC-100 consume one dataset rather than four.
5. **Self-consistency validation** — every label must resolve to something the
   corpus actually contains. A dataset that references what is not there measures
   fiction, and this is the one property this Epic can prove without a harness.
6. **A version and a checksum**, so a quality figure can name the dataset it was
   measured against (Governance §21).

## 4. Non-scope

Named here so it is not quietly adopted:

- **Computing any metric.** Precision, recall and ranking are EPIC-098's; parser
  structure is EPIC-097's; provider conformance is EPIC-099's; security
  regression is EPIC-100's. This Epic supplies the data and the identity
  contract, and measures nothing. A dataset that also scored itself would make
  the four harnesses four copies of one scorer.
- **Setting a quality threshold.** A number that passes or fails a build is a
  policy decision, and choosing one before anything has been measured would be
  inventing a target rather than deriving it. The first measurement is what makes
  a threshold arguable; EPIC-098 raises it with data.
- **Reusing `spikes/corpus`.** EPIC-005's, gitignored, generated, and explicitly
  non-shipping. Adopting it would take that Epic's scope and commit 110 MB.
- **A corpus of third-party repositories.** Licence provenance and
  reproducibility both argue against it, and neither is this Epic's to resolve.
- **Semantic or embedding-based relevance.** Ferret ships no embedding provider
  by design; labels that assumed one would be unmeasurable today.
- **Performance and scale benchmarks** — EPIC-101, and already partly served by
  `scripts/baseline.mjs`.
- **Judging an answer's prose.** A context pack's wording is not gradeable
  against a fixture; what is gradeable is which entities and evidence it cites.

## 5. Inputs

- `canonicalKey`, `canonicalId` (EPIC-006) — the identity labels resolve through.
- `EntityKind`, `RelationshipKind`, `EvidenceMethod` (EPIC-006/007/008) — the
  vocabulary a label is written in.
- `tests/support/git-fixtures.ts` — deterministic repository construction, if the
  corpus needs history.
- `scripts/copy-migrations.mjs` and `copy-grammars.mjs` — the established pattern
  for shipping non-TypeScript assets into `dist/`.

## 6. Outputs

- A committed corpus under a stable path, with a manifest naming its version and
  content checksum.
- A labelled expectation set: queries, expected results with graded relevance,
  and the identity each expectation resolves to.
- `loadGoldenDataset()` and its schema, exported so a harness in this package or
  a provider's own suite can consume it.
- A validation that the dataset is self-consistent, run by `npm run verify`.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-006 Canonical Entity Model | VALIDATED | deterministic identity |
| EPIC-008 Evidence & Provenance Model | VALIDATED | what an evidence expectation names |
| EPIC-022/023 File Discovery & Identity | VALIDATED | how a corpus file becomes an entity |
| EPIC-052/053 Retrieval | VALIDATED | the query shapes a label describes |

Nothing here depends on EPIC-097–100; the dependency runs the other way, which is
why this Epic is first in its domain.

## 8. Contracts

Other Epics may rely on the following.

- **The corpus is in the repository and is reproducible.** Not generated at test
  time, not downloaded, not a submodule. A quality figure that cannot be
  reproduced from a checkout is not evidence.
- **A label names source identity, never a generated id.** It carries kind,
  source system and source id, and the loader resolves those through
  `canonicalId` — the same function the indexer uses. Writing a UUID into a
  fixture would make the dataset a snapshot of one indexing run.
- **Scope is bound at resolution, not written into the label.** A file entity is
  keyed within its repository, and a repository's id derives from its path — so a
  corpus indexed from a temporary directory produces different ids every run. A
  label therefore names a *symbolic* scope and the loader binds it to the actual
  repository id when the measurement happens. This is what lets one dataset be
  measured against a corpus checked out anywhere.
- **The dataset is versioned and checksummed.** Every measurement cites both, so
  "precision improved" cannot silently mean "the dataset changed".
- **Relevance is graded, not binary.** Ranking is one of the five things
  Governance §19 names, and a binary label cannot distinguish a right answer in
  position one from the same answer in position nine.
- **An expectation may assert absence.** "This query must return nothing" is a
  measurable claim and the only way a precision figure can be honest about
  false positives.
- **The dataset validates itself, and that validation is part of `verify`.** A
  label that resolves to nothing in the corpus fails the build rather than
  quietly scoring zero in a harness nobody has written yet.
- **This Epic scores nothing.** A harness reads the dataset; the dataset never
  reads a harness.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | A corpus is committed to the repository and its content checksum is reproducible from a clean checkout. | §8; Gov §21 |
| AC-2 | The corpus is not `spikes/corpus` and does not depend on it. | EPIC-005 non-scope; `.gitignore:19` |
| AC-3 | A labelled expectation set exists, covering exact lookup, full-text retrieval, and absence. | Gov §19; EPIC-052/053 |
| AC-4 | Every expectation names source identity, and resolves through `canonicalId` rather than a stored UUID. | §8; `identity.ts:54` |
| AC-5 | Relevance is graded, so ranking is measurable. | Gov §19 ("ranking") |
| AC-6 | At least one expectation asserts that a query returns nothing. | §8 |
| AC-7 | Evidence expectations name the observation a claim should be traceable to. | Gov §19 ("evidence correctness") |
| AC-8 | The dataset carries a version and a checksum, and the loader exposes both. | Gov §21 |
| AC-9 | Loading a dataset whose label resolves to nothing in the corpus fails, naming the label. | §8 |
| AC-10 | The self-consistency check runs in `npm run verify`. | §8 |
| AC-11 | The loader is exported from the package and usable without a database. | §6; EPIC-099 |
| AC-12 | The dataset computes no metric and imports no harness. | §4 |
| AC-13 | The corpus is licence-clean: every file is authored for this repository. | §4 |

## 10. Test requirements

- Unit: the loader resolves an identity to the same id the indexer derives —
  asserted against `canonicalId` directly, not against a copy of the rule.
- Unit: a deliberately broken label (naming a file the corpus lacks) fails to
  load, and the error names the label.
- Unit: the manifest checksum matches the corpus on disk.
- Integration, real PostgreSQL: index the corpus and assert every expectation's
  identity resolves to an entity that exists. This is the criterion that proves
  labels and the indexer agree, and it cannot be proved without indexing.
- The suite must fail if the corpus is empty, so a passing run is not a vacuous
  one.

## 11. Security

- Corpus content is authored for this repository, so nothing third-party or
  licence-encumbered enters the tree (AC-13).
- The corpus is indexed by Ferret like any other source and is therefore subject
  to EPIC-082's secret detection. It must contain no value that looks like a
  credential, or the dataset would train a false expectation into EPIC-100.
- A label is data, never a path or a command the loader executes.

## 12. Observability

The loader reports the dataset version, checksum, label count and corpus file
count, so a harness can state what it measured against rather than "the golden
dataset".

## 13. Performance constraints

Indexing the corpus must stay well inside a test timeout — target under 30
seconds against a local PostgreSQL. A dataset that is slow to run is a dataset
that gets run rarely, and a quality gate nobody runs is not a gate.

## 14. Definition of Done

All acceptance criteria pass; the corpus indexes against real PostgreSQL and
every expectation resolves; `npm run verify` green including the self-consistency
check; limitations recorded in §16.

## 15. Governance alignment

- **§19 Testing and Quality** — the requirement this Epic exists to serve, quoted
  in §2 in full.
- **§21 Versioning and Reproducibility** — "derived-result formats must be
  versioned where changes can affect reproducibility". A quality figure is a
  derived result and the dataset is its input.
- **§6** — the dataset is *evidence*, so it is immutable in meaning: changing a
  label changes what a past measurement meant, which is why AC-8 exists.
- **§2** — small enough to run, not a second product.

## 16. Raised, not absorbed

- **What the corpus is, is this Epic's decision.** Nothing on record says whether
  the golden corpus should be a synthetic fixture, a pinned commit of Ferret
  itself, or a curated set of authored files. Ferret's own repository is tempting
  — it is real, and it is already indexed for dogfooding — and it is rejected
  here for one reason: its answers move every time someone commits, so a
  precision figure would drift without anyone changing retrieval. A committed,
  authored corpus is chosen because a golden dataset whose ground truth changes
  underneath it is not golden.
- **No quality threshold is set, deliberately.** The first measurement is the
  argument for a threshold, and this Epic produces none. EPIC-098 inherits an
  unmeasured product and a way to measure it, not a target to hit.
- **Coverage is a starting set, not a claim of sufficiency.** The first dataset
  covers the retrieval shapes Ferret has today. It says nothing about how many
  labels are enough, and the honest answer will come from the first harness run
  that finds a gap.
