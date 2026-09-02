# EPIC-092 — Metrics & Tracing

**Status: APPROVED | Priority: P1 | Domain: Reliability & Operations**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Reliability & Operations,
> where it has been named and prioritised since the registry was written; only
> the specification is new.

## 1. Objective

Say how long something took and how often it happened — as numbers a run
records, not as prose a reader has to count.

## 2. Value — four Epics parked it here, and one invited it

- **EPIC-004's validation** — "No metrics, tracing or history — health is
  point-in-time. *Was it healthy an hour ago* cannot be answered."
- **EPIC-091 §4** — "Metrics and tracing — EPIC-092. **No counters, no
  histograms, no spans, no parent/child propagation, no exporter.**"
- **EPIC-095 §4** — "Metrics, counters, histograms, tracing or history over
  time."
- **EPIC-094 §16** and **EPIC-099 §4** — timing for a repair, trend history for
  a conformance run.

And EPIC-091 left an explicit invitation rather than a boundary: "The invocation
id in §3.1 is a correlation key for reading stderr, **not** a trace id … If
EPIC-092 adopts W3C trace context, this field is renamed or subsumed, and this
paragraph is why that is cheap."

So today a run reports counts and a duration for itself, and nothing else can be
timed. `ferret verify` cannot say which stage was slow; a traversal cannot say
how many queries it made; an operator cannot answer whether last week's index was
slower than today's.

## 3. Scope

- **Counters and histograms** in a registry, named and dimensioned.
- **Spans** with parent/child and a duration, on EPIC-091's existing stream.
- **W3C trace context** as the propagation format, subsuming the invocation id
  exactly as EPIC-091 invited.
- **A snapshot** a caller can read, and which a run records into the journal —
  so history is answerable **without a new table**.
- **No exporter, no collector, no dependency** — §8.1.

## 4. Non-scope

- **An exporter or a collector.** §8.1. Nothing speaks OTLP, nothing opens a
  socket, and no daemon is required to read a number.
- **Aggregation across processes.** One process is one invocation (EPIC-091
  §3.1), and combining two is an operator's job with the NDJSON they already
  have.
- **Alerting, thresholds or dashboards.** Ferret reports; deciding what is too
  slow is a policy no Epic defines.
- **Sampling.** Every span is recorded. §8.3 records why that is affordable and
  what would change it.
- **A time-series table.** §8.4 — the run journal's `summary` is "free-shaped on
  purpose", and a second history table would be a second place a duration is
  defined.
- **Audit events** — EPIC-085. A metric is discardable; an audit event is a
  durable record with a retention policy, and EPIC-091 §4 already drew that line.
- **Instrumenting everything.** §8.6 names what is instrumented and why those.

## 5. Inputs

EPIC-091's logger and its invocation id; EPIC-094's run journal and its
`summary` column; the stages that already report counts.

## 6. Outputs

- `src/observability/` — the registry, the span, and the snapshot.
- Spans and metric records on the existing NDJSON stream.
- Metrics in `index_run.summary`, and in `ferret status --json`.
- No schema change; no migration; no dependency.

## 7. Dependencies

EPIC-091 (the stream, the level gate, redaction, the invocation id), EPIC-004
(the health surface a snapshot joins), EPIC-094 (the journal that gives history).

## 8. Contracts

### 8.1 No dependency, and the reason is on record

The obvious implementation is the OpenTelemetry SDK. It is not used, and this is
the same decision EPIC-091 made one layer down: it ships **NDJSON to stderr**
and says "redirecting it is the operator's job and the Unix answer", declining a
log shipper.

A metric is a name, a number and a few labels. A span is a name, two instants
and a parent. Neither needs a vendor SDK, an exporter pipeline or a background
flush thread, and Governance §14 requires infrastructure to be justified by
measured requirements while §23 warns against accumulating it for architectural
fashion.

What is adopted is the **format, not the runtime**: `traceparent` is a 55-character
string this Epic can produce in four lines, so a future exporter — or an
operator's own collector reading the NDJSON — inherits a standard identifier
rather than a Ferret invention. Taking the format and declining the SDK is the
whole of §8.1.

### 8.2 A metric is a name, a unit and labels — and the unit is not optional

Two instruments, because they answer the only two questions asked:

