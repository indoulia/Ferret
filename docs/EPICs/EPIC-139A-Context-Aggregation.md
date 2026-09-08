# EPIC-139A — Context Aggregation

**Status:** IMPLEMENTED · **Priority:** P1 · **Domain:** Durable Context · **Classification:** CONTINUATION

Specification written 2026-09-08 and **not approved**. Decisions:
[EPIC-139A-DECISIONS](../Architecture/EPIC-139A-DECISIONS.md). Design
measurement: [signals](../evidence/FERRET-DO-THE-AGGREGATION-SIGNALS-EXIST.md)
(2.1 corrected) · [corpus readiness](../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md)
· [populated corpus](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md).

No production code exists. **§26 gates implementation on corpus readiness. The
corpus was populated on 2026-09-08 from genuine product-path observations and
re-measured: 1 gate passes unambiguously, and population exchanged one passing
gate for another rather than adding one** (§26.5). Sections 2, 7.2.1, 25, 26 and
27 were revised on 2026-09-08 by the corpus-readiness study, which corrected the
earlier claim that `subjectId` is structurally unreachable: it is formable in two
tool calls and simply unused. No product change is required to reach the gates.

**Implemented 2026-09-08 as a relation index, on the owner's approval of the
design-resolution pass.** Validation:
[EPIC-139A-VALIDATION](validation/EPIC-139A-VALIDATION.md). The measured defect
of §2 is closed: on the same question, the same store and the same budget, the
pack now says `statement 3 supersedes statement 4` and names the relationship
row, at **229 tokens and no extra round trip** against the **2 295 tokens and 4
round trips** it cost before — while `standing` stays byte-identical. G2 passes
on the populated corpus with all three claimed signals contributing under
leave-one-out; **G4's contradiction half and G5 do not pass, and nothing was
manufactured to make them** (validation §Gates). §25 is not run: with C5
withdrawn and C2 operator-dependent, two of five tasks are runnable, which §26.3
already calls insufficient.

**Design resolution, 2026-09-08 — the primitive changed.** With the corpus
question closed, the remaining blockers were design questions and they were
resolved: decisions 14–18 of
[EPIC-139A-DECISIONS](../Architecture/EPIC-139A-DECISIONS.md). **Connected
components over five relations is rejected. The primitive is a relation index —
named links and shared-key groups** (§7.5). `same-subject` becomes a group and
not a link; `restates` leaves the relation set as structurally unreachable on the
pack path; `contradicts` is read and not claimed; the anchor unit stays the file
and is never composed. §7.1–§7.2.1 and §8 are revised below; §10–§15, §21, §22
and §23 are **written against the rejected primitive and are marked pending**
(§7.6). Implementation remains unapproved, and one owner decision now blocks it
(§27).

## 1. Objective

When a pack hands an agent several durable statements, it reports what Ferret has
already recorded between them: which one replaced which, which two are rivals,
and which rest on one file or name one entity.

**Revised 2026-09-08.** The original read *"it says which of them are one belief"*.
That claim is withdrawn: three of the five relations proposed to support it assert
sameness and two assert only association, so a single answer to *"is this one
belief?"* cannot be built from them (§7.2.1). What is delivered is each recorded
relation, reported as what it is.

## 2. Problem, measured

Measured 2026-09-08 on the dogfood store through `ferret mcp`
([report](../evidence/FERRET-DO-THE-AGGREGATION-SIGNALS-EXIST.md) §3). One
question, budget 4 000:

```
question   "is a durable statement verified when the anchored content hash matches"
standing   4 entries · items 1 · estimated 3 622 of 4 000
```

| # | id | kind | state | bears on the question |
| --- | --- | --- | --- | --- |
| 1 | `47a0bfcd` | decision | active | **no** — it is about `ferret_search` routing |
| 2 | `4e215770` | fact | active | no — a dogfood artefact |
| 3 | `c894a630` | fact | active | yes |
| 4 | `68fc0c86` | fact | **superseded** | yes — and it is the one #3 replaced |

**Entries 3 and 4 are one belief in two versions, and the pack says so about
neither.** Entry 4's own text reads *"replaced by a later statement, which is the
answer instead"* — and does not name the statement, although it is entry 3 of the
same array. `StandingContext` (`src/context/standing.ts:49`) carries no
`supersededBy`, `supersedes` or `contradictedBy`; `ContextBelief` carries all
three, and `trust()` reads the edges the pack does not
(`src/storage/durable-context.ts:483`).

**Recovering the link costs more than a fifth of the pack.**
`ferret_context_trust` names it immediately — `"supersededBy":
"c894a630-…"` — so the fix an agent has today is one call per statement.
Measured across all four: 7 198 characters ≈ **2 295 tokens and 4 round trips,
63% of the pack's own 3 622**, to learn one edge the pack already held both
endpoints of.

This is the third appearance of one shape. EPIC-124: *"built twice and joined
neither time."* EPIC-130: *"the merger had already written five edges saying so;
retrieval never read them."* Here: the pack fetches the statements, fetches their
anchors to verify them, and reads none of the relations between them.

**And the signals are thin.** The same measurement counted every candidate
relation in the store:

| signal | rows | fires |
| --- | --- | --- |
| `ENTITY_SUPERSEDES_ENTITY` between two `context` | 1 | yes |
| shared anchor `(scope, path)` | 1 pair | yes — the same pair |
| `context_relates_to_context` | 0 | no |
| `context_contradicts_context` | 0 | no |
| `subjectId` equality / `CONTEXT_CONCERNS_ENTITY` | 0 statements carry a subject | no |

**Corrected 2026-09-08 by the corpus-readiness study**
([report](../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md) §3.2). An
earlier draft of this section called `subjectId` *structurally unreachable*,
because it demands a UUID while an agent holds a path. That was wrong. One
`ferret_find {kind:'file', attributes:{path}}` call converts a path into the
entity UUID — measured live — and `relationship.to_id`'s foreign key is
satisfied by it. `subjectId` is **formable in two tool calls and used zero
times**: a routing fact, not a structural one. EPIC-138 is the measurement of how
well routing-by-description works.

The consequence is sharper than the original claim, not weaker. Nothing in the
product blocks the missing signals; every one is formable today with no code
change (§26.2). What is missing is a **populated corpus**, and populating it is
dogfooding work rather than an Epic — EPIC-134 settled that *"self-dogfooding is
an acceptance discipline across the roadmap, not a separate product or agent
workflow"*.

**One signal is genuinely missing, and it is not `subjectId`.**
`candidates()` filters `e.attributes->>'contextKind' = context.contextKind`
(`src/storage/durable-context.ts:322`), so `context_relates_to_context` and
`context_contradicts_context` can **never** connect a `decision` to a
`constraint`.

**Reframed 2026-09-08 by the design-resolution pass.** This was recorded as the
one genuinely missing signal. It is not missing — it is *correct*: a `decision`
and the `constraint` behind it are not restatements of each other, whatever their
token overlap, so comparing across kinds would manufacture false edges. The
motivating example was never a relate case. It is carried by the two association
signals, and the population study measured it forming naturally through exactly
those (§7.2.1).

## 3. Value

An agent that is handed four statements and told nothing about how they relate
must either treat them as four independent claims — and act on a superseded one —
or spend a call per statement finding out. The measurement above prices the
second at 63% of the pack. Aggregation makes the relations arrive with the
statements they are about, at the cost of one query over ten ids.

**Not claimed:** that this reduces the agent's total work. EPIC-137 was correct,
safe, and produced no rediscovery saving; EPIC-138 was correct and moved
behaviour the wrong way. §25 measures this one, and §26 refuses to measure it on
a corpus that cannot exercise it.

## 4. Goal

**Revised 2026-09-08** (§7.5). `ContextPack` gains a **relation index** —
`links`, `anchors`, `subjects` and `absent`, whose ids all index into the existing
`standing` list, each entry naming the single record that carries it. Nothing in
`standing` changes. No new MCP tool, no new table, no new lifecycle state, no
model call — and no cluster.

## 5. Non-scope

Compaction and any token-level rewriting of what a cluster contains; generic
summarization; deciding which member is true; automatic supersession, merging,
archival or negation; new lifecycle states; a `context_cluster` entity kind, a
`cluster_id` column or a `context_in_cluster` relation; a new provenance
subsystem; any scheduler, watcher or background pass; agent orchestration; any
change to ranking (EPIC-056/057/130) or to `ferret_search`; connector expansion;
a graph database; any vendor-specific behaviour; any new MCP tool; changing
`ferret_context_record`'s input schema (§27.1); recomputing similarity at read
time; indexing source records rather than durable statements (§7.4); persisting
any part of the index; and — added 2026-09-08 — composing two association links
into a third (§7.5.2), and lowering `NEAR_DUPLICATE_SIMILARITY`.

## 6. Four stages, and which code owns each

The Epic's central requirement is that these do not collapse. Each already has
an owner except the second.

| stage | question | owner today |
| --- | --- | --- |
| **Retrieval** | Which records might be relevant? | EPIC-052/053 `RetrievalStore.search`, planned by `planner.ts`, ranked by `rank` (EPIC-056/057), restatements folded by `equivalenceKey` (EPIC-130) |
| **Aggregation** | What has Ferret already recorded between the relevant records? | **nothing — this Epic** |
| **Assembly** | What is delivered for this task, in what action-oriented structure? | EPIC-131 `ContextPackBuilder`, `standing.ts`, `orderStanding`, `budget.ts` |
| **Compaction** | How is that expressed in fewer tokens without losing epistemic information? | nothing — future work, out of scope |

The boundaries, stated as rules rather than as description:

- **Retrieval may not aggregate.** EPIC-130 already fixed this direction:
  `equivalenceKey` is *supplied* to ranking, never derived by it, because
  *"a ranking that re-derived which statements are the same would be a second
  opinion with no evidence behind it."* Aggregation is downstream of the fold,
  not a competitor to it.
- **Aggregation may not assemble.** It decides membership and nothing about
  delivery: not what fits the budget, not what is dropped, not the order of the
  flat list, not what the agent should do first. `standing` is byte-identical
  with aggregation on and off (AC-1).
- **Assembly may not aggregate.** `orderStanding` is reused for the order of
  statements within a group rather than reimplemented, and it is the one thing
  assembly lends aggregation. Assembly consumes the index; it does not compute
  it.
- **Neither may compact.** No member's statement is shortened, merged, reworded
  or dropped because a cluster-mate says something similar. A cluster of four
  restatements is four members with four statements; expressing it as one is
  compaction's decision and needs compaction's epistemic-preservation argument.

