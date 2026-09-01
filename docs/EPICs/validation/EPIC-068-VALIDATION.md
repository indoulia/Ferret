# EPIC-068 — AI Authorization Model · Validation Evidence

**Assessed against:** working tree on top of `355a833`
**Date:** 2026-09-01
**Specification:** [`../EPIC-068-AI-Authorization-Model.md`](../EPIC-068-AI-Authorization-Model.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

The decision itself is pure, so it is demonstrated by unit tests — deliberately:
an authorization decision that cannot be reproduced from its inputs cannot be
reviewed. The surface behaviour is demonstrated through the real MCP protocol, and
all three configurations are additionally exercised over **real stdio against a
real index**: no grant, an empty grant, and a misspelled grant.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** A principal names who is asking, its class, and its grant | **MET** | `Principal` carries `id`, `class`, `permissions`, `permittedScopes` and `scope`. `PrincipalClass` reuses EPIC-009's `ActorClass.AGENT` rather than inventing a parallel word for the same thing. |
| **AC-2** A permission not granted is denied, including one added after the grant was written | **MET** | `authorization.test.ts` — *"denies what was not"* and *"denies a permission granted to nobody, however new"*, the second iterating the whole vocabulary against an empty grant, which is what a principal configured before a new permission existed looks like. |
| **AC-3** The anonymous default permits `READ` and denies everything else | **MET** | `authorization.test.ts` — *"may read and may do nothing else"*, iterating every other permission. Confirmed in production: with no configuration at all, `ferret_search` returned two hits. |
| **AC-4** A decision is pure and reproducible | **MET** | `authorization.test.ts` — *"is pure: the same inputs decide the same way"*. `authorize` is a set membership test; the module reaches no clock, no store and no I/O. |
| **AC-5** A denial names the missing permission and nothing about the protected thing | **MET** | `authorization.test.ts` — *"names the permission and nothing about the protected thing"*, asserted as a shape check (no slash, no `scope\|path\|password\|secret\|token`) so a reason that later interpolated a target fails. Confirmed in production: the refusal names `read` and the config key, and no credential appears. |
| **AC-6** An unpermitted operation raises `NOT_PERMITTED`, distinguishable from not-found | **MET** | `authorization.test.ts` and `tools.test.ts` — *"refuses every read tool with NOT_PERMITTED"*, across five tools through the real protocol, asserting `isError` **and** the code. `ExitCode.NOT_PERMITTED` (7) is its own code for the reason `STORAGE` has one: a narrow grant is a different condition from a broken configuration. |
| **AC-7** The grant is read from configuration and cannot be widened by tool input or content | **MET** | `principalFrom(config)` is the only reader and takes only a `FerretConfig`. No tool schema accepts a permission, a scope or a selector. `authorization.test.ts` — *"is not widened by anything a caller could say about itself"*. |
| **AC-8** A principal converts to an EPIC-058 access context, and that is the only conversion | **MET** | `accessContextFor` is the single conversion, called once by the composition root. `authorization.test.ts` — *"carries the principal scopes and selector across"*, plus *"takes exclusions from configuration, never from the principal"*: exclusion is additive and one-way (EPIC-003), so letting a principal carry its own would be a way to ask for less. |
| **AC-9** Every MCP tool declares its permission, and the server refuses before the handler runs | **MET** | The check is in `guard`, ahead of `run`, and all seven tools name `Permission.READ` at their call site — so a new tool cannot be registered without naming one. `tools.test.ts` — *"refuses before the handler runs"* asserts the *ordering* rather than the intention: the fake retrieval counts every search it is asked for, and it records none. |
| **AC-10** A refusal serializes without leaking configuration or credentials | **MET** | `tools.test.ts` — *"names the missing permission and leaks no configuration"*, through EPIC-009's serializer, which is the one place that guarantee lives. Confirmed in production against a database whose password was in the server's own environment. |
| **AC-11** A malformed grant is refused at composition | **MET** | `authorization.test.ts` — *"refuses a misspelled permission at composition"*, with the message naming the known vocabulary so an operator does not have to find it, plus strict-schema tests for an unknown field and an unknown class. Confirmed in production: `permissions: ['reed']` exits before serving, with `Use one of: read, config.read, config.write, index, mutate, provider.admin.` |
| **AC-12** A granted scope makes scoped evidence reachable, end to end | **MET** | `permission.test.ts` — *"reaches scoped evidence the anonymous principal cannot"*, against a real PostgreSQL: the same query and the same database, one grant seeing the protected statement and the anonymous principal seeing nothing with `withheld: 1`. Companion tests cover a grant naming a *different* scope, and configured exclusions arriving through the same conversion. **This is the first time EPIC-058's `permittedScopes` is non-empty and came from configuration.** |

**Summary: 12 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite: **88 files, 2090
passed, 3 skipped**, database suites against a real PostgreSQL. New:
`tests/unit/authorization.test.ts` (21 tests), 4 tests in
`tests/integration/mcp/tools.test.ts`, 3 in
`tests/integration/retrieval/permission.test.ts`, 3 boundary tests.

All three grants exercised over **real stdio** against a real index:

```
default      OK count=2 withheld=0
             leaks a credential: false

ungranted    REFUSED E_NOT_PERMITTED — Not permitted: mcp.search
             remediation: Grant "read" to this principal in Ferret's
                          configuration (`authorization.permissions`), then
                          restart the client.
             leaks a credential: false

misspelled   ferret: error: Configuration grants unknown permission(s): reed
             code: E_CONFIG_INVALID
             hint: Use one of: read, config.read, config.write, index, mutate,
                   provider.admin.
```

The middle case is the row this Epic closes, seen from the client's side. The
third is AC-11 in production: the server declines to start rather than serving a
grant it cannot read.

## 4. Where the evidence is weaker than the criterion

**A malformed grant reaches an AI client as a closed connection.** The reason and
the remediation go to stderr with exit code 3, which is correct for a CLI and is
what an operator reading a client log will find — but the client itself sees only
that the transport closed. Making a startup refusal legible *inside* the protocol
would mean serving in order to report that serving is refused, which is worse.
Recorded as a known characteristic.

**`MUTATE`, `CONFIG_WRITE`, `INDEX` and `PROVIDER_ADMIN` gate nothing yet.** No
mutating tool exists — EPIC-059 §4 records that every tool is read-only, and §4 of
this specification declines to add one. The vocabulary exists so EPIC-066 and
EPIC-067 have something to declare, and adding a mutation here would be taking
their scope. So those four permissions are demonstrated as *denied* and never as
gating a real operation.

**One principal, asserted by configuration.** §16 states the limit and it is worth
repeating: this prevents a *configured* client from exceeding its grant. It does
not prevent a different process from starting Ferret with a grant of its own,
because there is no channel over stdio on which a client could present a
credential Ferret could verify. Closing that needs a transport that can carry
identity, which no approved Epic defines.

**EPIC-036's identity merge is still not wired.** This Epic supplies the decision
that validation was waiting on (`MUTATE`), and does not perform the merge —
EPIC-009 owns that.

## 5. What the boundary test found

Authorization was first written into `src/security/`, and the suite refused it:

```
FAIL  tests/unit/boundaries.test.ts > canonical model boundary
      > depends on nothing but the error model and zod
AssertionError: expected [ 'picomatch', 'pino', 'zod' ] to strictly equal [ 'zod' ]
```

`domain/memory-extraction.ts` imports `security/index.ts`, so anything in that
barrel is reachable from the canonical model — and authorization reads
configuration and produces a retrieval context, which dragged `picomatch` and
`pino` into a graph EPIC-006 requires to depend on nothing but the error model and
zod.

The split that failure forced is also the honest one. `security/` holds *content*
controls — containment and secret detection — which the model itself needs; this
holds a *caller* control, which only the surfaces a caller reaches need. It is now
`src/authorization/`, with three boundary tests pinning the placement: not
reachable from the canonical model, reaching configuration and the retrieval
context on purpose, and reaching neither storage, the CLI, a provider nor the MCP
surface — because a decision must be makeable without a transport.

This is the second time in this sequence an architectural test caught a placement
rather than a bug, and it was caught in seventeen seconds by a test written four
Epics earlier.

## 6. What this closes

- **The known-limitation row** at `validation/EPIC-059-061-064-065-VALIDATION.md`
  §159: *"No authorization: every indexed thing is reachable by any client that
  can spawn the process."* A client granted nothing now reaches nothing.
- **EPIC-058's stated hole**: *"there is no principal whose scopes could be looked
  up"*. There is one, and AC-12 demonstrates a configured scope reaching scoped
  evidence end to end.
- **`Checkpoints/EPIC-059-065.md` §99** — "EPIC-068/058 (Authorization) — before
  Ferret is pointed at anything private" — is satisfied for retrieval.
- **EPIC-066 and EPIC-067 are unblocked**: both now have a permission to declare.

## 7. Raised, not absorbed

Both in specification §16, because neither is on record and both are decisions:

- **This authorizes; it cannot authenticate.** Stated plainly rather than dressed
  up.
- **`READ` is granted by default.** Everything Ferret indexes today is unscoped
  local source the caller could read with `cat`, and Governance §3 makes the AI
  client the primary interface, so denying reads out of the box would cost every
  user something and protect nobody.

## 8. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 12 MET |
| Unit tests | Yes — 21 new, plus 3 boundary |
| Integration tests | Yes — real MCP protocol, real PostgreSQL, real stdio |
| Failure and boundary cases | Yes — misspelled permission, unknown class, unknown field, empty grant |
| Security implications | The Epic *is* a security control; the refusal is demonstrated leaking neither configuration nor credentials |
| Observability | A refusal names the permission; the decision is loggable without naming what was reached |
| Documentation | Specification, this document, and the exit-code table |
| Governance | §12, §3, §6, §2, §5 |
| Dependencies validated | EPIC-003, 009, 058, 064, 065 |
| Known blockers | None |
