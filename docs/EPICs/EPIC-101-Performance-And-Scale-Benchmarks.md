# EPIC-101 — Performance & Scale Benchmarks

**Status: VALIDATED | Priority: P1 | Domain: Quality & Evaluation**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Quality & Evaluation; only
> the specification is new.

## 1. Objective

Measure Ferret at a size where the answers change — and prove that every index
it declares is the plan PostgreSQL actually chooses.

## 2. Value

Five Epics defer performance here, and one of them names the part nobody has
built: **EPIC-086 §4 — "Query performance, indexes and plans."**

Ferret declares **22 indexes**. Nothing checks that any of them is used. An
index PostgreSQL never chooses is not neutral: it is a write cost paid on every
insert, an object in every backup, and a false sense that a query is fast. The
only way to find one is to ask the planner, at a size where the planner's answer
means something.

This project has already paid for learning that. Issue #109 was a query-plan
test that passed only while the table had no statistics:

> *"On 74 rows a sequential scan **is** cheaper, so the assertion held only
> until autoanalyze happened to run… The flake was never a race in Ferret; it
> was a test measuring the absence of statistics."*

The fix there was local — one table, seeded and `ANALYZE`d. This Epic makes it
systematic.

- **EPIC-086 §4** — query performance, indexes and plans.
- **EPIC-097 §4** — a performance budget for parsing.
- **EPIC-098 §4** — "Performance — EPIC-101. Quality and speed are different
  numbers", and §173: "EPIC-101 owns the question."
- **EPIC-100 §4** — performance of the security path.
- **EPIC-056's validation** — "EPIC-101 owns scale."

## 3. Scope

- **An index-reachability sweep**: every declared index, asserted to be the plan
  chosen for a query at a scale where it is genuinely cheaper.
- **Read-path budgets at scale** — retrieval, traversal and symbol lookup
  measured at a size the planner takes seriously, not at fixture size.
- **The permission filter's cost** — EPIC-100 §4's question, measured.
- **A recorded baseline** in `docs/Performance/`, so a later Epic compares
  rather than re-derives.

## 4. Non-scope

- **Tuning anything.** This measures and reports. A budget breach is a finding
  for the Epic that owns the path, not a licence to add an index here.
- **Adding or removing an index.** If the sweep finds an unused one, that is a
  recorded finding and the owning Epic's decision — dropping an index is a
  migration, and §16 says why this Epic does not write one.
- **Quality.** EPIC-098 owns precision and recall; this owns milliseconds.
  "Quality and speed are different numbers" is that Epic's phrasing and it
  holds.
- **A parsing budget.** EPIC-097 §4 sent it here, and §16 declines it: parsing
  cost is dominated by grammar and file size, both of which EPIC-097's own
  corpus already varies, and a budget here would measure that corpus rather
  than Ferret.
- **Load or soak testing.** A single process, a single connection pool, one
  measurement pass. Concurrency is EPIC-079's and EPIC-093's.
- **Cold start.** EPIC-002's budgets already own it and are not restated.

## 5. Inputs

The schema's declared indexes; a seeded index large enough for the planner;
`EXPLAIN` output; `performance.now()`.

## 6. Outputs

`tests/integration/storage/scale.test.ts` and a baseline in
`docs/Performance/EPIC-101-scale-baseline-*.json`.

## 7. Dependencies

EPIC-086 (the schema and its indexes), EPIC-002 (the budget shape and the
baseline convention this follows), EPIC-056/057 (the read paths), EPIC-058
(the permission filter).

## 8. Contracts

### 8.1 A plan assertion, not a stopwatch, is what catches a missing index

A timing assertion at fixture scale proves nothing: issue #109's whole content
is that PostgreSQL was right to sequentially scan 74 rows. So the primary
assertion is **which plan the planner chose**, and the seeding exists to make
that choice meaningful rather than to make the query slow.

### 8.2 Statistics are made current, never left to a background worker

`ANALYZE` after seeding, every time. Issue #109's defect was "a plan that
depended on whether a background worker had run yet", and a sweep with the same
dependency would flake in exactly the same way — worse, because it would flake
across 22 assertions rather than one.

### 8.3 Every declared index is named, and each is either used or reported

The sweep enumerates the indexes from `pg_indexes` rather than a list kept
beside it, so an index added by a later migration is covered without anyone
remembering — and §17 records that the schema *file* would have missed the
migration-declared ones, which are the indexes most worth checking. For each, either a query exists that the planner answers with it —
or the index is **reported as unexercised**, which is a finding and not a
failure.

The distinction matters. An index may be unexercised because no query needs it
(a real defect: a write cost with no reader) or because *this Epic did not write
the query* (a gap in the sweep). Only a reader can tell those apart, so the
sweep reports the list and pins its size — §8.6.

### 8.4 A budget is a ceiling a regression would breach

EPIC-002's rule, restated because it is the reason these budgets survive:
*"several times the figures observed on a laptop and on CI, because a budget
tight enough to flake is a budget that gets deleted — and a deleted budget
catches nothing."*

### 8.5 The permission filter is measured against the same query without it

EPIC-100 §4 asks what the security path costs. The honest answer is a
*difference*, so the same query is measured with and without a scope, and the
ratio is reported. An absolute number would be a fact about the machine.

### 8.6 The unexercised list is pinned, so a new index is a visible diff

The count of unexercised indexes is asserted exactly. Adding a 23rd index
without a query fails the build; writing a query for an existing one also fails,
and both are the review moment. Same shape as the limitation sweep EPIC-070
built for issue #117, and for the same reason: a number nobody is asked about
drifts.

### 8.7 The baseline is written only when asked

