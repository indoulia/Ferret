# EPIC-074 — External Provider Extension Framework

**Status: VALIDATED | Priority: P2 | Domain: External Project Knowledge**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under External Project Knowledge.

## 1. Objective

Make it possible for somebody who is not Ferret to write a provider — and find
out what was missing by checking rather than by assuming.

## 2. Value

Ferret's provider architecture is thorough. EPIC-013 discovers providers,
EPIC-016 supplies an SDK and a conformance suite, EPIC-011 defines capability
contracts, EPIC-099 gates every provider through the suite, and EPIC-081 handles
credentials. Five Epics of framework.

**And a third party could not load one.** `providers` in the configuration is
keyed by provider *id* and carries options, which presumes the provider is
already registered; nothing said where it comes from. The only module discovery
ever saw was Ferret's own parser subpath, hard-coded at two call sites. The
extension framework had a registry, a contract, a conformance suite and no way
in.

That is the kind of gap only an Epic that tries to *use* the framework finds,
which is what this one is for.

## 3. Scope

- **`providerModules`** in the configuration — the way in.
- **`src/providers/manifest.ts`** — what a package declares about itself, read
  from `package.json` rather than by importing it.
- **A pre-import compatibility gate** in discovery — §8.2.
- **`docs/Architecture/WRITING-A-PROVIDER.md`** — the guide, which is the part
  of an extension framework that is most often missing and most often the
  actual blocker.
- **The extension points, asserted** rather than assumed to work.

## 4. Non-scope

- **Sandboxing.** §8.5. A provider runs in-process with full privileges, and
  saying so is more useful than a sandbox that does not contain anything.
- **A plugin registry or marketplace.** Ferret resolves modules through npm,
  which is a package manager the user already has and already trusts.
- **Automatic discovery.** EPIC-013's position holds and §8.4 restates why:
  Ferret never scans a repository, a package tree or a policy file for code to
  execute.
- **Versioned capability negotiation beyond a contract range.** `contractVersion`
  with a supported range is what EPIC-010 built; a richer negotiation is a
  problem nobody has yet.
- **Loading a provider at runtime.** The registry seals at `initializeAll`, and
  EPIC-013 already reports a late registration as `lifecycle` rather than
  quietly accepting it.

## 5. Inputs

A configured list of module specifiers, and each package's `package.json`.

## 6. Outputs

The config field, the manifest module, the discovery gate and the guide.

## 7. Dependencies

EPIC-011 (capability contracts), EPIC-013 (discovery), EPIC-016 (the SDK and
conformance suite), EPIC-081 (secret references), EPIC-006/007 (the extension
points a provider registers into).

## 8. Contracts

### 8.1 A capability declaration is the interface, and it is already public

Nothing new is required for a third party to *write* a provider: `BaseProvider`,
`Capability`, `CAPABILITY_VERSIONS`, `configSchema`, `secretOptions`,
`registerEntityKind`, `registerRelationshipType` and `runConformance` are all
exported. This Epic asserts them — §9's last four criteria — rather than
assuming that because they are exported they work from outside.

### 8.2 A manifest is read before the package is imported

EPIC-013 imports a module and validates the provider it exports. That order has
a consequence nobody had written down: **a package built for a future Ferret
runs its top-level code in this one before being refused.** Importing is
executing, and the refusal arrives after the fact.

So a package may declare a `ferret.provider` manifest in its `package.json` —
data, not code — and discovery reads it first. A package targeting an
unsupported contract version is declined without being imported.

Three verdicts, and only one stops an import:

- **`unsupported-contract`** — declines. The package says it is for a different
  Ferret.
- **`absent`** — imports. A package with no manifest predates this Epic or
  simply did not write one, and refusing those would make this a breaking change
  for every provider written before this sentence.
- **`malformed`** — imports. A package that got its own metadata wrong is not
  evidence that its code will not work.

A manifest that cannot be *read at all* is silence, not a refusal: the specifier
may be a relative path or a workspace link with no reachable `package.json`, and
failing to find metadata says nothing about compatibility.

### 8.3 There is a way in, and it is a list a human writes

`providerModules` in the configuration. Empty by default, because Governance §2
requires `parseConfig({})` to succeed.

Rendered by `describeConfig` even when empty — "no external providers are
configured" is a diagnosable fact, and an omitted field would make it
indistinguishable from a Ferret that cannot load any.

### 8.4 Naming a module is authorising code execution, and that is the honest description

EPIC-013 says it and this Epic does not soften it: Ferret never scans a
repository, a package tree or a policy file for code to run. A human writes the
list, and writing it authorises everything that package does.

The manifest gate refuses an *incompatible* package. It refuses nothing else,
and it is not a security boundary — the package writes its own manifest, so a
hostile one lies. Saying this plainly is worth more than a warning, because the
alternative is somebody believing the gate is a defence.

### 8.5 A provider is not sandboxed, and pretending otherwise would be worse

A provider runs in-process with full privileges. EPIC-024's framework bounds a
*parser* by size and stops the process from dying when one throws — and its own
comment already says that is a different claim from containing it.

