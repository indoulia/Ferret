# EPIC-081 — Credential Isolation · Validation Evidence

**Assessed against:** working tree on top of `ca79812`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, real `git`. Linux and Windows both green in CI.

## What changed, against what was measured

The specification's §2 measured three leaks. All three are closed.

| measured at `594d858` | now |
| --- | --- |
| Every provider receives the database password on `context.config` | `database.password` is absent from `ProviderContext.config` **at the type level** — reaching for it does not compile — and absent at runtime from the object the registry builds |
| `FERRET_DATABASE_PASSWORD` reaches every Git subprocess; `detectGit` passes no `env` at all | Removed by `withoutCredentials`, applied by `scrubEnvironment` and by `detectGit`; a boundary test bounds who may start a child process at all |
| `ferret init --save` replaces a stored `$secret` reference with the literal it resolved to | The reference survives; a literal is still written as a literal |

The first is worth stating precisely: the narrowing is enforced by `Omit`, so it
holds for provider code that has not been written yet. The conformance suite's
own "provider that logs the database password" test could no longer be
compiled — it had to be rewritten to reach the credential through the declared
grant, which is the only route that now exists.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 no credential field in `context.config` | MET | `credential-isolation.test.ts` "removes the password from what a provider sees" — `'password' in projected.database` is false, and the serialised projection contains no value. Enforced structurally by `ProviderVisibleConfig` |
| AC-2 the storage provider still connects | MET | Full integration suite against real PostgreSQL: 115 storage tests, `init-cli`, `migrations`, `durability`, `compatibility`, `performance`, plus the MCP and retrieval suites that start a real runtime. The provider declares `credentials: ['database.password']` and reassembles the config for `createPool` in one local |
| AC-3 `$secret` survives `--save` | MET | "leaves a stored `$secret` reference alone": after a resolved `setMany`, the stored value is still `{ $secret: { env: 'PW' } }` and the file contains no `hunter2` |
| AC-4 a literal is still written | MET | "still writes a literal password as a literal", and "overwrites a stored literal, because a literal is not an indirection". D-011 preserved |
| AC-5 a third source needs no schema change | MET | `test-vault` registered and resolved in a test; `databaseConfigSchema` untouched. **No keychain backend registered** — §16-3's dependency review has not happened; see Raised |
| AC-6 an unresolvable reference names the source | MET | "names the source in a failure and never the value"; unknown-source and malformed-body failures both raise `E_CONFIG_INVALID` |
| AC-7 an unavailable source is reported as one | MET | "reports an unavailable source as unavailable, never as an empty password" — `unavailableReason()` is consulted before `resolve()`, so a missing store cannot return nothing and have it used |
| AC-8 `scrubEnvironment` removes credentials and keeps removing the Git set | MET | Three tests, including one that feeds every one of `GIT_STRIPPED_ENV` back in and asserts each is still gone — the regression this Epic could most easily have caused |
| AC-9 no child process starts unscrubbed | MET | `boundaries.test.ts` "starts a child process from two modules and no others" and "gives every spawner the credential scrub". Both would have failed before this Epic |
| AC-10 `ferret doctor` reports the real at-rest protection | MET | `describeConfigProtection` reports Windows ACL inheritance as unenforced and returns **no mode** rather than Node's synthesised one; on a mode-bearing platform it reports the octal mode and whether it is owner-only. Rendered every run |
| AC-11 no credential reaches a log, error, audit entry or MCP response | MET | EPIC-003's and EPIC-015's redaction suites re-run unchanged and green, plus `init-cli`'s "never prints the database password, at any log level or output mode" and "does not print the saved password, and journals the change without it" |
| AC-12 the limitation rows are resolved or restated | MET | Four documents updated: `EPIC-003-VALIDATION.md` (two rows restated with the residue), `Checkpoints/EPIC-003.md` (two lines), `EPIC-015-VALIDATION.md` (the credential-store limitation restated, and the `ProviderContext.config` paragraph marked resolved) |

## Two things the type system now proves

**A provider cannot read the password.** Not "should not" — `context.config.database.password`
is a compile error. The one provider that needs it declares `credentials` and
reads `context.credentials['database.password']`, which is a line of code in the
provider rather than a consequence of being loaded.

**Only two modules may start a child process.** Bounded by test, so a third
spawner is a deliberate addition rather than an oversight. `detectGit` had been
passing the whole parent environment into `git --version` since EPIC-001,
through every review of every Epic that touched the file, because nothing was
looking. The least consequential subprocess in the codebase was the one handing
on the most.

## Where the runtime narrowing is applied

Two places build a `ProviderContext` in production, and both now project and
grant: `ProviderRegistry.#contextFor` and `src/cli/health.ts`. The second was
found by looking rather than by a failing test — a hand-built context passes a
full `FerretConfig`, which is *structurally* assignable to the narrowed type, so
the password would have continued to arrive at runtime while the type said
otherwise. Recorded because it is the failure mode of a type-only narrowing, and
the reason `createTestProviderContext` now projects too.

## Verification

`npm run verify` green: 106 files, 2330 passed, 3 skipped. New suite:
`tests/unit/credential-isolation.test.ts` (22). `tests/unit/boundaries.test.ts`
gains two assertions (104 total).

## Raised, not absorbed

- **No keychain backend.** AC-5 is satisfied by the seam with `env` and `file`
  registered against it, which is the outcome §16-3 named as acceptable if the
  dependency review rejected every candidate. That review has not happened
  rather than having failed: a Windows keychain binding is a native module, and
  Ferret's runtime dependencies contain none. The limitation is restated in
  EPIC-003's and EPIC-015's evidence rather than closed.
- **The at-rest gap on Windows is reported, not fixed.** It cannot be fixed by
  Ferret: the platform ignores the mode. AC-10 asked for a report and gets one.
  Setting an explicit ACL on the configuration directory is a larger change with
  a real chance of locking a user out of their own file, and no record asks for
  it.
- **A hand-built `ProviderContext` still leaks at runtime.** The `Omit` stops
  the code being written; it cannot stop a caller passing an object that happens
  to carry the field. Both production sites are correct and
  `createTestProviderContext` projects, but several integration tests construct
  contexts directly with a full config. They are testing storage, not isolation,
  and were left alone. A structural assertion over context-construction sites is
  the natural next step and belongs with EPIC-016 conformance.
- **`--save` with a password supplied only through `FERRET_DATABASE_PASSWORD`
  still writes the literal.** Considered and declined: writing an env reference
  instead would look tidier and would break Governance §3, since an AI client
  spawns Ferret with an environment Ferret does not control. A configuration
  that only works inside today's shell is a configuration that does not work.
