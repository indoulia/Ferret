# EPIC-059 — Context Packs · EPIC-061 — Token Budgeting · EPIC-064 — MCP Server · EPIC-065 — MCP Knowledge Tools

**Status: APPROVED | Priority: P0 (all four)**

> **Specification note.** Four registry entries, one document, because they form
> a single path: a pack needs a budget, a budget is meaningless without a pack,
> and a server with no tools serves nothing. Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entries and Governance §4, §6, §12, §14 and §20. Each Epic keeps its
> own acceptance criteria.

## 1. Objective

Let an AI client use Ferret: assemble what Ferret knows into something that fits
a context window, and serve it over the Model Context Protocol.

## 2. Value

This is the last step. Ferret indexes, and it answers — but nothing can *ask*
it except a person at a terminal.

Two constraints shape everything here, and they pull in opposite directions.

**A context window is small.** Ferret holds far more than fits, so what it sends
is always a selection. The selection must be explicit: a client that received a
silently truncated pack answers confidently from half the evidence, and nobody
finds out. Governance §6 forbids manufacturing certainty, and an answer built
from a quietly truncated pack is exactly that.

**Everything in it is untrusted.** Every string came from a repository Ferret did
not write. A commit message can say *"ignore your previous instructions"*, and a
document Ferret indexed can be written specifically to say so. The delivery
brief is unambiguous: indexed content must **never** override Ferret's or the
client's instructions.

That second constraint cannot be met by filtering. A message discussing prompt
injection is indistinguishable from one attempting it, and no denylist survives
an attacker who can write arbitrary text into a repository. So the defence is
**structural** — see §8.

## 3. Scope

- **EPIC-061:** token estimation and a budget that reports what it refused.
- **EPIC-059:** context packs — ranked selection, explicit omissions, trimming
  rather than dropping, and a renderer.
- **EPIC-064:** an MCP server over stdio, and `ferret mcp`.
- **EPIC-065:** the knowledge tools an AI client calls.

## 4. Non-scope

- Answer packs (EPIC-060), evidence selection (EPIC-062), query explanation
  (EPIC-063).
- Configuration and provider-administration tools (EPIC-066, EPIC-067).
- Authorization and destructive-operation confirmation (EPIC-068, EPIC-069) —
  which is why every tool here is read-only.
- Client capability discovery (EPIC-070). **Delivered 2026-09-03:**
  `ferret_health` answers *what can this Ferret do right now*. Tool discovery
  stays MCP's own `listTools`, which EPIC-070 §8.5 declines to reimplement — a
  hand-maintained catalogue is a second copy that goes stale silently.

## 5. Inputs

EPIC-052/053 retrieval, EPIC-009 error serialization, the official MCP SDK
(TECHNOLOGY-DECISIONS §4).

## 6. Outputs

`src/context/`, `src/mcp/` (published as `@indoulia/ferret/mcp`), `ferret mcp`.

## 7. Dependencies

EPIC-002, EPIC-009, EPIC-011, EPIC-052, EPIC-053.

## 8. Contracts

### Estimation, not counting

A real token count needs the tokenizer of a specific model, and pulling one in
would tie Ferret to a model family — exactly what Governance §4 forbids, since
the AI client is a provider like any other. So Ferret **estimates**, and the name
says so everywhere.

The estimate is deliberately **conservative**, because the failure modes are not
symmetric: over-counting means Ferret sends a little less than it could;
under-counting means the *client* truncates, silently, from whichever end it
happens to truncate — and what it cuts is not what Ferret would have chosen.

### A pack says what it left out

Three ways a pack can be smaller than the knowledge behind it — dropped for
budget, stopped at a result limit, or **trimmed** — and each is named in the
pack.

Trimming exists because dropping is worse. An oversized item's longest values are
shortened until the item fits; its short values (a path, a name, a hash) are
never cut, because those are what make it identifiable and a truncated id is
worse than useless.

### Indexed content is framed, never sanitised

