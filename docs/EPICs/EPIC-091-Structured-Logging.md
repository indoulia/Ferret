# EPIC-091 — Structured Logging

**Status: APPROVED | Priority: P0 | Domain: Reliability & Operations**

> **Specification note.** The registry approved this Epic by name, domain and
> priority (`docs/EPICs/README.md:202`); no specification was ever written, and
> **no other document parks a single limitation on EPIC-091** — a repository-wide
> grep for `091` returns that one registry line and nothing else.
>
> That absence is the finding. A structured logger has existed since EPIC-001 and
> 32 modules import it. This Epic is therefore **not** "build structured
> logging". It is the much smaller job of closing the gaps §2 measures, and it
> says so rather than restating shipped work as new requirements.
>
> Authored against `594d858`. §2, §8 and §13 describe the code as it is, with
> numbers taken from running it, not from reading it.

## 1. Objective

Make every Ferret log record complete, correlatable and safe — so an operator
reading stderr can reconstruct one invocation end to end, and so the commands
Governance §20 names by name are not silent.

## 2. Problem, measured

Governance is short and specific:

> Provider health, synchronization, indexing, search, migrations, and errors must
> be inspectable. `ferret status` and `ferret doctor` must remain dependable even
> when other subsystems are unhealthy.
> — `Governance/README.md:129` (§20 Observability)

### 2.1 What already exists — and works

Do not rebuild any of this.

- **A narrowed logger interface** over Pino, `src/logging/logger.ts:23-32`, with
  `child()` and the six-level ladder. Deliberately narrower than Pino's "so the
  implementation stays replaceable and so every record passes through
  redaction".
- **NDJSON on stderr, stdout reserved for results.** `destination({ dest: 2 })`
  at `src/logging/logger.ts:131`; asserted end to end by
  `tests/integration/cli-process.test.ts:74-81` ("keeps stdout free of log output
  so JSON stays parseable") and `:83-94` (severity, ISO time and `msg` on every
  record).
- **Quiet by default.** `warn`, `src/logging/logger.ts:106`;
  `tests/integration/cli-process.test.ts:96-98` asserts an empty stderr with no
  flag.
- **Redaction on the way out, not at the call site.** Every method funnels
  through `sanitize()` (`src/logging/logger.ts:49-61`), which key-redacts
  top-level names *and* value-redacts recursively. EPIC-001's validation records
  that the key-name half was a real defect caught before merge
  (`validation/EPIC-001-VALIDATION.md:146-150`).
- **Errors serialize usefully.** The identity `err` serializer
  (`src/logging/logger.ts:112-129`) exists because dogfooding produced a log line
  *worse* than the terminal: `"…missing database: …missing database: …missing
  database"` with a synthesised empty stack
  (`validation/EPIC-031-VALIDATION.md:146-167`). Fixed and regression-tested.
- **A convention, universally followed.** All 27 call sites in `src/` pass an
  `operation` field. `index.lifecycle` (`src/indexing/indexer.ts:650,697`),
  `runtime.initialize`/`runtime.shutdown`, `storage.migrate`,
  `mcp.<tool>` — the taxonomy is real and consistent.
- **A null logger** for embedding and tests, `src/logging/logger.ts:137`.
- **12 unit cases** in `tests/unit/logging.test.ts`, plus real-process secret
  assertions at `--log-level trace` in `tests/integration/cli-process.test.ts:126-160`.

A representative record, emitted by the shipped build:

```json
{"level":"info","time":"2026-09-01T20:52:02.798Z","component":"demo",
 "operation":"demo.run","repo":"x","msg":"hello"}
```

That is a good record. Four things are missing from it, and two things are wrong
elsewhere.

### 2.2 Gap 1 — the two commands §20 names emit nothing

```
$ ferret status --log-level trace 2>&1 >/dev/null
$ ferret doctor --log-level trace 2>&1 >/dev/null
$
```

Both empty, at every level. `probeHealth` accepts a logger and threads it only
into storage probing (`src/cli/health.ts:127,136`); no probe, verdict, component
or duration is logged. §20 asks for these two to be *dependable*; today they are
mute, so a `status` that returns `unknown` leaves nothing behind to diagnose.