EPIC-126's merge sits before all four and is not one of them: it is a **write**
stage keyed on statement identity, and *"nothing is merged on similarity"*
(EPIC-126 invariant 4).

## 7. What a cluster is

### 7.1 Definition

**Revised 2026-09-08 by the design-resolution pass** (decision 17). The original
definition — *"a maximal set of durable statements … connected by at least one
relation Ferret has already recorded"* — is rejected, because it requires the
relations to be interchangeable and they measurably are not (§7.2.1). What
replaces it is smaller:

> A **relation index** is what Ferret has already recorded between the statements
> in this pack's `standing` list, reported as it was recorded: **links**, each
> naming one relationship row, and **groups**, each keyed on the one record its
> members share. Nothing in it is composed.

Three words carry the weight now. **As it was recorded** — an entry is an edge or
a shared key, never a derivation over several of them. **In this pack** — the
index is relative to the page retrieval returned, which is why it is derived and
not durable (§8.2). **Nothing is composed** — every entry names the single record
a reader can check it against (§7.5.2).

### 7.2 What the index reports

**Revised 2026-09-08** (decisions 14, 15, 16, 17). The five-relation membership
table is withdrawn. Three signals are **claimed**, one is **read and not
claimed**, and one is **not read at all** — and the distinction is the point,
because a list of five relations invites an implementation that tests all five
and measures none.

| signal | shape | recorded as | claimed |
| --- | --- | --- | --- |
| `supersedes` | link | `ENTITY_SUPERSEDES_ENTITY` between two `context` entities | **yes** |
| anchor group | group keyed on `(scope, path)` | `locator.start` on EPIC-137 anchor observations | **yes** |
| subject group | group keyed on an entity id | `subjectId` / `CONTEXT_CONCERNS_ENTITY` | **yes** |
| `contradicts` | link | `context_contradicts_context` | **read, not claimed** — has never formed (§7.2.2) |
| `restates` | — | `context_relates_to_context` | **not read** — unreachable on this path (§7.2.3) |

A **link** asserts sameness of subject matter: two statements occupy one slot. A
**group** asserts association: these statements rest on one file, or name one
entity. Those are different claims, they are reported differently, and neither is
converted into the other. Adding a signal, or promoting a read one to claimed, is
an amendment to this Epic.

### 7.2.1 The signals are not interchangeable — which is why there is no component

Measured by the corpus-readiness study
([report](../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md) §4.7) and by
the [population study](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md)
§4. Revised 2026-09-08: the original section treated non-interchangeability as a
limitation on what the Epic could deliver. It is a refutation of the primitive.

| signal | crosses `contextKind` | granularity | what it asserts | adoption measured |
| --- | --- | --- | --- | --- |
| `supersedes` | yes | one belief's versions | **sameness** | 1 edge per store, agent-authored |
| `contradicts` | no — same kind, and needs a shared `subjectId` | one subject | **sameness** (rivalry) | **0**, ever |
| `restates` | no — same kind | one statement | **sameness** | **0**; max observed pair 0.634 |
| subject group | yes | an entity | **association** | **0 of 10** agent calls; operator-only |
| anchor group | yes | **a file** — median 7 declared symbols, max 40 | **association** | variable; 0 and 5 of 5 across two sessions |

Two consequences, and the second is the architectural one.

**The motivating example was never a relate case.** A `decision` and the
`constraint` behind it are **not restatements of each other**, whatever their
token overlap, so `candidates()`'s same-kind filter
(`src/storage/durable-context.ts:322`) is *correct* rather than a defect. The
example is carried by the two association signals, and it was measured forming
naturally through exactly those: population study §4.1.

**Sameness and association cannot be unioned into one component.** A component
over the union answers *"are these one belief?"* using edges that only ever meant
*"these are related"*. And the composition behaves differently for each:
supersession chains stay one belief, `subjectId` equality is an equivalence
relation so composing it cannot leave the subject, and anchor-set intersection is
neither — X on {A,B}, Y on {B,C}, Z on {C,D} puts X and Z in one component
sharing **nothing**. §7.5 is what replaces it.

### 7.2.2 `contradicts` is read and not claimed

It is retained as a read for two reasons and claimed as a capability for none.

Retained because it is not folded — `#equivalenceOf` reads
`context_relates_to_context` only, so contradiction endpoints survive retrieval
and both can be members of a page — and because its absence is a **safety** loss
rather than a convenience one: without it Ferret presents two rivals as
independent claims, which is the mandatory-safety failure §25 says outranks every
saving.

Not claimed because it has never formed. `contradicts()`
(`src/context/durable.ts:125`) requires *same `subjectId`* and *same
`contextKind`* and *Jaccard at or above 0.8*, and the first conjunct has zero
natural adoption. **Its absence is reported in the index, not omitted** — that is
what keeps a dead signal from being quietly reclassified as unavailable.

The 0.8 threshold does not change and no formation semantics change.

### 7.2.3 `restates` is not read, because retrieval has already removed one endpoint

`RetrievalStore.#equivalenceOf` (`src/storage/retrieval.ts:1152`) already reads
`context_relates_to_context` between the retrieved ids, after the permission
filter, and runs union-find over the pool (`:1164`) — the identical mechanism
§8.1 and §17.1 propose. `foldEquivalents` (`src/retrieval/rank.ts:206`) then
elects one survivor per component and reports the rest in `subsumed`, which the
pack carries as `StandingContext.restates`. Both queries that populate `standing`
go through it, so **both endpoints of a relate edge are never both in
`standing`.**

So a `restates` relation here would be the same query, the same union-find and
the same signal a second time, over a page from which one endpoint has already
been removed. Governance §5 — *Reuse Before Reinvent* — settles it, and the corpus
evidence (0 edges over two stores; the highest pair in either is **0.634**, an
agent restating **its own** statement; 0.583 in the dogfood store) says the edge
would rarely exist to read.

*Reported and not fixed, and it belongs to EPIC-130:* `#standingFor`
(`src/context/pack.ts:476`) unions two searches that fold **independently**, so
two pools could elect two different survivors of one equivalence component and
place both in `standing` — the pack showing one belief twice. Not a capability to
build on.

### 7.3 What is deliberately not a signal

**Semantic similarity, computed at read time.** Not because similarity is
irrelevant but because Ferret already computes it — at **write** time, once,
with the outcome recorded as an inspectable `context_relates_to_context` edge
that `ferret verify` checks. Aggregation reads the edge. The measured limit is
stated rather than hidden: the corpus's one genuine disagreement scores **0.583**
against `NEAR_DUPLICATE_SIMILARITY = 0.8` — computed with the product's own
`normalizeStatement`/`statementTokens`/`similarity` — and joins no cluster,
because neither statement names its subject. That is a capture gap (§27.1), and
a read-time model asked to close it would be inferring a subject from prose,
which EPIC-137 decision 7 already refused for anchors.

**`scope` alone.** Every statement recorded against a repository shares its
scope. Scope as a membership relation makes one cluster of the store — the
unbounded traversal this Epic exists to prevent, arriving by another door.

**`contextKind`.** Kind decides **position inside** a cluster, never membership.
The Epic's motivating example — a decision, the constraint behind it, its
evidence, the current state, related gotchas, and what it superseded — is one
cluster because those records share a subject or an anchor; their kinds say where
each sits within it. Clustering *by* kind yields a bag of constraints and a bag
of decisions, which is the opposite of the capability.

**A symbol — confirmed 2026-09-08 against 27.2, and now for a second reason.**
`locator.detail` narrows a re-read; it does not separate two statements on one
path. EPIC-137 §7: *"a symbol locator names the area, never the key."* The
design-resolution pass adds the mechanical reason: `locatorFor`
(`src/storage/durable-context.ts:743`) stores `detail` as producer free text that
**concatenates the symbol with a line range** and passes it through
`redactSecrets`, so keying on it means parsing a producer's sentence back into a
symbol — the inference EPIC-137 decision 7 forbids — and would separate two
statements that name one symbol but differ in line range. `locator.start` is the
only anchor component resolved against the index, so it is the only one that can
key a group. The symbol is **displayed** per statement inside the anchor group,
which is what "narrows a re-read" means (§7.5.3).

**Recency.** EPIC-057 §8.2 refused a decay curve because age is not evidence.
Two statements written in one session are not thereby one belief.

### 7.4 Source records are not members

A Jira issue, a GitHub pull request, a Confluence page and a commit are **not**
cluster members. They are `items`, and they reach a cluster in two ways that
already exist:

- as **provenance** — a member's `preferredEvidenceId` names an observation
  whose `sourceSystem`, `sourceId` and `sourceUrl` name the source record;
- as **what the index is keyed on** — a subject group names the entity id a
  producer supplied; an anchor group names `(scope, path)`.

**Corrected 2026-09-08.** An earlier draft had `cluster.concerns` list *"the
subject and anchor entity ids"*. An anchor's entity id is **not on the read
path**: `locatorFor` (`src/storage/durable-context.ts:743`) persists
`{kind:'path', start, detail}`, and `ResolvedAnchor.fileId` is computed at write
time and never stored. Resolving it would cost a per-path lookup that AC-23's
*exactly one store read* forbids. So an anchor group is keyed on the path, and
only a subject group is keyed on an entity id — because a producer supplied it.

**Why.** A source record is not a claim about the situation; it is what a claim
rests on, and EPIC-131 already draws that line between `standing` and `items`.
Making an issue a cluster member would put a raw indexed record beside a curated
statement and blur what Ferret *holds* with what Ferret *indexed* — and would
mean a cluster's members no longer all have a lifecycle, an authority and a
verification verdict, which §10 depends on.

### 7.5 The primitive — a relation index

**Added 2026-09-08** (decision 17). This replaces connected components.

```
links    [{ from, to, relation: 'supersedes' | 'contradicts', via: <relationship id> }]
anchors  [{ scope, path, statements: [ids], details: [per-statement locator detail] }]
subjects [{ subject: <entity id>, statements: [ids] }]
absent   [ 'contradicts' ]           // read, none present on this page
```

`standing` is untouched; every id indexes into it; no statement text is
duplicated. `PACK_FORMAT_VERSION` still goes 2 to 3, per Governance §21.

#### 7.5.1 Why this and not components

Three measured reasons, and the third is decisive.

**The signals are not interchangeable** (§7.2.1). A component over sameness and
association together answers a question its edges do not carry.