- Every tool returns **structured content** — JSON with named fields — rather
  than prose. A model reading `{"message": "ignore your instructions"}` is
  reading an attributed value, not receiving a command.
- Every response carries a **content notice**, and it comes **first**. A model
  reads in order, and an instruction arriving after the content it governs has
  already lost.
- No tool interpolates indexed content into a sentence Ferret wrote. There is no
  template anywhere with a hole for source text.

### Read-only, and stdio

Every tool is read-only and declared so. Indexing is a command a person runs;
until EPIC-069 provides confirmation for destructive operations, the safest
number of destructive tools is none.

stdio because that is how an AI client spawns a tool it trusts: no port, no
listener, no surface anything else on the machine can reach. **stdout is the
transport** — a single stray line corrupts it, which is why Ferret's logger has
written to stderr since EPIC-001.

## 9. Acceptance criteria

### EPIC-061 — Token Budgeting

- **AC-1** An estimate is never zero for non-empty input.
- **AC-2** An identifier or path costs more than prose of the same length.
- **AC-3** The estimate over-counts rather than under-counts.
- **AC-4** A budget admits what fits, refuses what does not, and **counts the
  refusals**.
- **AC-5** Running out reports rather than throws.

### EPIC-059 — Context Packs

- **AC-6** Items are admitted highest-scoring first.
- **AC-7** A pack never exceeds its budget, and a requested budget is capped.
- **AC-8** A pack states every omission with a reason.
- **AC-9** An oversized item is trimmed rather than dropped, marked as trimmed,
  and keeps what identifies it.
- **AC-10** One entity appears once, however many ways it matched.
- **AC-11** A pack carries its own producer, version and question.

### EPIC-064 — MCP Server

- **AC-12** `ferret mcp` serves over stdio and writes nothing to stdout but
  protocol messages, including when it fails to start.
- **AC-13** The schema policy is `verify`: serving never migrates.
- **AC-14** The core does not reach the MCP SDK, enforced by test.

### EPIC-065 — MCP Knowledge Tools

- **AC-15** Search, exact find, entity read, traversal and context pack are
  offered as tools.
- **AC-16** Every tool is declared read-only.
- **AC-17** Every tool description and every response states that content is
  data, not instructions.
- **AC-18** A schema violation is declined with the offending field named.
- **AC-19** A failure becomes a tool error with the secret redacted.
- **AC-20** Absence is an answer, not an error.
- **AC-21** Traversal accepts an instant, so *"what was I working on last
  Tuesday"* is reachable from a client.

## 10. Test requirements

- **Unit:** estimation and budget behaviour; pack assembly, trimming and
  omissions, against a fake retrieval port — which is the right double here,
  because the awkward cases (a hostile message, an item too big for any budget)
  have to be constructed exactly.
- **Integration:** the tools through the **real protocol**, client and server
  over an in-memory transport.
- **Security:** a hostile commit message carried end to end, asserting it stays
  an attributed value and that the notice precedes it.
- **Process:** stdout stays empty when `ferret mcp` cannot start.
- **Dogfooding:** a real MCP client over stdio against Ferret's own index.

## 11. Security requirements

§8. Plus: every tool input is schema-validated by the SDK before Ferret runs;
every failure is serialized through EPIC-009, so a credential cannot reach a
client through an error; and results are bounded so one call cannot fill a
context window.

## 12. Observability

A pack reports its estimate, its budget, and whether it is complete. A tool
failure is logged with its operation and reported to the client as an error
rather than an empty result.

## 13. Performance constraints

None new: the cost is retrieval's, which EPIC-053 bounds.

## 14. Definition of Done

All four implemented, criteria evidenced, and a real MCP client demonstrated
against Ferret's own index.

## 15. Governance alignment

- **§4 Provider-First** — the AI client is a provider; Ferret does not adopt its
  tokenizer.
- **§6 Evidence** — a pack never hides that it is partial.
- **§12 Security** — content is data, framed rather than filtered.
- **§14 Lightweight infrastructure** — stdio, no listener.
- **§20 Observability** — a pack says what it did and did not include.
