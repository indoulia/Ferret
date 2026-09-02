# EPIC-015 — Provider Configuration & Secrets

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-015-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §4, §12, §16, §18 and §22, following the Epic Specification
> Standard. It does not expand provider lifecycle/health (EPIC-014), conformance
> testing (EPIC-016), or credential storage backends (EPIC-081).

## 1. Objective

Give every provider its own validated configuration slice, resolved through
Ferret's precedence and secret-reference rules, and keep the secrets inside that
slice out of every rendered, logged and audited surface.

## 2. Value

`FerretConfig.providers` already carries a per-provider `{ enabled, options }`
record, but nothing validates `options`, nothing enforces `enabled`, and every
provider is handed the entire configuration — including the database password
and every other provider's options. A provider that mistypes an option finds out
at first use, far from the cause; a provider that holds a token has no way to
say so, and redaction that works by key name alone lets a token through under
the name `pat`.

## 3. Scope

- a provider declares the schema of its own `options`, and the option paths that
  hold secrets;
- the core resolves each provider's slice from `FerretConfig.providers[id]`,
  applies the declared schema, and supplies the result on the provider context;
- validation failure is a startup error naming the provider and the option path,
  never the value;
- `enabled: false` keeps a provider out of initialization, dependency checks and
  capability selection;
- secret-bearing option values are redacted wherever configuration is rendered,
  by declared path as well as by key name;
- configuration naming an unregistered provider id is reported rather than
  silently ignored.

## 4. Non-scope

- provider health, restart or failure isolation — EPIC-014 (**delivered
  2026-09-03**), EPIC-093;
- provider conformance suites — EPIC-016;
- OS keychain, vault or any credential store beyond the existing environment and
  file secret references — EPIC-081;
- narrowing `ProviderContext.config` itself, which is credential isolation —
  EPIC-081;
- provider-specific option meaning or defaults;
- runtime reconfiguration of a running provider.

## 5. Inputs

- EPIC-003 configuration engine: precedence, secret references, redaction;
- EPIC-011 provider contract and EPIC-012 SDK;
- EPIC-013 discovery, which decides which providers exist;
- `FerretConfig.providers`, a record keyed by provider id.

## 6. Outputs

- `Provider.configSchema` and `Provider.secretOptions` — optional declarations;
- `ProviderSettings` on `ProviderContext`, carrying `enabled` and the validated
  `options` for that provider only;
- `BaseProvider.settings` and `BaseProvider.options` accessors;
- `ProviderRegistry.isSecretConfigPath()`, a predicate `describeConfig` uses;
- `providerConfigurationWarnings()` for ids configured but not registered.

## 7. Dependencies

EPIC-003, EPIC-011, EPIC-012, EPIC-013.

## 8. Contracts

### Declared options

A provider may declare `configSchema`: any object exposing `safeParse(value)`.
Zod satisfies this structurally, so a provider is not coupled to Ferret's Zod
version. A provider that declares nothing receives its raw `options` record
unchanged.

### One slice per provider

The registry derives a per-provider context from the host context. A provider's
`settings.options` is its own slice; no provider's settings ever contain another
provider's options.

### Validation is a startup error

Options are validated once, immediately before `initialize`, so a bad option
fails where the mistake is. The error is `E_CONFIG_INVALID` and carries the
provider id and the failing option paths. Rejected values are never echoed.

### Disabled means absent

A provider disabled by configuration is registered — so diagnostics can say it
exists and is off — but is not initialized, not asked for dependency checks, and
not returned by capability selection. `supports()` reports the capability as
unavailable rather than pretending it is there.

### Declared secrets are redacted

`secretOptions` holds dotted paths into `options`. Any rendered configuration
redacts those paths in addition to the key-name rule EPIC-003 established.
Redaction by declaration is what covers a secret whose key name does not look
like one.

## 9. Acceptance criteria

- **AC-1** A provider receives its own `{ enabled, options }` slice and no other
  provider's options.
- **AC-2** A declared `configSchema` is applied, and its defaults and coercions
  reach the provider.
- **AC-3** Options that fail the declared schema raise `E_CONFIG_INVALID` naming
  the provider and the option path, with no value in the message or details.
- **AC-4** A provider declaring no schema receives its raw options unchanged.
- **AC-5** `enabled: false` prevents initialization, dependency checks and
  capability selection, and is visible in `describe()`.
- **AC-6** A disabled provider's `shutdown` is not called, because it was never
  initialized.
- **AC-7** Secret references inside provider options resolve through the existing
  EPIC-003 path, and an unresolvable one fails configuration resolution.
- **AC-8** A value at a declared `secretOptions` path is redacted by
  `describeConfig`, including when its key name is innocuous.
- **AC-9** Configuration naming an unregistered provider id is reported as a
  warning, and does not fail startup.
- **AC-10** Validation failure of one provider does not leave an earlier provider
  initialized.

## 10. Test requirements

- unit tests for slice isolation, schema application, defaults, and the
  no-schema path;
- unit tests asserting the validation error names the path and contains no
  value, including when the value is a credential;
- unit tests for disabled providers across initialize, checkAll, forCapability,
  supports and describe;
- unit tests for redaction by declared path, by key name, and nested;
- a test that an unresolvable secret reference in provider options fails
  resolution with the source named and the value absent;
- a test that unknown configured ids are reported and non-fatal.

## 11. Security requirements

A provider's own options are the only configuration this Epic hands it. Secrets
inside those options are resolved once, at configuration resolution, and are
never written back to disk, logged, or included in audit entries. Redaction is
enforced by Ferret at the render boundary, not by asking providers to be careful.
An option value is data: it may never be interpreted as a module specifier or
otherwise cause code to load.

## 12. Observability

`describe()` reports each provider's enabled state alongside its capabilities.
Runtime initialization logs the redacted configuration and any unknown-provider
warnings, both structured. Validation failures carry `providerId` and the failing
paths in `details`.

## 13. Performance constraints

One schema validation per provider per startup. No I/O beyond the secret-file
reads EPIC-003 already performs. No new dependency.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, exports, documentation
and validation evidence. No provider lifecycle, conformance or credential-store
behaviour is claimed here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — provider-specific validation lives with
  the provider; the core validates shape and boundary only.
- **§12 Security** — secrets are not rendered, logged or persisted, and options
  are data rather than policy.
- **§16 Configuration** — provider options ride the existing precedence ladder;
  a lower-trust layer cannot widen what a provider is given.
- **§18 Provenance and Explainability** — configuration introspection can say
  which provider is off, and where a secret comes from, without revealing it.
- **§22 Change Management** — stays within the approved Provider Configuration &
  Secrets capability.