**Composition is the failure mode, and it is arithmetic rather than speculative.**
A statement may carry `MAX_ANCHORS = 20` anchors
(`src/context/code-state.ts:24`), so anchor overlap is set *intersection* and its
transitive closure leaves the shared record behind. Measured on the populated
corpus: 12 distinct anchored paths over 8 statements, **9 of them carrying exactly
one statement**, one member carrying **6** anchors that reach `src/retrieval/`,
`src/git/`, `src/authorization/` and `src/security/`, and **zero singletons** in
an 8-record corpus. Each of those 9 paths is one future statement away from
bridging a cluster about glob syntax to one about retrieval permissions.

*Stated honestly:* the population study measured that **structure**, not a
transitive bridge actually firing. The 4-member group it found is a *clique* on
one path, and every pair in it is a true direct bridge. The risk is proven as
arithmetic and as latent structure; it is not yet proven as a field failure.

**And the component has no measured case where it differs from the index except
the cases where it is wrong.** Both corpora hold exactly **one** sameness edge —
one supersession, zero contradicts, zero restates — so a component over sameness
edges is a pair, which is a link. Every multi-member structure either corpus
produced came from association, and in the one that formed naturally the
component's claim is the false one: cluster 1's four `exclusions.ts` statements
are two facts and two gotchas resting on one file. *"These four rest on
`src/config/exclusions.ts`"* is exactly true. *"These four are one belief"* is
not. The index says the first.

**What the index keeps.** The whole of the defect §2 measured. *"Entries 3 and 4
are one belief in two versions, and the pack says so about neither"* is answered
by one link, and the **2 295 tokens and 4 round trips** that recovering it costs
today are the saving. Nothing in that measurement needed a component.

#### 7.5.2 What a safe bridge is, and how composition is constrained

> A **safe aggregation bridge** is a link Ferret can name in full — the statement
> ids, the relation, and the *single record* that carries it — such that a reader
> can check the link against that record without Ferret having composed anything.
> A composed link is unsafe because there is no record to name.

**Association is never composed.** Anchor and subject groups are keyed on the
shared record, so there is nothing to compose: the group *is* the shared record.
A hub path with twelve statements on the page yields one group naming twelve
statements — self-evidently a hub, and no claim that the first and the twelfth are
one situation.

**Composition is permitted only along `ENTITY_SUPERSEDES_ENTITY`**, where it
preserves the relation's own meaning — a version chain is still one belief — and
where **each hop is reported as its own link**. A chain A to B to C arrives as two
links, not as an assertion about A and C.

This is also what settles 27.2: symbol granularity was proposed as the mitigation
for the hub risk, and it is the wrong lever. Grouping plus refusing composition
mitigates breadth at its root; symbol keying leaves a hub a hub whenever two
statements name one symbol, and silently splits when they spell the area
differently (§7.3).

#### 7.5.3 Shape and ordering

Ordering is total without an argument: `links` by `(relation, from, to)`,
`anchors` by `(scope, path)`, `subjects` by `subject`, `statements` within a group
by `orderStanding`'s existing order over `standing`. Two builds of one pack
against a fixed store are identical (AC-25 unchanged in intent).

`details` carries each member's `locator.detail` verbatim, contained exactly as
`locator.detail` already is — so a reader can see that two statements on
`pack.ts` name different symbols, without a symbol having keyed anything.

**Cost is lower than the component's, not merely equal.** One query, extending
`#equivalenceOf`'s existing shape rather than adding a second copy of it; no
union-find; no 45 pairwise comparisons; path grouping is a map over at most
10 times `MAX_ANCHORS` anchors already read in step 4.

### 7.6 Sections written against the rejected primitive

**Pending, 2026-09-08.** These are unrevised and describe cluster machinery that
decision 17 removes. They are **not** deleted, because the owner has not yet
accepted the primitive change (§27.0) and the reasoning is part of the record.

| section | status under the relation index |
| --- | --- |
| §8.1, §8.2 | superseded — no aggregation key, no `clusterId` (see §8 note) |
| §10 Conflicts | mostly unnecessary: a `contradicts` link **is** the `contested` flag, at the pair granularity where the condition holds. The refusals stand |
| §11 Lifecycle bands | unnecessary — `standing` already carries `state` and `current`; bands only ordered within a cluster. "Mutates nothing" stands |
| §12 Authority triples | unnecessary and measurably vacuous — durable-context authority is the constant `asserted`/`ferret`/`20` (§26.2). Authority stays on `standing` |
| §14 verdict counts | unnecessary — EPIC-137 verdicts are already per member |
| §15.2 inter-cluster ordering | withdrawn — five keys for a structure no longer built; §7.5.3 replaces it |
| §21 worked example | to be re-expressed as links and groups; its conclusions are unchanged |
| §22 shape | `ContextCluster`/`ClusterMembership` withdrawn; §7.5's shape replaces them |
| §23 AC-2 to AC-12, AC-16 to AC-18, AC-25 to AC-28 | to be restated over links and groups. AC-1, AC-13 to AC-15, AC-19 to AC-24, AC-29 to AC-31 hold as written |

§13's rule survives intact and is the one the index makes trivial: *"a membership
with no justification is a bug, not a weak signal."* Under the index there is no
unjustified entry to write — an entry **is** its justification.

## 8. The aggregation key

> **Superseded 2026-09-08 by §7.5** (decision 17). There is no aggregation key
> and no `clusterId`: the index reports recorded edges and shared keys, so
> §8.1's "keyed on a relation, not a value" is right about the value and wrong
> about the connectivity, and §8.2 identifies a structure that is no longer
> built. Kept for the argument in §8.1 against a new identity scheme, which
> stands.

### 8.1 There is no single key, and no new identity scheme

Aggregation is keyed on a **relation**, not on a value. The alternative — one
derived key per statement, clustered by equality — was considered and refused: it
would require choosing a canonical subject for every statement, which is
precisely the field the corpus does not carry (§2), and inventing one would be a
new identity scheme competing with `durableContextSourceId`. EPIC-137 §7 already
settled the shape of that mistake: *"An anchor must not enter statement identity
— it would fork one finding per commit and break EPIC-126 merge and EPIC-130
convergence."*

So the five relations of §7.2 are read between the ids on the page, and
connectivity does the rest. Union-find over at most `MAX_STANDING_CONTEXT`
members; no key, no scheme, no stored identity.

### 8.2 The cluster's own identity is derived

```
clusterId = contentHash(sorted member ids)
```

Deterministic for a fixed page, and correct that adding a member yields a
different id — it is a different cluster. Nothing persists it and nothing
references it across builds, for the reason EPIC-137 gave against persisting
staleness: a derived fact that depends on the caller and the page is wrong for
any second caller.

## 9. From a task to an ordered pack

The pipeline, with the boundary between existing and new marked. Steps 1–4 and
7–8 are today's `ContextPackBuilder`, unchanged.

```
1  task sentence            "Should we add a macOS runner for storage tests?"
2  retrieval                #recordsFor  — planned, ranked, EPIC-130 fold applied
3  standing read            #standingFor — one widened durable-context query,
                            unioned with durable-context hits from step 2
4  per-statement reads      #supportFor (scoped evidence) · #verifyFor (EPIC-137)
   ────────────────────────────────────────────────────────────────────────────
5  RELATION INDEX (new)     recorded edges read between the ids from step 3, over
                            visible members only; anchors and subjects grouped by
                            the key they share; nothing composed  (§7.5)
6  index shaping (new)      total ordering per §7.5.3; absent claimed signals
                            reported; charged to estimatedTokens
   ────────────────────────────────────────────────────────────────────────────
7  assembly                 standingContextOf · orderStanding · budget.admit
8  delivery                 pack fields, notice, containment, omissions
```

Two properties of that placement matter. Aggregation runs **after** step 4, so
every anchor it needs has already been read for verification and it adds no
per-statement reads. And it runs **before** step 7 without feeding it: step 7 is
unchanged code operating on unchanged input, which is what AC-1 asserts.

The index's own ordering is §7.5.3's; `standing`'s order comes from
`orderStanding` exactly as today. (Revised 2026-09-08 — §15.2 is withdrawn.)

## 10. Conflicts

> **Pending §7.6.** A `contradicts` link *is* the `contested` flag, at the pair granularity where the condition holds; the refusals below stand unchanged.

**The rule that makes this enforceable rather than aspirational:** a cluster
carries no epistemic field of its own. Every cluster field is a **set** or a
**count** of its members' fields. There is no field into which a winner could be
written.

| the cluster contains | what happens |
| --- | --- |
| two conflicting **active** statements | both are members; `contested: true`; both in the `current` band; no member marked primary; each keeps its own `undecided` |
| a **superseded** decision | member with `state: 'superseded'`, in the `history` band, and the membership records `superseded-by` naming the replacement — which is the fact §2 measured as missing |
| **stale** anchored evidence | the member's EPIC-137 verdict stays `stale`; the cluster's `verification` counts report one `stale`; no cluster verdict |
| **unknown** verification | stays `unknown`, counted as `unknown`, never promoted |
| **unanchored** legacy context | stays `unanchored`; joins a cluster only through `superseded-by`, `contradicts`, `restates` or `same-subject`, since it has no anchor to overlap |
| **different authorities** for different facts | per member, never aggregated; the cluster lists the distinct `(sourceSystem, method, authority)` triples present (§12) |

`contested` names a condition and resolves nothing. It is `true` when the cluster
holds a `contradicts` membership, or two or more `active` members whose
`preferredEvidence` reports `undecided`. It is a flag on the cluster because that
is where a reader looks before acting; it is not a ranking of members.

**Explicitly refused:** a cluster `confidence`; a `primary` or `answer` member; a
cluster `verification` verdict; collapsing the four EPIC-137 verdicts into a
score (EPIC-137 §10 forbids it outright); dropping a superseded member because
its replacement is present (that is what makes the replacement checkable).

## 11. Lifecycle

> **Pending §7.6.** "Mutates nothing" stands. The three bands are unnecessary under §7.5 — `standing` already carries `state` and `current`.

Aggregation is **read-side** and mutates nothing. No lifecycle state is added,
changed or inferred; no edge is asserted; no evidence is recorded; `markStale`
gains no caller. The stage takes no handle that can write (AC-13).

Three bands, derived entirely from what EPIC-127 already exports — no new
categorization:

| band | membership test | why separate |
| --- | --- | --- |
| `current` | `lifecycle === LifecycleState.ACTIVE` | what Ferret holds |
| `proposed` | `lifecycle === LifecycleState.CANDIDATE` | stated in full, unaccepted — EPIC-127 put it at standing 10, deliberately outside the historical category |
| `history` | `HISTORICAL_LIFECYCLE_STATES` — `superseded`, `archived`, `deleted` | EPIC-127: historical is the *category*, and refused a sixth state meaning the same |