`FERRET_RECORD_BASELINE=1`, EPIC-002's convention: "an ordinary run must leave
the repository exactly as it found it, and someone re-recording the baseline
knows they are doing it."

## 9. Acceptance criteria

- **AC-1** The sweep enumerates every index the database actually has, read from
  `pg_indexes` rather than from a list — §17 records why the schema file is the
  wrong source.
- **AC-2** The entity lookup by canonical key uses its index.
- **AC-3** The evidence lookup by subject uses `evidence_subject_idx`.
- **AC-4** The relationship lookup by endpoint uses its index.
- **AC-5** The symbol prefix lookup uses its index — the `text_pattern_ops` case
  EPIC-034 recorded.
- **AC-6** Each assertion runs against a table seeded large enough that the
  index is the cheaper plan, with statistics current.
- **AC-7** An index the sweep does not exercise is reported, not silently
  passed.
- **AC-8** The unexercised count is pinned, so adding an index is a visible
  diff.
- **AC-9** Retrieval at scale stays within its ceiling at p95.
- **AC-10** Traversal at scale stays within its ceiling at p95.
- **AC-11** The permission filter's cost is reported as a ratio against the same
  query unscoped.
- **AC-12** Dropping a declared index makes its assertion fail — the property
  that makes the sweep worth having.
- **AC-13** The baseline is written only under `FERRET_RECORD_BASELINE=1`.
- **AC-14** The suite skips with a stated reason when no database is available,
  like every other integration suite.

## 10. Test requirements

**Integration (real PostgreSQL)** — all of it. A plan is a property of a real
planner with real statistics, and nothing here can be faked.

**Failure** — an index dropped mid-test (AC-12), which is the only way to prove
the assertion is load-bearing.

**Regression** — EPIC-002's budgets unchanged; the existing plan assertions in
`entity-store`, `evidence-store`, `relationship-store` and `symbol-index` left
alone, because each belongs to its own Epic's suite.

## 11. Security requirements

None added. AC-11 measures the permission filter and does not change it; the
seeded rows carry no credential-shaped content.

## 12. Observability

The measurement table on stderr, and the baseline document. Both name the
budget beside the figure, so a reader sees the headroom rather than only the
number.

## 13. Performance constraints

The suite seeds tens of thousands of rows, so it is the slowest in the project.
One seeding pass shared across every assertion, and the seed is deterministic so
two runs measure the same table.

## 14. Definition of Done

Scope implemented; AC-1 to AC-14 with evidence in
`validation/EPIC-101-VALIDATION.md`; `npm run verify` green; the registry
updated; the deferrals in EPIC-086, EPIC-097, EPIC-098, EPIC-100 and EPIC-056's
validation struck with dated notes — EPIC-097's recording that this Epic
**declined** the parsing budget.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.1: the planner's answer rather than a
  guess about it, and §8.3 reports an unexercised index rather than implying
  coverage.
- **§21 Reproducibility** — §8.2: statistics current, seed deterministic.
- **§13 Diagnosability** — the baseline is comparable across releases.
- **§5 Reuse Before Reinvent** — EPIC-002's budget shape, baseline convention
  and `FERRET_RECORD_BASELINE` flag, unchanged.

## 16. Raised, not absorbed

- **A parsing budget is declined.** EPIC-097 §4 sent one here. Parsing cost is
  dominated by grammar and file size, and EPIC-097's corpus already varies both
  — so a budget here would be measuring that corpus. A parse-rate figure that
  moved when somebody added a fixture would be worse than no figure.
- **This Epic does not drop an unused index.** Dropping one is a migration, and
  a migration written to satisfy a benchmark is a schema change nobody reviewed
  on its merits. The sweep reports; the owning Epic decides.
- **Every figure is a laptop figure.** The budgets are ceilings and the baseline
  is a record, but neither is a claim about production hardware. Two baselines on
  two machines are not comparable, which is why the file name carries the
  platform — EPIC-002's convention, kept.
- **Concurrency is not measured.** One pool, one pass. What happens under twenty
  simultaneous indexers is EPIC-079's and EPIC-093's, and a benchmark that
  guessed at it would produce a number nobody could act on.
- **`EXPLAIN` without `ANALYZE`.** The plan is asserted; the row counts the
  planner *estimated* are not compared against reality. A plan that is chosen
  and then wrong about cardinality is a different defect, and finding it needs
  `EXPLAIN ANALYZE` on production-shaped data.

## 17. Recorded during implementation

**A scale fixture has to be *selective*, not merely large — and the first one
was not.** Every seeded relationship shared one `from_id`, so `WHERE from_id =
$1` matched 13 334 of 20 000 rows and PostgreSQL correctly chose a sequential
scan. The fixture was wrong, not the index: an index is only the cheaper plan
when a lookup returns a small fraction of the table. This is issue #109's lesson
from the other direction — that one was a table too *small* for an index to win,
this was a lookup too *broad* — and both produce a plan assertion that measures
the fixture instead of the schema.

**`pg_indexes` is the right source, not the schema file.** AC-1 was written
expecting to parse `src/storage/schema/`; migrations `0007`, `0010` and `0011`
declare indexes in raw SQL, including the `text_pattern_ops` one AC-5 covers
and which Drizzle cannot express. A schema sweep would have missed exactly the
indexes most worth checking.

**A control test, so the sweep can fail.** `count(*)` must still choose a
sequential scan — without it, a sweep asserting "an index was used" would pass
against a planner that had lost its statistics and was index-scanning
everything, which is issue #109 inverted.

Full evidence in [validation](validation/EPIC-101-VALIDATION.md).
