# EPIC-016 — Provider Conformance Testing

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-016-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §4, §12, §13, §19 and §22, following the Epic Specification
> Standard. It does not expand provider lifecycle/health (EPIC-014), and it is
> the conformance *suite*, not the cross-provider quality harness that runs it
> over time (EPIC-099).

## 1. Objective

Give any provider — in this repository or in someone else's package — an
executable definition of what the provider contract actually requires, and a
machine-readable verdict on whether it complies.

## 2. Value

EPIC-011 states the contract in prose and types, EPIC-012 implements the hard
parts once, EPIC-015 adds configuration and secret rules. None of that stops a
provider from initializing twice under a race, throwing from a second
`shutdown`, returning a malformed dependency result, or writing its own token
into a log line. Those are the failures that surface as someone else's outage,
and every one of them is checkable from outside the provider.

Without a shared suite each provider author reinvents the same dozen tests,
badly or not at all, and Ferret has no answer to "is this third-party provider
safe to install" beyond reading its source.

## 3. Scope

- a conformance suite covering contract declaration, lifecycle, dependency
  reporting, configuration declaration and secret handling;
- a runner that takes a provider factory and returns a structured report;
- an assertion helper that turns a failing report into a classified error;
- stable check identifiers, so a report can be compared across runs and
  versions;
- publication through `@indoulia/ferret/testing`, so a provider outside this
  repository can run it;
- application of the suite to Ferret's own providers.

## 4. Non-scope

- capability *behaviour* semantics — that a repository provider actually
  discovers repositories is EPIC-017's suite, not this one;
- the cross-provider quality harness, scoring and trend reporting — EPIC-099;
- provider health monitoring at runtime — EPIC-014 (**state and recovery
  delivered 2026-09-03; nothing polls**), EPIC-093;
- certifying a provider as secure: the suite checks stated invariants, it does
  not audit provider source;
- any test-framework dependency. The suite returns data; a caller asserts on it
  in whatever framework it already uses.

## 5. Inputs

- EPIC-011 provider contract and capability declarations;
- EPIC-012 SDK test doubles (`CapturingLogger`, `createTestProviderContext`);
- EPIC-015 provider settings and declared secret option paths;
- a provider *factory*, because lifecycle checks need independent instances.

## 6. Outputs

- `runConformance(options)` returning a `ConformanceReport`;
- `assertConformant(report)`, throwing `E_PROVIDER_INVALID` naming every failed
  check;
- `ConformanceCheck` — `{ id, title, status, detail }` with `pass`, `fail` or
  `skipped`;
- `CONFORMANCE_CHECK_IDS`, the complete stable list.

## 7. Dependencies

EPIC-011, EPIC-012, EPIC-015.

## 8. Contracts

### A factory, not an instance

`create()` is called per scenario. A provider that has shut down must not be
revived — EPIC-012 makes that an error — so idempotency and concurrency checks
each need their own instance, and reusing one would test the harness rather than
the provider.

### Skipped is a result, not a gap

A check that cannot apply — no `checkDependencies`, no declared schema, no
declared secrets — reports `skipped` with the reason. A report is conformant
when nothing failed; skipped checks are visible so a reader can see what was not
proven, which Governance §6 requires of any claim.

### Secrets are checked by canary

The suite writes a unique canary into every option path the provider declared as
a secret, runs the provider's whole lifecycle against a capturing logger, and
fails the provider if the canary appears in what was logged or in an error it
threw. The logger captures *unredacted*, so the check inspects what the provider
passed in rather than what redaction already cleaned.

The database password is checked the same way, but the value searched for is the
caller's own: with no supplied configuration the suite plants a canary password,
and with one it searches for that password rather than substituting a canary,
which would make the check pass by construction.

### The suite never touches an external system on purpose

It calls only contract methods. A provider whose `initialize` opens a connection
will try to open one; that is the provider's design, and `offline: true` skips
the checks that would drive it.

## 9. Acceptance criteria

- **AC-1** A conformant provider produces a report with no failures.
- **AC-2** A malformed id, unknown kind, unsupported contract version or invalid
  capability declaration each fail their own named check.
- **AC-3** A provider that throws from a second `initialize`, from `shutdown`
  without `initialize`, or from a second `shutdown` fails the matching lifecycle
  check.
- **AC-4** Concurrent `initialize` calls are checked, and a provider that fails
  under them is reported.
- **AC-5** A malformed `DependencyCheckResult` fails the dependency-shape check;
  a provider without `checkDependencies` skips it.
- **AC-6** A provider that logs a declared secret option fails the secret check,
  and the failing check names the option path, never the value.
- **AC-7** A provider that puts a secret into a thrown error fails the same way.
- **AC-8** Checks that cannot apply report `skipped` with a reason, and do not
  make the report non-conformant.
- **AC-9** `assertConformant` throws `E_PROVIDER_INVALID` naming every failed
  check, and returns quietly for a conformant report.
- **AC-10** Check identifiers are stable and enumerable, and every check the
  runner can emit appears in `CONFORMANCE_CHECK_IDS`.
- **AC-11** Ferret's own Git provider passes the suite.
- **AC-12** The suite is reachable from `@indoulia/ferret/testing` and adds no
  runtime dependency.

## 10. Test requirements

- a conformant fixture provider producing a clean report;
- a fixture per failure mode: bad id, bad kind, bad version, bad capability
  declaration, throwing second initialize, throwing bare shutdown, throwing
  second shutdown, malformed dependency result, secret-logging, secret-throwing;
- tests that skipped checks are reported and do not fail the report;
- a test that every emitted check id is in the published list;
- the real Git provider run through the suite;
- a boundary test that neither the core nor the SDK import graph reaches the
  suite, and that it is imported through the `./testing` module.

## 11. Security requirements

The canary checks are the security content of this Epic: a provider that leaks a
declared secret into a log or an error fails conformance. The suite must not
itself disclose a canary — a failing check names the option path and the sink,
never the value. The suite executes provider code, so it is a development tool
and is published on the testing subpath, never reachable from the package root.

## 12. Observability

The report is data: every check carries a stable id, a human title, a status and
a detail. A caller can print it, diff it between versions, or assert on
individual ids without parsing prose.

## 13. Performance constraints

The suite runs a bounded number of lifecycle scenarios — under twenty provider
instantiations — and performs no I/O of its own. Total time is whatever the
provider's own `initialize` costs.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, application to a real
provider, `./testing` export, documentation and validation evidence. No
capability-behaviour or cross-provider harness behaviour is claimed here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — the contract becomes executable, so the
  boundary is enforced rather than described.
- **§12 Security** — a provider that leaks a declared secret fails, and the
  failure names the path rather than the value.
- **§13 Reliability** — the lifecycle invariants checked here are exactly the
  ones whose violation makes one provider break another.
- **§19 Testing and Quality** — the suite ships with the contract rather than
  being re-derived per provider.
- **§22 Change Management** — stays within the approved Provider Conformance
  Testing capability.