A cluster may be entirely `history`. That is a real answer — the belief that bore
on this question has been retired and nothing replaced it in scope — and it must
not be dropped, because the alternative is silence where Ferret holds something.

`current` precedes `proposed` precedes `history` within every cluster, which
keeps EPIC-131 AC-3 (*"current precedes historical, whatever the kind"*) true at
cluster granularity as well as at pack granularity.

## 12. Authority

> **Pending §7.6.** Authority stays on `standing`. The per-cluster triples are withdrawn: §26.2 measured durable-context authority to be the constant `asserted`/`ferret`/`20`, so they were vacuous on any corpus that exists.

Authority is question-dependent, and aggregation's job is to **preserve** that
rather than resolve it.

**It is already question-shaped.** `AUTHORITY_BY_METHOD` ranks *how* evidence was
obtained, not *who* supplied it, and `systemOfRecord` is promotable only for
`OBSERVED` and `PARSED` — *"A provider may say 'I own this fact' about something
it read; it may not promote a guess, an inference or a model's output to
authoritative by declaring itself important."* So a Jira connector reading an
issue's status is `SYSTEM_OF_RECORD: 100` for that; the same connector's claim
about architecture is `DERIVED: 40`. GitHub is authoritative for code state
because it *observed* it, not because it is GitHub.

**What aggregation does.** Each cluster reports the distinct
`(sourceSystem, method, authority)` triples its members' preferred evidence
carries, so a reader can see that the constraint came from a parsed workflow file
and the decision from an assertion. Within a cluster, `effectiveAuthority` is
used **only** as a tiebreak inside one kind band — exactly as `orderStanding`
already uses it — never as a cross-member verdict.

**What aggregation does not do.** It does not decide which source is
authoritative *for this question*. Doing so requires knowing the question's fact
type, and a task sentence does not deterministically yield one; inferring it
would be manufacturing certainty, which Governance §6 forbids. Governance §7
requires authority rules to be *configurable* where systems compete — which is a
configuration capability this Epic does not build and must not pre-empt with a
hardcoded per-question ranking.

`isUnknownAuthority` is honoured: an unassessed authority is reported as
unassessed, never as the weakest, because *"ranking an unassessed source below a
known-weak one is a claim and Governance §6 forbids manufacturing it."*

## 13. Provenance

Two questions must be answerable about everything in a cluster, and both are.

**"Where did this statement come from?"** Unchanged. Each member is an id into
`standing`, whose entry already carries `supportCount`, `authority` and — through
`ferret_why` and `ferret_context_trust` — the observations behind it. Aggregation
adds nothing here and removes nothing.

**"Why is this in this cluster?"** New, and mandatory. Every membership carries
the relation that justifies it and the record that carries the relation:

```
{ id, because: ['superseded-by'], via: ['<relationship id>'] }
{ id, because: ['shared-anchor'], via: ['src/context/code-state.ts'] }
{ id, because: ['restates','shared-anchor'], via: ['<rel id>', '<path>'] }
```

`because` is never empty except for the seed member, which carries `['seed']`.
A membership with no justification is a bug, not a weak signal, and AC-8 asserts
it. This is Governance §18 applied to a derived structure: *"Ferret should be able
to explain why evidence was included, excluded, considered authoritative,
considered stale, or considered conflicting"* — a cluster adds a sixth thing to
explain, *why these were considered one belief*, and it must be explained the
same way.

**Provenance is not shortened to make a cluster smaller.** If `via` does not fit
the budget, the whole cluster index is dropped and reported (§17.3) — a cluster
whose memberships cannot be justified is worse than no cluster, because an
unjustified grouping reads as an assertion Ferret made.

## 14. Verification

> **Pending §7.6.** Every rule here holds per member. The per-cluster verdict counts are withdrawn — the verdicts are already on `standing`.

EPIC-137 semantics are used exactly as they exist and are not extended.

- `verified`, `stale`, `superseded`, `unknown`, `unanchored` stay **per member**,
  on `StandingContext.verification`, unchanged in value and wording.
- The cluster reports **counts** per verdict. A count is not a verdict.
- No cluster verdict, no confidence score, no promotion. Aggregation cannot make
  anything `verified` — it performs no comparison, reads no hash and calls no
  code-state reader. It receives the verdicts step 4 already computed.
- Lifecycle precedes verification, as EPIC-137 §8 requires: a `superseded` member
  reads `superseded` whatever its anchors say, and clustering does not change
  that.
- `verification` absent (no code-state reader wired) stays absent, and is not
  reported as `unanchored` — *"one says Ferret cannot answer, the other that
  nothing was claimed."*

## 15. Ordering

### 15.1 Intra-cluster — reuse, do not reimplement

Band (`current` → `proposed` → `history`), then `orderStanding` applied to the
members within each band. `orderStanding` already sorts by kind cost, then
`effectiveAuthority`, then support count, then id — and it is the accepted
ordering. Reimplementing it would be *"two orderings deriving the same rank
separately"*, which `src/domain/authority.ts` calls one definition too many.

So the candidate ordering the Epic proposed — decision, constraints, state,
evidence, gotchas, next facts, history — is **rejected in that form** on two
counts. Its first two entries are inverted relative to the accepted
`KIND_ORDER`: EPIC-131 puts `constraint` before `decision` because *"breaking a
constraint is worse than contradicting a decision"*, and that argument has not
changed. And "state" and "evidence" are not kinds — implementation state is a
`fact`, and evidence is not a cluster member at all (§7.4). The accepted order
stands: `constraint → decision → gotcha → preference → fact → next-step`, with
current before proposed before history.

### 15.2 Inter-cluster — new, and total

> **Withdrawn §7.6.** Five ordering keys for a structure no longer built. §7.5.3 replaces it with a total order needing no argument.

| key | direction | why |
| --- | --- | --- |
| 1 | highest-cost kind present among members, by `KIND_ORDER` | keeps EPIC-131's cost logic at cluster granularity: a cluster containing a constraint precedes one that does not |
| 2 | `contested` first | within one cost band, an unresolved contradiction is the likeliest way to be wrong |
| 3 | greatest `effectiveAuthority` among members, descending | the same tiebreak `orderStanding` uses |
| 4 | member count, descending | a cluster the graph says more about is more likely the situation |
| 5 | lexicographically smallest member id | totality — ids are unique, so no tie survives |

Total, therefore reproducible: two builds of one pack against a fixed store
produce identical `clusters` (AC-25). Relevance is **not** a key, for EPIC-131's
reason: retrieval already decided what belongs to the question, and re-ranking by
score would put a well-worded fact above a constraint.

### 15.3 `standing` is untouched

`standing` keeps its shape, its contents and `orderStanding`'s order. Clusters
are an index alongside it. This is what keeps EPIC-131 AC-2 and AC-3 literally
true at pack level, and it makes regression a single assertion rather than a
suite (AC-1).

## 16. Scope and security

**Clusters form after the permission filter**, over visible members only —
EPIC-130's rule, and EPIC-058's requirement.

**An inaccessible record cannot be a bridge.** If A relates to B, B relates to C,
and B is withheld, A and C are **not** joined. Joining them would disclose that a
bridge exists — an existence fact about a record the caller was refused. This is
the sharp case the Epic asks about, and the answer is that the influence is
dropped, not routed around: transitive closure runs only over members the caller
can see.

**No new withheld channel.** The pack's existing `withheld` report carries
permission losses at pack level and category granularity. There is no
per-cluster "one member hidden" count, because that reintroduces the disclosure
at finer resolution. EPIC-136 §9 — *"Nothing may reduce what a caller is told
about what was withheld"* — is satisfied by leaving that channel exactly as it
is, not by adding a second one.

**Nothing new reaches a model unquoted.** Cluster fields are ids, enumerated
relation names, counts and booleans. The one field carrying repository-derived
text is `via` when the relation is `shared-anchor`, where it is a path; paths
already travel through `locator.detail` under `redactStatement` and through the
existing `containUntrusted` contract, and a `shared-anchor` `via` uses the same
containment. No statement text is duplicated into a cluster, so `contentSafety`
counts do not change (AC-21).

**Scope isolation.** `shared-anchor` requires the same `scope`. Two repositories
with a file at the same path do not cluster — EPIC-137 §5 already put cross-repo
anchors out of scope, and this is that rule read from the other side.

## 17. Performance

> **Revised 2026-09-08.** The bounds below hold and are now loose: §7.5 removes
> the union-find and the 45 pairwise comparisons, leaving one query and a map over
> at most 10 × `MAX_ANCHORS` anchors already read in step 4. §17.2's worst case is
> unchanged in cost and no longer produces a ten-member component.

### 17.1 Bounded by construction, not by a limit

Aggregation operates on the page assembly already holds: at most
`MAX_STANDING_CONTEXT = 10` members. No new limit is introduced because none is
needed — the bound is the existing cap.

| cost | bound |
| --- | --- |
| additional store reads | **one** query: relations of three types where both endpoints are in the ≤10 ids |
| anchor reads | **zero** — already read in step 4 for verification |
| pairwise anchor comparisons | ≤ 45 (10 × 9 / 2), in memory |
| union-find operations | ≤ 9 unions |
| traversal depth | bounded by member count; no depth parameter, no traversal API, `MAX_TRAVERSAL_DEPTH` not consulted |
| output size | ≤ 10 memberships total across all clusters |

Nothing is proportional to the size of the store. This is EPIC-130's pattern
verbatim: *"The edges are read between the ids already retrieved — one query over
the page, never over the corpus — so the cost does not grow with what Ferret
holds. Transitive closure is therefore also bounded by the page."*

### 17.2 Worst case

All ten members in one cluster, via a relate-chain: one cluster, ten
memberships, 45 comparisons, one query. The degenerate opposite — ten singleton
clusters — costs the same query and no unions. There is no input for which
aggregation reads more than one extra query or compares more than 45 pairs.

`ferret_context_find` returns up to `MAX_CONTEXT_PAGE = 200`. If clustering is
extended to that surface (§18), the bound becomes 200 members and 19 900
comparisons, which is why §18 scopes it to the pack first and names the find
surface as a follow-on rather than assuming it.

### 17.3 Budget

The cluster index is charged to `estimatedTokens`, as EPIC-137 AC-19 required for
verification and as EPIC-136 §2.1 requires of everything in the envelope.

**If it does not fit, it is dropped whole** and reported in `omitted` under
`TruncationReason.TOKEN_BUDGET`. A partial index is refused deliberately: a
missing membership is indistinguishable from an absent relation, so half an index
is a set of silent false negatives. That is the direction `budget.ts` already
forbids — *"the thing that gets cut is not the thing Ferret would have chosen to
cut."*

