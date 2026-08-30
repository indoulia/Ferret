# EPIC-011 — Provider Contracts

**Status: APPROVED | Priority: P0**

> **Specification note.** The Epic registry (v3.0) approved this capability by
> name, domain and priority. This specification elaborates it to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry, `docs/Governance/README.md` §4 (Provider-First Architecture),
> and the contracts EPIC-001 through EPIC-010 already publish. It introduces no
> capability the registry did not approve.

## 1. Objective

Define the versioned, capability-shaped contracts every external system and
replaceable implementation sits behind, so a provider can be added, replaced or
removed without changing core logic.

## 2. Value

Governance §4 makes provider-first architecture binding, and EPIC-001 delivered
the *lifecycle* half of it: a provider is registered, initialized, health-checked
and shut down. What it does not yet express is **what a provider can do**.

Today `PostgresStorageProvider` is the only provider, and the core reaches it
through a concrete class rather than a capability. That works for one provider
and stops working at two: a GitHub source provider and a Git source provider have
almost nothing in common as classes, and everything in common as *capabilities* —
both can enumerate repositories, both can fetch history, neither can parse a PDF.

Without capability contracts, every consuming Epic invents its own coupling.
EPIC-017 would import a Git provider directly, EPIC-021 a GitHub one, and
"replacing a provider does not require unrelated core changes" would be false by
the time three of them existed.

## 3. Scope

- **Capability contracts** — the interfaces a provider implements to declare what
  it can do, independent of which system it talks to.
- **Capability declaration and discovery** — how a provider states its
  capabilities and how the core finds a provider for a capability.
- **Contract versioning** — per-capability versions, within the runtime-wide
  contract range EPIC-010 established.
- **Optional capabilities** — a provider implementing part of a contract, and
  callers degrading rather than failing.
- **Provider metadata** — identity, description, the systems it speaks to, and
  its declared limits.
- **Capability invariants** — what every implementation must guarantee
  regardless of the system behind it.
- **Error and cancellation contracts** — how a provider reports failure, and how
  a caller cancels work.

## 4. Non-scope

- Concrete provider implementations. Git, GitHub and Jira are EPIC-017/021/071.
- The provider **SDK** — helpers, base classes and test doubles are EPIC-012.
- **Discovery from installed packages** — EPIC-013.
- Provider **configuration and secrets** — EPIC-015.
- The **conformance suite** that verifies an implementation — EPIC-016.
- Provider lifecycle and health beyond what EPIC-001 already publishes —
  EPIC-014.

## 5. Inputs

- EPIC-001 `Provider`, `ProviderContext`, `ProviderRegistry`, `ProviderKind`.
- EPIC-010 `PROVIDER_CONTRACT_VERSION` and its supported range.
- EPIC-006 canonical entities, EPIC-007 relationships, EPIC-008 evidence — a
  provider's output is expressed in these, never in its own shapes.
- Governance §4, §5, §6, §13, §14.

## 6. Outputs

- A capability contract per approved capability area.
- A capability registry the core queries by capability rather than by identity.
- Declared metadata and limits per provider.
- Type-level guarantees that a consumer cannot reach a provider concretely.

## 7. Dependencies

EPIC-001 (provider lifecycle), EPIC-006–EPIC-008 (the shapes a provider
produces), EPIC-010 (contract versioning). No external dependency.

## 8. Contracts

Capabilities the core recognises, each versioned independently:

| Capability | What it can do | First consumer |
| --- | --- | --- |
| `storage` | Persist and read canonical knowledge | EPIC-002 (exists) |
| `source.repository` | Discover repositories, branches and worktrees | EPIC-017, EPIC-018 |
| `source.history` | Enumerate commits and the changes they made | EPIC-019 |
| `source.file` | Enumerate and read files | EPIC-022 |
| `source.project` | Issues, pull requests, reviews, releases | EPIC-071, EPIC-072 |
| `parser` | Turn file content into structured extraction | EPIC-024 |
| `embedding` | Produce vectors for semantic retrieval | EPIC-054 |
| `mcp` | Serve the AI control plane | EPIC-064 |