### 2.3 Gap 2 — configured `logLevel` never reaches `status` or `doctor`

```
$ FERRET_LOG_LEVEL=trace ferret env    2>&1 >/dev/null | wc -l
2
$ FERRET_LOG_LEVEL=trace ferret status 2>&1 >/dev/null | wc -l
0
```

`status` and `doctor` construct a logger **only when the `--log-level` flag is
present** — `src/cli/commands/status.ts:47-50` and
`src/cli/commands/doctor.ts:56-59` both read `globals.logLevel` (the Commander
flag) and pass `undefined` otherwise, so `probeHealth` falls back to
`createNullLogger()`. The configured value at `src/config/schema.ts:110`, which
`ferret env` honours through the runtime (`src/runtime/runtime.ts:177-178`), is
simply not consulted. The same holds for the process-level logger:
`earlyLogLevel` (`src/cli/main.ts:33-39`) reads argv and defaults to `warn`, so
signal handling and `uncaughtException` (`src/cli/main.ts:133-137`) ignore
configuration too.

### 2.4 Gap 3 — no invocation identity, and no way to correlate

A repository-wide grep for `correlation`, `requestId`, `operationId`, `traceId`
and `runId` across `src/` returns **nothing**. Records carry `component` and
`operation`; nothing ties the records of one `ferret index` run together, and
nothing distinguishes two concurrent runs interleaved on the same stderr. The
`base` bindings are set to exactly `{ ...options.base }`
(`src/logging/logger.ts:110`), which also overrides Pino's default `pid` and
`hostname` — so a record identifies neither the process nor the build:
`ferret --version` is knowable, the log's producer version is not. This matters
against Governance §21, which requires producers to be versioned where a change
affects reproducibility.

### 2.5 Gap 4 — the log path redacts less than the ingestion path

Two redactors exist, by design: `src/errors/redact.ts` for errors and logs
("over-redaction is a cosmetic defect, under-redaction is a security defect",
`:9-10`), and `src/security/secrets.ts` for indexed content, where a false
positive destroys data (`:4-7`). The split is correct. The **coverage** is not:
`SECRET_VALUE_PATTERNS` (`src/errors/redact.ts:54-64`) carries six patterns;
EPIC-082's `PATTERNS` (`src/security/secrets.ts:26-44`) carries twelve. Four
credential kinds Ferret already knows how to recognise are not recognised on the
log path. Emitted by the shipped build:

```json
{"level":"info","component":"demo","operation":"d",
 "note":"xoxb-1234567890-abcdefghijkl AIzaSyA…901234 npm_abc…6789 sk_live_abc…1234",
 "msg":"m"}
```

Slack token, Google API key, npm token and Stripe key: all four verbatim on
stderr. The values above are synthetic. The asymmetry is not: a value Ferret
refuses to *store* it will happily *print*, and the log path is the one that
reaches an operator's terminal, a CI transcript and a client's captured stderr.
EPIC-082 §8 already states the rule this violates — "Redaction is applied before
the value reaches storage, **logging** or an error".

### 2.6 Gap 5 — four Epics wrote "loggable", not "logged"

They deferred deliberately, and named no owner:

> A write is loggable with the path and the principal — never the value.
> — `EPIC-066-MCP-Configuration-Tools.md:262`

> A decision is loggable at debug with the principal id and the permission —
> — `EPIC-068-AI-Authorization-Model.md:218`

> A request and a consume are loggable at debug with the operation and the
> token's —
> — `EPIC-069-Destructive-Operation-Confirmation.md:259`

> A denial logs the operation and the missing permission, never the protected
> value. Structured audit events remain EPIC-085's; this Epic must not pre-empt
> their shape.
> — `EPIC-083-Authorization-Enforcement.md:216-218`

"Loggable" means the data is in hand and the line was never written. EPIC-083 is
the tell: it states the behaviour as present tense and explicitly refuses to
build EPIC-085's event shape. Someone must emit these four lines through the
ordinary logger. That is this Epic — it is a log line, not an audit event.

