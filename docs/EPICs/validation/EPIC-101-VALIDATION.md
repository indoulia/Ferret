# EPIC-101 — Performance & Scale Benchmarks · Validation Evidence

**Assessed against:** working tree on top of `90094b2`
**Date:** 2026-09-03
**Environment:** real PostgreSQL 17 + pgvector, 20 000 entities, 20 000
evidence rows and 20 040 relationships, `ANALYZE`d. Baseline recorded to
`docs/Performance/EPIC-101-scale-baseline-win32.json`.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 indexes enumerated, not listed | **MET** | `scale.test.ts` "finds the indexes from the catalogue" — read from `pg_indexes`, which covers the migration-declared ones the Drizzle schema does not carry |
| AC-2 entity by canonical key uses its index | **MET** | "looks an entity up by canonical key through its index" |
| AC-3 evidence by subject uses `evidence_subject_idx` | **MET** | "reads one subject s evidence through evidence_subject_idx" |
| AC-4 relationship by endpoint uses its index | **MET** | "reads one entity s outgoing edges through its index", plus "reads an incoming edge through relationship_to_idx" |
| AC-5 the symbol prefix lookup uses the `text_pattern_ops` index | **MET** | "finds a symbol by name prefix through the text_pattern_ops index" — the index EPIC-034 recorded as the difference between "fine on a fixture" and "unusable on a real repository" |
| AC-6 seeded large enough, statistics current | **MET** | 20 000 rows per table and an explicit `ANALYZE`; the control test asserts a `count(*)` still chooses a sequential scan, so the sweep can tell "index chosen" from "index always chosen" |
| AC-7 an unexercised index is reported | **MET** | "pins how many indexes this sweep does not exercise" — the names are in the assertion message and the baseline |
| AC-8 the count is pinned | **MET** | `PINNED_UNEXERCISED = 27`, asserted exactly |
| AC-9 retrieval within its ceiling at p95 | **MET** | entity by key 0.85 ms against 100 ms; evidence by subject 0.87 ms against 150 ms |
| AC-10 traversal within its ceiling at p95 | **MET** | one hop 0.84 ms against 150 ms |
| AC-11 the permission filter reported as a ratio | **MET** | "reports the scoped read as a ratio of the unscoped one" — **1.08×** measured |
| AC-12 dropping an index fails its assertion | **MET** | "fails to find the index once it is dropped" — `evidence_subject_idx` dropped, the plan becomes a sequential scan, and the index is restored in `finally` |
| AC-13 the baseline is opt-in | **MET** | `FERRET_RECORD_BASELINE=1` only, EPIC-002's convention |
| AC-14 skips with a stated reason without a database | **MET** | `describeDb` with `SKIP_REASON` in the suite title, as every integration suite does |

Fourteen of fourteen MET. `npm run verify` green on top of `90094b2`:
150 files, 3 080 passed, 3 skipped.

## Measured

| read | median | p95 | ceiling |
| --- | --- | --- | --- |
| entity by canonical key | 0.74 ms | 0.85 ms | 100 ms |
| evidence by subject | 0.75 ms | 0.87 ms | 150 ms |
| edges by endpoint, one hop | 0.73 ms | 0.84 ms | 150 ms |
| symbol by name prefix | 1.6 ms | 2.2 ms | 200 ms |

**The permission filter costs 1.08×** — 1.94 ms unscoped against 1.98 ms
scoped, at p95. That is EPIC-100 §4's question answered: the security path is
not where Ferret's time goes.

Every figure has two orders of magnitude of headroom against its ceiling, which
is the point of §8.4's rule — these are ceilings a regression would breach, not
targets. A budget tight enough to flake is a budget that gets deleted.

## Found while implementing

**A scale fixture has to be *selective*, not merely large — and the first one
was not.** Every seeded relationship was given the same `from_id`, so
`WHERE from_id = $1` matched **13 334 of 20 000 rows** and PostgreSQL correctly
chose a sequential scan:

