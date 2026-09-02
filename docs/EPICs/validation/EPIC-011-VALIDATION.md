# EPIC-011 — Validation Evidence

**Epic:** EPIC-011 — Provider Contracts
**Branch:** `feat/epic-011-provider-contracts`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

> **Specification note.** EPIC-011 had no specification file — the registry
> approved the capability by name, domain and priority. The specification was
> written first, to the approved standard, from the registry entry and
> Governance §4, and is part of this change. **The acceptance criteria validated
> below are therefore ones this work authored**, which is worth stating plainly.
> They are drawn from the registry's domain and the governance rules; nothing was
> invented, and the specification is in the diff for review.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Every approved capability has a versioned contract | **PASS** | Eight capabilities in `Capability`, each with its own entry in `CAPABILITY_VERSIONS` and `MINIMUM_CAPABILITY_VERSIONS`. `capabilities.test.ts` → "the capability catalogue" asserts the exact set and that each version is independent. |
| AC-2 | A provider declares which capabilities it implements, and at which versions | **PASS** | `Provider.capabilities` carries `CapabilityDeclaration[]`. The storage provider declares `storage` with its systems and limits — `capabilities.test.ts` → "the storage provider adopts the contract". |
| AC-3 | The core selects a provider by capability, never by concrete identity | **PASS** | `ProviderRegistry.forCapability` / `allForCapability`. Enforced architecturally: `boundaries.test.ts` → "capability boundary" (4 cases) proves the core entry point reaches no `storage/` module and that the contract itself imports no implementation. |
| AC-4 | A provider implementing part of a capability is usable, and callers can discover what is missing | **PASS** | `CapabilityDeclaration.operations` names a subset; `declares()` and `describeSupport(capability, …, operation)` answer before the call. `capabilities.test.ts` → "partial implementation" (2 cases) and `OPERATION_UNSUPPORTED`. |
| AC-5 | Capability versions are checked before use, and an unsupported version is refused clearly | **PASS** | `isSupportedCapabilityVersion` and `validateCapabilityDeclaration`, checked at **registration**. `capabilities.test.ts` → "refuses a version this runtime cannot honour, naming the span". |
| AC-6 | A capability contract can be added without changing existing providers | **PASS** | `Provider.capabilities` is optional, so every EPIC-001-era provider still registers and is lifecycle-managed. `capabilities.test.ts` → "registers a provider that declares nothing, but never selects it". |
| AC-7 | Provider-declared limits are queryable before an operation is attempted | **PASS** | `CapabilityLimits` on the declaration; `registry.declarationFor(capability)`. `capabilities.test.ts` → "reports declared limits before an operation is attempted". |
| AC-8 | Core code cannot import a concrete provider, enforced by test | **PASS** | `boundaries.test.ts` → "does not reach a concrete provider from the core entry point", plus the reverse direction: a provider depends on the contract, the contract on no provider. |

**8 / 8 PASS.**

---

## 2. Test requirements

| Required test | Status | Location |
| --- | --- | --- |
| Capability declaration and validation | PASS | `capabilities.test.ts` → "declaring a capability" (4 cases) |
| Version checking within and outside the range | PASS | "the capability catalogue" (4 cases) |
| Selection by capability | PASS | "selecting a provider by capability" (10 cases) |
| Partial implementation | PASS | "partial implementation" (2 cases) |
| Metadata and limits | PASS | limits queryable; `describe()` reports capabilities |
| Storage provider adopts the contract with no behaviour change | PASS | Every pre-existing storage test passes unmodified |
| Two providers of one capability coexist | PASS | "selects deterministically", asserted in both registration orders |
| Unsupported capability version | PASS | refused at registration, naming the span |
| Provider declaring a capability it does not implement | PASS | refused at registration (`E_PROVIDER_INVALID`) |
| Cancelled operation / unclassified error | **NOT APPLICABLE** | See §4 |
| Security: credentials in metadata or limits | PASS | Limits are a closed shape of booleans, numbers and a note; a provider gets no global state. See §5 |
| Architecture | PASS | `boundaries.test.ts` → "capability boundary" (4 cases) |

---

## 3. The defect this Epic's own tests caught

**Registration was not atomic.** Capability declarations were validated *after*
the provider had been inserted into the registry's map and order, so a provider
with an invalid declaration was left half-registered: present in `size` and in
`describe()`, absent from the capability index. The inconsistency would have
outlived the error that caused it, and the next thing to read the registry would
have found a provider that could never be selected and no explanation why.

