# EPIC-068 — AI Authorization Model

**Status: IMPLEMENTED | Priority: P0 | Domain: AI Control Plane & MCP**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> the registry entry, the known-limitation row at
> `validation/EPIC-059-061-064-065-VALIDATION.md` §159, `Checkpoints/EPIC-059-065.md`
> §99, `validation/EPIC-036-VALIDATION.md` §109, EPIC-058's §4, and Governance §12
> and §3. **Nothing here invents a requirement.** Where a plausible requirement is
> *not* on record, §4 excludes it and names the owner.
>
> Authored after a readiness review against `355a833` measured what exists; §2, §3
> and §8 describe the code as it is.

## 1. Objective

Give Ferret a principal — who is asking — and a decision about what that
principal may do, so that authorization is a value an operation carries rather
than an assumption the code makes.

## 2. Value

EPIC-059/065's own validation states the position without softening it:

> **No authorization: every indexed thing is reachable by any client that can
> spawn the process.** stdio limits the blast radius to whoever can already run
> commands as that user, but **it is not an authorization model**.

And the checkpoint that closed those Epics named this one as a precondition:

> **EPIC-068/058 (Authorization)** — before Ferret is pointed at anything
> private.

Three more places are waiting on it.

1. **Every MCP tool is read-only, and that is the only control.** EPIC-059 §4 says
   so outright — "Authorization and destructive-operation confirmation (EPIC-068,
   EPIC-069) — which is why every tool here is read-only." Read-only-by-omission
   is a safe default and it is not a model: the moment one mutating tool is
   wanted, there is nothing to hang the decision on. EPIC-066 (MCP Configuration
   Tools) is exactly that tool, and it is blocked behind this.

2. **EPIC-058 has a principal-shaped hole.** Its `AccessContext` carries permitted
   scopes and the composition root supplies **none**, and the validation says why:
   "Ferret has no authentication: there is no principal whose scopes could be
   looked up, and asserting one from configuration would be inventing a caller."
   So permission-aware retrieval is enforced correctly against an empty grant.

3. **Identity merging has nowhere to go.** `validation/EPIC-036-VALIDATION.md`
   §109: proposals "currently go nowhere … merging is EPIC-009's and needs an
   authorization decision (EPIC-068)".

Measured on `355a833`, `src/` contains no principal, no permission, and no
authorization decision of any kind. `Capability` exists and is about *providers* —
what a plugin can do — not about what a caller may ask for.

## 3. Scope

- A **principal** — who is asking: an id, a class, and what it was granted.
- A **permission vocabulary** over the operations Ferret performs, at the
  granularity a decision is actually made: read, index, configure, and mutate.
- A **decision function** — `authorize(principal, permission)` → allowed or
  denied *with a reason*, pure and reproducible.
- **Deny by default**, so a permission nobody granted is refused rather than
  assumed.
- **Configuration as the grant surface**, since there is nothing else that can
  legitimately grant anything (§4).
- **A principal as the source of EPIC-058's access context**, so the two models
  are one model rather than two that can disagree.
- **Composition into the MCP surface**: every tool declares the permission it
  needs, and the server refuses before the handler runs.
- **A refusal that explains itself**, so an AI client can tell "not permitted"
  from "not found" and from "broken".

## 4. Non-scope

Named here so it is not quietly adopted:

- **Authenticating the principal.** Ferret is spawned over stdio by the client it
  serves; the client *is* the process's parent, and there is no channel on which
  it could present a credential Ferret could verify. A model that pretended
  otherwise would be security theatre. What this Epic gives is **authorization of
  a configured principal**, and §16 records the limit plainly.
- **Enforcement outside retrieval and the MCP surface** — EPIC-083.
- **The confirmation prompt for a destructive operation** — EPIC-069. This Epic
  decides whether an operation is permitted; EPIC-069 decides whether it was
  *intended*, and both must hold.
- **Audit events for a decision** — EPIC-085.
- **Any mutating tool.** No tool becomes writable here. The vocabulary exists so
  EPIC-066 and EPIC-067 have something to declare; adding a mutation would be
  taking their scope.
