# EPIC-070 — AI Client Capability Discovery

**Status: VALIDATED | Priority: P1 | Domain: AI Interface**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under AI Interface; only the
> specification is new.

## 1. Objective

Let an AI client ask **what can this Ferret do right now** — and get the health
report an operator gets, without shelling out to a terminal.

## 2. Value

`validation/EPIC-004-VALIDATION.md` has carried this row since EPIC-004:

> *"Health is not yet exposed over MCP. An AI client must shell out to
> `ferret status --json`. The report is already structured for it."*

Shelling out is the part that does not work. An MCP client is often a process
with no shell, no `ferret` on its path, and no way to read a second process's
exit code — so "the report is already structured for it" has been true and
unreachable for the whole life of the project.

- **EPIC-066 §16** — "*what can this Ferret do right now*, which is EPIC-070's
  question", and it "records the call" that health does not belong in EPIC-066.
- **EPIC-059/065 §4** — "Client capability discovery (EPIC-070)."
- **Governance §3** — the CLI is "a bootstrap, health, and emergency-recovery
  interface", which does not mean it is the *only* health interface.

## 3. Scope

- **`ferret_health`** — EPIC-004's report over MCP: the aggregate verdict, every
  component, and the remediation each carries.
- **What is indexed** — the inventory, so a client can tell an empty index from
  a stale one from a healthy one before it asks a question.
- **Saying what discovery already works** — §8.5.

## 4. Non-scope

- **A second capability list.** EPIC-067's `ferret_providers` reports which
  capabilities are available and why one is not. This reports *readiness*: is
  the database reachable, is the schema current, is anything indexed. Different
  question, and §8.4 states the boundary rather than letting the two drift.
- **A tool catalogue.** MCP's own `listTools` is the discovery mechanism, and
  every tool already carries a description written for a client to read. A
  Ferret-specific catalogue would be a second copy that goes stale — §8.5.
- **Repairing anything.** `ferret_health` reads. The remediation is a sentence,
  not a button; `ferret verify --repair` is a person's decision.
- **Health *polling*.** EPIC-014 §8.6 and EPIC-078 §8.5 both declined it. A tool
  a client calls when it wants to know is not a poll.
- **Starting an index.** No MCP tool starts an index run, and no Epic has
  claimed one. This Epic does not claim it either — §16.

## 5. Inputs

`probeHealth` (EPIC-004) and `readInventory` (EPIC-095), both of which exist and
both of which already produce structured output.

## 6. Outputs

`src/mcp/health-tools.ts`, and a `health` dependency on the MCP server.

## 7. Dependencies

EPIC-004 (the report), EPIC-095 (the inventory), EPIC-068 (the permission),
EPIC-066/067 (the tool shape this follows).

## 8. Contracts

### 8.1 A port, and the tool is absent without it

`health?: HealthAccess` on the server, and when it is absent the tool is **not
registered**. EPIC-066's rule for `configuration`, EPIC-048's for `evidence`,
EPIC-067's for `providers`: a tool that is honestly not there is better than one
a client cannot distinguish from a broken one.

A port is also a boundary requirement, not only a preference. `probeHealth`
lives in `src/cli/`, and `boundaries.test.ts` asserts that no MCP module reaches
a CLI one — so the composition root supplies it and the tool depends on two
functions.

### 8.2 It reads, it never repairs, and it never throws

`READ`, and read-only. Governance §20 requires `status` and `doctor` to stay
dependable "when other subsystems are unhealthy, which is precisely when they
are worth running" — so this tool inherits `probeHealth`'s contract that it
never throws. A health tool that failed when things were unhealthy would be
useless at the only moment it matters.

### 8.3 An unknown check is reported, never omitted

`probeHealth` already reports `unknown` for a check that could not run, and
EPIC-004's own reasoning is why this Epic must not filter it: *"an operator
reading a report [must] see that a check did not run, rather than having to
notice that a name is missing."* The same holds for an AI client, which is worse
at noticing an absence than a person is.

### 8.4 Readiness and capability are different questions

EPIC-067 answers *what can this Ferret do, and which provider is stopping it*.
This answers *is this Ferret working, and is there anything in it*. Stated here
because two tools that both drifted toward "everything about the server" would
end up disagreeing, and a client would have no way to know which to trust.

The response therefore carries **no** capability list and **no** provider
states. It points at `ferret_providers` for those.

### 8.5 Tool discovery is MCP's, and Ferret does not reimplement it

An AI client discovers Ferret's tools through `listTools`, and every tool
carries a description written for a client rather than for a developer. A
`ferret_tools` catalogue would be a second copy of that, maintained by hand,
and the failure mode of a second copy is that it goes stale silently.