So: Ferret has a structured logger, a redactor, a level ladder, stream
discipline and a naming convention, and lacks invocation identity, health-path
instrumentation, configuration reach, and parity with its own secret detector.

## 3. Scope

1. **Invocation identity.** One id minted per CLI invocation and per MCP session,
   attached as a base binding, so every record of one run shares it.
2. **Producer identity in `base`.** The package version and the process id on
   every record, restoring what setting `base` removed.
3. **Instrument the health path.** `probeHealth` and `buildDoctorReport` log each
   probe, its verdict and its duration, so §20's two named commands leave a
   trace.
4. **Configured level reaches every command.** `status`, `doctor` and the
   process-level logger honour `logLevel` from configuration, with the
   `--log-level` flag still winning.
5. **Log-path redaction reaches parity with EPIC-082's kinds** — the four missing
   formats, added to the log/error redactor.
6. **Emit the four deferred lines** named in §2.6, at the levels those Epics
   specified.
7. **`operation` becomes a required, typed field**, so the convention is checked
   by the compiler rather than by review.

## 4. Non-scope

Named here so it is not quietly adopted.

- **Audit events — EPIC-085 (P1).** Six shipped Epics already route audit to it
  (`EPIC-058:114`, `EPIC-066:116`, `EPIC-068:91`, `EPIC-069:105`,
  `EPIC-083:91,218`, `Architecture/EPIC-003-DECISIONS.md:166`). A log line is
  diagnostic, best-effort, level-gated and discardable; an audit event is a
  durable record with a schema and a retention policy. EPIC-083 forbids
  pre-empting its shape and this Epic does not. **Journal rotation** is also
  EPIC-085's (`validation/EPIC-003-VALIDATION.md:152`).
- **Metrics and tracing — EPIC-092 (P1).** No counters, no histograms, no spans,
  no parent/child propagation, no exporter. EPIC-004 parked "health is
  point-in-time; no metrics, tracing or history" there
  (`Checkpoints/EPIC-004.md:113`, `validation/EPIC-004-VALIDATION.md:154`). The
  invocation id in §3.1 is a correlation key for reading stderr, **not** a trace
  id, and this Epic defines no propagation format. If EPIC-092 later wants W3C
  trace context, it may reuse or replace the field — see §16.
- **Log shipping, aggregation or a file sink.** `destination` takes a file
  descriptor (`src/logging/logger.ts:131`) and that is the whole transport
  contract. Ferret writes NDJSON to stderr; redirecting it is the operator's job
  and the Unix answer. Rotation, retention and shipping are operational concerns
  with no approved requirement behind them.
- **Pretty-printing / a human log renderer.** Nothing on record asks for one, and
  `pino-pretty` is a pipe away. The `--json` flag governs **stdout results**, not
  the log stream; conflating them would break the stream discipline
  `tests/integration/cli-process.test.ts:74` protects.
- **Per-component log levels.** Not on record. One level, as `LOG_LEVELS`
  defines it.
- **Sampling or rate limiting of log records.** Not on record.
- **Changing what any existing call site logs**, beyond the redaction fix and the
  `operation` type change. The taxonomy at those 27 sites is already consistent
  and other Epics' §12 sections depend on it (EPIC-012, EPIC-017, EPIC-032).
- **Operational diagnostics commands — EPIC-095 (P0).** This Epic instruments the
  *existing* health path; new diagnostic surfaces are that Epic's.
- **Making the ingestion redactor more aggressive.** Parity moves in one
  direction only: the log redactor gains EPIC-082's kinds. EPIC-082 §4 rejected
  entropy heuristics and nothing here revisits that.

## 5. Inputs

- `Logger`, `LogLevel`, `LOG_LEVELS`, `createLogger`, `createNullLogger` —
  EPIC-001, `src/logging/`.
- `redact`, `redactString`, `isSecretKey`, `REDACTED`, `serializeError` —
  EPIC-001, `src/errors/`.
- EPIC-082's `PATTERNS` kinds as the parity target, `src/security/secrets.ts:26-44`.
- Resolved `logLevel`, `src/config/schema.ts:110`; the `--log-level` option,
  `src/cli/program.ts:64-68`.
