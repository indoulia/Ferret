# EPIC-126 — Context Merger: architecture decisions

Recorded before implementation, per Governance §22.

**The design in one sentence:** evidence is keyed on *who observed it*, durable
context is keyed on *what is said*, and that change of key is the merge.

## What already existed

The study found the source mirror already answers most of the Epic's questions:
derived stable ids (`domain/identity.ts`), immutable attributed evidence,
authority (`domain/authority.ts`), confidence with *unassessed* distinct from
zero, per-field supersession and conflict detection (`storage/evidence.ts`),
entity lifecycle and tombstones, bitemporal relationships, permission scope,
scope inclusion/exclusion. Measured on the dogfood index on 2026-09-06:
10 391 current and 9 521 superseded evidence rows, 0 conflicting. None of it is
rebuilt here.

## The gap, measured

The same index held **one** engineering memory for 208 commits, 139 pull
requests and 49 issues. Ferret's own durable knowledge lives in `docs/`, in PR
bodies, and in 11 agent memory files outside the product. The decision *"do not
add a macOS CI runner"* is written in `EPIC-105`, `EPIC-105-VALIDATION`,
`EPIC-115-VALIDATION` and one agent memory file — four representations, none in
Ferret, none aware of the others.

The structural cause is `engineeringMemoryKey(sessionId, kind, statement)`:
identity contains the **author**, so two sessions recording one decision produce
two rows by construction.

## Model

Three tiers. This Epic owns the boundary between the second and third.

| Tier | What it is |
| --- | --- |
| source data | what a connector read; never stored as such |
| evidence | an attributed, immutable observation |
| durable context | the statement Ferret holds, independent of who said it |

A durable context record is an **entity** of the registered kind `context`
(`registerEntityKind`, exactly as `code_symbol` — EPIC-006 AC-4), so storage,
relationships, retrieval, scope filtering and the integrity sweep work
unchanged and **no table is added**.

```
source      { system: 'ferret', id: digest(kind, subjectId, normalized), scope }
attributes  { statement, contextKind, normalized, subjectId? }
lifecycle   active | superseded
```

The record carries **no belief-strength of its own** — no confidence, no
authority, no observedAt. Those are properties of observations, they already
live on evidence, and a second copy would be a second place to drift.

`engineering_memory` was not extended: it is session-scoped in its schema and
sits outside the entity/evidence/relationship/permission machinery. EPIC-129
promotes memories *into* durable context rather than becoming it.

## Identity, and why the merge is free

Two agents, two sessions, a month apart, writing the same statement derive the
same id. Merging is not an operation; it is a property of the identifier — the
EPIC-006 trick applied one tier up.

`normalize` is NFKC, case-folded, whitespace-collapsed, terminal punctuation
dropped. Nothing else: stemming or synonyms would make two *different*
statements collide, and a collision is a silent merge of two beliefs. It is
stored so the id is recomputable from the row.

**The first writer's wording is kept** (`upsert(…, { ifAbsent: true })`). Later
wordings are retained on the evidence; rewriting the canonical text on every
restatement would churn the content hash.

## Merge rules

| Verdict | Test | Action |
| --- | --- | --- |
| same | identical derived id | merge — one record, both observations |
| near | token-set Jaccard ≥ 0.8, same scope and kind | relate. **Never merged.** |
| distinct | otherwise | nothing |

*When uncertain, consolidate less.* A false "near" costs one edge; a false
"same" would cost a belief nothing downstream could notice.

Similarity is Jaccard over normalized tokens — deterministic, explainable, no
model. `NEAR_DUPLICATE_SIMILARITY` is a named constant, not a configuration key.

## Model assistance: nowhere

The merger calls no model. A model may be a *producer* upstream, emitting
`generated` evidence, which `AUTHORITY_BY_METHOD` already ranks at `ASSERTED`.
A model inside the merge would make Ferret decide what is true.

## Conflict

Two current records, same scope, same kind, same `subjectId`, near-duplicate but
different, get a `context_contradicts_context` edge and **both stay active**.
Ferret picks no winner — `preferredEvidence` already returns `undefined` rather
than an arbitrary pick. Resolution needs a producer to say `supersedes: <id>`.

Without a `subjectId` Ferret says nothing, which is honest rather than a guess.

## Lifecycle

Only `active` and `superseded`, plus `ENTITY_SUPERSEDES_ENTITY`. Superseding
never touches evidence. The fuller state machine — candidate, current,
superseded, historical, archived — is **EPIC-127** and is not built here.

## Retrieval

Reads default to `active`; superseded is returned only when asked for. Each
record carries its related ids so a consumer can collapse a cluster Ferret did
not merge. Migration `0016` adds `attributes->>'statement'` to the entity
`search_vector` — the amendment `0007`'s own comment invites.

Assembly is not merger: turning retrieved context into a task-ready package is
EPIC-131 and stays in `context/pack.ts`.

## Performance

- **same** — a hash and an upsert. No scan, no comparison against the corpus.
- **near** — one bounded ranked full-text query, same scope and kind, capped at
  `MAX_CANDIDATES` (25). Not O(n²); cost does not grow with the corpus.
- No background reconciliation pass is introduced.

## Security

No second authorization architecture.

- Every write emits evidence carrying `permissionScope`; reads go through
  `ScopedQuery`, unchanged.
- `source.scope` is the repository id, so `scopeContextFor` and
  `visibleEntities` filter durable context with no new code.
- `redactSecrets` runs **before** the id is derived — an identifier is the one
  field no later redaction can reach.
- Statement length is bounded, and an over-length statement is refused rather
  than truncated.

## Not decided here

- **Whether a statement deserves to be durable.** The merger bounds length,
  strips credentials and refuses to multiply records. Judging content value
  would be Ferret inventing judgement — EPIC-129 owns promotion.
- The full lifecycle state machine — EPIC-127.
- The agent-facing surface. No MCP tool or CLI command is added; that is
  EPIC-128, and building it now would make the first client's shape the
  architecture.

## Unresolved

- `NEAR_DUPLICATE_SIMILARITY = 0.8` is chosen, justified by the asymmetry above
  rather than measured over a corpus that does not yet exist. EPIC-129 produces
  one; it becomes measurable then.
- Cross-scope duplicates are deliberately not merged. If that proves wrong it is
  a product decision, not an implementation one.

## Found by building it

`candidates` first used `websearch_to_tsquery` directly, which builds a
conjunction. The near-duplicate a restatement most needs to find is the one
differing in exactly the word that matters — "the page limit is twenty" against
"…fifty" — and an AND query can never retrieve it. Caught by the contradiction
test, which failed on a pair scoring 0.82. Fixed by sharing `relaxedTsQuery`
with `storage/retrieval.ts` rather than writing a second copy of an expression
that has been wrong before (F-65).