- **Interpreting a permission scope's meaning** — EPIC-083, as EPIC-058 already
  records.
- **Merging identities** — EPIC-009. This Epic supplies the decision EPIC-036 is
  waiting on; it does not perform the merge.
- **Multi-tenancy, users, roles or groups.** One principal per process. A role
  system with no authentication behind it is a configuration file with extra
  steps.
- **Network transport, TLS, tokens or sessions.**

## 5. Inputs

- Resolved configuration (EPIC-003) as the grant surface.
- `AccessContext`, `PUBLIC_ACCESS` (EPIC-058) — what the principal's grant
  becomes on the retrieval path.
- `ActorClass` (EPIC-009) for the vocabulary of *who*, so a principal's class and
  an indexed actor's class are the same words.
- `FerretError` and `ErrorCode` (EPIC-001/009) for a refusal that serializes.

## 6. Outputs

- `Permission`, `PrincipalClass`, `Principal`, `AuthorizationDecision`.
- `authorize(principal, permission)`, `assertPermitted(...)`, and
  `accessContextFor(principal)`.
- `ANONYMOUS_PRINCIPAL` — the deny-almost-everything default.
- `principalFrom(config)` — the one place a grant is read.
- `McpServerDependencies.principal`, and a permission declared per tool.
- `ErrorCode.NOT_PERMITTED`.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-003 Configuration Engine | VALIDATED | the grant surface |
| EPIC-009 Identity & Scope Model | VALIDATED | `ActorClass`, the scope selector |
| EPIC-058 Permission-Aware Retrieval | IMPLEMENTED | the access context a grant becomes |
| EPIC-064/065 MCP | VALIDATED | the surface a permission gates |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **Deny by default.** A permission absent from a principal's grant is denied. A
  new permission added later is therefore denied for every existing principal
  until granted, which is the only safe direction for that change.
- **A decision is pure.** Same principal and permission in, same decision out,
  with no clock, no database and no I/O. An authorization decision that cannot be
  reproduced cannot be reviewed.
- **A denial carries a reason and never carries what was protected.** The reason
  names the *permission* that was missing, never the content, the path, the id or
  the scope behind it. "You may not configure" is a fact about the caller;
  anything more is a fact about the data.
- **A refusal is an error, not an empty result.** The opposite of EPIC-058's rule,
  and deliberately: retrieval withholds *some* of an answer and must stay
  answerable, while an unpermitted *operation* did not happen at all, and
  returning success for it would be a lie. `ErrorCode.NOT_PERMITTED` is
  distinguishable from `ENTITY_NOT_FOUND` and from a failure.
- **The grant comes from configuration only.** Never from tool input, never from
  repository content, never from anything a principal says about itself
  (Governance §12).
- **`READ` is granted to the anonymous principal.** Everything Ferret indexes
  today is unscoped local source that the caller could read with `cat`, and the
  brief makes the AI client the primary interface (Governance §3). Denying reads
  by default would make Ferret useless out of the box without protecting
  anything. Every other permission is denied.
- **A principal's grant and EPIC-058's access context are one thing.**
  `accessContextFor` is the only conversion, so a scope granted for reading and a
  scope enforced on reading cannot drift apart.
- **Authorization is not confirmation.** A permitted destructive operation still
  requires EPIC-069. Neither substitutes for the other.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | A principal names who is asking, its class, and what it was granted. | registry; §159 |