- **A counter** — how many times. Monotonic within a process.
- **A histogram** — how long, or how big. Recorded as count, sum, min, max and
  a bounded set of buckets.

Every instrument declares a **unit** at registration, and a recording in the
wrong unit is a programming error rather than a number that looks plausible.
`durationMs` and `bytes` read alike in JSON and mean nothing alike, which is how
a dashboard ends up claiming a 34-millisecond file is 34 megabytes.

Names are `ferret.<area>.<thing>` and are declared in one place, so the set is
greppable and two areas cannot register the same name with different units.

### 8.3 A span is a duration with a parent, and every one is recorded

A span opens, closes, and emits one record carrying its name, its duration, its
`traceparent`, its parent's span id, and whether it failed. Parent/child comes
from a per-process stack, so a nested `await` inside a stage is a child without
the caller threading anything.

**Every span is recorded — no sampling.** Ferret's spans are per stage and per
file, not per HTTP request: an index run over 600 files produces hundreds, not
millions. Sampling would add a policy, a bias and a reason to distrust a
count, to save an amount of output an operator can `grep -v`. What would change
it is a measured run whose span output dominates its work, and §16 records that
as the trigger rather than a guess.

A span that throws is recorded as failed **and rethrows**. An observability layer
that swallows an error is worse than no observability, and EPIC-093's isolation
already decides which failures are survivable.

### 8.4 History comes from the run journal, not a new table

EPIC-004 asked "was it healthy an hour ago". Migration `0012`'s own comment
answers where that lives: `summary` is `jsonb` and "free-shaped on purpose: the
counts an index run reports are EPIC-031's and change with it, and pinning them
into columns here would make this table a second place they are defined."

So a run's metric snapshot is written into `summary` when the run closes. "Was
it slower last week" becomes a query over `index_run`, which already carries
`started_at`, `finished_at`, `outcome`, `ferret_version` and `invocation`. **No
migration, no second history, and the version is already beside the number** —
which is what makes a comparison across two runs meaningful rather than
misleading.

A snapshot is a *sample*, not a stream: it records the totals at the moment the
run ended. Per-second resolution would need a time-series store, which §4
declines and §16 raises.

### 8.5 Metrics are on the log stream, and inherit its guarantees

A metric record is a log record with `operation: 'metrics.snapshot'`, at `info`.
That is not laziness — it means metrics inherit EPIC-091's redaction, its level
gate, its NDJSON framing and its one transport, and a caller that already
captures Ferret's stderr captures metrics without new configuration.

The consequence, stated: **metrics are level-gated**, so `--log-level silent`
emits none. That is correct — an operator who silenced the stream asked for
silence — and the in-process snapshot is still readable by `ferret status`,
which is the path that does not depend on the stream.

### 8.6 What is instrumented, and why only these

Instrumenting everything would be a diff nobody can review and a set of names
nobody chose. Four places, each because a question was already asked of it:

- **The index stages** — EPIC-031's counts exist and their durations do not.
- **Retrieval** — search and traversal, because EPIC-050 §13 makes a claim
  about query counts that nothing measures.
- **The content stage per file** — EPIC-108 reports parsed and unparsed, not how
  long parsing took.
- **`verify`** — EPIC-094 §16 asked for repair timing by name.

A fifth place is added when a question is asked of it, not in advance.

## 9. Acceptance criteria

- **AC-1** A counter increments, and reads back its total.
- **AC-2** A histogram records count, sum, min, max and buckets.
- **AC-3** An instrument registered twice with different units is refused.
- **AC-4** A recording on an unregistered name is refused.
- **AC-5** A span records a duration greater than zero for work that took time.
- **AC-6** A nested span names its parent's span id, without the caller passing
  it.
- **AC-7** A span that throws is recorded as failed **and the error propagates**.
- **AC-8** Sibling spans do not become each other's parents.
- **AC-9** `traceparent` is a valid W3C trace-context string, and its trace id is
  the invocation id's 16 bytes.
- **AC-10** Every span in one process shares one trace id.
- **AC-11** A snapshot is a plain object of names to values, stable to serialise.
- **AC-12** A run records its snapshot into `index_run.summary`, readable back.
- **AC-13** Two runs' summaries are comparable, and each carries the
  `ferret_version` that produced it.