## 18. MCP surface

**No new tool.** The capability's content is *which of the records you were just
handed are one belief*, which is only answerable relative to a page. The surfaces
that produce such a page exist. A separate tool would take a question, re-run
retrieval, and re-derive the page — a second retrieval path with its own drift,
answering a question about a page the caller already has.

The cost is not neutral. EPIC-136 §4a measured thirty tool definitions at
~8 000 tokens **per turn**, established that the surface cannot be reduced
without breaking four accepted refusal contracts (EPIC-066 AC-6, EPIC-067 AC-12,
EPIC-068 AC-5/AC-6, EPIC-117 AC-5), and recorded that the owner declined all
three reduction mechanisms. A thirty-first tool is a permanent per-turn tax paid
to expose a stage the pack already runs.

**Where it surfaces:** `ferret_context_pack` gains `clusters` in its response,
additive. `PACK_FORMAT_VERSION` 2 → 3, per Governance §21. `renderPack` gains a
line per link and per group in the standing section — *statement 3 supersedes
statement 4*; *statements 1, 2 and 5 rest on `src/config/exclusions.ts`* — after
the notice and before the records, keeping EPIC-131 AC-7's arrangement. (Revised
2026-09-08: the earlier wording, *"these N statements are one belief"*, is exactly
the claim §7.2.1 withdraws.)

**`ferret_context_find` is a follow-on, not part of this Epic.** Its page is 200
rather than 10 (§17.2), and it is a listing surface rather than a task surface.
Deferred explicitly rather than silently.

**Refusal contracts unchanged.** No tool is added, removed or unpublished, so
EPIC-136 §4a stands and AC-17's four criteria are unaffected — asserted rather
than assumed.

## 19. Agent independence

Nothing here names a client, a vendor, a model or a workflow. Aggregation is a
pure function in `src/context/`, behind the same port discipline
`durable-port.ts` describes — *"an MCP server, a CLI command and a future HTTP
surface would all be adapters over the same port, and none of them owns the
model."* `boundaries.test.ts` keeps proving the core reaches no `storage/`
module, and it must keep passing.

The output is ids, enumerated relation names, counts and booleans. Any consuming
agent can read it; none is required to. There is no instruction to an agent, no
suggested next action and no prompt — EPIC-138 measured what a sentence of
guidance to an agent achieves, and this Epic does not repeat it.

## 20. Determinism

Deterministic, with no model in the loop. The stage is a pure function of the
page, the relations between its members, and the anchors already read.

**No LLM is proposed.** The bar one would have to clear is recorded here so a
later proposal must meet it rather than restate the attraction:

1. name the deterministic mechanism that cannot do the job, measured;
2. state exactly what the model receives, and that it is contained;
3. state how a fabricated membership is prevented;
4. state how a model-derived membership records provenance — it would be
   `EvidenceMethod.GENERATED`, authority `ASSERTED: 20` by
   `AUTHORITY_BY_METHOD`, the lowest assessed rank, which is itself the argument
   against;
5. state how the output is validated against the records;
6. bound the cost per pack;
7. state how two builds of one pack agree.

The measured gap of §7.3 does **not** meet that bar. A pair of statements that
share a subject neither of them names is a capture gap; a model inferring the
subject from prose is the failure mode EPIC-137 decision 7 named, not the fix.

## 21. Worked example — the macOS runner question

> **Pending §7.6.** To be re-expressed as links and groups. Its conclusions do not change: S1 still stays out, E1–E3 are still never members, S4 is still visible as history.

Conceptual, as the Epic requires. It assumes a store carrying the eight records
below; **the dogfood store today carries none of the cross-source ones**, because
it holds repository-connector output only (measurement §1), which is why §26
gates the experiment on a synced store.

Question: *"Should we add a macOS runner for storage tests?"*

Assumed records — five durable statements and three source records:

| ref | what | kind / lifecycle | anchor / subject |
| --- | --- | --- | --- |
| S1 | "macOS packaging validation runs on every release" | `fact`, active, **unanchored** | packaging scripts; no anchor recorded |
| S2 | "Do not add a macOS runner" | `decision`, active | `.github/workflows/ci.yml` |
| S3 | "The storage suites need a Linux container; a macOS runner cannot run one" | `constraint`, active | `.github/workflows/ci.yml` |
| S4 | "macOS runners are part of the release gate" | `fact`, **superseded** by S2 | `.github/workflows/ci.yml` |
| S5 | "The macOS packaging gate takes 3m47s" | `fact`, active | packaging workflow |
| E1 | GitHub workflow-run record | source record | — |
| E2 | Jira issue, status *Won't Do* | source record | — |
| E3 | Confluence note on CI architecture | source record | — |

### 1. What retrieval returns

The widened durable-context read plus the ranked record search: S1–S5 in
`standing`, E1–E3 among `items`. Ordered by `orderStanding`: S3 (`constraint`),
S2 (`decision`), then the `fact`s S1, S5, S4 — S4 last, because current precedes
historical. Nothing says any of them are related. This is the state §2 measured.

### 2. What aggregation considers one cluster

**Cluster A — {S2, S3, S4}.**

```
S3  seed
S2  because ['shared-anchor']  via ['.github/workflows/ci.yml']
S4  because ['superseded-by','shared-anchor']  via ['<rel id>', '.github/workflows/ci.yml']
```

`current`: S3 (constraint), S2 (decision) — `KIND_ORDER`. `history`: S4.
`contested: false`. `kinds: [constraint, decision, fact]`.
`concerns: ['<entity id of .github/workflows/ci.yml>']`.
`verification`: whatever step 4 computed, per member, counted.
`authorities`: the distinct triples — the parsed workflow observation and the
asserted decision appear as different triples and are not collapsed.

**Cluster B — {S1, S5}**, joined by a shared packaging anchor. About macOS
*packaging*, which is a different situation from macOS *test runners*.

### 3. What aggregation excludes

**S1 does not join Cluster A.** It has no anchor overlap with the CI workflow,
no subject in common, and no recorded relation to S2, S3 or S4. It is about
packaging validation, and it is exactly the record that a similarity-based
grouping would pull in — it shares the token *macOS* with every member of Cluster
A. Deterministic signals keep it out; that is the point of §7.3.

**E1, E2 and E3 are never members** (§7.4). E1 appears as the provenance of S3's
observation; E2 and E3 stay `items`; E2's id may appear in
`Cluster A.concerns` if a statement names it as a subject.

### 4. What stays visible as contradiction and history

S4 stays a member, in the `history` band, with `state: 'superseded'`, verdict
`superseded`, and a membership that names S2 as the replacement — the fact §2
measured as absent today. It is not dropped: keeping it is what lets a reader see
that the *"macOS runners are part of the release gate"* belief was retired and
what retired it, rather than encountering it again next session.

If S1 and S3 had both named the same subject and disagreed, `contested: true`
would appear on the cluster, both would sit in `current`, and no member would be
marked primary.

### 5. What assembly would eventually consume

Assembly's decisions, not aggregation's, and out of scope here: Cluster A leads
because it holds a `constraint`; the budget could be spent cluster-first so that
a cluster arrives whole rather than half; and a singleton cluster with no
relation to the anchors the question touches is a *relevance-independent* reason
to drop the unrelated entry that ranked first in §2. Each is a change to
EPIC-131 and none is proposed here.

### 6. What compaction would eventually do

Also out of scope. Express four restatements as one statement plus *"3
restatements folded"*; express the pair as *"S2, replacing S4"* rather than two
statements and an edge; state the shared anchor path once per cluster rather than
once per membership. All token-level, all required to preserve the epistemic
content — the verdicts, the lifecycle bands, the contested flag and the
provenance — and all needing their own argument that they do.

## 22. Data and model

> **Pending §7.6.** `ContextCluster`, `ClusterMembership` and `MembershipRelation` are withdrawn; §7.5 carries the shape. The location table is otherwise accurate, and `src/context/aggregate.ts` still owns a pure function.

No new entity kind, relationship type, lifecycle state, table, migration, index
or MCP tool. Every change is additive and read-side.

| location | change |
| --- | --- |
| `src/context/aggregate.ts` (new) | `ContextCluster`, `ClusterMembership`, `MembershipRelation`, `aggregate()` — pure; takes members, relations and anchors, returns clusters |
| `src/context/durable-port.ts` | a relation-read shape on the port: relations of the three context types **between** a given id set. Nothing storage-specific, per the port's own rule |
| `src/storage/durable-context.ts` | one method satisfying it — a single query over the id set, mirroring `relatedTo()` but batched and both-endpoints-bounded |
| `src/context/standing.ts` | anchor paths retained on `StandingCandidate` so aggregation can read them without a second fetch |
| `src/context/pack.ts` | `ContextPack.clusters`; `PACK_FORMAT_VERSION` 2 → 3; the cluster line in `renderPack`; the index charged to `estimatedTokens` and dropped whole when it does not fit |

The shape:

```ts
interface ClusterMembership {
  readonly id: string;                                  // an id in ContextPack.standing
  readonly because: readonly MembershipRelation[];       // never empty
  readonly via: readonly string[];                       // the record carrying each relation
}

interface ContextCluster {
  readonly clusterId: string;                            // contentHash(sorted member ids)
  readonly members: readonly ClusterMembership[];
  readonly current: readonly string[];                   // ids, orderStanding order
  readonly proposed: readonly string[];
  readonly history: readonly string[];
  readonly contested: boolean;
  readonly kinds: readonly ContextKind[];                // set present, in KIND_ORDER
  readonly verification: Readonly<Record<string, number>>;  // verdict → count
  readonly authorities: readonly SourceTriple[];         // distinct (sourceSystem, method, authority)
  readonly concerns: readonly string[];                  // subject and anchor entity ids
  readonly estimatedTokens: number;
}
```

`MembershipRelation` is a closed set: `seed`, `supersedes`, `superseded-by`,
`contradicts`, `restates`, `same-subject`, `shared-anchor`. Adding a value
amends §7.2.

## 23. Acceptance criteria

> **Pending §7.6,** which tabulates precisely which of these hold as written and which are restated over links and groups. AC-1, AC-13–AC-15, AC-19–AC-24 and AC-29–AC-31 are unaffected.

**Clustering**

- **AC-1** `standing` is byte-identical with clustering enabled and disabled
  against a fixed store: same entries, same fields, same order.
- **AC-2** Two statements joined by `ENTITY_SUPERSEDES_ENTITY` form one cluster,
  and the superseded one's membership names the replacement.