- `HealthProbeOptions.logger` and `probeHealth`, `src/cli/health.ts:38,125`.
- The package version, `package.json:3`.

## 6. Outputs

- A base binding set carrying `component`, `version`, `pid` and the invocation
  id on every record.
- A typed `LogFields` requiring `operation`.
- Log records on the `status` and `doctor` paths.
- Four new log lines at the sites EPIC-066, EPIC-068, EPIC-069 and EPIC-083
  named.
- Four additional value patterns in `src/errors/redact.ts`.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-001 Core Runtime & Package | VALIDATED | the logger, the redactor, the level ladder, stream discipline |
| EPIC-003 Configuration Engine | VALIDATED | `logLevel` and the precedence ladder |
| EPIC-004 Runtime Health & Diagnostics | VALIDATED | `probeHealth`, the component model, the two commands |
| EPIC-082 Secret Detection & Exclusion | VALIDATED | the credential kinds parity is measured against |
| EPIC-064/065 MCP | VALIDATED | the session the invocation id is minted for |
| EPIC-066/068/069/083 | IMPLEMENTED | the four "loggable" sites |

No new package. No schema change. No external dependency.

## 8. Contracts

Other Epics may rely on the following.

- **One invocation, one id.** Every record produced by a single CLI invocation or
  MCP session carries the same id in `base`, inherited by every child logger. It
  is opaque, locally generated, carries no user or host data, and is never
  accepted from outside the process — a client-supplied correlation id is input,
  and input does not get to name Ferret's records.
- **`operation` is required.** It is a dotted, stable, `component.verb` name. A
  record without one does not compile. The 27 existing names are the vocabulary;
  this Epic renames none of them.
- **stdout is never a log stream.** Unchanged from EPIC-001 and re-asserted here
  because this Epic touches the MCP path, where a stray line corrupts the
  transport (`validation/EPIC-059-061-064-065-VALIDATION.md:131`).
- **Redaction remains at emission, not at the call site.** No caller is asked to
  redact before logging. The single funnel through `sanitize()` is the property
  that makes the guarantee reviewable, and this Epic widens what it catches
  without moving where it happens.
- **The log redactor is a superset of the content redactor's kinds, never a
  subset.** Anything EPIC-082 refuses to store, the logger refuses to print. The
  converse does not hold and must not: the log redactor may be more aggressive,
  because over-redacting a log line costs nothing and over-redacting indexed
  content destroys it.
- **A log line is not an audit record.** It is level-gated, best-effort and may
  be discarded. Nothing may treat stderr as a compliance artefact; that is
  EPIC-085.
- **Logging never fails an operation.** A failure inside the logging path is
  swallowed. Governance §20 asks for inspectability, not for a new way to abort
  an index run.
- **`warn` remains the default.** Ferret runs as infrastructure behind an AI
  client (`src/logging/logger.ts:99-104`).

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | Every record carries `level`, `time` (ISO-8601), `msg`, `component` and `operation`. | `tests/integration/cli-process.test.ts:83-94`; §2.1 |
| AC-2 | Every record carries the Ferret version and the process id. | Gov §21; §2.4 |
| AC-3 | Every record of one invocation carries the same invocation id; two concurrent invocations carry different ones. | Gov §20 "inspectable"; §2.4 |
| AC-4 | Omitting `operation` at a call site is a compile error. | §2.1 (convention at 27/27 sites, unenforced at `src/logging/logger.ts:13`) |
| AC-5 | `ferret status` and `ferret doctor` emit at least one record per probed component, with its verdict and duration, at `debug`. | Gov §20 (both named) |
| AC-6 | `ferret status` and `ferret doctor` still produce a correct report when logging is disabled, and still produce records when a subsystem is unavailable. | Gov §20 "dependable even when other subsystems are unhealthy" |
| AC-7 | `FERRET_LOG_LEVEL=trace ferret status` emits records; the configured level reaches every command. | §2.3; EPIC-003 precedence |
| AC-8 | `--log-level` overrides the configured level, on every command. | EPIC-003 §16 precedence ladder |
| AC-9 | Every credential kind in `src/security/secrets.ts` `PATTERNS` is redacted from a log field value, under any key name. | EPIC-082 §8 ("before the value reaches storage, logging or an error") |
| AC-10 | A secret-named key is redacted by name even when its value matches no pattern. | `validation/EPIC-001-VALIDATION.md:146-150` (regression) |
| AC-11 | An error logged with `err` keeps its cause chain intact and gains no synthesised stack. | `validation/EPIC-031-VALIDATION.md:146-167` (regression) |
| AC-12 | An MCP configuration write logs the path and the principal, never the value. | `EPIC-066:262` |
| AC-13 | An authorization decision logs the principal id and the permission at `debug`. | `EPIC-068:218` |
| AC-14 | A confirmation request and consume log the operation and the token identity at `debug`, never a protected value. | `EPIC-069:259` |
| AC-15 | A denial logs the operation and the missing permission, and no protected value. | `EPIC-083:216-218` |
| AC-16 | stdout carries exactly one parseable document under `--json` at `--log-level trace`, for every command. | `tests/integration/cli-process.test.ts:74-81` |
| AC-17 | With no `--log-level` and no configured level, stderr is empty. | `tests/integration/cli-process.test.ts:96-98` |
| AC-18 | No log record emitted by this Epic's new lines carries an audit-event shape or a durable identifier. | `EPIC-083:216-218`; §4 |