An extension framework that implied isolation it does not provide would be
worse than one that says there is none: the first produces a user who installs
something they would not have.

### 8.6 A registered kind is validated, not waved through

`registerEntityKind` takes a schema and the schema is enforced on every entity
of that kind — an extension does not get a laxer model than Ferret's own. An
unregistered relationship type is still refused. AC-15 to AC-18 assert both,
because "extensible" and "unchecked" are easy to confuse and only one of them is
a feature.

### 8.7 The guide is part of the framework

`docs/Architecture/WRITING-A-PROVIDER.md`. The part of an extension framework
most often missing is not a capability — it is the sentence that tells somebody
which of the four exported things to start from. It also carries the three
things Ferret will *not* do: sandbox you, retry your network calls, or merge
your entities with anybody else's.

## 9. Acceptance criteria

- **AC-1** A well-formed manifest is read.
- **AC-2** An absent manifest is silence and does not stop an import.
- **AC-3** An unsupported contract version stops an import.
- **AC-4** A malformed manifest is reported and does not stop an import.
- **AC-5** A manifest error names the failing path and not the value.
- **AC-6** A non-object is refused.
- **AC-7** An unknown capability is refused.
- **AC-8** Discovery declines an incompatible package **without importing it**.
- **AC-9** Discovery imports a compatible package.
- **AC-10** Discovery imports a package with no manifest.
- **AC-11** An unreadable manifest is treated as silence.
- **AC-12** A bare loader is still accepted positionally — EPIC-013's callers.
- **AC-13** `providerModules` exists, defaults to empty, and refuses an empty
  specifier.
- **AC-14** `parseConfig({})` still succeeds.
- **AC-15** A provider can register an entity kind and create one.
- **AC-16** A registered kind's attributes are validated.
- **AC-17** A provider can register a relationship type.
- **AC-18** An unregistered relationship type is still refused.

## 10. Test requirements

**Unit** — every acceptance criterion. AC-8 is the one that matters: it asserts
the loader was *not called*, which is the only way to state "before importing".

**Regression** — EPIC-013's discovery suite, unchanged, because AC-12 is what
keeps it so.

## 11. Security requirements

§8.4 and §8.5, and both are statements rather than mechanisms. The one mechanism
is AC-5: a manifest is a package's own file, so an error names the failing path
and never echoes the value into a log.

## 12. Observability

`describeConfig` renders `providerModules`. Discovery reports `incompatible` as
a distinct skip reason, so a package declined for its contract version is
distinguishable from one that failed to load.

## 13. Performance constraints

One extra file read per configured module, before an import that would have cost
more.

## 14. Definition of Done

Scope implemented; AC-1 to AC-18 with evidence in
`validation/EPIC-074-VALIDATION.md`; `npm run verify` green; the registry
updated.

## 15. Governance alignment

- **§2 Zero-configuration** — `providerModules` defaults to empty.
- **§6 Evidence Before Inference** — §8.2's three verdicts: silence, a mistake
  and an incompatibility are three facts and only one is a refusal.
- **§12 Untrusted Input** — §8.4, §8.5, AC-5.
- **§5 Reuse Before Reinvent** — nothing new was needed for a third party to
  *write* a provider; what was missing was a way in and a guide.

## 16. Raised, not absorbed

- **The manifest is unverifiable.** A package writes its own, so it can claim
  any contract version. This buys an honest package a clean failure; it buys
  nothing against a dishonest one, and §8.4 says so rather than implying
  otherwise.
- **Nothing loads `providerModules` yet.** The field exists and discovery can
  use it; the composition root still hard-codes Ferret's own parser subpath at
  two call sites. Wiring it is a change to the CLI's composition that this Epic
  did not make, and doing it without the change would have been a config field
  that silently does nothing — which is worse than an unwired one that is
  documented.
- **No provider outside this repository has been written against the guide.**
  The guide is derived from the five providers inside it, which is the best
  available evidence and is not the same as a stranger succeeding.
- **A provider still cannot be unloaded.** The registry seals, deliberately.
- **`registerEntityKind` is process-global.** Two providers registering the same
  kind name with different schemas is a conflict nothing detects, because
  nothing has yet had two.

## 17. Recorded during implementation

**The gap was not a missing capability. It was a missing door.** Five Epics
built a provider framework — registry, contract, SDK, conformance suite,
credential handling — and the configuration had no field naming a module to
load. Every one of those Epics was correct in itself; the hole was between them,
which is where holes are.

**Discovery imported before it validated.** Writing the manifest was meant to be
a small documentation-adjacent addition; asserting that an incompatible package
is declined turned up the ordering, and AC-8 is written as *"the loader was not
called"* because that is the only way to state it. A package for a future Ferret
had been running its module-level code here before being refused.

**Three verdicts, not two.** The first version refused any package without a
valid manifest, which would have been a breaking change for every provider
written before this Epic — including Ferret's own parser subpath, which has no
manifest and never needed one. Silence, a mistake and an incompatibility are
three different facts and only the last is a refusal.

Full evidence in [validation](validation/EPIC-074-VALIDATION.md).
