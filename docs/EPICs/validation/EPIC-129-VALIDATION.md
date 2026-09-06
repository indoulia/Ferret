# EPIC-129 — Durable Context Capture: validation evidence

**Status: VALIDATED** · a real session's six memories promoted through the real
MCP tools: five recorded, one refused as superseded, two of the five held back
as proposals — and **zero captures**, because a transcript is not an input.
**No migration.**

## Environment

| | |
| --- | --- |
| Tree | `b1a5516` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | `@modelcontextprotocol/sdk`, real client and server |
| Database | `ferret-dogfood`, PostgreSQL 17 + pgvector, real `SessionStore` |
| Date | 2026-09-06 |

## Implementation

| | |
| --- | --- |
| Rule | `src/context/promotion.ts` — `planPromotion`, pure |
| Loop | same — `promoteMemories`, over `DurableContextPort` |
| Tool | `src/mcp/context-tools.ts` — `ferret_context_promote` |
| Contract | `AgentProvenance.confidence` — set by the promoter, exposed by no tool |

## Dogfood — a real session, promoted

The memories are ones this session actually produced while building EPIC-126 to
EPIC-129. Two were stated outright; two are the shape an extraction rule finds;
one was retracted and replaced.

```
memories the session recorded                       6
captures promoted (the transcript)                  0
considered                                          6
created                                             5
  of which proposals, not beliefs                   2
refused                                             1
  refused because                            superseded
current context after promotion                     3
  proposals awaiting acceptance                     2
promoting the same session again — created          0
  merged onto what was already held                 5
```

**Zero captures** is the Epic's central constraint, and it holds structurally
rather than by policy: captures are not an argument `promoteMemories` accepts,
and `ferret_context_promote` takes one field — which session.

**Two of five held back.** The extracted memories became candidates, so
automatic extraction did not silently become current context. Three current
statements, two awaiting acceptance.

**One refused.** A memory this session retracted — *"the historical lifecycle
state will be added as a sixth value"*, replaced by *"historical is the category
superseded, archived and deleted already form"* — was refused rather than
promoted, because promoting it would revive a belief that had been withdrawn.

**Promoting twice adds nothing.** Five merged, none created.

### Provenance reaches the work

```
source system                             ferret.session
source id is the session                            true
confidence carried from the memory                  0.95
```

## A defect dogfooding found

The first run reported `confidence carried from the memory: null`.

`planPromotion` computed a confidence from the memory's origin and
`promoteMemories` had nowhere to put it — `AgentProvenance` had no such field.
So the number was computed and dropped, which is precisely the failure
`confidence.ts` was raised for and describes:

> `confidence` is stored, read by two orderings as the tiebreak under authority,
> and **never written**.

Fixed by adding `confidence` to the port and passing the plan's. The field is
deliberately not exposed by any tool: a caller naming its own confidence is
self-assessment, and `authority.ts` records what a number like that becomes. It
exists for a producer Ferret runs, where an explicit statement and a matched
marker are genuinely 0.35 apart.

Covered by `carries a weaker confidence for a memory a rule found`.

## A fake that could not diverge

`tests/unit/context-promotion.test.ts` builds its fake port's ids through the
real `createDurableContext`. The first draft generated an id per call, and the
"promoting twice adds nothing" test failed against a fake that disagreed with
the product about the one property promotion depends on — that identity is a
function of what was said. The fake was wrong; the code was not.

## Suites

| Suite | Result |
| --- | --- |
| `tests/unit/context-promotion.test.ts` | 12 passed |
| `tests/integration/mcp/context-tools.test.ts` | 24 passed |
| `tests/unit/mcp-destructive-tools.test.ts` | 10 passed |
| `tests/integration/distribution.test.ts` | 11 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
