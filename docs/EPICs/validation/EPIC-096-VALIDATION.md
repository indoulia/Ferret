# EPIC-096 — Golden Evaluation Dataset · Validation Evidence

**Assessed against:** working tree on top of `faa8334`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`.

## Before

Governance §19: "Golden datasets must be used to measure retrieval precision,
recall, ranking, evidence correctness, and completeness. 'Perfect' parsing or
retrieval is not an acceptable quality claim without measurable validation."

Measured on `faa8334`, none of it existed. Searching `src/` and `tests/` for
precision, recall, nDCG, MRR or F1 returned five hits — four `doublePrecision`
column types and one comment about regex precision. EPIC-052, EPIC-053 and
EPIC-055 are VALIDATED on demonstrations that specific queries return specific
rows: a correctness claim, not a rate. Two records already named the gap
(`validation/EPIC-042-VALIDATION.md:96`, `validation/EPIC-044-045-VALIDATION.md:100`)
and both assigned the harness to EPIC-098 without supplying anything to measure
against.

The only corpus in the tree, `spikes/corpus`, is EPIC-005's: generated,
`.gitignore`d at line 19, and explicitly "not Ferret. Nothing here ships."

## After

A committed corpus of 11 authored files, nine declared commits, eight labelled
queries (two of them absences) and two evidence expectations. It loads, verifies
its own checksum, refuses six distinct kinds of inconsistency, and every label
resolves to an entity a real index actually contains.

Ferret's retrieval quality is still **unmeasured**. This Epic supplies what a
measurement needs and deliberately performs none — see §4 of the specification.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 corpus committed and reproducible | MET | `datasets/golden/`, checksum `cbcb9d98…6790`; `golden-dataset.test.ts` — *"matches its manifest checksum"* |
| AC-2 not the spike corpus | MET | *"does not depend on the EPIC-005 spike corpus"*; no path contains `spikes` |
| AC-3 labels cover exact, text and absence | MET | 8 queries: 2 exact-path, 4 text, 2 absence |
| AC-4 identity resolved, never stored | MET | Unit: resolution asserted against `canonicalId`/`canonicalKey` directly. **Integration, real PostgreSQL**: every expected result resolves to an entity the indexer wrote |
| AC-5 relevance is graded | MET | *"grades relevance rather than labelling it present or absent"* — more than one grade in use |
| AC-6 at least one absence | MET | `absent-kubernetes`, `absent-graphql`; loading a dataset with none refuses |
| AC-7 evidence expectations | MET | Integration: each subject holds at least the observations its expectation requires |
| AC-8 versioned and checksummed | MET | Manifest carries both; loader exposes `checksum` and `computedChecksum`; drifted content refuses to load |
| AC-9 broken label fails, naming itself | MET | *"names the offending label"* asserts the error carries `exact-invoice-path` |
| AC-10 runs in `verify` | MET | Both suites are ordinary tests; `npm run verify` runs them |
| AC-11 exported, usable without a database | MET | Exported from `src/index.ts`; the unit suite loads and validates the dataset with no database at all |
| AC-12 computes no metric | MET | Exported surface is exactly `computeGoldenChecksum`, `loadGoldenDataset`, `resolveIdentity`; the module reaches no retrieval, storage, indexing, mcp or context module |
| AC-13 licence-clean | MET | All 11 corpus files authored in this commit; `scripts/` generated them from literals in the tree |

## What the refusals prove

The loader refuses six things, each with a test: a label naming a file the corpus
lacks, an unnamed scope, a corpus file no commit introduces, a dataset with no
absence expectation, two labels sharing an id, and content that has drifted from
the manifest.

That last one is the important one. A measurement cites a checksum, so a dataset
whose corpus has moved away from its manifest must not load — otherwise
"precision improved" can silently mean "the dataset changed". Recomputing is a
deliberate act: `npm run golden:checksum`.

The self-consistency check is what stops a harness measuring fiction. A label
naming a deleted file scores zero, and zero is indistinguishable from "retrieval
returned the wrong thing" — so it fails at load instead.

## Three things the implementation found

**Scope cannot live in a label.** A file entity is keyed within its repository
and a repository's id derives from where it was found, so a corpus indexed from a
temporary directory produces different ids every run. Labels therefore name a
*symbolic* scope that the loader binds at resolution. This was not in the
specification's first draft; it was added to §8 when the integration test made it
unavoidable.

**The digest had to normalise newlines.** Hashing raw bytes would have made the
checksum fail on a Windows checkout and pass on Linux — a checksum that is wrong
half the time is worse than none.

**The corpus is data, not source.** ESLint tried to type-check the corpus's `.ts`
files against this repository's `tsconfig` and failed the build. `eslint.config.js`
now ignores `datasets/golden/corpus/**`: the corpus answers to what it represents,
not to this repository's style rules.

## What is not demonstrated

- **No quality figure exists.** This Epic measures nothing, by design (§4). Ferret's
  precision and recall remain unknown, and EPIC-098 is what will produce them.
- **Labels target commit messages and file paths, not file bodies.** Ferret does
  not index file content yet (EPIC-087), so a text label can only match what is
  searchable today. The dataset will need extending when content arrives, and the
  checksum makes that visible rather than silent.
- **Coverage is a starting set.** Eight queries is enough to measure with and says
  nothing about how many are enough. The first harness run that finds a gap is the
  honest source of that number.
- **Ranking is labelled but unexercised.** Grades exist so ranking is measurable;
  nothing ranks against them yet, and EPIC-056/057 are P1.

## Run

`npm run verify` green: 102 files, 2247 passed, 3 skipped. Suites bearing on this
Epic: `golden-dataset.test.ts` unit (17, no database) and
`tests/integration/evaluation/golden-dataset.test.ts` (5, real PostgreSQL and
real `git`).