| AC-2 | A permission not granted is denied, including one added to the vocabulary after the grant was written. | §8 |
| AC-3 | The anonymous default permits `READ` and denies every other permission. | Gov §3; §8 |
| AC-4 | A decision is pure: no clock, no I/O, reproducible. | §8 |
| AC-5 | A denial names the missing permission and nothing about the protected thing. | Gov §12 |
| AC-6 | An unpermitted operation raises `NOT_PERMITTED`, distinguishable from not-found and from failure. | §8; EPIC-009 serialization |
| AC-7 | The grant is read from configuration and cannot be widened by tool input or indexed content. | Gov §12 |
| AC-8 | A principal converts to an EPIC-058 access context, and that is the only conversion. | EPIC-058 §4 |
| AC-9 | Every MCP tool declares the permission it requires, and the server refuses before the handler runs. | Gov §3; §159 |
| AC-10 | A refusal serializes without leaking configuration or credentials. | EPIC-009 |
| AC-11 | A malformed grant is refused at composition rather than silently narrowing or widening. | EPIC-058 precedent |
| AC-12 | Granting a scope to a principal makes scoped evidence reachable through retrieval, end to end. | EPIC-058 AC-3; §2 |

## 10. Test requirements

**Unit.** The vocabulary and the decision: deny by default, the anonymous grant,
an unknown permission, a reason carrying no protected value, purity, the
conversion to an access context, and a malformed grant.

**Integration.** Through the real MCP protocol: a read tool works under the
anonymous principal; a principal granted no read is refused with
`NOT_PERMITTED` rather than an empty result; the refusal serializes with no
configuration in it. And end to end against a real PostgreSQL: a principal
granted a permission scope reaches scoped evidence that the anonymous principal
cannot — which is AC-12 and the first time EPIC-058's `permittedScopes` is
non-empty from configuration.

**Failure.** A grant naming an unknown permission, an unknown class, a
malformed scope selector, and an empty grant must each be refused or denied
rather than throwing from inside a handler.

**Security.** A grant cannot be widened by tool input; a denial reason contains
no path, id, scope or configuration value; `NOT_PERMITTED` does not disclose
whether the target exists.

## 11. Security requirements

- The grant originates in configuration. Nothing a client sends and nothing
  Ferret indexed can widen it.
- A denial names a permission, never a protected value.
- `NOT_PERMITTED` is returned identically whether or not the target exists, so a
  refusal cannot be used to probe.
- Every refusal goes through EPIC-009's serializer, which is the one place the
  no-credentials guarantee lives.

## 12. Observability

- A decision is loggable at debug with the principal id and the permission —
  never with what was being reached.
- The refusal an AI client receives states the missing permission, so a client
  can tell "ask the operator" from "retry differently".

## 13. Performance constraints

- A decision is a set membership test. No query, no round trip, no allocation
  per call beyond the decision itself.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration, failure and security tests pass; the regression suite passes.
- `docs/EPICs/validation/EPIC-068-VALIDATION.md` records the evidence.
- Registry entry updated, and the EPIC-059/065 limitation row it closes is named.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§12 Security** — controls enforced by Ferret, not by prompts; the grant is
  never taken from content.
- **§3 AI-Operated by Default** — the model exists so an AI client can be granted
  more than read without the grant being implicit.
- **§6 Evidence Before Inference** — a denial is explicit, not an empty result
  that reads as an absence.
- **§2 Simplicity** — one principal per process, no roles, nothing required for
  ordinary use.
- **§5 Reuse Before Reinvent** — `ActorClass`, the scope selector, the exclusion
  model and `AccessContext` are consumed, not re-created.

## 16. Raised for governance

**This Epic authorizes; it cannot authenticate.** Ferret is spawned over stdio by
the client it serves, and there is no channel on which that client could present a
credential Ferret could verify. So a principal is *asserted by configuration on
the machine* and trusted because the operating system already trusts whoever can
run the process — which is the same reasoning EPIC-059's validation gives for
stdio limiting the blast radius. That is a real limit and it is worth stating
rather than dressing up: this model prevents a *configured* client from exceeding
its grant, and does not prevent a different process from starting Ferret with a
grant of its own. Closing that needs a transport that can carry identity, which no
approved Epic defines.

**`READ` is granted by default.** Not on record either. Everything Ferret indexes
today is unscoped local source the caller could read with `cat`, and Governance §3
makes the AI client the primary interface, so denying reads out of the box would
cost every user something and protect nobody. A deployment indexing private
sources through a provider should narrow it, and EPIC-058's permission scopes are
how.