Fixed by validating every declaration before recording anything. Asserted by
"refuses to register a provider whose declaration is invalid", which checks
`registry.size` is still zero.

---

## 4. Why two test areas are NOT APPLICABLE

**Cancellation and unclassified-error contracts.** The specification states both
as invariants every capability implementation must satisfy — an operation
observes its `AbortSignal`, a failure is a classified `FerretError`. Those are
real requirements, but they are properties of an *implementation*, and the only
provider that exists is the storage provider, whose operations are single
database round-trips with nothing to cancel.

Writing a test today would mean writing a fake provider that deliberately
misbehaves and asserting the fake does what the fake was written to do — which
demonstrates nothing about Ferret. **EPIC-016 (Provider Conformance Testing) is
the right home**: a suite every real provider must pass, run against Git, GitHub
and Jira implementations where cancellation and error classification are
genuinely at stake. Recorded here rather than fabricated.

---

## 5. Security

A provider is a trust boundary: it talks to systems Ferret does not control and
returns content Ferret must treat as untrusted (Governance §12).

| Concern | Handling |
| --- | --- |
| A provider reaching global state | Unchanged from EPIC-001: a provider receives a logger, config, environment and signal. It constructs no logger, reads no `process.env` and holds no database handle it was not given. |
| A credential in metadata or limits | `CapabilityLimits` is a closed shape — booleans, numbers and one note string. There is no free-form field for a secret to land in, and the note passes through the same redaction as everything else Ferret prints. |
| A provider lying about what it implements | Refused at registration, not at first use, so the failure names the provider instead of surfacing far away as a broken operation. |
| A missing capability as a denial of service | It is not. A capability with no provider is a *reportable state*, and callers are expected to degrade — Governance §13 wants a missing capability to reduce what Ferret can answer, not break what it can. `assertSupported` exists for the few call sites that genuinely cannot degrade. |

---

## 6. Performance

Capability selection is on the hot path of every operation that reaches a
provider, so it is an index rather than a scan through declarations.

| Measurement | Budget |
| --- | --- |
| 10,000 lookups across 200 registered providers | 200 ms |

A scan would be 2,000,000 comparisons and would show against that ceiling.

---

## 7. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Every capability has a versioned contract with stated invariants | **PASS** | `src/providers/capabilities.ts`; invariants in the specification §8. |
| The storage provider is expressed through the contract, with no behavioural change | **PASS** | It declares `storage`; every pre-existing storage test passes unmodified. |
| Selection by capability implemented, tested, documented | **PASS** | 28 cases; the specification and the module doc comment explain the reasoning. |
| The architecture test proves the core cannot reach a concrete provider | **PASS** | `boundaries.test.ts` → "capability boundary". |
| Validation evidence records every criterion | **PASS** | This document. |

---

## 8. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Seven of eight capabilities have no implementation.** Only `storage` is offered by a real provider. | The contracts are exercised through the registry and one real provider; the rest are shapes waiting for their Epic. This is the honest state of a foundation Epic, not a gap in it. | **EPIC-017**, **EPIC-021**, **EPIC-024**, **EPIC-054**, **EPIC-064**, **EPIC-071** |
| Capability contracts declare *what* a provider offers, not the **method signatures** it must implement. | A `source.repository` provider knows it must enumerate repositories; the exact interface is defined by the Epic that first needs it. Fixing signatures now would be designing against imagined requirements. | **EPIC-012** (SDK) and each consuming Epic |
| Selection is by registration order, with no scoring or preference. | Deterministic and explicit, which is the right default. A user with two source providers cannot yet express a preference. | **EPIC-013** (Discovery), **EPIC-015** (Configuration) |
| Cancellation and error-classification invariants are stated but unverified. | See §4. | **EPIC-016** |
| Capabilities are not yet reported by `ferret status` / `ferret doctor`. | `describe()` carries them; the diagnostics do not yet surface them. Small, and belongs with the Epic that gives providers health. | **EPIC-014** |
| No provider can be *deregistered*. | The registry seals at initialization, which suits a process-lifetime composition. Hot-swapping a provider is not a requirement anything has yet. | **EPIC-014** if it becomes one |
| ~~macOS unvalidated.~~ **Measured 2026-09-03 by EPIC-105:** macOS passes — 112 test files and 2 463 tests on `macos-latest`, including the packaging suite and all seven signal tests. The database suites skip there (no Linux containers), so PostgreSQL behaviour stays validated on Linux only. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |
