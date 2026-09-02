# EPIC-067 — MCP Provider Administration

**Status: VALIDATED | Priority: P1 | Domain: AI Interface**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under AI Interface; only the
> specification is new.

## 1. Objective

Let an AI client see **which providers Ferret has, what state each is in, and
which capability is missing because of it** — and recover one that failed.

## 2. Value

EPIC-059/065's validation recorded the gap in one sentence: *"An AI client
cannot index, configure or manage providers — only read."* EPIC-066 took
*configure*. This takes **providers**, which is the half nobody has built.

The concrete cost is a question an AI client cannot answer. When semantic
retrieval is unavailable, a client sees results without embeddings and has no
way to learn *why* — whether no provider offers it, one offers it and is
switched off, or one offers it and failed to start. Those need three different
things done about them, and Ferret already knows which it is.

- **Governance §3** — configuration and management "should be exposed through a
  discoverable AI interface", with the CLI as "a bootstrap, health, and
  emergency-recovery interface". Provider state is currently CLI-only, which
  inverts that.
- **EPIC-066 §4** — "Provider administration — EPIC-067, which the same row
  names."
- **EPIC-014's validation** — "`recover` is a registry method with no `ferret`
  command behind it… EPIC-067 is where that belongs."
- **EPIC-068 §93** — "EPIC-066 and EPIC-067 have something to declare."

## 3. Scope

- **`ferret_providers`** — every registered provider: kind, state, whether
  configuration switched it off, and the code it failed with.
- **The capability view** — which capabilities are available, and for each one
  that is not, *why*.
- **`ferret_provider_recover`** — EPIC-014's bounded recovery, over MCP.

## 4. Non-scope

- **Enabling or disabling a provider.** That is a configuration change, and
  EPIC-066 already has it: `ferret_config_set providers.<id>.enabled`. A second
  path to the same setting would be a second set of durability bugs, which is
  the argument EPIC-066 §8 made about `ConfigStore` and it applies here.
- **Registering or removing a provider.** The registry seals at
  `initializeAll` — EPIC-013 — and that stays true. Composition is the host's.
- **Restarting a *required* provider.** EPIC-014 §8.4 refuses it, and this Epic
  exposes that refusal rather than working around it.
- **Health polling.** EPIC-014 §8.6 and EPIC-078 §8.5 both declined it. A tool
  a client calls is not a poll.
- **Provider *configuration* values.** `ferret_config_get` reads them, with
  EPIC-081's redaction. Nothing here returns a provider's options.

## 5. Inputs

`ProviderRegistry.describe()`, `.states()`, `.capabilities()`, `.supports()`
and `.recover()` — all of which exist. This Epic adds no registry behaviour.

## 6. Outputs

`src/mcp/provider-tools.ts`, and a `providers` dependency on the MCP server.

## 7. Dependencies

EPIC-013 (the registry), EPIC-014 (state and recovery), EPIC-011 (the capability
verdict), EPIC-068 (the permission), EPIC-085 (the audit event), EPIC-066 (the
tool shape this follows).

## 8. Contracts

### 8.1 A port, and the tools are absent without it

`providers?: ProviderAdministration` on the server, and when it is absent the
tools are **not registered** rather than registered and failing. The same
reasoning EPIC-066 gave for `configuration` and EPIC-048 for `evidence`: a tool
that is honestly not there is better than one a client cannot distinguish from a
broken one, and a consumer embedding Ferret with only a `RetrievalPort` still
gets a working knowledge server.

A narrow port rather than the registry itself, so the MCP layer depends on four
questions instead of a class.

### 8.2 Reading needs `READ`; recovering needs `INDEX` and a confirmation

Reading is a read. Recovery changes what Ferret can do — a capability becomes
selectable — so it takes the same grant an index does, and it goes through
**EPIC-069's confirmation gate**.

That is a correction. The first draft of this section argued a recovery is not
destructive, since it re-runs an `initialize` the composition root already
registered with settings from the same configuration, and gave it the plain
guard. `mcp-destructive-tools.test.ts` refused that, and was right to: the
control's contract is *not read-only*, not "deletes something", and its whole
value is having no exceptions. That test exists because "a tool that simply
never calls the gate" is the failure mode, and this would have been the first
one.

`INDEX` rather than `CONFIG_WRITE`, because nothing is written to
configuration; what changes is which capabilities are selectable.

The plan names the state the provider is in **now**, so a client seeing it can
tell a recovery that will be refused from one that will be attempted, rather
than spending a confirmation round trip to find out.

EPIC-014's circuit is the second bound: four failed attempts and the provider is
`unrecoverable`, after which `recover` refuses without trying. A client that
calls the tool in a loop stops being able to, by design.

### 8.3 A missing capability says which of three things happened

For every capability Ferret knows about and cannot currently serve, the answer
names the cause:

- **no provider offers it** — a missing dependency;
- **a provider offers it and configuration switched that provider off** — a
  decision somebody made;
- **a provider offers it and failed to start** — an event, with the code.

EPIC-093 §8.4 already insists those look different in a descriptor, and
EPIC-011's `CapabilityVerdict` already carries the distinction. This is the
first surface that hands it to an AI client, which is the caller most likely to
otherwise guess.

### 8.4 A failure is reported as a code, never a message

EPIC-093's rule, unchanged: a message can carry a path or a value, and this
reaches a client's context window. The code plus the remediation is what makes
it actionable without disclosing anything.

### 8.5 A refused recovery says which refusal, and what to do about it