## 10. Test requirements

**Unit.** Base-binding composition (version, pid, invocation id present; the id
stable across `child()`); the four added redaction patterns, each with a positive
and a near-miss negative; `operation` typing (a `@ts-expect-error` case is the
proof for AC-4); the identity `err` serializer regression, unchanged.

**Integration, real process.** `ferret status` and `ferret doctor` at
`--log-level debug` — one record per component, each with a verdict and a
duration. `FERRET_LOG_LEVEL=trace ferret status` — non-empty stderr, which is the
direct regression for §2.3. Two concurrent invocations — every record
attributable to exactly one, by id alone.

**Failure.** A subsystem unavailable (no PostgreSQL) must still produce both a
report and records — AC-6 is the one §20 states explicitly and the one most
likely to regress. A logger whose destination fd is closed mid-run must not fail
the command.

**Security.** The parity test is the one that matters and it must be
**generated from EPIC-082's `PATTERNS`, not hand-listed**: for every kind that
module declares, assert a synthetic instance is absent from log output at
`trace`, and that `[redacted]` is present, proving masking rather than absence.
Written that way, a kind added to EPIC-082 later fails this test until the log
path catches up — which is the only durable form of AC-9. Extend the existing
real-process secret suite (`tests/integration/cli-process.test.ts:126-160`)
rather than starting a second one.

**Performance.** §13's per-record budget, measured the way §13 measured it.

## 11. Security requirements

- Redaction stays at emission, in one funnel (`src/logging/logger.ts:49-61`).
  Nothing in this Epic adds a call site that formats a value before logging it.
- The log redactor covers every kind EPIC-082 detects (AC-9). This closes the
  asymmetry in §2.5, which is the one genuine security defect this Epic fixes.
- The invocation id is opaque and locally generated: no hostname, no username, no
  path, no time-decodable component, and never taken from client input.
- The four new lines in §2.6 log identifiers only — a path, a principal id, a
  permission name, an operation name. Never a configuration value, never a
  protected value, never a token secret.
- Log volume is a side channel. A record emitted per denial at `debug` tells an
  operator what was refused; it must not tell a caller, and stderr is not
  returned to an MCP client (`validation/EPIC-068-VALIDATION.md:74`).
- Logging failures are swallowed, so no logging path can become a denial of
  service against an index run.

## 12. Observability

This Epic *is* the observability Epic; the reflexive requirement is that its own
additions are inspectable.

- The invocation id is printed in no user-facing output and needs none — it is
  found in the log, which is where it is used.
- `ferret doctor` already tells an operator to re-run with `--log-level debug`
  (`src/diagnostics/doctor.ts:71,75`). AC-5 is what makes that advice true; today
  it is not.

## 13. Performance constraints

Measured on `594d858`, 20 000 records with four fields to a real file descriptor:

| Path | µs/record |
| --- | --- |
| Raw Pino, `sync: true` | 16.8 |
| Through `sanitize()` | 27.7 |

