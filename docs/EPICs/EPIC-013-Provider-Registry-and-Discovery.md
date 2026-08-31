# EPIC-013 — Provider Registry & Discovery

**Status: APPROVED | Priority: P0**

> **Specification note.** This specification is authored from the approved
> registry entry and Governance §4, §5, §12, §13, §15 and §22, following the
> Epic Specification Standard. It does not expand provider configuration,
> lifecycle/health, or conformance testing beyond their separate Epics.

## 1. Objective

Make Ferret able to discover explicitly selected provider modules and register
all valid providers atomically and deterministically behind the existing
provider contracts.

## 2. Value

Providers are the extension boundary of Ferret. A registry that only accepts
providers constructed by application code is useful in tests but does not make
an installed provider usable. Discovery supplies that missing bridge without
letting repository content or repository policy decide what executable code is
loaded.

## 3. Scope

- explicit provider module discovery from an ordered list of module specifiers;
- support for one or multiple providers exported by a module;
- reuse of `ProviderRegistry` validation and capability indexing;
- deterministic module and provider ordering;
- best-effort handling of unavailable, malformed, and duplicate providers;
- machine-readable discovery results explaining every skipped module/provider;
- public provider-package export of the discovery contract.

## 4. Non-scope

- provider credentials or secrets — EPIC-015;
- provider initialization, health, shutdown, or failure isolation — EPIC-014;
- provider conformance suites — EPIC-016;
- repository-controlled provider activation;
- scanning arbitrary `node_modules` directories or repository files for code;
- package installation or dependency management;
- provider-specific behavior.

## 5. Inputs

- EPIC-011 provider contracts;
- EPIC-012 Provider SDK and `ProviderRegistry`;
- an explicit ordered list of module specifiers supplied by trusted application
  configuration or composition code.

## 6. Outputs

`discoverProviders()` returns the modules considered, providers registered, and
providers/modules skipped with stable reasons. Successfully discovered providers
are registered through the existing atomic `ProviderRegistry.register()` path,
so capability indexes and contract validation remain centralized.

## 7. Dependencies

EPIC-006, EPIC-010, EPIC-011 and EPIC-012.

## 8. Contracts

### Explicit activation

Discovery imports only module specifiers supplied by its caller. It never reads
repository policy, repository content, or an untrusted source to obtain a module
specifier. Provider code execution therefore remains an explicit composition
choice rather than a side effect of indexing a repository.

### Supported module shape

A provider module may export one provider as `default`, one as named `provider`,
or multiple providers as named `providers`. The registry remains the authority
for provider validity; discovery does not duplicate contract validation.

### Deterministic order

Modules are processed in caller order. Providers within a module are processed
in export order. The first successfully registered provider for a capability
therefore retains the registration-order semantics established by EPIC-011.

### Best-effort discovery

An unavailable or malformed optional provider is reported and skipped. A
successful provider already registered in the same discovery operation remains
available. Duplicate module specifiers and provider ids are reported rather than
silently replacing an existing registration.

## 9. Acceptance criteria

- **AC-1** An explicitly supplied module exporting a default Provider is loaded
  and registered.
- **AC-2** Named `provider` and `providers` exports are supported.
- **AC-3** Module processing and provider registration preserve deterministic
  caller/export order.
- **AC-4** Provider contract and capability validation remain centralized in
  `ProviderRegistry`; discovery does not create a second validation path.
- **AC-5** An unavailable module is reported as skipped without removing already
  registered providers.
- **AC-6** A malformed module export is reported as invalid and does not partially
  register a provider.
- **AC-7** Duplicate modules and provider ids are reported without replacing the
  existing registration.
- **AC-8** Empty module specifiers are rejected without executing a loader.
- **AC-9** Repository content and repository policy cannot cause discovery to
  execute a provider module.
- **AC-10** Discovery exposes machine-readable results sufficient for diagnostics
  and future AI administration without parsing human log text.

## 10. Test requirements

- unit tests for every supported export shape;
- unit tests for unavailable, malformed, duplicate and blank inputs;
- tests proving registration remains atomic and existing providers survive a
  failed discovery candidate;
- tests proving caller order is preserved;
- architecture/security review confirming discovery accepts explicit module
  specifiers only and has no repository-content input.

## 11. Security requirements

Provider modules execute application code and are therefore trusted dependencies,
not repository data. Discovery must never infer modules from `.ferret/config.json`,
Git metadata, file contents, or any other repository-controlled input. A future
configuration surface may choose explicit modules, but that policy belongs to
configuration governance and must not be widened by this Epic.

Malformed provider objects must pass through the existing registry validation
before they can enter the capability index. No credentials are accepted or
stored by this Epic.

## 12. Observability

Discovery returns a structured skip record for every unavailable, invalid, or
duplicate candidate. Callers can log or expose the result without pattern
matching prose. Successful provider ids are also returned in deterministic order.

## 13. Performance constraints

Discovery performs at most one dynamic import per unique module specifier and no
filesystem scan. Registry registration remains in-memory. No new infrastructure
or dependency is introduced.

## 14. Definition of Done

Implementation, unit/security tests, provider-package exports, documentation,
and validation evidence demonstrate all applicable acceptance criteria. No
provider configuration, lifecycle, or conformance behavior is claimed here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — providers remain behind the existing
  contract and registry.
- **§5 Reuse Before Reinvent** — Node's native dynamic module loader is reused;
  no package discovery framework is introduced.
- **§12 Security** — repository-controlled data never activates executable
  provider modules.
- **§13 Reliability** — optional provider discovery failures do not erase
  already available capabilities.
- **§15 Automatic Operation** — the registry is shaped for future automatic
  composition while this Epic keeps activation explicit and safe.
- **§22 Change Management** — this specification stays within the approved
  Provider Registry & Discovery capability.