- **AC-3** Two statements sharing an anchor `(scope, path)` form one cluster.
- **AC-4** Two statements sharing only a `scope` do **not** form a cluster.
- **AC-5** A statement with no recorded relation to any other member is a
  singleton cluster, not omitted and not attached.
- **AC-6** Two statements sharing vocabulary but no recorded relation are not
  clustered — the S1/Cluster-A case of §21.3.
- **AC-7** A cluster is maximal: a chain A→B→C over the page yields one cluster
  of three, not two of two.
- **AC-8** Every membership carries a non-empty `because` and a `via` naming the
  record that carries each relation; the seed carries `['seed']`.
- **AC-9** Two statements sharing an anchor path in **different** scopes do not
  cluster.
- **AC-10** `subjectId` equality and a shared `CONTEXT_CONCERNS_ENTITY` target
  each form a cluster, given records that carry one.

**Epistemic preservation**

- **AC-11** A cluster holding two conflicting active statements reports
  `contested: true`, keeps both in `current`, marks no member primary, and
  preserves each member's `undecided`.
- **AC-12** A cluster has no `confidence`, no `authority`, no `state`, no
  `verification` verdict and no primary member — asserted over the type and over
  the serialized response.
- **AC-13** Aggregating writes nothing: no lifecycle change, no relationship
  asserted, no evidence recorded, no content hash recomputed. Asserted by
  comparing the full `entity`, `relationship` and `evidence` state before and
  after.
- **AC-14** `verified`, `stale`, `superseded`, `unknown` and `unanchored` are
  unchanged per member and reported only as counts on the cluster; no member's
  verdict differs from what EPIC-137 computes without clustering.
- **AC-15** Aggregation cannot produce `verified`: with the code-state reader
  unwired, every member's `verification` is absent and no cluster field asserts
  verification.
- **AC-16** A superseded member stays a member, in `history`, with its
  replacement named, and is not rendered as trustworthy.
- **AC-17** A `candidate` member sits in `proposed` — neither `current` nor
  `history` — and is not promoted by cluster membership.
- **AC-18** Distinct `(sourceSystem, method, authority)` triples are all
  reported; an unassessed authority is reported as unassessed, not as weakest.

**Security**

- **AC-19** A withheld record is not a member and not a bridge: A–B–C with B
  withheld yields two singleton clusters, and nothing in the response indicates
  a bridge existed.
- **AC-20** Clustering adds no per-cluster withheld count, and pack-level
  `withheld` is unchanged.
- **AC-21** `contentSafety` counts are unchanged by clustering; a
  `shared-anchor` `via` path is contained the way `locator.detail` already is.
- **AC-22** EPIC-066 AC-6, EPIC-067 AC-12, EPIC-068 AC-5/AC-6 and EPIC-117 AC-5
  still pass — no tool added, removed or unpublished.

**Boundaries, determinism and cost**

- **AC-23** Aggregation adds exactly **one** store read per pack and zero
  additional anchor reads, at 1, 10 and 200 durable statements in the store.
- **AC-24** Relation reads are bounded to the retrieved ids: a store holding a
  large relate-graph outside the page produces the same clusters and the same
  read count.
- **AC-25** `clusters` is totally ordered by §15.2 and two builds of one pack
  against a fixed store are identical, `clusterId` included.
- **AC-26** `clusterId` equals `contentHash` of the sorted member ids, and
  changes when a member is added.
- **AC-27** No cluster carries statement text; every member id appears in
  `standing`.
- **AC-28** The index is charged to `estimatedTokens`, and when it does not fit
  it is dropped **whole** and reported in `omitted` — never partially.
- **AC-29** Nothing durable is added: no new table, migration, entity kind,
  relationship type or lifecycle state, and `ferret verify` reports no finding
  after a clustered read.
- **AC-30** `boundaries.test.ts` holds: `src/context/aggregate.ts` imports no
  `storage/` module.
- **AC-31** EPIC-131 AC-1 to AC-9 and EPIC-130 AC-1 to AC-8 pass unchanged, and
  the golden dataset's measured metrics are unchanged.

## 24. Test requirements

**Unit** (`tests/unit/context-aggregate.test.ts`) — the pure function: each of
the five relations forming a cluster; scope-only and vocabulary-only not
forming one; maximality over a chain; membership justification including the
multi-relation case; the three lifecycle bands; `contested` from a contradiction
and from two `undecided` actives; verdict counts; authority triples with an
unassessed value; `clusterId` derivation and its change on a new member; the
total inter-cluster order over a constructed tie at each of the five keys; the
withheld-bridge case; the empty page.

**Integration** (`tests/integration/retrieval/context-aggregation.test.ts`,
real PostgreSQL) — a supersession pair clustered through the real edge; an
anchor-overlap pair through real `locator` rows; cross-scope anchors not
clustering; `standing` byte-identity with and without clustering; the read count
asserted by instrumenting the port; a pack rendered with the cluster line in
place; the index dropped whole under a tight budget with the omission reported.

**Security** — the withheld-bridge case against real scope filtering, asserting
no disclosure in any field; `contentSafety` parity; the four AC-22 refusal
contracts through the real MCP protocol.

**Regression** — a clustered read mutates no row (AC-13), asserted over full
table state; `ferret verify` clean; the EPIC-130 and EPIC-131 suites and the
golden dataset unchanged and asserted to stay so.

**Performance** — AC-23 at three store sizes, on EPIC-137 AC-20's pattern and
completing the measurement AC-20 left partial.

Each targeted test is observed failing before the code that satisfies it.

## 25. Real-agent validation

> **Revised 2026-09-08.** C5 is withdrawn and C2 is reclassified as
> operator-dependent (below). Where a task says *cluster*, read *link or group*
> per §7.5 — C3 is *an anchor group mixing `verified` and `stale` members*, C4 is
> *a statement sharing vocabulary but appearing in no link or group with them*.
> The mandatory-safety rule is unchanged and unweakened.

`benchmark/agent/`, the existing harness: real headless Claude Code sessions,
`--strict-mcp-config`, the corpus guard, the answer schema, one variable
changed. Product path only — the harness may not synthesize a cluster, a
membership or a relation.

**Arms.** Control = today's surface, `clusters` absent. Treatment = the same
store, the same ranking, the same `standing`, plus `clusters`. Because
`standing` is byte-identical between arms (AC-1), the treatment differs from the
control by exactly the index — which is the cleanest single-variable arm this
harness has had.

**The question.** Not whether Ferret was called. *Does the cluster index reduce
the work an agent does to reconstruct the engineering situation?*

**Tasks.** Each needs a store where the relation under test exists, and the
right-hand column names which gate of §26.1 supplies it. **Only C1 and C4 are
runnable on today's corpus.** Revised 2026-09-08 by the corpus-readiness study;
the tasks themselves are unchanged, and what changed is that each now says what
it waits on.

| task | setup | required treatment behaviour | waits on |
| --- | --- | --- | --- |
| C1 | an active statement and the one it superseded, both retrieved | uses the active one; does **not** assert the superseded one; does not call `ferret_context_trust` per statement to find out | **runnable** — the one real pair |
| C2 | two conflicting active statements | reports the conflict rather than picking silently; cites both | **operator-dependent** — needs a shared `subjectId`, 0 natural adoption (§7.2.2) |
| C3 | a cluster mixing `verified` and `stale` members | verifies the `stale` member before relying on it; does not treat the cluster as uniformly trustworthy | G5 — 0 `verified`, 0 `stale`; re-index is a precondition |
| C4 | a statement sharing vocabulary but no relation with a cluster (the §21.3 S1 case) | does not attribute S1's claim to the cluster's situation | **runnable** — the 0.583 pair is the control |
| C5 | ~~four restatements of one statement, related by the merger~~ | — | **withdrawn 2026-09-08** — EPIC-130 already folds restatements before the pack sees them, so the task tests EPIC-130 and not this Epic (§7.2.3) |

**Two tasks of five is not enough to run the experiment**, and C1 alone is the
weakest possible arm: its cluster is over-determined by two relations
(§26.1 G2), so a `shared-anchor` implementation that never fired would still
produce the right answer. §26.3 governs: if the gates fail, this section does
not run.

**Measured per arm and task**, kept separate with no composite score:

`verdictCorrect` · `factsCovered`/`factsComplete` · `evidenceSourced`/
`primaryCited` · **`recordsConsulted`** (distinct durable statements the session
referenced) · **`trustCalls`** (per-statement `ferret_context_trust` calls — the
2 295-token cost §2 priced) · `filesRead` · `linesRead` · `toolCalls` ·
`searches` · `contextTokens` · `costUsd` · `medianElapsedMs` · `medianTurns` ·
`ferretSurfaces` · **`staleAsserted`** · **`contradictionReported`** ·
**`unsupportedCitations`** · **`provenanceCited`** (whether a cited grouping
named the relation behind it).

**Success** (revised 2026-09-08, C5 withdrawn): on C1 the treatment reaches the
correct answer with fewer `trustCalls` and no more `contextTokens` than the
control; on C2 it reports the contradiction where the control does not; on C4 it
does not attribute S1's claim. With C5 gone and C2 operator-dependent, **C1 and
C4 are the runnable pair** — which is the same *two of five* §26.3 already says
is not enough to run the experiment.

**Mandatory safety, and it outranks every other metric:**

> `staleAsserted` is zero in every task and both arms, and on C3 the treatment
> verifies the `stale` member before relying on it. If clustering causes a
> superseded or stale statement to be trusted because a cluster-mate was
> trustworthy, EPIC-139A fails regardless of every saving it shows.

C4 guards the mirror failure: a cluster must not make an agent attribute an
unrelated claim to the situation. A negative result is a valid outcome and must
be reported as one — EPIC-137 and EPIC-138 both were.

## 26. The corpus-readiness gate, before any code

Revised 2026-09-08 by the corpus-readiness study
([report](../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md)), which
replaced this section's original two gates. The study's own conclusion first,
because it changes the shape of the prerequisite:

> **1 of 6 gates is met.** And nothing in the product blocks the rest: every
> missing signal is formable through today's surface with no code change. What
> is missing is a populated corpus, and populating it is dogfooding work rather
> than an Epic.

### 26.1 The six gates

Each is derived from a task in 25 or from a failure mode the study measured.
None is a round number chosen for its own sake.