So redaction costs ~11 µs/record — roughly 65% on top of Pino — and the shipped
logger sustains ~36 000 records/sec synchronously. Constraints:

- **This Epic must not make the per-record cost worse than 35 µs.** The added
  patterns are four more regex passes over string values in `redactString`; that
  is the only hot-path change, and it must stay inside the headroom.
- **`sync: true` stays** (`src/logging/logger.ts:131`). A crash that loses the
  records explaining it is worse than a slow log, and the default level is
  `warn`, so the synchronous cost is paid on almost no records in normal
  operation.
- **Base bindings are computed once per logger**, never per record. Version and
  pid are constants; the invocation id is minted once.
- **AC-5's per-component records are bounded** by the component count, which
  `probeHealth` fixes at a small number.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration, failure, security and performance tests pass; `npm run
  verify` green.
- The three reproductions in §2.2, §2.3 and §2.5 no longer reproduce, shown as
  before/after output.
- `docs/EPICs/validation/EPIC-091-VALIDATION.md` records the evidence, including
  the measured per-record cost against §13's budget.
- Registry entry updated.
- The four `loggable` statements in EPIC-066, EPIC-068, EPIC-069 and EPIC-083 are
  named as satisfied; no acceptance criterion of any other Epic is changed.
- Nothing in EPIC-085's or EPIC-092's territory was built.

## 15. Governance alignment

- **§20 Observability** — the requirement, quoted in §2. Errors, migrations,
  indexing and provider health are already inspectable; this Epic adds the health
  path and makes the two commands §20 names by name non-silent.
- **§12 Security** — redaction is enforced by Ferret at emission, not by a
  convention at the call site, and AC-9 removes the gap between what Ferret
  refuses to store and what it prints.
- **§21 Versioning and Reproducibility** — a record names its producer version
  (AC-2).
- **§5 Reuse Before Reinvent** — Pino, the existing redactor and the existing
  level ladder are consumed. This Epic adds no dependency and replaces no
  component.
- **§6 Evidence Before Inference** — a probe that did not run is logged as such
  rather than being absent, matching how `probeHealth` already reports `unknown`
  (`src/cli/health.ts:140-152`).
- **§22 Change Management** — the scope is confined to gaps measured against a
  named commit; §16 records the decisions no document dictated.

## 16. Raised, not absorbed

**Four decisions this specification makes rather than finds on record.**

**An invocation id is introduced, and it is not a trace id.** Nothing on record
asks for correlation. §2.4 is a measured absence, not a quoted requirement, and
the justification is Governance §20's word "inspectable" — a log you cannot
attribute to a run is not inspectable once two runs overlap. It is deliberately
minimal: one opaque id, no propagation format, no parent/child, no exporter,
because all four are EPIC-092's and choosing a format here would pre-empt it. If
EPIC-092 adopts W3C trace context, this field is renamed or subsumed, and this
paragraph is why that is cheap.

**`operation` becomes required.** All 27 call sites already pass it, so the
change is a type signature, not a migration. But the convention was never
written down as a contract, and making it one narrows `LogFields`
(`src/logging/logger.ts:13`) for every future caller including providers. That is
a contract change with no record behind it. The alternative — leaving it to
review — is what 27 sites of luck currently rests on.

**Log-path redaction parity is treated as a defect, not a feature.** EPIC-082 §8
says redaction happens "before the value reaches storage, logging or an error",
and §2.5 shows it does not for four kinds. Reading that as an existing unmet
requirement rather than a new one is a judgement call. It is the reading that
puts the fix in a P0 Epic instead of leaving it unowned, and the generated test
in §10 is what stops the two lists diverging again.

**The four "loggable" lines are assigned here rather than to EPIC-085.** Those
Epics deferred without naming an owner. EPIC-085 is P1 and owns durable audit
events; these are `debug` log lines about a decision already made. Putting them
in the P0 logging Epic gets an operator the diagnosis now without pre-empting the
audit schema EPIC-083 explicitly protects. If EPIC-085 later decides these events
must be durable, it supersedes the lines rather than being blocked by them.