Invariants every capability implementation must satisfy:

1. **Provider-neutral output.** A provider returns canonical entities,
   relationships and evidence — never its own shapes, and never a shape naming
   its system.
2. **Cancellable.** Every long-running operation observes the `AbortSignal` it is
   given and stops promptly.
3. **Failure is classified.** A provider reports a `FerretError` with a code and
   remediation, never an opaque throw.
4. **Idempotent reads.** The same request against unchanged upstream state
   returns the same canonical result.
5. **Declared limits are honest.** A provider that cannot page, cannot filter, or
   has a rate limit says so rather than failing when asked.
6. **No credential leakage.** Nothing a provider returns or logs contains a
   secret.

## 9. Acceptance criteria

- Every approved capability has a versioned contract.
- A provider declares which capabilities it implements, and at which versions.
- The core selects a provider by capability, never by concrete identity.
- A provider implementing only part of a capability is usable, and callers can
  discover what is missing rather than failing at the call.
- Capability versions are checked before use, and an unsupported version is
  refused with a clear error.
- A capability contract can be added without changing existing providers.
- Provider-declared limits are queryable before an operation is attempted.
- Core code cannot import a concrete provider, enforced by test.

## 10. Test requirements

- **Unit:** capability declaration and validation; version checking within and
  outside the supported range; selection by capability; partial implementation;
  metadata and limits.
- **Integration:** the existing storage provider adopts the contract without
  behaviour change; two providers of one capability coexist and are selected
  deterministically.
- **Failure:** an unsupported capability version; a provider declaring a
  capability it does not implement; a provider throwing an unclassified error; a
  cancelled operation.
- **Security:** a provider cannot return a credential in metadata or limits; a
  provider cannot reach core internals it was not given.
- **Architecture:** the boundary test proves no concrete provider is reachable
  from the core entry point or from another provider.

## 11. Security requirements

A provider is a **trust boundary**. It talks to systems Ferret does not control
and returns content Ferret must treat as untrusted (Governance §12).

- A provider receives capabilities, never global state — no `process.env`, no
  logger of its own, no database handle it was not given.
- Provider metadata, limits and errors pass through redaction; a provider cannot
  leak a credential through a field nobody expected to carry one.
- A provider declaring a capability it does not implement is a defect, not a
  degradation, and is refused at registration.

## 12. Observability

- Registered providers, their capabilities and versions are reportable through
  `ferret status` and `ferret doctor` (EPIC-004's contract).
- A capability with no provider is a *reportable* state, not an error: Ferret
  says the capability is unavailable rather than failing at the point of use.

## 13. Performance constraints

Capability lookup is on the hot path of every operation that reaches a provider,
so it must be O(1) in the number of providers and must not allocate per call.
Selection is asserted under a regression ceiling.

## 14. Definition of Done

- Every capability in §8 has a versioned contract with stated invariants.
- The storage provider is expressed through the contract, with no behavioural
  change (existing tests unmodified except where the contract is the subject).
- Selection by capability is implemented, tested and documented.
- The architecture test proves the core cannot reach a concrete provider.
- Validation evidence records every criterion with a named artefact.

## 15. Governance alignment

- **§4 Provider-First Architecture** — every external system and replaceable
  implementation behind a stable, versioned, documented contract.
- **§5 Reuse Before Reinvent** — contracts describe capabilities so a mature
  implementation can be dropped behind one.
- **§6 Evidence Before Inference** — provider output carries provenance.
- **§13 Reliability** — providers fail independently; a missing capability
  degrades rather than breaking unrelated knowledge.
- **§21 Versioning** — capability contracts are versioned where a change affects
  compatibility.
- **AI Development Rule §14** — provider-specific behaviour stays behind the
  contract.