EPIC-014 has five: unknown, already running, disabled, required, exhausted. Each
has its own remediation, and this returns them rather than collapsing them into
"could not recover" — a client that was told "disabled" changes configuration,
and one told "required" restarts Ferret.

### 8.6 Both tools are audited

EPIC-085's trail. A recovery is a state change an operator will want to find
afterwards, and a `providers` read is one of the reads EPIC-085 §4 deliberately
does not audit — so only the recovery emits an event, and §16 records that
asymmetry.

## 9. Acceptance criteria

- **AC-1** `ferret_providers` lists every registered provider with its kind.
- **AC-2** Each provider reports the state EPIC-014 gives it.
- **AC-3** A provider switched off in configuration reports `disabled`, and is
  still listed.
- **AC-4** A failed provider reports `failed` with the failure **code**.
- **AC-5** No provider's option values appear in any response.
- **AC-6** The response names each available capability.
- **AC-7** For an unavailable capability, the response says no provider offers
  it.
- **AC-8** For a capability whose provider failed, the response says so and
  names the provider.
- **AC-9** `ferret_providers` is refused without `READ`.
- **AC-10** `ferret_provider_recover` re-initializes a failed optional provider.
- **AC-11** A successful recovery reports the provider `initialized`, and the
  capability becomes available in a following `ferret_providers` call.
- **AC-12** `ferret_provider_recover` is refused without `INDEX`.
- **AC-12a** `ferret_provider_recover` without `confirm` returns a plan naming
  the provider's current state, and recovers nothing.
- **AC-13** A refusal names which of EPIC-014's five it is, with a remediation.
- **AC-14** Recovering a required provider is refused, naming the reason.
- **AC-15** Recovering an `unrecoverable` provider is refused without calling
  `initialize`.
- **AC-16** Neither tool is registered when the port is absent.
- **AC-17** A recovery emits one audit event; a read emits none.
- **AC-18** No tool here enables or disables a provider.

## 10. Test requirements

**Unit** — the response shape; each refusal; the capability explanation.

**Integration** — both tools over the **real MCP protocol**, as EPIC-066's tests
do, including a recovery making a capability available to the next call.

**Security** — AC-5, AC-9, AC-12, AC-17, AC-18.

**Failure** — a provider that fails every attempt; an unknown id.

**Regression** — EPIC-066's and EPIC-014's suites unchanged.

## 11. Security requirements

§8.4's code-not-message rule, and AC-5: no option value crosses this surface,
because EPIC-081 put credentials in provider options and a tool that returned
them would undo that Epic. Both tools go through the same guard EPIC-066's do.

## 12. Observability

The state and the capability verdict *are* the observability. One audit event
per recovery.

## 13. Performance constraints

Set membership and a map lookup — `describe`, `states` and `capabilities` are
all in-memory. `recover` costs one `initialize`.

## 14. Definition of Done

Scope implemented; AC-1 to AC-18 (with AC-12a) with evidence in
`validation/EPIC-067-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-059/065's "cannot manage providers" limitation, EPIC-066 §4 and
EPIC-014's validation note struck with dated notes.

## 15. Governance alignment

- **§3 AI-Native Interface** — provider state stops being CLI-only.
- **§6 Evidence Before Inference** — §8.3: three causes, named, rather than one
  "unavailable".
- **§12 Security** — §8.4, AC-5, and the same guard as every other tool.
- **§5 Reuse Before Reinvent** — no registry behaviour is added; §4 refuses to
  duplicate EPIC-066's enable/disable.

## 16. Raised, not absorbed

- **A read is not audited and a recovery is.** EPIC-085 §4 decided reads are not
  audited — "every search would be an event, which is a log rather than an audit
  trail" — so a `providers` read leaves no durable record. An operator asking
  "who looked at our provider configuration" cannot answer it from the trail.
- **A recovery costs a client two round trips**, because it goes through the
  confirmation gate (§8.2). For a capability that came back on its own that is
  friction with no safety return; the alternative was an exception in a control
  whose value is having none, so the friction is the lesser cost.
- **The tools describe the *server's* registry**, which on an MCP server composed
  with only a `RetrievalPort` is not the registry that indexed anything. Two
  processes, two registries; nothing here reports another process's providers.
- **No capability *version* negotiation.** The response says a capability is
  available, not which version — EPIC-010 owns version compatibility, and a
  client that needs to branch on it has no way to ask.

## 17. Recorded during implementation

**The destructive-tool gate refused §8.2's first design, and was right to.** It
argued a recovery is not destructive and gave the tool the plain guard;
`mcp-destructive-tools.test.ts` failed three ways — not routed through the
guard, no `destructiveHint`, and missing from the pinned inventory. The
control's contract is *not read-only*, not "deletes something", and its value is
having no exceptions: that test exists because "a tool that simply never calls
the gate" is the failure mode, and this would have been the first one. §8.2 was
rewritten and AC-12a added.

**`ProviderRegistry.supports()` cannot answer §8.3's question**, and that is
EPIC-093 working as designed: `#offered` filters out failed and disabled
providers, so a capability whose only provider failed reports `unavailable` with
no `providerId` — indistinguishable from one nobody declares. For a caller
*selecting* a provider that is right. For an operator asking *why* it is not, so
the three answers are derived from the **declaration**, which survives the
filter. No registry change, and no weakening of EPIC-093's filter.

Full evidence in [validation](validation/EPIC-067-VALIDATION.md).
