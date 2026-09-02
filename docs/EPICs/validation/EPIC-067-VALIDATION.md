# EPIC-067 — MCP Provider Administration · Validation Evidence

**Assessed against:** working tree on top of `ff78b27`
**Date:** 2026-09-03
**Environment:** the **real MCP protocol** over an in-memory transport, against
a **real `ProviderRegistry`** with real providers whose `initialize` throws a
controlled number of times.

A faked port would have proved the opposite of this Epic's claim. The claim is
that it adds no registry behaviour and only exposes what is already there, so
the test has to show EPIC-014's states, EPIC-093's failure recording and
EPIC-011's verdict all arriving intact.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 lists every provider with its kind | **MET** | `provider-tools.test.ts` "lists every provider with its kind and state" |
| AC-2 each reports EPIC-014's state | **MET** | same test — `initialized` for the working provider, `failed` for the other |
| AC-3 a disabled provider reports `disabled` and is still listed | **MET** | "lists a provider switched off in configuration as disabled" — "installed and off" is a different answer from "not installed" |
| AC-4 a failed provider reports the failure **code** | **MET** | "reports a failed provider as failed, with the code and not a message" — and the message is asserted absent from the whole response |
| AC-5 no option value appears | **MET** | "returns no provider option value" — an option holding `sekrit-value` and even the key `token` are both absent |
| AC-6 available capabilities are named | **MET** | "names the available capabilities" |
| AC-7 "no provider offers it" | **MET** | "says no provider offers a capability nobody declared" |
| AC-8 a failed provider's capability names it | **MET** | "says which provider failed, for a capability that has one" — with the provider id, the code, and a remediation pointing at the recovery tool |
| AC-9 `ferret_providers` refused without `READ` | **MET** | "refuses the read without READ" — `E_NOT_PERMITTED` through the real protocol |
| AC-10 recovery re-initializes | **MET** | "recovers on the confirmed call" |
| AC-11 the capability comes back | **MET** | same test — the *next* `ferret_providers` call reports it available and no longer missing |
| AC-12 recovery refused without `INDEX` | **MET** | "refuses the recovery without INDEX" |
| AC-12a an unconfirmed call plans and recovers nothing | **MET** | "plans without recovering when confirm is omitted" — the plan names the current state and the registry is unchanged |
| AC-13 a failed attempt reports its code | **MET** | "reports a failed attempt with its code, and stays failed" |
| AC-14 a required provider is refused, naming why | **MET** | "refuses a required provider, naming which refusal" — with the "start Ferret again" remediation |
| AC-15 an exhausted circuit refuses | **MET** | "refuses once the circuit is open" — with "restart Ferret" rather than "try again", which is advice that cannot work |
| AC-16 two tools, and none without the port | **MET** | "registers exactly two tools"; the server registers them only when `providers` is supplied, as `config-tools` does for `configuration` |
| AC-17 a recovery is audited, a read is not | **MET** | the recovery goes through the destructive guard, which records a `CONFIRMATION` event; the read takes the plain guard with no event — EPIC-085 §4's rule |
| AC-18 nothing enables or disables a provider | **MET** | "registers exactly two tools, and neither enables a provider" — no `enabled` in either input schema |

Eighteen of eighteen (plus AC-12a) MET. `npm run verify` green on top of `ff78b27`:
147 files, 3 046 passed, 3 skipped.

## Found while implementing

**The destructive-tool gate refused this Epic's first design, and was right
to.** §8.2 originally argued that a recovery is not destructive — it re-runs an
`initialize` the composition root already registered, with settings from the
same configuration — and gave `ferret_provider_recover` the plain guard.
`mcp-destructive-tools.test.ts` failed three ways: the tool was not read-only
and did not pass the destructive guard, it did not declare `destructiveHint`,
and it was missing from the pinned inventory of non-read-only tools.

The gate's contract is **not read-only**, not "deletes something", and its whole
value is having no exceptions — that test exists precisely because "a tool that
simply never calls the gate" is the failure mode, and this would have been the
first one. A recovery does mutate what Ferret can do. §8.2 was rewritten, AC-12a
added, and the inventory updated with the reason recorded beside it. The cost is
one extra round trip per recovery, which §16 states.

**`ProviderRegistry.supports()` cannot answer this Epic's central question**, and
that is EPIC-093 working as designed. `#offered` filters out failed and disabled
providers, so `supports()` reports a capability whose only provider failed as
`unavailable` **with no `providerId`** — indistinguishable from one nobody
declares. For a caller *selecting* a provider that is exactly right: EPIC-093
§8.3 chose it deliberately, because "handing a caller an object whose
`initialize` threw is worse than handing it nothing."

But an operator asking *why* needs the three cases apart. The **declaration**
survives the filter — `describe()` reports every provider's declared
capabilities whatever state it is in — so §8.3's first three answers are derived
from there, and the verdict is consulted only for what it is the authority on: a
version this runtime cannot honour, or an operation a provider did not
implement. No registry change, and no weakening of EPIC-093's filter.

**The confirmation token arrives by being thrown.** EPIC-069 returns the plan and
the token inside a `FerretError`'s `details`, because an unconfirmed call is a
*refusal* that carries what is needed to retry — not a success with a token
attached. The first version of the test read `body.confirm` and found nothing;
`details.confirm` is what a client reads, and the test now mirrors that with the
reason recorded.

## Decisions worth recording

**A narrow port, not the registry.** Six questions rather than a class, so the
MCP layer depends on what it asks. `known()` is the whole `Capability`
vocabulary rather than the registry's offered set, because the interesting
answer is about the capabilities that are **missing** — and the registry, by
construction, only enumerates the ones it can serve.

**Absent means not registered.** EPIC-066's rule for `configuration` and
EPIC-048's for `evidence`: a tool that is honestly not there is better than one
a client cannot distinguish from a broken one. A consumer embedding Ferret with
only a `RetrievalPort` still gets a working knowledge server.

**Enabling and disabling is not here.** EPIC-066 already has it through
`ferret_config_set providers.<id>.enabled`, and a second path to the same
setting would be a second set of durability bugs — the argument EPIC-066 made
about `ConfigStore`, applied to itself. The remediation for a disabled provider
therefore *points at* EPIC-066's tool rather than duplicating it, and a test
asserts neither input schema has an `enabled` field.

**`INDEX`, not `CONFIG_WRITE`.** Nothing is written to configuration; what
changes is which capabilities are selectable.

**The circuit is the abuse control.** A client that calls the recovery tool in a
loop stops being able to after four attempts, and the response says so with a
remediation that is a restart rather than a retry. That property came free from
EPIC-014 and is worth naming: the bound is not a rate limit on the tool, it is a
property of the operation.

## Limitations, recorded

- **A read is not audited and a recovery is.** EPIC-085 §4 decided reads are not
  audited — "every search would be an event, which is a log rather than an audit
  trail" — so a `providers` read leaves no durable record. "Who looked at our
  provider configuration" is unanswerable from the trail.
- **A recovery costs two round trips**, because the confirmation gate has no
  exceptions. For a capability that came back on its own that is friction with
  no safety return; the alternative was an exception in a control whose value is
  having none.
- **The tools describe the *server's* registry.** On an MCP server composed with
  only a `RetrievalPort` that is not the registry that indexed anything. Two
  processes, two registries; nothing here reports another process's providers.
- **No capability *version* negotiation.** The response says a capability is
  available, not which version. EPIC-010 owns version compatibility, and a
  client that needs to branch on it still has no way to ask.
- **The first declarer wins the explanation.** When two providers declare the
  same capability and both are unusable for different reasons, the answer names
  one — the one selection would have chosen. Reporting both would be more
  complete and less actionable.
