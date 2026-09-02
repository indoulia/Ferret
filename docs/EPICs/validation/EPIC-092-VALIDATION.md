# EPIC-092 — Metrics & Tracing · Validation Evidence

**Assessed against:** working tree on top of `d78c714`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, a real index run.

## Acceptance criteria

| AC | Verdict | Evidence (`tests/unit/observability.test.ts` unless noted) |
| --- | --- | --- |
| AC-1 counter | **MET** | "counts" |
| AC-2 histogram count/sum/min/max/buckets | **MET** | "records count, sum, min, max and buckets" |
| AC-3 same name, different unit refused | **MET** | "refuses the same name with a different unit"; same unit twice is allowed, so two modules may both declare |
| AC-4 unregistered name refused | **MET** | "refuses a recording on a name nobody registered"; also counter-as-histogram and the reverse |
| AC-5 span duration | **MET** | "records a duration for work that took time" |
| AC-6 nested span names its parent | **MET** | "names its parent without the caller passing one" |
| AC-7 failed span rethrows | **MET** | "records a failed span and rethrows", plus stack unwinding after failure |
| AC-8 siblings are not each other's parents | **MET** | "does not make siblings each other's parents" |
| AC-9 valid `traceparent`, trace id from the invocation | **MET** | four tests, including rejection of four malformed forms |
| AC-10 one trace id per process | **MET** | "shares one trace id across every span" |
| AC-11 snapshot stable to serialise | **MET** | identical JSON for identical state; names sorted; frozen; empty-but-well-formed |
| AC-12 snapshot in the run journal | **MET** | `content-indexing.test.ts` "records a snapshot into the run journal" |
| AC-13 two runs comparable, version beside the number | **MET** | "keeps the version beside the number, so two runs are comparable" |
| AC-14 `ferret status --json` carries it | **MET** | `status.ts` reports `defaultMetrics().snapshot()` on the path that does not depend on the log stream |
| AC-15 `silent` emits none, snapshot still readable | **MET** | the span record is a `debug` log line, so the level gate applies; AC-14's path does not |
| AC-16 duration per stage over a real run | **MET** | "reports a duration per stage over a real run" — stage and per-file histograms both non-empty |
| AC-17 no regression | **MET** | `verify` green: 133 files, 2839 passed, 3 skipped; EPIC-098's figures unchanged |

Seventeen of seventeen MET.

## Found while implementing

**The trace id was 24 hex characters, not 32.** `randomBytes(4)` beside a 16-hex
invocation id gives 24, and a W3C trace id is 16 bytes. Every `traceparent` this
Epic produced would have been rejected by its own validator. Caught by AC-9.

**The content stage was handed the process registry, not the run's.** The
indexer resolved `dependencies.metrics` for itself and did not pass it down, so a
caller holding its own registry saw stage timings and no per-file ones — a
snapshot that is half true, which is worse than one that is empty. Caught by
AC-16's second assertion.

**The package-size gate fired, and was re-baselined by its own procedure.**
Non-grammar output reached 2 258 135 against a 2 250 000 limit, 0.36% over. The
gate's comment requires measuring before moving the number; the nine modules this
session added account for ~101 kB, nothing improper ships (0 source maps, 0
tests, 0 fixtures, re-measured), and the limit moved to 2 530 000 keeping the
same 12% headroom. The measurement is recorded inline at the assertion.

## Limitations, recorded

- **No exporter.** An operator wanting Prometheus or OTLP reads the NDJSON. §8.1
  takes the format and declines the SDK.
- **No per-second resolution.** A snapshot is the totals at the end of a run;
  sub-run resolution needs a time-series store.
- **No sampling.** Every span is recorded. §8.3 names the trigger for revisiting:
  a run whose span output dominates its work.
- **A client's trace context is still refused.** EPIC-091 §8 forbids accepting a
  correlation id from outside, so joining a caller's trace needs that rule
  revisited by whoever owns it.
- **Four places are instrumented** (§8.6): index stages, search, traversal with
  its hop count, the content stage per file, and `verify`. A fifth is added when
  a question is asked of it.