So "capability discovery" in this Epic's title means *what this Ferret can do
right now* — a runtime question — and not *which tools exist*, which the
protocol already answers.

### 8.6 The inventory says what is indexed, in counts

Entity counts by kind, evidence, relationships, content blobs and the last run's
age. Enough for a client to distinguish an empty index from a stale one from a
healthy one **before** it asks a question and misreads an empty answer as
"nothing matched".

## 9. Acceptance criteria

- **AC-1** `ferret_health` returns the aggregate status and every component.
- **AC-2** Each component carries its status, whether it is required, and its
  remediation when it has one.
- **AC-3** A check that could not run is reported as `unknown`, not omitted.
- **AC-4** The response names Ferret's version, Node's version and the platform.
- **AC-5** The response carries the index inventory: counts by kind, evidence,
  relationships and blobs.
- **AC-6** The last run's age is reported when there has been one.
- **AC-7** An empty index is reported as empty rather than as an error.
- **AC-8** The tool returns a report rather than throwing when the database is
  unreachable.
- **AC-9** `ferret_health` is refused without `READ`.
- **AC-10** `ferret_health` is not registered when the port is absent.
- **AC-11** The tool is annotated `readOnlyHint: true`.
- **AC-12** No credential or connection string appears in any response.
- **AC-13** The response carries no capability list and no provider state —
  §8.4, as a test.
- **AC-14** No `ferret_tools` catalogue is registered — §8.5, as a test.

## 10. Test requirements

**Unit** — the response shape; the unknown-component case; the empty inventory.

**Integration** — the tool over the **real MCP protocol**, with a real
`probeHealth` against an unreachable database, so AC-8 is measured rather than
argued.

**Security** — AC-9, AC-12.

**Failure** — an inventory read that throws; a report with every component
`unknown`.

**Regression** — EPIC-066's and EPIC-067's suites unchanged.

## 11. Security requirements

AC-12: `probeHealth`'s components already carry no credential, and
`describeConnection` redacts. This Epic adds a test asserting it rather than
trusting it, because a health report is the response most likely to grow a
connection string by accident.

## 12. Observability

This Epic *is* observability, exposed to the client that most needs it.

## 13. Performance constraints

One `probeHealth` and one inventory read per call. `probeHealth` opens its own
connection and closes it, which is EPIC-004's behaviour and is not changed here.

## 14. Definition of Done

Scope implemented; AC-1 to AC-14 with evidence in
`validation/EPIC-070-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-004's "health is not yet exposed over MCP" row and EPIC-066 §16's
deferral struck with dated notes.

## 15. Governance alignment

- **§3 AI-Native Interface** — health stops being CLI-only.
- **§20 Dependability** — §8.2: the tool works when things are broken.
- **§6 Evidence Before Inference** — §8.3: a check that did not run says so.
- **§5 Reuse Before Reinvent** — §8.5 refuses to reimplement `listTools`, and
  the tool wraps `probeHealth` rather than probing again.

## 16. Raised, not absorbed

- **An AI client still cannot index.** No MCP tool starts an index run, and this
  Epic does not add one: an index is a long operation with no progress channel
  in MCP, and a tool that returned before finishing would report success for
  work that had not happened. EPIC-059/065's limitation row is now closed for
  *configure* and *manage*; **index** stays open with no owner.
- **`probeHealth` opens its own connection.** So `ferret_health` costs a
  connect per call, which is EPIC-004's design and fine for an operator running
  `status` occasionally. A client polling it would be paying for that, which is
  another reason §4 declines polling.
- **The inventory is counts, not coverage.** "Is this repository fully indexed"
  is a different question, and answering it needs a comparison against the
  source that only an index run performs.
- **No per-repository health.** The report is Ferret-wide. A client working in
  one repository cannot ask "is *this* one healthy", and EPIC-078's drift report
  is the closest thing — from the CLI.

## 17. Recorded during implementation

**A port was a boundary requirement, not a preference.** `probeHealth` lives in
`src/cli/health.ts`, and `boundaries.test.ts` asserts no MCP module reaches a
CLI one — so the tool could not call it even though it is exactly the right
function. `HealthAccess` is two functions supplied by the composition root.

**The inventory and the report fail independently.** `probeHealth` needs no
database; `readInventory` does. A failing inventory is therefore reported as an
absence with a reason rather than failing the call — the same shape §8.3
requires of a check that could not run.

**`DependencyStatus` has no `failed`.** It is `ok`, `degraded`, `unavailable`,
`unknown`, and the absence is deliberate: EPIC-004 chose `unavailable` because a
*dependency* is not available, which is a fact about the dependency rather than
a verdict on Ferret.

Full evidence in [validation](validation/EPIC-070-VALIDATION.md).