- **AC-14** `ferret status --json` includes the snapshot.
- **AC-15** `--log-level silent` emits no metric record, and the snapshot is
  still readable.
- **AC-16** An index run over a real repository reports a duration per stage.
- **AC-17** Instrumentation adds no measurable regression: the golden harness's
  figures are unchanged and `verify` stays green.

## 10. Test requirements

**Unit** — every instrument, both refusals, the span stack including siblings
and a throwing span, `traceparent` validity against the W3C grammar, snapshot
stability, and the level gate.

**Integration (real PostgreSQL)** — AC-12, AC-13 and AC-16 over a real index
run; AC-14 through the CLI.

**Failure** — a span whose body throws; a snapshot taken with no instruments; a
run that fails, which must still record what it measured before failing.

**Regression** — EPIC-091's, EPIC-004's and EPIC-094's suites; AC-17 through
EPIC-098's harness.

## 11. Security requirements

A metric name is Ferret's own and a label is a bounded enum — **never a path, a
name from a repository, or anything a source supplied**. That is the whole
control: EPIC-091 redacts values, and this Epic avoids the question by not
putting source-derived strings in a label at all. A high-cardinality label would
also be a memory leak, so the rule serves two purposes and is tested as one.

## 12. Observability

This Epic *is* observability, so the meta-question is what happens when it
fails: a broken instrument must not break the work. `record` on an unregistered
name throws in development and is a programming error caught by a test rather
than a runtime hazard — §8.3's rule that a span rethrows is the deliberate
exception, and it exists because swallowing a real error to protect a
measurement is the wrong trade.

## 13. Performance constraints

A counter is a map increment. A histogram is a bounded bucket array. A span is
two `performance.now()` calls and one log record. AC-17 is the assertion that
this is true rather than assumed.

## 14. Definition of Done

Scope implemented; AC-1 to AC-17 satisfied with evidence in
`validation/EPIC-092-VALIDATION.md`; unit, integration, failure and regression
tests present and passing; `npm run verify` green; the registry updated;
EPIC-004's and EPIC-091's recorded limitations struck with dated notes.

## 15. Governance alignment

- **§20 Observability** — "indexing, search, migrations and errors must be
  inspectable", and a duration is the part that was not.
- **§14 Lightweight Infrastructure** and **§23 Non-Goals** — §8.1 declines an
  SDK and adopts a format.
- **§6 Evidence Before Inference** — §8.4's snapshot is a sample and says so;
  §8.2's units make a number mean one thing.
- **§5 Reuse Before Reinvent** — EPIC-091's stream, EPIC-094's journal,
  EPIC-004's status surface. No new table and no new transport.

## 16. Raised, not absorbed

- **No exporter.** An operator wanting Prometheus or OTLP reads the NDJSON and
  translates it. Building an exporter is a dependency and a socket, and the
  trigger for revisiting is a measured need rather than a preference.
- **No per-second resolution.** A snapshot is the totals at the end of a run.
  Sub-run resolution needs a time-series store, which is a second datastore and
  the same question EPIC-007 §D-001 answered for the graph — with a measurement.
- **No sampling**, and §8.3 names what would change it: a run whose span output
  dominates its work. Ferret's spans are per stage and per file, so that is
  hundreds per run.
- **The invocation id is now a trace id.** EPIC-091 invited this and said it
  would be cheap; it was. What it costs is that a *client-supplied* trace context
  is still refused — EPIC-091 §8 forbids accepting a correlation id from
  outside, and joining a caller's trace would need that rule revisited by
  whoever owns it.
- **Four places are instrumented** (§8.6), and a fifth is added when a question
  is asked of it. A specification that instrumented everything would be naming
  measurements nobody wanted.

## 17. Recorded during implementation

- **The trace id was 24 hex characters, not 32** — `randomBytes(4)` beside a
  16-hex invocation id. Every `traceparent` would have failed its own validator.
- **The content stage got the process registry, not the run's**, so a caller
  holding its own saw stage timings and no per-file ones. A half-true snapshot is
  worse than an empty one.
- **The package-size gate fired and was re-baselined by its own procedure** —
  measured first, ~101 kB attributed, nothing improper shipping.
