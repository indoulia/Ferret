# EPIC-128 — Agent Context Bridge: validation evidence

**Status: VALIDATED** · an agent's eleven-file parallel durable store was moved
into Ferret through the real MCP tools, read back by a later session, replayed
without duplicating, and curated — while an agent without `mutate` was refused.
**No migration, no new dependency.**

## Environment

| | |
| --- | --- |
| Tree | `31b504f` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | `@modelcontextprotocol/sdk` over `InMemoryTransport` — the real client, the real server |
| Database | `ferret-dogfood`, PostgreSQL 17 + pgvector |
| Date | 2026-09-06 |

## Implementation

| | |
| --- | --- |
| Port | `src/context/durable-port.ts` — `DurableContextPort` |
| Tools | `src/mcp/context-tools.ts` — four |
| Composition | `src/cli/commands/mcp.ts` passes `DurableContextStore` as the port |
| Surface record | `README.md` — the tool table and the governance prose |

The store satisfies the port **structurally**: neither file imports the other,
and the composition root compiling is the proof.

## Dogfood — an agent's parallel store, moved in

The eleven markdown files this repository's agent maintains outside the product,
recorded verbatim through `ferret_context_record` over the protocol.

```
files in the agent-local store                    11
records created in Ferret                         11
merged onto a record already held                  0
what a later session reads back                   11
  of which decisions                               3
after replaying every file again                  11
a second agent restates one — outcome         merged
```

The replay is the property that matters for an agent that re-reads its own
memory each session: **11 records in, 11 records after replaying all eleven
again**. And a second agent stating one of them in different words — *"Re-index
Ferret after every merge so it answers about the code on main."* against
*"Re-index Ferret after every merge, so it answers about the code on main"* —
**merged** onto the record already held rather than adding a twelfth.

### Should the agent believe it?

```
trust on "no macOS runner" — current            true
  support                                          1
  reason      current on 1 observation(s), strongest by asserted
```

### Curating, over the protocol

```
proposed — in current context                     11   (a proposal is not current)
after accepting the proposal                      12
after archiving one                               11
  still readable as history                       12
```

### Governance holds

```
an agent without `mutate` archiving            refused
statement contained on the way out                 yes
notice precedes the content                        yes
```

An agent holding `read` and `record` recorded freely and was refused a lifecycle
transition. Every statement came back wrapped in EPIC-087's sentinels, with the
data-not-instructions notice ahead of it — a model reads in order, and an
instruction arriving after the content it governs has already lost.

## The boundary, asserted rather than intended

`names no client, protocol or vendor anywhere in what it offers` scans the whole
offered surface — every tool name, description and schema — for `claude`,
`anthropic`, `openai`, `copilot`, `cursor` and `gpt`. Claude is the first
dogfood client; nothing about the architecture knows it exists.

## Three controls objected, all correctly

**The permission must be named at the call site.** `mcp-destructive-tools.test.ts`
refused the first draft, which had gathered the permissions into a `PERMISSIONS`
map for readability. The rule is that a tool naming its permission anywhere else
is a tool whose permission can be changed without touching the tool. The map is
gone; the rationale stayed as a comment. The same file's additive-tool inventory
is pinned, so the two new writing tools are a visible line in the diff.

**One notice, not two.** The first draft defined its own `CONTEXT_NOTICE`, and
`mcp/tools.test.ts` refused it: every tool description must carry the notice the
whole surface is judged by. `CONTENT_NOTICE` was widened by four words to name
durable statements — one definition, one place for the rule to live.

**An absent dependency means an absent tool.** The first draft registered the
tools unconditionally and had them report `available: false`. `mcp/tools.test.ts`
caught it, and `McpServerDependencies.evidence` had already recorded the
decision in the opposite direction: *"a tool that always reports no evidence is
worse than a tool that is honestly not there, because a client cannot tell the
two apart."* The tools are now registered only when a port is wired.

## Suites

| Suite | Result |
| --- | --- |
| `tests/integration/mcp/context-tools.test.ts` | 16 passed |
| `tests/unit/mcp-destructive-tools.test.ts` | 10 passed |
| `tests/integration/distribution.test.ts` | 11 passed |
| `tests/integration/storage/durable-context.test.ts` | 11 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
