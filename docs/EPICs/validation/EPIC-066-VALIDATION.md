# EPIC-066 — MCP Configuration Tools · Validation Evidence

**Assessed against:** working tree on top of `e4dfd9d`
**Date:** 2026-09-01
**Specification:** [`../EPIC-066-MCP-Configuration-Tools.md`](../EPIC-066-MCP-Configuration-Tools.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

Almost everything here is demonstrated **through the real MCP protocol against a
real `ConfigStore` on a real temporary file**, and that choice is the point of the
Epic. §8 makes "one implementation, wrapped" a contract; a fake store would have
shown the tools calling *something* and hidden whether EPIC-003's lock,
validation, atomic write and journal came along. Several of the assertions below —
the invalid value leaving the file byte-identical, the journal reading back, the
schema refusing a bad enum — only mean anything because the store is real.

The composition is then exercised over **real stdio against the actual `ferret
mcp` process**, because a tool registered in a test and a tool an AI client can
reach are different claims.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** Read the effective configuration, redacted, with the layer that supplied each value | **MET** | `config-tools.test.ts` — *"describes the whole configuration with the layer that supplied each value"*. `describeConfig` is EPIC-003's own redactor, so there is no second redaction policy to drift from it, and `origins` is `resolveConfig`'s per-path map. The response also names `unwritableThroughThisSurface`, so an agent learns the `authorization` rule from the read rather than from a refusal. |
| **AC-2** Read one value by dotted path, with its origin | **MET** | *"reads one value by dotted path, with its origin"*. Paired with *"distinguishes an unset value from one set to null"* — `value: null` with `set: false` beside it, because a bare `null` cannot be told from a value that is genuinely null and Governance §6 forbids manufacturing that certainty. |
| **AC-3** Discover the schema rather than guessing what is settable | **MET** | *"exports a schema an agent can discover keys from"*. `z.toJSONSchema(ferretConfigSchema, { io: 'input' })` — generated at call time from the schema Ferret validates against, so it cannot describe a configuration Ferret would reject. `io: 'input'` because the question an agent is about to ask is *what may I write*. Closes `validation/EPIC-003-VALIDATION.md` §154. |
| **AC-4** Change one value; it persists and takes effect | **MET** | *"stores the value on confirmation, and it is readable back"* — read back **through the tool**, not the store, because what matters is that an AI client sees its own change. *"accepts a non-string value as its real type"* covers `6543` arriving as a number rather than a string, which the CLI cannot do without parsing. Caveat on "takes effect" in §4. |
| **AC-5** Remove one value, restoring its default | **MET** | *"removes a value on confirmation, restoring the default"*. `logLevel` returns to `warn` with `origin: 'default'` — restored, not absent, which is the distinction between unsetting a value and deleting a concept. |
| **AC-6** A write requires `CONFIG_WRITE`, a read `CONFIG_READ`, anonymous neither | **MET** | *"refuses a write to a caller granted only CONFIG_READ"*, which also asserts the read it *was* granted still works — a server that refused everyone would prove nothing. *"refuses everything to the anonymous principal"* iterates all seven tools. Confirmed over real stdio against `ferret mcp` with no configuration: every configuration tool refuses. |
| **AC-7** A write refuses its first call, discloses a plan, completes only on confirmation | **MET** | *"refuses the first call, discloses the plan, and writes nothing"* — asserting `store.exists` is `false`, not merely that an error came back. *"reports OVERWRITE and the previous value when replacing"* shows the plan distinguishing `set` from `overwrite`, which is the difference between adding a value and discarding one. EPIC-069's binding is exercised on a real tool by *"refuses a confirmation issued for a different path"*. |
| **AC-8** No tool can write any `authorization` path | **MET** | *"refuses to write any authorization path"*, across five paths including `authorization.scope.include`, plus `unset`. Refused by **first segment**, and refused **before the plan is built** — so a denied caller does not learn the current grant in the course of being refused. `expect(details(body).plan).toBeUndefined()` is the assertion that proves the ordering. |
| **AC-9** A secret is never returned and never accepted as a literal | **MET** | *"never returns a stored credential"* checks a stored password against **all five** read tools, because a password extractable through any one of them is extractable. Masked rather than absent (`[redacted]`, `redacted: true`), so the caller knows a value is there. *"refuses a literal credential and names the reference form"*, paired with *"accepts a secret reference"* — the refusal is only useful if the alternative works. |
| **AC-10** An invalid value is refused and the file is unchanged | **MET** | *"refuses an invalid value and leaves the file byte-identical"* — the file is read before and compared after, not merely checked for the error. `E_CONFIG_INVALID` comes from `validateCandidate` inside `ConfigStore`, which is EPIC-003's guarantee rather than a second one. |
| **AC-11** Check the configuration is usable, changing nothing | **MET** | *"reports the configuration as valid but not usable without a database"* — two separate facts, `valid: true` and `usable: false`, because collapsing them would repeat EPIC-004's `unknown`-is-not-`ok` mistake. *"reports an invalid configuration as an answer rather than a failure"* covers the input a validate tool most needs to survive. |
| **AC-12** Read the change journal | **MET** | *"reads the change journal"*. **A defect this test found:** the tool called `readAudit()` with no argument and so read the platform-default journal, reporting it empty beside a store with two entries in it — see §5. |
| **AC-13** List exclusions and test a path | **MET** | *"lists exclusions and tests a path against them"*. `effectiveExclusions` — Ferret's defaults **plus** the user's, because `config.exclude` alone reads as "nothing is excluded" on a default installation, which is the opposite of the truth. The deciding rule is returned, so *why* is answerable without the caller re-deriving it. |
| **AC-14** A scope selector persisted through this surface reaches EPIC-058's access context | **MET** | *"persists a scope selector that reaches the access context"* — stored, then resolved through `principalFrom` and `accessContextFor`, asserting both `permittedScopes` and `scope.include` arrive. Closes `validation/EPIC-009-VALIDATION.md` §115. Written directly rather than through the tool, because `authorization` is unwritable over MCP by design (AC-8); what the criterion needs is that a stored selector survives and resolves, not that an agent can write one. |
| **AC-15** Every write goes through `ConfigStore` | **MET** | `configuration.store` is the only writer in `config-tools.ts`; there is no `writeFileSync`, no lock and no schema call anywhere in the module. Demonstrated rather than asserted: AC-10's byte-identical file and AC-12's journal are both `ConfigStore` behaviours that a second implementation would have had to reproduce and would have got wrong. |
| **AC-16** A configuration path cannot address object internals | **MET** | *"refuses a path that addresses object internals"* — `__proto__.polluted`, `a.constructor.b` and `prototype`, all `E_USAGE`, with `Object.prototype` asserted clean afterwards. Fixed in EPIC-003 by issue [#81](https://github.com/indoulia/Ferret/issues/81) / `e4dfd9d`, **found while assessing this Epic's readiness** — see §5. |

**Summary: 16 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite.

New:

- `tests/integration/mcp/config-tools.test.ts` — 25 tests, real MCP protocol, real
  `ConfigStore`, real temporary file
- `tests/unit/mcp-destructive-tools.test.ts` — generalized from EPIC-069 to scan
  every module in `src/mcp/`, and now covering two real destructive tools

### 3.1 Over real stdio, against the actual `ferret mcp` process

Not a synthetic server: this spawns the CLI's own composition root against the
real dogfood PostgreSQL, so what it demonstrates is that `ferret mcp` serves these
tools rather than that a test can register them.

**With no configuration** — the default anonymous grant:

```
config tools served : 7 -> describe, schema, validate, audit, exclusions, set, unset
destructive         : ferret_config_set, ferret_config_unset
default grant       : REFUSED E_NOT_PERMITTED
  remediation       : Grant "config.read" to this principal in Ferret's
                      configuration (`authorization.permissions`), then restart
                      the client.
```

**Granted `config.read` and `config.write`**, with `FERRET_LOG_LEVEL=silent` set in
the environment so the precedence ladder is visible:

```
read logLevel       : "silent" origin=environment
schema keys         : logLevel, database, exclude, authorization, providers
  unwritable        : ["authorization"]
set (no token)      : REFUSED E_CONFIRMATION_REQUIRED
  plan              : [{"target":"logLevel","change":"set","to":"debug"}]
set (token)         : APPLIED {"stored":true,"journalled":true}
read back           : "debug" origin=file:…\.local\probe-066\config.json
escalate w/ token   : REFUSED E_CONFIRMATION_INVALID
write authorization : REFUSED E_NOT_PERMITTED | plan disclosed: false
literal password    : REFUSED E_USAGE
__proto__ path      : REFUSED E_USAGE
journal             : ["set logLevel"]
unset               : APPLIED -> value now "silent"
```

Three things in that trace are worth reading twice.

**Governance §16's precedence ladder, demonstrated by accident.** `logLevel` reads
`"silent"` from the environment; after the write the *file* wins, because user
configuration outranks environment discovery; after the unset it falls back to
`"silent"` again. That is the ladder working end to end, and it is stronger
evidence for AC-1, AC-2 and AC-5 than the integration tests produced, because
nothing in the probe was arranged to show it.

**`escalate w/ token` is EPIC-069's binding on a real tool.** A token Ferret
issued, presented by the caller it was issued to, on the same tool, in the same
process — with `path` changed from `logLevel` to `database.host`. Refused.

**`write authorization` discloses no plan.** `E_NOT_PERMITTED` with
`plan disclosed: false`, which is AC-8's ordering property: the refusal happens
before the plan is built, so a caller denied the grant does not learn the grant.

## 4. Weaker than the criterion deserves

**AC-4's "takes effect" is narrower than it sounds.** A write persists
immediately, and every read tool re-resolves, so an agent always sees its own
change. But `access` and `principal` are derived once at composition, so a changed
exclusion or scope selector reaches *retrieval* only after a restart. Re-deriving
them per call is EPIC-058's composition to change, not this Epic's. Specification
§4 excludes it and `ferret_config_set` says so in its own response rather than
leaving an agent to discover it.

**No test proves an agent will read the schema before writing.** AC-3 proves the
schema is available and correct. Whether a model consults it is a property of the
model, not of Ferret, and the tool description is the only lever Ferret has. Said
plainly because "discoverable" can be read as a stronger claim than the evidence
supports.

**`CONFIG_READ` is not granted by default**, so out of the box every tool in this
Epic refuses. That is deliberate — configuration holds credentials by design, and
EPIC-068 defended the default `READ` grant on the grounds that everything Ferret
indexes is source the caller could read with `cat`, which is not true of a stored
password. The cost is that a default installation must be granted `config.read`
before an agent can help with configuration. Specification §16 records it.

## 5. What was found while building this

**A prototype-pollution defect in EPIC-003, found before a line of this Epic was
written.** `parsePath` accepted `__proto__`, and `setAt` then assigned into
`Object.prototype`, polluting every object in the process while leaving the file
on disk clean and giving `validateCandidate` nothing to reject. Verified against
`dist/`, filed as issue [#81](https://github.com/indoulia/Ferret/issues/81), and
fixed in **EPIC-003** — the Epic that owns the code — as `e4dfd9d`, rather than
worked around here.

Two things about it are worth keeping. First, EPIC-003 was safe exactly where it
modelled hostile input — a cloned repository's config file, refused by allowlist —
and holed where it did not: an operator's own path string, trusted because only an
operator could supply one. **This Epic is what made that assumption false.**
Second, **EPIC-069's confirmation gate would not have contained it**: the
assignment happens inside `setAt`, after `consume` succeeds, so a confirmation
reduces the attack to two calls. A confirmation is not a substitute for input
validation, and it is worth writing that down next to the Epic that just shipped
the gate.

**Two defects in this Epic's own code, both found by its tests.**

1. `ferret_config_audit` called `readAudit()` with no argument, reading the
   platform-default journal rather than the one its store writes. Against a
   temporary store the tool reported an empty journal beside a store holding two
   entries — the one failure mode a journal must not have, because "nothing
   changed" and "I looked in the wrong place" are indistinguishable to the caller.
   Fixed by making `ConfigStore.auditPath` public, so there is one source of truth
   rather than two paths that agree by luck.

2. `parsePath` was called *outside* `guardDestructive`, above the guard rather
   than inside the plan thunk. A malformed path therefore threw before reaching
   `serializeError`, and the client got an unredacted protocol error with no
   `code` to branch on instead of a structured `E_USAGE`. Both refusals now run
   inside the thunk, which also puts them after the permission check.

Neither would have been caught by a fake store or by a test that only asserted
`isError`.

**EPIC-069's architecture control needed generalizing, and the timing proves the
point.** As shipped it read `src/mcp/server.ts` alone. This Epic registers its
tools from `src/mcp/config-tools.ts`, so the control would have stopped covering
the surface **at exactly the moment the surface grew its first destructive tool**.
It now discovers every module in `src/mcp/` by reading the directory, and it found
both new tools, confirmed they route through `createDestructiveToolGuard`, and
confirmed they declare `destructiveHint`.

**Three of the five initial test failures were the test's fault, not the code's,
and each taught something.** A scope selector holds `{kind, id}` objects rather
than bare strings (EPIC-009). EPIC-003 correctly refuses a secret reference it
cannot resolve, so the harness had to supply the variable. And EPIC-003 journals
the configuration file's creation as well as each change, so the journal was never
going to be just the two writes.

## 6. What this closes

- **`validation/EPIC-059-061-064-065-VALIDATION.md` §160** — *"An AI client cannot
  index, configure or manage providers — only read."* It can now **configure**.
  *Index* and *manage providers* remain; specification §16 raises the first as
  unowned and the second is EPIC-067's.
- **`validation/EPIC-003-VALIDATION.md` §154** and **`Checkpoints/EPIC-003.md`
  §131** — the schema export for AI clients. `ferret_config_schema` is it. The
  `ferret config edit` half of that row is declined with a reason, not delivered:
  an editor is a human affordance, and the schema is what an agent needed.
- **`validation/EPIC-009-VALIDATION.md` §115** — scope selectors are persisted,
  and AC-14 demonstrates one reaching the access context. EPIC-083 still owns what
  a scope *means*.
- **Governance §1, §3 and §16** — configuration through the connected AI client,
  discoverable, accessible through the control plane. §3's ordering is restored:
  the AI client configures, and the CLI is the bootstrap and recovery interface it
  says it is.
- **EPIC-069's AC-11 caveat.** That Epic's evidence recorded that its destructive
  tool was registered by a test rather than by Ferret. Two real ones now exist, and
  its architecture test covers them.

## 7. Raised, not absorbed

In specification §16:

- **Health over MCP belongs to EPIC-070**, not here. The record named both; this
  Epic is configuration, and a health report answers *what can this Ferret do right
  now*.
- **Nothing owns indexing over MCP.** The §160 row names 066, 067 and 069; 066
  takes *configure*, 067 takes *providers*, 069 supplied the confirmation, and no
  approved Epic takes indexing. The capability now exists — `INDEX` and a
  confirmation both do — so the gap is ownership, and EPIC-032 may be the real
  owner rather than an MCP Epic at all.
- **`CONFIG_READ` stays ungranted by default.** The right default for the subtree
  that holds the secrets.

## 8. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 16 MET |
| Unit tests | Yes — the architecture control, generalized and covering two real destructive tools |
| Integration tests | Yes — 25, real MCP protocol, real `ConfigStore`, real file |
| Failure and boundary cases | Yes — invalid value, malformed path, object-internal path, schema violation, unresolvable secret reference, absent journal, `authorization` by five paths |
| Security implications | The `authorization` subtree is unwritable; a literal credential is refused; no read tool returns a stored password; a confirmation is bound to its path |
| Observability | A write is loggable with path and principal, never the value; the journal is readable back through the surface that wrote it |
| Documentation | Specification, this document, and the registry |
| Governance | §1, §2, §3, §5, §6, §12, §16 |
| Dependencies validated | EPIC-003, 064, 065, 068, 069 |
| Known blockers | None. §4 records what is deliberately narrower than it sounds. |