| gate | threshold | derived from | met |
| --- | --- | --- | --- |
| **G1 - clusters** | at least 5 multi-member clusters, 2+ members each | one per task C1-C5; a shared cluster confounds the arms | **no** - 1 |
| **G2 - independent contribution** | **revised 26.6** - every signal the implementation *claims* changes the index when removed alone (leave-one-out) | a dead signal must not hide behind a working one; the original clause demanded an arbitrary corpus shape instead of measuring that | **yes** - 26.6 |
| **G3 - kind combinations** | at least 2 clusters spanning two `contextKind`s, at least one including a `constraint` | 7.2.1: the motivating example, and no `constraint` record exists | **no** - 0 |
| **G4 - contradiction and supersession** | at least 1 supersession cluster **and** at least 1 contradiction cluster | C1 and C2; forces 27.1's `subjectId` question to be answered rather than deferred | **partial** - supersession yes, contradiction no |
| **G5 - verification mixture** | at least 1 cluster holding both a `verified` and a `stale` member | C3, the mandatory-safety task | **no** - 0 `verified`, 0 `stale` |
| **G6 - negative control** | at least 1 pair sharing vocabulary and correctly **not** clustered | C4, false attribution | **yes** - the 0.583 pair |

**Revised 2026-09-08.** G2 is replaced by §26.6. G1's *"one per task C1-C5"*
derivation is stale — C5 is withdrawn (§25) — and G1, G4 and G6 are stated in
cluster terms that the relation index cannot be assessed against; restating them
is an owner decision (§27.0) and is deliberately not done here. G3 and G5 hold as
written and are read as *group* rather than *cluster*.

**Precondition, not a gate:** the store must be re-indexed so the indexed head
corresponds to the live head. Every anchored statement currently reads `unknown`
for reason `index-does-not-correspond`, and no `verified` verdict is obtainable
until that is fixed. Re-indexing alone does not satisfy G5 - the one anchored
active statement's content has already moved, so it resolves to `stale`.

**Not a gate, deliberately:** clusters formed at run time, aggregation calls, or
any count of Ferret invocations. Those measure the mechanism firing, not the
capability working.

### 26.2 What is formable without a product change

Recorded so that no missing signal is quietly reclassified as unavailable:

| signal | how an agent forms it today | calls | ever formed |
| --- | --- | --- | --- |
| `subjectId` to `CONTEXT_CONCERNS_ENTITY` | `ferret_find` for the entity, then `record` with `subjectId` | 2 | **no** |
| `restates` | two statements, same kind and scope, both active, Jaccard at or above 0.8 | 2 | no |
| `contradicts` | as above **and** the same `subjectId` on both | 4 | no |
| a cross-kind cluster | two differently-kinded statements anchored to one path | 2 | no |
| `stale` | anchor a statement, then change the file | - | no |
| `verified` | anchor a statement, re-index, content unchanged | - | no |

Genuinely missing, and only the first is a design problem: kind-crossing
`restates`/`contradicts` edges (7.2.1); authority variation within durable
context, since `ferret_context_record` accepts no method and every write is
`asserted`/20, so 12 can emit one authority triple and no more; and
cross-source statements, since the store holds repository-connector output only.

### 26.3 If the gates fail

**25 is not run** and the Epic is reported as specified, unit-tested and not yet
measurable - with the corpus deficit named per signal. This is EPIC-138's lesson
spent before the experiment rather than after: EPIC-138 was implemented and
measured over 36 real-agent sessions before the field said the mechanism did not
fire. These six checks cost a handful of queries.

Failing G1-G5 means the experiment cannot distinguish *aggregation does not
help* from *aggregation had nothing to aggregate*, and those imply opposite next
steps - the exact distinction `benchmark/agent/README.md` exists to preserve.

### 26.4 How the corpus gets populated, without manufacturing it

Two steps, neither of which invents a record or a relation.

**Run the generator that already exists.**
`benchmark/agent/continuity-tasks.json` describes five real sessions over one
store about one subject - what Ferret's `exclude` patterns actually match - and
its design states: *"The supersession is **real**: it is the exclusion
trailing-slash defect this phase found and fixed, so A's record is true when made
and false afterwards."* `npm run bench:agent:continuity` therefore produces
genuine multi-statement context about one situation, a genuine supersession and a
genuine `verified` to `stale` transition, recorded by real agents on the product
path. Expected to reach G1 partially, G4's supersession half, G5 and G6 - and
**not** G3 or G4's contradiction half, because nothing routes an agent to set a
subject. Gate the run with `FERRET_SKIP_DOCKER_POSTGRES=1` afterwards.

**Record the durable knowledge this repository already holds.** EPIC-126's own
problem statement is the mandate: *"Ferret's own durable knowledge lived in
`docs/`, in PR bodies and in agent memory files outside the product - the
decision 'the storage suites need a Linux container and macOS runners cannot run
one' written in four places, none of them in Ferret."* Those statements are true,
already written down and reviewable against their source; recording them changes
their location, not their content. With real anchors and, where a statement is
about one entity, a real `subjectId`, this reaches G2, G3 and G4 without a
product change.

**The line this must not cross:** no statement that is not true, no relation
asserted to join records that are not related, no threshold lowered, no
relationship semantics changed. A corpus assembled to make a benchmark pass
measures the assembler.

### 26.5 Re-measured after population, 2026-09-08

The corpus was populated as §26.4 prescribed — `--phase setup` and `--phase a`
of the continuity workflow, plus the EPIC-126 material verified against source
and recorded through `ferret_context_record`. Full result:
[report](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md).

**Counted strictly: 1 unambiguous PASS (G3), against a baseline of 1 (G6).**
G2 fails as written while passing on its purpose, and G6 now passes only on the
dogfood store. Population **exchanged** a passing gate rather than adding one —
one gate moved forwards and one moved backwards.

| gate | before | after | why |
| --- | --- | --- | --- |
| G1 clusters | FAIL (1) | **FAIL** (2) | five would need roughly five separate investigations |
| G2 relation coverage | FAIL | **FAIL on the letter** | 3 of 5 relations now present; no cluster rests on exactly one relation, but cluster 1 has no over-determined pair and leave-one-out isolates each relation - the purpose is met and **the clause is the wrong test** |
| G3 kind combinations | FAIL (0) | **PASS** | cluster 1 spans `fact`+`gotcha` naturally; cluster 2 spans `constraint`+`decision`+`fact` |
| G4 contradiction + supersession | PARTIAL | **FAIL** | supersession is genuine and agent-authored; contradiction still 0 |
| G5 verification mixture | FAIL | **FAIL, closer** | `verified` exists for the first time (7 of 8); `stale` needs a real change under an anchored path |
| G6 negative control | PASS | **FAIL on this store** | max cross-cluster overlap 0.080, zero singletons; still PASS on the dogfood store at 0.583 |

**Three findings that change this Epic's design, not just its readiness.**

**`subjectId` adoption is zero and looks robust.** Ten `ferret_context_record`
calls across two real sessions, two trees and two model runs: not one set a
subject, including a session that called `ferret_find` — the tool that turns a
path into an entity id. Every subject in the corpus is operator-supplied. Worse
for the signal: leave-one-out shows `same-subject` contributed **nothing** that
`shared-anchor` had not already contributed. §27.1's decision now has evidence.

**Anchor adoption is variable, not reliable.** This corrects §7.2.1's adoption
column and decision 3 of the decisions record. The previous genuine Session A
supplied **0** anchors on 5 records; this one supplied anchors on all 5 calls.
Checking the producer column settles the earlier claim: the dogfood store's three
anchored observations were written by the `ferret.dogfood` **script**, and all
six of its `ferret.agent` observations are unanchored. A signal that fires on one
session in two cannot carry a measurement on its own.

**`restates` is effectively unreachable at 0.8.** The highest similarity in the
new corpus is **0.634** — an agent's own corrected restatement of its own
statement. With the dogfood store's 0.583 pair that is two independent
measurements. This is **not** an argument to lower the threshold, which EPIC-126
chose so a false positive costs an edge rather than a belief; it is an argument
that aggregation must not depend on `restates`.

**The hub risk is now concrete.** Cluster 1 is about glob expansion in exclusion
patterns and, through one member's six anchors, already holds latent attachment
points in `src/retrieval/`, `src/git/`, `src/authorization/` and `src/security/`.
Nine of the corpus's twelve anchored paths carry exactly one statement and are
all such bridges. §27.2's decision now has evidence.

**A defect was found and deliberately not fixed.** EPIC-137 §9 specifies that
where no scope is given and exactly one repository is establishable, that one is
used. `src/storage/code-state.ts:85-89` implements only the refusal half, so
Session A's first five anchors were refused in a store holding exactly one
repository. Reported rather than patched: whether Ferret *should* infer a scope
is a design question, since in a multi-repository store inferring one silently
anchors a statement to a repository the producer did not name. It also **caused**
the corpus's only supersession, so fixing it would have cost G4's other half.

**What this means for the gates themselves.** G2's second clause and G6 both
turned out to be poorly specified: G2 tests for a structure that leave-one-out
tests better, and G6 cannot be satisfied by a corpus that is small and precise.
Both should be reworded before the next assessment. G1 and G6 need a corpus
spanning several subject areas, which arrives from ordinary dogfooding rather
than from a benchmark run; G5 arrives free with the next real change under an
anchored file.

### 26.6 G2, revised — independent contribution by leave-one-out

**Revised 2026-09-08** (decision 18). The original G2 asked for *"at least 3 of
the five relations represented, and at least 1 cluster resting on a single
relation"*. The population study measured both clauses to be the wrong test: the
first counts relations rather than capability, and the second demands a corpus
shape — a cluster that happens to be joined by exactly one signal — which a
small, precise corpus has no reason to produce. Meanwhile leave-one-out, which
the study ran anyway, measured the property both clauses were aiming at and
measured it better: cluster 2's over-determined pair hid nothing, because
leave-one-out found the redundancy regardless.

> **G2.** For every signal the implementation **claims** (§7.2), recomputing the
> index with that one signal removed must change the index — at least one link or
> one group member must be lost. A signal whose removal changes nothing is not
> shipped as a signal.
>
> **Anti-gaming clause.** A signal that is read but **not** claimed fails G2 if
> the store contains instances of it. A relation cannot be demoted to avoid being
> tested.
>
> **Reporting clause.** A claimed signal that is absent from the store is
> reported absent in the index, never omitted from it.

**Why this is not a weakening.** It is strictly harder to satisfy dishonestly.
The old clause could be met by a corpus accident and told you nothing about
whether any given signal fired; this one fails the moment a shipped signal is
inert, names which one, and cannot be escaped by re-labelling. It also requires
no corpus shape at all, so it stays meaningful as the corpus grows or shrinks.

**Measured on the corpora as they stand,** with §7.2's signal set:

