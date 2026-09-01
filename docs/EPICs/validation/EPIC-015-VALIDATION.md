# EPIC-015 — Provider Configuration & Secrets: validation evidence

**Status: VALIDATED** · no database, no new runtime dependency; the schema a
provider declares is its own, and the core only calls `safeParse` on it.

## What the Epic does

`FerretConfig.providers` has carried `{ enabled, options }` since EPIC-003 and
nothing read it. Now the registry resolves each provider's slice before it
initializes that provider, validates `options` against a schema the provider
declares, hands the provider that slice and nothing else, refuses to start a
provider configuration switched off, and knows which option values are secrets
so `describeConfig` can redact them by declaration rather than by key name.

## Acceptance criteria

Every row is `tests/unit/provider-configuration.test.ts` unless stated.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 own slice, no other provider's options | PASS | `gives a provider its own slice and no other provider options`, and `hands each provider only its own settings` — two providers initialize, each sees only its own record |
| AC-2 declared schema applied, defaults reach the provider | PASS | `applies a declared schema, including its defaults` — `depth: '25'` coerces to `25` and `followTags` arrives defaulted |
| AC-3 error names provider and path, echoes no value | PASS | `names the failing option path and echoes no value` asserts `auth.token` is named and `12345` appears in neither message nor details; `keeps a credential out of the validation error` repeats it with a token-shaped value |
| AC-4 no schema means options unchanged | PASS | `passes options through untouched when no schema is declared` |
| AC-5 disabled: no initialize, no selection, visible | PASS | `is not initialized, and reports as disabled`; `is not selected for its capability` (`forCapability`, `allForCapability`, `supports`); `lets an enabled provider behind a disabled one win the capability`; `is not asked for dependency checks` |
| AC-6 disabled provider is not shut down | PASS | `is not shut down, because it was never initialized` |
| AC-7 secret references in options resolve, unresolvable fails | PASS | `resolves a secret reference in provider options`; `fails resolution when the reference cannot be resolved, naming only the source` |
| AC-8 declared secret path redacted | PASS | `redacts a declared secret option whose key name looks innocuous`; `redacts a nested declared secret, and the whole subtree of a declared prefix`; `does not redact another provider because one declared the same option name`; `is available from the registry for the providers it holds` |
| AC-9 unknown configured id reported, not fatal | PASS | `reports a configured id no registered provider claims`; `does not fail startup` |
| AC-10 failed validation leaves nothing initialized | PASS | `validates before initialize, and leaves nothing initialized on failure` — the first provider's `shutdown` runs, the second never initializes |

## Design decisions worth recording

**`configSchema` is structural, not `z.ZodType`.** A provider shipped as its own
package brings its own Zod, and a nominal type would make two copies of the same
library incompatible for no benefit. The core requires only
`safeParse(value) => { success, data | error.issues }`, which every Zod schema
satisfies as written and a hand-rolled validator can satisfy in ten lines. It
also keeps Governance §4 honest: provider-specific validation lives with the
provider, and the core knows only that a schema exists and where its failures
point.

**Redaction paths are segments, not a dotted string.** A provider id contains
dots, so `providers.ferret.source.github.options.pat` cannot be split back into
its parts unambiguously. `describeConfig`'s `secret` predicate receives
`['providers', 'ferret.source.github', 'options', 'pat']`, which can.

**A declared path covers everything beneath it.** Declaring `endpoint` redacts
`endpoint.pat` and `endpoint.login` both. That is the safe direction to be wrong
in, and it gives a provider a way to say "this whole subtree is credentials"
without enumerating keys it may add later.

**Disabled providers stay in the capability index and are filtered at
selection.** Removing them from the index would make re-enabling a provider a
re-registration rather than a configuration change, and would lose the
descriptor that lets diagnostics say *installed and off* — which is a different
answer from *not installed*, and only one of them is a missing dependency.

**`ProviderContext.config` is still the whole configuration.** Narrowing it is
credential isolation, EPIC-081, and doing it here would have broken the storage
provider's access to `config.database` for no gain this Epic claims. What is
new is that a provider no longer has to reach into `config.providers[myId]`
itself, and that the settings it does get are validated.

**Resolved by EPIC-081.** `ProviderContext.config` no longer carries a
credential — `database.password` is absent from the type, so reaching for it
does not compile. The storage provider's access was preserved the way this
paragraph anticipated it could not be: it *declares* the credential it needs and
receives it in `context.credentials`, which is a visible line in the one
provider that opens the connection rather than a property of being loaded.

## Boundary and surface changes

`providers/configuration.ts` joins the boundary test's core allowlist, on the
same ground as `sdk/` and `discovery.ts`: it is machinery over the contract, it
imports no concrete provider, and the public package exports it.

`ProviderContext.settings` is required rather than optional. A provider reading
`context.settings.options` on a hand-built context would otherwise crash at the
first property access, and the churn is confined to test doubles and one CLI
health probe, all updated in this change.

`ProviderDescriptor.enabled` is new, and `describeProvider` takes it as a third
parameter defaulting to `true`.

## Limitations

- **Options are validated once, at startup.** Reconfiguring a running provider
  is out of scope; a change takes effect on the next run.
- **No credential store.** Secrets come from an environment variable or a file.
  **Restated by EPIC-081**: those two are now registrations against a resolver
  seam rather than branches in one function, so a keychain is a third
  registration and needs no schema change. None is registered — the dependency
  review a native binding requires has not happened (EPIC-081 §16-3).
- **A provider that declares no `secretOptions` gets key-name redaction only**,
  which will miss a credential under an innocuous name. Declaration is the fix
  and nothing forces a provider to declare — EPIC-016 conformance is where that
  could become a requirement.
- **`enabled` is not consulted before `initializeAll`.** The registry has no
  configuration until the runtime hands it one. Nothing selects a provider
  before then, because registration seals at that point, but a caller that
  drives the registry directly and calls `forCapability` first will see a
  disabled provider.
- **An unregistered configured id is a warning, not an error.** A configuration
  file shared across machines may legitimately name a provider only some of them
  install.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 30 files, 781 passed.
`vitest run tests/integration`: 30 files, 603 passed, 3 skipped.
