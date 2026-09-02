# EPIC-004 — Validation Evidence

**Epic:** EPIC-004 — Runtime Health & Diagnostics
**Branch:** `feat/epic-004-runtime-health-and-diagnostics`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it, and one
required test is recorded as **NOT APPLICABLE** rather than claimed — see §2.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Status distinguishes healthy, degraded, unavailable and unknown | **PASS** | `health.test.ts` → "status severity" and "aggregation" (9 cases) assert the ordering and the aggregation rule directly. Observed end to end: healthy (`health-database.test.ts` → fully provisioned), degraded (pending migration; absent `git`), unavailable (unreachable database; unconfigured), unknown (capabilities that do not exist yet). |
| AC-2 | Doctor identifies common setup, database, migration, permission and runtime failures | **PASS** | Setup: no database configured, unparseable configuration, unresolvable secret reference, repository policy overstepping. Database: unreachable, wrong credentials. Migration: pending, recorded failure, schema from a newer Ferret. Runtime: unsupported Node, missing `git`. Each is asserted in `health-cli.test.ts` or `health-database.test.ts` with its classification **and** its remediation. |
| AC-3 | Diagnostics include actionable remediation without exposing secrets | **PASS** | `health.test.ts` → "always supplies a remediation, even when the component gave none". `health-cli.test.ts` → "gives doctor a remediation for every finding". Secrets: 7 real processes across `status`/`doctor`, `--json` and human, at `--log-level trace`, including `doctor --show-config`, assert the password appears in neither stdout nor stderr — and that `[redacted]` *is* present, proving masking rather than absence. |
| AC-4 | Health checks do not mutate data unless explicitly requested | **PASS** | The migration policy is forced to `MigrationPolicy.OFF` in `probeHealth`, so checking health cannot migrate — enforced, not intended. `health-database.test.ts` → "leaves the database untouched" runs both commands against an uninitialized database and asserts `ferret.schema_migrations` still does not exist. `health-cli.test.ts` → "creates no configuration file merely by being run" asserts both directories are still empty afterwards. |
| AC-5 | Health remains useful when optional providers are unavailable | **PASS** | `aggregateStatus` can never let an optional component make the report `unavailable` — asserted in `health.test.ts`, and end to end in `health-cli.test.ts` → "degrades the report without making Ferret unusable", which removes `git` from `PATH` for a real process. An absent pgvector likewise degrades rather than fails. |
| AC-6 | Output is machine-readable for AI tooling | **PASS** | Both commands emit a structured report under `--json`, with stable component names, `HealthArea` values and per-finding `id`s. `health-cli.test.ts` → "keeps stdout as exactly one JSON document even at trace log level" and "agrees between status and doctor about the verdict". |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names eight test areas. **Seven PASS; one is NOT APPLICABLE**, recorded
honestly rather than claimed.

| Required test | Status | Location |
| --- | --- | --- |
| Healthy runtime | PASS | `health-database.test.ts` → "a fully provisioned database" (3 cases) |
| Database unavailable | PASS | `health-cli.test.ts` → "an unreachable database" (3 cases) |
| Migration pending | PASS | `health-database.test.ts` → "a database that has never been initialized" (5 cases) |
| Invalid credentials | PASS | `health-database.test.ts` → "wrong credentials" (2 cases) |
| Optional provider failure | PASS | `health-cli.test.ts` → `git` removed from `PATH`; pgvector optionality asserted throughout |
| Malformed configuration | PASS | `health-cli.test.ts` → "a Ferret whose configuration will not parse" (3 cases) |
| Degraded index | **NOT APPLICABLE** | See below |
| Secret redaction | PASS | `health-cli.test.ts` → "secret safety" (2 cases); `health-database.test.ts` → "does not echo the rejected password anywhere" |

### Why "degraded index" is NOT APPLICABLE

**There is no index yet.** Indexing arrives with EPIC-031 and integrity checking
with EPIC-094. Writing a test that asserted a degraded index would require
fabricating one, and would assert nothing about Ferret.

What EPIC-004 *does* do is refuse to paper over it. `plannedCapabilityComponents`
reports `index-integrity` as **`unknown`**, with the detail "No index exists yet,
so its integrity cannot be assessed" and a remediation naming the owning Epics.
Governance §6 requires not-indexed to be representable and forbids manufacturing
certainty, so an operator reading a clean bill of health can see that indexing
was never checked rather than infer it from an absence.

Two tests hold that line: `health-cli.test.ts` → "reports them as undetermined
rather than omitting them" and "never lets an unimplemented capability read as
healthy". When EPIC-031 lands, this component becomes a real check and this row
becomes PASS.

### Coverage beyond the required list

- **The diagnostic never throws** — every failure path above runs as a real
  process and returns a report, including the hardest case: configuration itself
  being unparseable, which is what the diagnostic needs in order to run.
- **Deterministic exit codes** — 3 configuration, 4 dependency, 6 schema, 0 when
  usable, attributed to the worst *required* component.
- **`--strict`** for callers that want anything less than perfect to fail.
- **Repository policy oversteps** surfaced as degraded, naming the refused keys.
- **`status` and `doctor` agree** — asserted directly, because two commands that
  disagreed about health would be worse than either alone.
- **Performance budget** with the database unreachable (below).

---

## 3. Deterministic classification

