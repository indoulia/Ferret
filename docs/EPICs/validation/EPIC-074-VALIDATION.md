# EPIC-074 — External Provider Extension Framework — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-074](../EPIC-074-External-Provider-Extension-Framework.md), AC-1 to AC-18.

Ferret's provider architecture is thorough: EPIC-013 discovers, EPIC-016
supplies an SDK and a conformance suite, EPIC-011 defines capability contracts,
EPIC-099 gates every provider through the suite, EPIC-081 handles credentials.
Five Epics of framework.

**And a third party could not load one.**

## The gap was not a missing capability

`providers` in the configuration is keyed by provider *id* and carries options,
which presumes the provider is already registered. Nothing said where it comes
from. The only module discovery had ever seen was Ferret's own parser subpath,
hard-coded at two call sites.

Every one of those five Epics was correct in itself. The hole was between them,
which is where holes are, and it took an Epic that tried to *use* the framework
to find it.

## The finding: discovery imported before it validated

Writing a manifest was meant to be a documentation-adjacent addition. Asserting
that an incompatible package is declined turned up the ordering: EPIC-013
imports a module and validates the provider it exports, so **a package built for
a future Ferret ran its top-level code in this one before being refused.**

Importing is executing. The refusal arrived after the fact.

AC-8 is written as *"the loader was not called"*, because that is the only way
to state "before importing":

```ts
let imported = false;
const result = await discoverProviders(registry, ['@acme/future'], {
  load: () => { imported = true; /* … */ },
  readManifest: () => Promise.resolve(manifest({ contractVersion: 2 })),
});
expect(imported).toBe(false);
```

## Three verdicts, not two

The first version refused any package without a valid manifest. That would have
been a breaking change for every provider written before this Epic — including
Ferret's own parser subpath, which has no manifest and never needed one.

| Verdict | Stops the import | Why |
|---|---|---|
| `unsupported-contract` | **yes** | The package says it is for a different Ferret |
| `absent` | no | Silence: it predates this Epic or did not write one |
| `malformed` | no | A package that got its own metadata wrong is not evidence its code will not work |

An unreadable manifest — a relative path, a workspace link with no reachable
`package.json` — is silence too. Failing to *find* metadata says nothing about
compatibility.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `reads a well-formed one`. |
| AC-2 | **MET** | `treats an absent manifest as silence, not as a refusal`. |
| AC-3 | **MET** | `refuses a future contract version, and only that`. |
| AC-4 | **MET** | `reports a malformed manifest without echoing its contents`. |
| AC-5 | **MET** | The same test: the detail names `contractVersion` and never the value. A manifest is a package's own file, and echoing its values into an error is echoing untrusted text into a log. |
| AC-6 | **MET** | `refuses anything that is not an object`. |
| AC-7 | **MET** | `refuses an unknown capability rather than accepting it`. |
| AC-8 | **MET** | `declines an incompatible package before importing it — the finding`. |
| AC-9 | **MET** | `imports a compatible package`. |
| AC-10 | **MET** | `imports a package with no manifest at all`. |
| AC-11 | **MET** | `treats an unreadable manifest as silence`. |
| AC-12 | **MET** | `still accepts a bare loader, as EPIC-013 callers pass one`. |
| AC-13 | **MET** | `has somewhere to name an external provider module`; `refuses an empty specifier`. |
| AC-14 | **MET** | `defaults to empty, so parseConfig({}) still succeeds — Governance §2`. |
| AC-15 | **MET** | `lets a provider register an entity kind and use it`. |
| AC-16 | **MET** | `validates a registered kind attributes, rather than waving them through` — "extensible" and "unchecked" are easy to confuse and only one is a feature. |
| AC-17 | **MET** | `lets a provider register a relationship type between existing kinds`. |
| AC-18 | **MET** | `still refuses an unregistered relationship type`. |

## What the guide says that the code cannot

`docs/Architecture/WRITING-A-PROVIDER.md` is part of the deliverable. The part
of an extension framework most often missing is not a capability — it is the
sentence telling somebody which of the four exported things to start from.

It also carries the three things Ferret will not do, which an author needs
before they start rather than after:

- **It will not sandbox you.** A provider runs in-process with full privileges.
  EPIC-024's framework bounds a *parser* and its own comment already says that
  is a different claim from containing it. An extension framework that implied
  isolation it does not provide is worse than one that says there is none.
- **It will not retry your network calls.**
- **It will not merge your entities with anybody else's.**

## What this does not claim

- **The manifest is unverifiable.** A package writes its own, so it can claim
  any contract version. This buys an honest package a clean failure and buys
  nothing against a dishonest one. §8.4 says so rather than implying otherwise —
  what authorises loading a module is a human naming it in configuration.
- **Nothing loads `providerModules` yet.** The field exists and discovery can
  use it; the composition root still hard-codes the parser subpath at two call
  sites. Wiring it is a CLI composition change this Epic did not make — and
  shipping the field unwired *and documented* is better than shipping it wired
  in a way nobody reviewed.
- **No provider outside this repository has been written against the guide.**
  It is derived from the five inside it, which is the best available evidence
  and is not the same as a stranger succeeding.
- **`registerEntityKind` is process-global**, and two providers registering the
  same kind name with different schemas is a conflict nothing detects — because
  nothing has yet had two.
