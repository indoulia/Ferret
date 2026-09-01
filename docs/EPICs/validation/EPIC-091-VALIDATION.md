# EPIC-091 — Structured Logging · Validation Evidence

**Assessed against:** working tree on top of `b5ee2a4`
**Date:** 2026-09-02
**Environment:** Windows 11, real processes via `runCli`, real PostgreSQL 17 for the suites that need one.

## What this Epic was, and was not

A structured logger has existed since EPIC-001 and 32 modules import it. The
specification said so and scoped itself to the five gaps §2 measured. Nothing
here rebuilds shipped work: the level ladder, the stream discipline, the
`sanitize()` funnel, the identity `err` serializer and the `operation`
convention are unchanged.

| measured at `594d858` | now |
| --- | --- |
| `ferret status` and `ferret doctor` emit nothing, at any level | One record per probed component with its verdict, plus a summary carrying the verdict and the duration |
| A configured `logLevel` reaches `ferret env` and not `status`/`doctor` | `effectiveLogLevel` consults configuration on all three, and on the process-level logger; the flag still wins |
| No invocation identity anywhere in `src/` | Every record carries an opaque per-process `invocation`, plus `ferret` and `pid` |
| The log redactor knows six credential formats; the ingestion redactor knows twelve | The log redactor is composed *from* the ingestion list, so it can never again be the smaller one |
| Four Epics wrote "loggable" and never wrote the line | All four lines emitted, at the levels those Epics specified |

## The security defect, and why the fix is structural

§2.5 was the one genuine security defect. A Slack token, a Google API key, an
npm token and a Stripe key were values Ferret **refuses to store** and printed
verbatim to an operator's terminal, a CI transcript and a client's captured
stderr.

The fix is not four more regexes. `SECRET_VALUE_PATTERNS` is now
`OWN_VALUE_PATTERNS` spread with `SECRET_KINDS.map(k => k.pattern)` — EPIC-082's
own list, imported. A credential format added to `security/secrets.ts` is
redacted on the log path in the same commit, which is the only version of parity
that survives the next format.

The test is generated the same way, as §10 required: it iterates `SECRET_KINDS`
and asserts, per kind, that a synthetic instance is absent and that `[redacted]`
is present — masking rather than a record that failed to be written. A guard
test asserts the sample table and `SECRET_KINDS` have the same keys, so a kind
added to EPIC-082 fails here first and cannot be added without the log path
catching up.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 level, ISO time, msg, component, operation | MET | `structured-logging.test.ts` "carries the level, an ISO time, a message, the component and the operation" |
| AC-2 version and pid on every record | MET | Unit, and end to end in `cli-process.test.ts` across every record of a real `ferret status` |
| AC-3 one invocation, one id; two invocations, two ids | MET | Unit (stable across `child()` and across two loggers in one process); real-process test runs two concurrent CLIs and asserts different ids |
| AC-4 omitting `operation` is a compile error | MET | `@ts-expect-error` case. The proof it is real: turning `LogFields` into `OperationFields` broke **only test files** — all 27 production call sites already complied |
| AC-5 one record per probed component, with verdict and duration | MET | `cli-process.test.ts` against a real `ferret status --log-level debug` and `ferret doctor --log-level debug` |
| AC-6 dependable when a subsystem is unavailable | MET | With no database configured: exit 3, a parseable report on stdout, and `health.probe` records on stderr |
| AC-7 configured level reaches every command | MET | `FERRET_LOG_LEVEL=trace ferret status` — the direct regression for §2.3, which produced zero lines |
| AC-8 the flag overrides the configured level | MET | `--log-level silent` with `FERRET_LOG_LEVEL=trace` produces no records |
| AC-9 every EPIC-082 kind redacted from a log value | MET | 12 generated cases, one per kind, plus a near-miss negative and an assertion on the shared `redact` |
| AC-10 secret-named key redacted by name | MET | EPIC-001's regression, re-asserted |
| AC-11 `err` keeps its cause chain, gains no synthesised stack | MET | EPIC-031's regression test, unchanged and green |
| AC-12 a configuration write logs path and principal, never the value | MET | Two cases in `mcp/config-tools.test.ts`: an ordinary path, and a credential path written as a `$secret` reference with the reference absent from every record |
| AC-13 an authorization decision logs principal and permission at debug | MET | `authorization-logging.test.ts`, plus the negative — a denial must not also read as a grant |
| AC-14 confirmation request and consume logged at debug | MET | Both phases distinguished; the token is asserted absent from every record |
| AC-15 a denial logs the operation and the missing permission | MET | `authorization-logging.test.ts` |
| AC-16 one parseable document on stdout under `--json` at trace | MET | `cli-process.test.ts` |
| AC-17 silent with no flag and no configured level | MET | `cli-process.test.ts` |
| AC-18 no audit-event shape, no durable identifier | MET | Asserted over every record the new lines produce: no `eventId`, `auditId` or `sequence`. EPIC-083's refusal to pre-empt EPIC-085 is preserved |

## Performance — §13

Measured the way §13 measured it: 20 000 records, four fields, to a real file
descriptor, after a 2 000-record warm-up.

```
23.48 us/record over 20000 records
42596 records/sec
```

**Inside the 35 µs budget.** Note the added patterns are twelve, not the four
§13 anticipated: parity is achieved by composing EPIC-082's whole list rather
than by copying the four missing kinds, which is more regexes and one fewer
place for the two lists to drift.

The 23.5 µs figure is **not** claimed as an improvement on §13's 27.7 µs
baseline — that was measured on a different run and machine, and no A/B was
performed here. The claim is only the one the constraint asks for: the per-record
cost is inside the budget with the wider pattern set in place.

`sync: true` is unchanged, base bindings are computed once per logger, and the
invocation id is minted once per process.

## Two design notes

**The invocation id is process-scoped, not threaded.** A CLI invocation builds a
logger in `main` and another in the runtime; threading an id between them would
have left every future third construction site out of the correlation by
default. One process is one invocation — a CLI run, or an MCP stdio session — so
the id is the one the process already implies. `createLogger` still accepts an
override for a caller that needs to pin one.

**The write line is `mcp.config.stored`, not `mcp.config.set`.** The latter is
the tool name, and the guard already logs the authorization decision under it;
using the same name made the first version of the test match the wrong record.
The file changing and the caller being permitted are different events.

## Verification

`npm run verify` green: 108 files, 2374 passed, 3 skipped. New suites:
`tests/unit/structured-logging.test.ts` (25), `tests/unit/authorization-logging.test.ts`
(8), nine new real-process cases in `tests/integration/cli-process.test.ts`, two
in `tests/integration/mcp/config-tools.test.ts`.

## Raised, not absorbed

- **The real-process secret suite still asserts the database password only.**
  The twelve-kind parity is proved at the unit level, where it can be generated
  from `SECRET_KINDS`; extending the real-process suite to all twelve would add
  twelve process spawns to prove the same funnel a thirteenth time. Recorded
  rather than done.
- **`effectiveLogLevel` resolves configuration a second time** for `status` and
  `doctor`, which then resolve it again inside `probeCore`. Cheap and correct,
  but it is a second read; a shared resolution would belong with EPIC-095's
  diagnostics work rather than here.
- **`silent` is treated as "no logger"** rather than as a logger that discards.
  Observably identical, and it avoids constructing a stream nothing will write
  to — noted because it means `--log-level silent` and an absent level take the
  same code path.