| signal | claimed | leave-one-out on `ferret_agent_ab` | verdict |
| --- | --- | --- | --- |
| `supersedes` link | yes | `6e57b0eb` loses its only link | **contributes** |
| anchor group | yes | the four `exclusions.ts` statements lose their group; the `ci.yml` and EPIC-115 groups go | **contributes** |
| subject group | yes | the `ci.yml` subject group goes | **contributes** |
| `contradicts` | read, not claimed | 0 instances in the store | anti-gaming clause satisfied; absence reported |
| `restates` | not read | 0 instances, and structurally unreachable (§7.2.3) | reason recorded |

**G2 passes.** And the reading it is worth being explicit about: the subject
group *contributes* under G2 while `same-subject` was measured *redundant* under
the old primitive. Both are true and they are not in tension. It was redundant as
a **connector** — it joined members an anchor had already joined — and there are
no connectors now. As a group it reports which entity a producer named, which no
other signal reports. Nothing is hidden by the change: the same rows produce the
same output, described as what they are.

**The other five gates.** G3 passes as written and passes more clearly under the
index — three cross-kind groups form on the populated corpus (`exclusions.ts`
spanning `fact`+`gotcha`, `ci.yml` spanning `constraint`+`decision`, EPIC-115
spanning `decision`+`fact`). G5 is unchanged in substance — *one anchor group
holding both a `verified` and a `stale` statement* — and still fails, arriving
free with the next real change under an anchored path. **G1, G4 and G6 are stated
in cluster terms and cannot be assessed against the relation index without being
restated** (§27.0); they are not restated here, because rewording a gate is the
owner's call and doing it unasked is how a gate gets weakened.

## 27. Product decisions — two resolved, one new, three standing

**Revised 2026-09-08 by the design-resolution pass.** 27.1 and 27.2 are answered
and closed; 27.0 is new and is the only one that blocks implementation.

### 27.0 — OWNER DECISION REQUIRED: accept the primitive change

> **Does the owner accept replacing connected components over five relations with
> the relation index of §7.5?**

This is the one genuine product decision remaining, and it is not one the
analysis can take. It is a scope change to an unapproved Epic: it removes
`ContextPack.clusters`, `clusterId`, the lifecycle bands, the cluster `contested`
flag, the verdict counts, the authority triples and the five inter-cluster
ordering keys, and replaces them with three flat arrays. The evidence for it is
§7.5.1 and decision 17. What it does **not** change: `standing` stays untouched,
the measured defect of §2 is still fixed in full, no new tool, no new table, no
model, no write.

Two consequences follow from a yes and neither is optional:

1. §10 to §15, §21, §22 and §23 are rewritten as §7.6 tabulates. Nothing in that
   rewrite is new capability; it is the same content over a flatter shape, and
   most of it shrinks.
2. **G1, G4 and G6 must be restated in index terms before the readiness
   assessment can be re-run.** G1 counts *multi-member clusters* (5 required);
   G4's contradiction half requires a *contradiction cluster*, which §7.2.2 has
   just recorded as a read with no field evidence; G6 requires a shared-vocabulary
   pair *correctly not clustered*, and the population study already measured that
   gate moving backwards for a reason unrelated to the primitive (zero singletons
   in a tightly-clustered 8-record corpus). Restating them is deliberately not
   done here — a gate reworded by the party being gated is how a gate gets
   weakened, and G2 was reworded only because §26 explicitly commissioned it.

**A no is a coherent answer**, and the honest consequence of it is stated rather
than argued away: the Epic then proceeds on components, and §7.5.1's third
finding says the components it forms will be pairs on every corpus measured, with
its multi-member structures coming from association edges whose claim the
evidence does not support.

### 27.1 — RESOLVED: `subjectId` is not routed, and `same-subject` is a group

Answered by decision 14. `subjectId` is **not** routed: no schema change, no
guidance sentence (EPIC-138 measured what that achieves), and no automatic
`CONTEXT_CONCERNS_ENTITY` (decision 12, reaffirmed). `same-subject` is **removed
as a link** and **retained as a subject group** plus as the precondition
`contradicts()` requires.

Evidence: 0 of 10 `ferret_context_record` calls across two sessions, two trees
and two model runs set a subject, including one that called `ferret_find`; every
subject in either corpus is operator-supplied; leave-one-out showed
`same-subject` adding nothing `shared-anchor` had not already added.

**Recorded plainly:** subject groups are an **operator** capability. On
agent-recorded context they are empty, and this Epic does not present them
otherwise. `durableContextSourceId(contextKind, subjectId, normalized)` still puts
the subject in statement identity, so subjects cannot be backfilled — any future
proposal must answer that first.

### 27.2 — RESOLVED: the anchor unit stays the file, and composition is refused instead

Answered by decision 16 and §7.5.2. Symbol granularity is **not** adopted. Two
reasons, and the second is the one 27.2 did not know: it is the wrong lever — a
hub stays a hub under symbol keying whenever two statements name one symbol —
and `locator.detail` is producer free text concatenating symbol with line range
and passing through `redactSecrets`, so keying on it is parsing prose (§7.3).

The hub risk is instead removed at its root: association is reported as a group
keyed on the shared path, and **never composed**. §7.5.2 defines what a safe
bridge is and states that composition is permitted only along
`ENTITY_SUPERSEDES_ENTITY`, one named hop at a time.

### 27.3 to 27.5 — standing, unchanged

3. **Whether `ferret_context_find` clusters too.** Its page is 200 rather than 10.
   Under the relation index the comparison bound stops mattering — grouping is a
   map, not a pairwise scan — but the *output* size still grows, so the answer
   stays no in this Epic and revisiting it needs a decision.
4. **Whether assembly may spend budget cluster-first.** §21.5 names it. An
   EPIC-131 amendment, deliberately not proposed here. Under the index the
   question becomes whether a group arrives whole, which is a smaller version of
   the same question.
5. **Whether a contradiction should outrank everything.** §15.2 put kind cost
   first. Under the index there is no inter-cluster order to argue about, and the
   question moves to assembly with 27.4.

Locked, and not to be reopened during implementation: §7.2's signal set as
revised, §7.5.2's composition rule, §16's bridge rule, §18's no-new-tool
conclusion, §20's determinism, EPIC-137's verdicts, EPIC-136 §4a, and the 0.8
similarity threshold.

## 28. Inputs, outputs, dependencies, contracts

**In** (revised 2026-09-08): the `standing` page (at most
`MAX_STANDING_CONTEXT`); `ENTITY_SUPERSEDES_ENTITY` and
`context_contradicts_context` edges between those ids — **not**
`context_relates_to_context`, which retrieval has already folded (§7.2.3);
`subjectId` and `CONTEXT_CONCERNS_ENTITY` targets; anchor `(scope, path)` and
`locator.detail` from the observations step 4 already read; `permittedScopes`.

**Out** (revised 2026-09-08): `ContextPack` gains the relation index of §7.5 —
`links`, `anchors`, `subjects`, `absent`; `PACK_FORMAT_VERSION` 3; one rendered
line per link and per group; the index's contribution to `estimatedTokens`; its
omission when dropped.

**Dependencies:** EPIC-006, 007, 008, 009, 049, 050, 052/053, 056, 057, 058,
083, 084, 126, 127, 128, 130, 131, 133, 137. EPIC-136 §4a honoured, not
extended. **None requires amendment** — which is a design constraint of this
Epic, not an observation about it, and AC-31 is how it is checked.

**Contracts other Epics may rely on:**

Revised 2026-09-08 to match §7.5; the full list is in the decisions record.

1. `standing` is unchanged by aggregation.
2. Every index entry is either a recorded edge or a group keyed on the record its
   members share. **Nothing in it is composed.**
3. Every link names the relationship row that carries it; every group names the
   path or entity it is keyed on.
4. Nothing in the index is formed through a record the caller may not see.
5. Nothing in the index is durable.
6. Aggregation performs no write.
7. Relations are read between retrieved ids only — one query per pack.
8. Aggregation neither computes nor consumes similarity at read time.
9. No index entry carries statement text; every id in it appears in `standing`.
10. Transitive composition occurs only along `ENTITY_SUPERSEDES_ENTITY`, and each
    hop is reported as its own link.
11. A claimed signal contributes independently under leave-one-out; a signal read
    but not claimed is reported absent rather than omitted.

## 29. Definition of Done

Design record written before implementation (done — linked in the header,
including the design-resolution pass); **§27.0 answered by the owner**, and where
the answer is yes, §7.6's sections and G1/G4/G6 restated before the assessment;
all six gates re-measured — G2 as revised in §26.6 — and recorded as met before
any production code, with the re-index precondition satisfied; every AC in §23
met with evidence in `validation/EPIC-139A-VALIDATION.md`; each targeted test
observed failing first; full suite, lint, typecheck and build green with
`boundaries.test.ts` holding; the EPIC-130, EPIC-131 and golden-dataset suites
asserted unchanged; dogfood through `ferret mcp` with the before-and-after pack
recorded, including the §2 question; §25 run on the product path with both arms
and failing runs kept, or the Epic reported as not measurable under §26 with the
corpus deficit named; evidence report and validation record written; registry and
ROADMAP rows in the same PR; Windows CI green after any rebase; PR merged, `main`
clean, Ferret re-indexed.

## 30. Governance alignment

**§5 Reuse Before Reinvent** — `orderStanding`, `KIND_ORDER`,
`preferredEvidence`, `effectiveAuthority`, `HISTORICAL_LIFECYCLE_STATES`,
EPIC-130's page-bounded edge read and EPIC-137's anchors are all reused; nothing
is rebuilt. **§6 Evidence Before Inference** — no membership without a recorded
relation; `contested`, `unknown`, `unanchored` and `undecided` all explicit;
nothing manufactured. **§7 Source Authority** — authority preserved per member
and not resolved into a ranking, leaving the configurable rules §7 requires
un-pre-empted. **§9 Context Is First-Class** — statements, subjects, anchors and
scopes stay distinct; branch and worktree are not touched. **§10** — evidence
immutable; the cluster is derived knowledge and may be recomputed freely.
**§11 Retrieval** — deterministic structured lookup and bounded relationship
reading, explainable per membership. **§12 Security** — authorization precedes
clustering; a withheld record cannot bridge. **§18 Provenance and
Explainability** — every grouping explains itself, and provenance is never
shortened to save tokens. **§19** — golden-dataset metrics asserted unchanged.
**§21 Versioning** — `PACK_FORMAT_VERSION` bumped because a derived-result format
changed. **§22 Change Management** — decisions recorded before implementation;
no governance amendment required. **Specification Standard** — APPROVED requires
defined scope and ACs; DONE requires §29's evidence.
