# Do the aggregation signals exist?

**Measured 2026-09-08** against the dogfood store `ferret-dogfood` (up 2 days),
through Ferret's own MCP surface and by direct read of the store it serves.
Design measurement for [EPIC-139A](../EPICs/EPIC-139A-Context-Aggregation.md),
taken **before** any design was fixed, on the rule EPIC-138 earned: a mechanism
whose input signal is absent measures nothing.

> **The question.** EPIC-139A proposes to group durable statements that describe
> one situation, using signals Ferret already records rather than similarity.
> Before specifying the mechanism: are those signals actually in the store?

> **CORRECTED 2026-09-08 by the
> [corpus-readiness study](FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md).**
> Section 2.1 below concluded that `subjectId` is *structurally unreachable*
> because it demands a UUID while an agent holds a path. **That conclusion is
> wrong.** One `ferret_find` call converts a path into the entity UUID, so
> `subjectId` is formable in two tool calls and is simply never used - a routing
> fact, not a structural one. Every count in this report stands; the inference
> in 2.1 does not. The original wording is left in place rather than rewritten,
> and the correction is recorded where the claim was made.

## 1. What the store holds

```
entity kinds        code_symbol 4051 · file_version 1118 · file 992 · commit 262
                    branch 18 · context 7 · worktree 4 · developer 2 · repository 1
evidence            15 151 rows, 14 626 current, 2 416 anchored
```

The store is **repository-connector output only**. There is no `issue`,
`pull_request` or `page` entity: the GitHub connector is enabled in
`.local/ferret-dogfood/config.json` and has not been synced into this store.
Every cross-source claim in the worked example of EPIC-139A §21 is therefore
**conceptual against this corpus**, and the experiment in §25 needs a synced
store or an explicit limitation.

The seven durable statements, in full:

| id | lifecycle | kind | statement |
| --- | --- | --- | --- |
| `47a0bfcd` | active | decision | Durable context is reachable through `ferret_search` only when `kinds` is restricted to `context`; the fix for that was the tool description, not the default ranking |
| `c894a630` | active | fact | Verification additionally requires that the anchored path has no uncommitted changes, so a dirty anchor is `unknown` |
| `4e215770` | active | fact | A dogfood statement anchored to a path that does not exist |
| `622e1122` | active | fact | Ferret dogfoods itself through a surface no agent uses |
| `8e13befb` | active | fact | Ferret dogfoods itself through the surface an agent actually uses |
| `88c0d4c7` | candidate | next-step | A proposal is not a belief until somebody accepts it |
| `68fc0c86` | superseded | fact | A durable statement is verified only when the anchored content hash matches and the indexed branch head equals the live worktree head |

## 2. Signal density — the finding

Every candidate membership relation, counted in the store rather than assumed:

| candidate signal | model support | rows in this store | fires |
| --- | --- | --- | --- |
| `ENTITY_SUPERSEDES_ENTITY` between two `context` | EPIC-126, EPIC-127 | **1** edge | yes |
| shared anchor `(scope, path)` | EPIC-137 | **1** pair | yes |
| `context_relates_to_context` | EPIC-126, read by EPIC-130 | **0** | no |
| `context_contradicts_context` | EPIC-126 | **0** | no |
| `subjectId` equality | EPIC-126 identity | **0** statements carry one | no |
| `CONTEXT_CONCERNS_ENTITY` | EPIC-126, writer at `src/storage/durable-context.ts:239` | **0** | no |

**Three of the six deterministic signals are empty, and one of them is empty
for a structural reason rather than by accident.**

### 2.1 `subjectId` is unreachable to the producer that writes context

> **Superseded by the corpus-readiness study 3.2.** The heading and the argument
> below overstate the case: `subjectId` is reachable in two calls
> (`ferret_find` for the entity, then `record`), and `relationship.to_id`'s
> foreign key is satisfied by the UUID that returns. What is true is the
> measurement - 0 of 7 records carry a subject. What is false is the explanation.

`ferret_context_record` declares `subjectId: z.string().uuid()` —
*"The Ferret entity this is about, when it is about one"*
(`src/mcp/context-tools.ts:230`). An agent recording a statement holds a
**path**, not an entity UUID. So no statement in the store has a subject, the
`CONTEXT_CONCERNS_ENTITY` writer has never fired, and `contradicts()` — which
requires `subjectId` on both sides (`src/context/durable.ts:127`) — is
structurally unreachable.

This is the same defect EPIC-137 §9 identified and routed around for anchors:

> `anchors: [{ path, symbol?, lineRange? }]` — repo-relative paths, **no entity
> UUID** (today's `subjectId`/`scope` are `uuid()`).

Anchors are supplied by agents and are present on 3 of the 10 durable-context
observations. `subjectId` is not supplied by anybody. The two facts have one
cause.

### 2.2 The two signals that fire, agree

The store's only `entity_supersedes_entity` edge joins two `context` records:

```
c894a630  supersedes  68fc0c86
```

Both rest on the same anchor path — every anchored durable-context observation
in the store names `src/context/code-state.ts`:

```
c894a630 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:fbd28c171c5
68fc0c86 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:6a1f6b75a46
68fc0c86 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:fbd28c171c5
```

So the only multi-statement grouping this corpus supports has **two members**,
and **two independent deterministic signals identify the same pair.** That is a
small sample and a real one: it is evidence that anchor overlap is not a
speculative signal, and it is not evidence that anchor overlap scales.

### 2.3 The pair a reader most needs together is the pair nothing joins

`622e1122` — *"Ferret dogfoods itself through a surface no agent uses"* — and
`8e13befb` — *"Ferret dogfoods itself through the surface an agent actually
uses"* — are the corpus's one genuine disagreement. Both are `active`, both are
`fact`, and **no signal in Ferret puts them together**:

- neither carries a `subjectId`, so `contradicts()` returns `false` before it
  looks at the words;
- neither is anchored, so there is no path to overlap;
- their token-set Jaccard, computed with the product's own
  `normalizeStatement`/`statementTokens`/`similarity`, is **0.583** against
  `NEAR_DUPLICATE_SIMILARITY = 0.8` — so `classifyPair` returns `distinct` and
  the merger wrote no edge.

This is the measured ceiling of deterministic aggregation, and it points at a
**capture** fix rather than a read-side inference: two statements about one
subject, neither of which names the subject. Lowering the similarity threshold
would not reach it either — 0.583 is far below 0.8, and a threshold low enough
to catch this pair would merge statements that merely share vocabulary.

## 3. What a real pack delivers today

`ferret_context_pack`, through `ferret mcp` against this store, budget 4 000:

```
question   "is a durable statement verified when the anchored content hash matches"
standing   4 entries
items      1 (a commit)
estimated  3 622 of 4 000
omitted    3 results did not fit; 1 trimmed; 1 observation not cited
withheld   0
```

The four standing entries, in the order the pack returned them:

| # | id | kind | state | verdict | bears on the question |
| --- | --- | --- | --- | --- | --- |
| 1 | `47a0bfcd` | decision | active | — | **no** — it is about `ferret_search` routing |
| 2 | `4e215770` | fact | active | — | no — a dogfood artefact |
| 3 | `c894a630` | fact | active | `unknown` | yes |
| 4 | `68fc0c86` | fact | **superseded** | `superseded` | yes — and it is the one #3 replaced |

Two findings, both on the product path:

**The highest-ranked standing entry is unrelated to the question.** `decision`
outranks `fact` in `KIND_ORDER` (`src/context/standing.ts:40`) and ordering is
deliberately not by relevance — EPIC-131 chose that, correctly, so that a
well-worded fact cannot outrank a constraint. The cost of the choice is visible
here: the widened durable-context read admitted a decision the question does not
touch, and the cost ordering then promoted it above both entries that answer.

**The pack holds both halves of one belief and names no link between them.**
Entry 4's own text says *"replaced by a later statement, which is the answer
instead"* — and does not say **which** statement, although the replacement is
entry 3 of the same array. `StandingContext` (`src/context/standing.ts:49`)
carries `id`, `statement`, `contextKind`, `state`, `current`, `supportCount`,
`authority`, `undecided`, `verification`, `restates`, `estimatedTokens` — and
**no** `supersededBy`, `supersedes` or `contradictedBy`. `ContextBelief` has all
three. The pack computes the entry from `preferredEvidence` and never reads the
supersession edges that `trust()` reads.

### 3.1 What recovering the link costs

`ferret_context_trust` names it immediately:

```
"supersededBy": "c894a630-0dcb-8f4a-983a-0ead0def7008"
```

So the information is one tool call away, per statement. Measured, all four:

| id | response |
| --- | --- |
| `47a0bfcd` | 1 684 chars |
| `4e215770` | 1 632 chars |
| `c894a630` | 2 122 chars |
| `68fc0c86` | 1 760 chars |
| **total** | **7 198 chars ≈ 2 295 tokens** |

At EPIC-136's measured 3.14 characters per token: **4 extra round trips and
~2 295 tokens — 63% of the pack's own 3 622 — to learn one edge the pack already
had both endpoints of.**

That is the same shape as the two findings this arc keeps producing:
EPIC-130's *"the merger had already written five edges saying so; retrieval never
read them"* and EPIC-124's *"built twice and joined neither time."*

## 4. What this measurement does and does not license

**Licenses:** a read-side grouping stage that reads supersession edges and
anchor overlap between the statements a pack has already fetched. Both signals
exist, both are deterministic, both cost one query over a page of at most ten
ids, and one of them fires on the only pair in the corpus that has an answer.

**Does not license:** a design whose value depends on
`context_relates_to_context`, `context_contradicts_context`, `subjectId` or
`CONTEXT_CONCERNS_ENTITY`. Those are zero here. (The corpus-readiness study
refines this: all four are *formable* through today's surface, so the deficit is
a populated corpus rather than a product gap.) A mechanism keyed on them would
ship, measure nothing, and be indistinguishable from a mechanism that does not
work — which is precisely how EPIC-138 was rejected, and the reason that
rejection was cheap was that it was measured before it was believed.

**Does not license a similarity model either.** The one pair deterministic
signals miss (§2.3) is missed because neither statement names its subject, and
an LLM asked to group them would be inferring a subject from prose — the thing
EPIC-137 decision 7 forbade for anchors, for the same reason.

## 5. Reproducing this

```bash
docker exec ferret-dogfood psql -U ferret -d ferret -At -F'|' -c "
  select type, count(*) from relationship group by type order by 2 desc;"

docker exec ferret-dogfood psql -U ferret -d ferret -At -c "
  select ev.subject_id, ev.locator::text from evidence ev
  where ev.subject_id in (select id from entity where kind='context')
    and ev.source_content_hash is not null;"

cd .local && node ask.mjs ferret_context_pack \
  '{"question":"is a durable statement verified when the anchored content hash matches","budget":4000}'
cd .local && node ask.mjs ferret_context_trust \
  '{"contextId":"68fc0c86-c94f-8588-ad71-cd680335c325"}'
```

`ask.mjs` and the dogfood database credentials live in gitignored `.local/`.
The store's `verification.reason` reads `index-does-not-correspond` throughout,
because the store was last indexed before the current `main`; that is EPIC-137
reporting correctly and does not affect any count above.
