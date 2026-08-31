# EPIC-016 — Provider Conformance Testing: validation evidence

**Status: VALIDATED** · no new runtime dependency; the suite is 19 checks over
the contract Ferret already has, and it ships on the testing subpath so it
cannot reach a production bundle.

## What the suite does

`runConformance({ create })` builds a fresh provider per scenario and returns a
`ConformanceReport`: one `{ id, title, status, detail }` per check, always all
nineteen, with `pass`, `fail` or `skipped` and a reason. `assertConformant`
turns a failing report into `E_PROVIDER_INVALID` naming every failure. No test
framework is involved on either side.

The security content is the canary: the suite writes a unique value into every
option path the provider declared as a secret, runs the provider's whole
lifecycle against an unredacted capturing logger, and fails the provider if the
canary appears in what was logged or in an error it threw.

## Acceptance criteria

Rows are `tests/unit/provider-conformance.test.ts` unless stated.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 conformant provider, no failures | PASS | `produces a report with no failures` |
| AC-2 bad id / kind / version / capability declaration | PASS | four `contract declaration` tests, plus `fails a capability declared twice` |
| AC-3 throwing second initialize, bare shutdown, second shutdown | PASS | three `lifecycle` tests, each asserting its own check id |
| AC-4 concurrent initialize | PASS | `checks concurrent initialization` — a provider that rejects re-entry fails `lifecycle.initialize.concurrent` |
| AC-5 malformed dependency result; skipped when absent | PASS | `fails a malformed dependency result`; `skips a provider that does not implement it` |
| AC-6 logged secret fails, names the path not the value | PASS | `fails a provider that logs a declared secret` — asserts the detail contains `pat` and matches no `canary-…` |
| AC-7 secret in a thrown error | PASS | `fails a provider that puts a secret into a thrown error` |
| AC-8 skipped checks are reported and non-fatal | PASS | `skips the secret checks when nothing is declared`, `skips a provider that does not implement it`, `skips the schema check when none is declared` — each asserts `conformant` stays true |
| AC-9 `assertConformant` names every failure | PASS | `names every failed check` — one report, two unrelated failures, both in the message; `passes assertConformant quietly` for the clean case |
| AC-10 stable, enumerable ids | PASS | `emits only published check ids` — the emitted set and `CONFORMANCE_CHECK_IDS` are asserted equal in both directions |
| AC-11 Ferret's Git provider passes | PASS | `the Git source provider is conformant`, and `tests/integration/providers/conformance.test.ts` runs the PostgreSQL storage provider against a real server |
| AC-12 reachable from `./testing`, no new dependency | PASS | the unit suite imports it from `providers/sdk/testing.ts`, which is the `./testing` subpath; `tests/unit/boundaries.test.ts` asserts the core and SDK graphs do not reach `conformance.ts`, and the SDK's package set is unchanged |

## The nineteen checks

`contract.id`, `contract.kind`, `contract.version`, `contract.capabilities`,
`contract.registers`, `contract.selectable`, `config.schema.total`,
`config.secretOptions.paths`, `lifecycle.initialize`,
`lifecycle.initialize.idempotent`, `lifecycle.initialize.concurrent`,
`lifecycle.shutdown.bare`, `lifecycle.shutdown.idempotent`,
`lifecycle.shutdown.afterAbort`, `lifecycle.errors.classified`,
`dependencies.shape`, `security.secrets.notLogged`,
`security.secrets.notThrown`, `security.config.notLogged`.

## Design decisions worth recording

**A factory, not an instance.** EPIC-012 makes a stopped provider unrevivable,
so idempotency and concurrency each need their own instance. Handing the suite
one provider would have tested the harness.

**The report is always complete.** Checks the run never reached are filled in as
`skipped` with the reason, so a report has a fixed shape whatever happened. That
is what makes two reports diffable, and what stops a crash halfway through from
reading as a shorter, cleaner result.

**A failure sticks.** The recorder refuses to overwrite a `fail` with a later
`pass`. Several checks are touched by more than one scenario, and the easier
path must not erase what the harder one found.

**The password probe is the caller's password, not a substitute.** With no
configuration the suite plants its own canary. With a caller's configuration it
searches for *that* password — substituting one would make
`security.config.notLogged` pass by construction, which is worse than skipping
it. When the supplied configuration has no password, the check skips and says so.

**A provider whose id the schema would reject gets no configuration entry.** It
has already failed `contract.id`; building `providers['Not An Id']` would fail
configuration parsing and report Ferret's error instead of the provider's defect.

**The module cycle is deliberate and safe.** `conformance.ts` imports the test
doubles and `testing.ts` re-exports the suite, so `@indoulia/ferret/testing` is
one import for a provider author. The cycle is evaluation-safe because
conformance touches the doubles only inside function bodies.

## What the suite does not prove

- **Behaviour.** That a repository provider discovers repositories is
  EPIC-017's suite. This is the contract and only the contract.
- **Security.** A provider passes `security.secrets.notLogged` by not logging
  the paths it *declared*. A provider that declares nothing skips the check
  entirely — which the report says, but which a reader skimming for red will
  miss. Making declaration mandatory is a governance change, not a test change.
- **Isolation.** The suite runs provider code in-process with full privileges.
  It is a development tool; it does not sandbox anything.
- **That `checkDependencies` does not mutate.** The contract requires it; the
  suite checks the shape of what comes back, because mutation is not observable
  from outside.
- **Anything under `offline: true`**, which skips every scenario that drives
  `initialize`. The declaration checks still run, and the rest reports skipped.

## Applied to Ferret's own providers

`GitSourceProvider` — conformant, with the secret checks skipped because it
declares no secret options, which the test asserts explicitly rather than
letting a skip pass unnoticed.

`PostgresStorageProvider` — conformant against a real PostgreSQL 17 + pgvector
server. This is the run that matters: every lifecycle invariant the suite checks
is a way to leak a connection pool, and `security.config.notLogged` searches for
the real test database password rather than a planted one.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 31 files, 808 passed.
`vitest run tests/integration/providers`: 1 file, 1 passed, real PostgreSQL.