```
Seq Scan on relationship (cost=0.00..534.01 rows=13334 width=189)
  Filter: ((from_id = '...'::uuid) AND (type = 'repository_contains_file'::text))
```

The fixture was wrong, not the index. A real graph has many distinct endpoints,
and an index is only the cheaper plan when a lookup returns a small fraction of
the table. The seed now writes one edge per file so `from_id` is distinct per
row, and the assertion queries a *file* — which has one outgoing edge — rather
than the repository, which has forty.

This is the same lesson as issue #109 from the other direction. That one was a
table too *small* for an index to win; this one was a lookup too *broad*. Both
produce a plan assertion that measures the fixture instead of the schema.

**`evidence_permission_idx` needed a selective scope for the same reason.** Half
the seeded rows carried a scope, which is not selective enough — so the test
gives one field's rows a rare scope and asks for that, which is the shape a real
multi-repository index produces.

**`pg_indexes` is the right source, not the schema file.** Migrations `0007`,
`0010` and `0011` declare indexes in raw SQL — including the `text_pattern_ops`
one AC-5 covers, which Drizzle cannot express — so a sweep over
`src/storage/schema/` would have missed exactly the indexes most worth checking.
Reading the catalogue also means an index added by a later migration is covered
without anyone remembering.

**Seven indexes gained their first plan assertion**, including
`entity_last_indexed_idx`, which is the index EPIC-078's reconcile pass depends
on for its oldest-first ordering and which nothing had ever checked.

## Decisions worth recording

**A plan assertion, not a stopwatch.** A timing assertion at fixture scale
proves nothing — issue #109's whole content is that PostgreSQL was right to scan
74 rows. So the primary assertion is *which plan the planner chose*, and the
seeding exists to make that choice meaningful rather than to make the query
slow. The timings are secondary and have two orders of magnitude of headroom,
which is honest about what they are for.

**A control test, so the sweep can fail.** `count(*)` must still choose a
sequential scan. Without it, a sweep that asserted "an index was used" would
pass against a database whose planner had lost its statistics and was
index-scanning everything — which is issue #109 inverted.

**The unexercised list is reported, not failed.** An index may be unexercised
because no query needs it — a real defect, a write cost with no reader — or
because this Epic did not write the query. Only a reader can tell those apart,
so the count is pinned at 27 and both directions of change fail the build. Same
shape as the limitation sweep for issue #117, and for the same reason: a number
nobody is asked about drifts.

**This Epic drops nothing.** Dropping an unused index is a migration, and a
migration written to satisfy a benchmark is a schema change nobody reviewed on
its merits. The sweep reports; the owning Epic decides.

## Limitations, recorded

- **27 indexes have no plan assertion.** Most are on tables this fixture does
  not seed — `derived_artifact`, `identity_alias`, `index_run` — plus the three
  GIN `*_search_idx` indexes, which need a `tsquery` rather than an equality and
  belong with EPIC-053's own suite. The list is in the baseline document.
- **A parsing budget is declined**, and EPIC-097 §4 sent one here. Parsing cost
  is dominated by grammar and file size, and EPIC-097's corpus already varies
  both — so a budget here would measure that corpus. A parse-rate figure that
  moved when somebody added a fixture would be worse than no figure.
- **Every figure is a laptop figure.** The baseline's name carries the platform,
  which is EPIC-002's convention, and two baselines on two machines are not
  comparable.
- **Concurrency is not measured.** One pool, one pass. Twenty simultaneous
  indexers is EPIC-079's and EPIC-093's question.
- **`EXPLAIN` without `ANALYZE`.** The plan is asserted; the planner's
  *estimated* cardinality is not compared against reality. A plan chosen and
  then wrong about row counts is a different defect, and finding it needs
  production-shaped data.
- **20 000 rows is not a large index.** It is large enough for the planner to
  prefer an index, which is what these assertions need — not large enough to
  say anything about a million-commit repository.