The Definition of Done requires failure modes to have deterministic
classifications. Two mechanisms provide it:

**Per-finding `id`.** Every diagnosis carries `<component>:<status>` — for
example `postgres:unavailable`, `postgres-schema:degraded`,
`database-configured:unavailable`. A script or an AI client branches on the id
rather than pattern-matching English. Asserted in `health.test.ts` → "gives every
finding a stable id a script can branch on".

**Exit code by area.** Attributed to the worst *required* failing component, so
the code says what to go and fix:

| Condition | Exit code | Meaning |
| --- | --- | --- |
| Healthy | `0` | |
| Degraded (usable) | `0`, or `4` under `--strict` | An absent pgvector should not fail a CI job that does not use semantic search |
| Configuration area unavailable | `3` | Ferret has not been told how to reach a database, or the file will not parse |
| Database area unavailable | `4` | The server is unreachable, or rejected the credentials |
| Schema area unavailable | `6` | Migration failed, drifted, or the database is from a newer Ferret |

The distinction between 3 and 4 is the point: "you have not told Ferret about a
database" and "the database is down" have different remediations, and conflating
them sends the user to debug the wrong thing.

---

## 4. Performance

An AI client calls `status` to decide whether Ferret can answer, and Governance
§3 has it spawn Ferret per session. A diagnostic that is slow *when everything is
broken* is a diagnostic nobody runs, so the budget is asserted against the worst
realistic case rather than the best.

| Measurement | Budget | Notes |
| --- | --- | --- |
| `ferret status --json` with the database unreachable, full process start to exit | 15 000 ms | Measured ~1.8 s locally. The ceiling is coarse because it includes Node startup and a TCP connect that must be allowed to time out on a slow network. |

The report carries its own `durationMs`, so a slow start can be attributed to
probing rather than guessed at.

---

## 5. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| CLI diagnostics documented | **PASS** | `README.md` → "Checking health"; `--help` for both commands; `docs/Architecture/EPIC-004-DECISIONS.md`. |
| Machine-readable diagnostics documented and tested | **PASS** | Report shape, `HealthArea` values, diagnosis `id` format and exit-code table documented in the README and here; asserted by 60 cases across three suites. |
| Failure modes have deterministic classifications | **PASS** | §3 above, asserted in `health.test.ts` → "exit codes" (5 cases) and per-condition in the database suite. |

---

## 6. Security

| Concern | Handling |
| --- | --- |
| Credential leakage through diagnostics | A diagnostic is exactly where a credential leaks, because it reports on the connection that failed. Every finding is built from `FerretError`'s already-redacted message, `doctor --show-config` renders through `describeConfig`, and 7 real processes assert the password never appears at `--log-level trace` on either stream. |
| Diagnostics as a mutation vector | `probeHealth` forces `MigrationPolicy.OFF`. A `status` that migrated would change the thing it was reporting on, and an AI client calls it freely. |
| Information disclosure | Components report host, port, database and user — never the password. This is the same `describeConnection` surface EPIC-002 established. |
| Denial of service | Probing is bounded by the storage connect timeout and never retries; an unreachable database is answered, not waited on indefinitely. |

---

## 7. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| No index or synchronization health, because neither exists. Reported as `unknown`. | An operator cannot yet learn whether indexing is behind. | **Resolved** — EPIC-031/032/094 for the index, and **EPIC-075** for synchronization, which now reports how long ago each source's cursor advanced. |
| No provider health beyond storage, because storage is the only provider. | The `providers` area is defined but unpopulated. | **EPIC-014** — Provider Lifecycle & Health |
| A long migration lock wait is not surfaced as a distinct finding. | EPIC-002 recorded that `client_connection_check_interval` is a no-op on a Windows-hosted *server*, so a crashed process there can hold the lock until the statement ends. `doctor` reports the resulting symptom, not the cause. | **EPIC-095** — resolved: the error now names the holding session's pid, state and duration, and its remediation names a Ferret command rather than `pg_locks`. |
| No metrics, tracing or history — health is point-in-time. | "Was it healthy an hour ago" cannot be answered. | **EPIC-092** — Metrics & Tracing |
| Health is not yet exposed over MCP. | An AI client must shell out to `ferret status --json`. The report is already structured for it. | **EPIC-066**, **EPIC-070** |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005; no macOS host available. | **EPIC-105** |

## Addendum — 2026-09-02, after EPIC-092

**The metrics and tracing limitation recorded above is closed.** The original
text stands.

Counters and histograms with declared units, spans with parent/child and a
duration, and W3C `traceparent` — EPIC-091 invited exactly this ("If EPIC-092
adopts W3C trace context, this field is renamed or subsumed, and this paragraph
is why that is cheap"), and the invocation id is now the high half of the trace
id so a log line and a span stay greppable against each other.

**"Was it healthy an hour ago" is answerable without a new table.** Migration
0012 made `index_run.summary` free-shaped on purpose, so a run records its metric
snapshot there beside the `started_at`, `ferret_version` and `invocation` the
journal already carries — which is what makes comparing two runs meaningful
rather than misleading. A failed run records what it measured before failing.

No dependency: the *format* is adopted and the SDK is not, which is EPIC-091's
own decision one layer up — it ships NDJSON to stderr rather than a log shipper.

Evidence: `docs/EPICs/validation/EPIC-092-VALIDATION.md`.
