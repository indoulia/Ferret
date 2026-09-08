# EPIC-139A — Context Aggregation: architecture decisions

Recorded **before** implementation, per Governance §22. Grounded in
[the signal-density measurement](../evidence/FERRET-DO-THE-AGGREGATION-SIGNALS-EXIST.md),
taken 2026-09-08 before any of these decisions was fixed.

**In one sentence:** aggregation reads the edges Ferret already wrote between the
statements a pack already fetched, and reports which of them are one belief —
adding an index over the standing list rather than a second list, a second
identity or a second opinion.

> **Read the second pass first.** Decisions 1–13 below are the first pass, taken
> before the corpus was populated. The
> [design-resolution pass](#design-resolution-2026-09-08-second-pass) at the end
> of this record **supersedes decisions 1 (the `clusters` shape), 2 (the
> five-relation table), 3, 4, 5 and 6** on measured grounds. Decisions 7–13 stand.
> The first pass is kept verbatim because the reasoning that was wrong is part of
> the record.

## What already existed

Every signal aggregation needs is recorded and unread on the assembly path:

- `ENTITY_SUPERSEDES_ENTITY` between two `context` records — written by
  `DurableContextStore.supersede`, read by `trust()`
  (`src/storage/durable-context.ts:483`), **never** read by the pack.
- `context_relates_to_context` and `context_contradicts_context` — written by
  `#relate` (`src/storage/durable-context.ts:270`), read by `relatedTo()` and by
  EPIC-130's `equivalenceKey`. The pack reads neither; it receives EPIC-130's
  fold as `subsumed` and carries it as `restates`.
- Anchors — `locator.start` plus `sourceContentHash` on each durable-context
  observation (EPIC-137). The pack already fetches these for verification and
  discards the paths after comparing them.
- `KIND_ORDER` and `orderStanding` (`src/context/standing.ts:40`) — an accepted
  cost ordering, reusable unchanged.
- `preferredEvidence`, `effectiveAuthority`, `isUnknownAuthority`
  (`src/domain/authority.ts`) — the authority policy, already question-shaped
  because it ranks *how* evidence was obtained rather than *who* supplied it.

Nothing is rebuilt. The measured defect is that the pack holds both endpoints of
an edge and does not read the edge — the shape EPIC-124 named *"built twice and
joined neither time"* and EPIC-130 named *"the knowledge needed to fix it was in
the graph, unused."*

## 1 — Aggregation is an index over `standing`, not a replacement for it

> **Superseded in part by decision 17.** The additive-index principle stands; `ContextPack.clusters` does not.

> `ContextPack.standing` keeps its exact shape, contents and order. Aggregation
> adds `ContextPack.clusters`, whose members are **ids into `standing`**.

**Why.** Three reasons, and each is sufficient on its own.

*It keeps every EPIC-131 acceptance criterion literally true.* AC-2
("constraints precede decisions; decisions precede next steps") and AC-3
("current precedes historical") are properties of a **flat total order**. If
clusters became the top-level list, a constraint in cluster 2 would follow a
decision in cluster 1 and AC-2 would be false at pack level. Amending an
accepted AC to accommodate a new field is the wrong direction when the field can
be additive instead.

*It makes regression impossible to hide.* `standing` must be byte-identical with
aggregation on and off against a fixed store. That is a single assertion, and it
is stronger than any set of ordering tests over a merged structure.

*It cannot send the same record twice.* EPIC-136 §2.1 and `CitedEvidence` record
what happens otherwise: *"On the wire it was the same record **twice**, by
construction … 861 of 2 532 bytes, a third of it, saying nothing the item did not
already say."* A cluster that embedded its members' statements would repeat every
statement in the pack. Members are ids; the text stays in `standing`.

**Rejected:** `standing` becomes `readonly ContextCluster[]` (breaks EPIC-131
AC-2/AC-3, repeats text); clusters replace `standing` and a flat view is derived
by the client (moves assembly's ordering decision to the caller, which is what
EPIC-131 exists to stop); a separate `ferret_context_cluster` tool (§9 below).

`PACK_FORMAT_VERSION` goes 2 → 3. Governance §21 requires it: *"derived-result
formats must be versioned where changes can affect reproducibility."*

## 2 — Membership is an explicit recorded relation, never a read-time judgment

> **Superseded in part by decisions 14, 15 and 17.** "Never a read-time judgment" stands; the five-relation membership table does not — three of the five are not membership signals.

> Two statements are in one cluster only because a relation Ferret has already
> **recorded** connects them. Aggregation computes no similarity, calls no
> model, and derives no equivalence of its own.

The five membership relations, and where each is already written:

| relation | source | what it means |
| --- | --- | --- |
| `supersedes` | `ENTITY_SUPERSEDES_ENTITY` | versions of one belief |
| `contradicts` | `context_contradicts_context` | rivals about one subject |
| `restates` | `context_relates_to_context` | wordings of one statement |
| `same-subject` | `subjectId` equality / `CONTEXT_CONCERNS_ENTITY` | about one entity |
| `shared-anchor` | `locator.start` overlap within one `scope` | resting on one file |

**Why not similarity.** EPIC-126 already computes token-set Jaccard — **at write
time**, once, and records the outcome as an edge that a person can inspect and
`ferret verify` can check. Recomputing it at read time would be a second opinion
with no evidence behind it, which is exactly the argument EPIC-130 made when it
required `equivalenceKey` to be *supplied* rather than inferred by ranking:
*"A ranking that re-derived which statements are the same would be a second
opinion with no evidence behind it."* The similarity signal is already in the
graph. Aggregation reads it there.

**The honest limit, measured.** The dogfood corpus's one real disagreement —
*"Ferret dogfoods itself through a surface no agent uses"* against *"…through the
surface an agent actually uses"* — scores **0.583** against the 0.8 threshold,
carries no `subjectId` and no anchor, and therefore joins no cluster. That pair
is missed, and it is missed because **neither statement names its subject**. The
fix is on the capture side (decision 12), not here. A read-time model asked to
group them would be inferring a subject from prose, which EPIC-137 decision 7
already refused for anchors: *"an anchor parsed from a sentence is inference
presented as evidence (Governance §6)."*

## 3 — Anchor overlap is a membership relation; scope alone is not

> **Superseded by decision 16.** Anchor overlap is a path-keyed group, not a membership relation; scope alone is still not a signal.

> Two statements resting on at least one common `(scope, path)` are in one
> cluster. Two statements sharing only a `scope` are not.

**Why anchors.** They are the one aggregation-shaped signal agents actually
supply — 3 of 10 durable-context observations carry one, against **0** carrying a
`subjectId`. Anchor overlap is also free here: the pack already reads every
anchored path to compute verification and currently discards them after the
comparison.

**Corrected twice, 2026-09-08.** First: an earlier draft explained the zero by
saying `subjectId` demands a UUID an agent does not hold. The corpus-readiness
study measured otherwise — one `ferret_find` call converts a path into the UUID,
so `subjectId` is formable in two calls and merely unused.

Second, and against this decision's own claim: the three anchored observations
counted above were written by the `ferret.dogfood` **script**, not by an agent,
and every `ferret.agent` observation in that store is unanchored. The
[population study](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md) §3
then measured two real sessions supplying **0** and **5** anchor sets
respectively. So anchors remain the right primary signal and the honest
description is *variable adoption, roughly one session in two* — not "what
agents supply unprompted". `subjectId` adoption across the same ten calls is
zero, and leave-one-out shows `same-subject` added nothing `shared-anchor` had
not already added.

**The granularity cost, measured.** An anchor names a **file**, and `src/` files
carry a median of 7 declared symbols, p90 21, max 40. So a hub file merges
unrelated concerns into one cluster. Every anchored observation in the store
already carries a `symbol`, which would narrow it; this decision's rejection of
the symbol below is about *verification* and is revisited as an open decision in
EPIC-139A 27.2.

**Why not scope.** Every statement recorded against a repository shares its
scope. Scope as a membership relation makes one cluster of the whole store,
which is the unbounded-traversal failure the Epic exists to avoid, arriving by a
different door.

**A symbol narrows, it does not separate.** `locator.detail` carries a qualified
symbol name. Two statements on the same path and different symbols are still one
cluster: EPIC-137 §7 already says *"a symbol locator names the area, never the
key"*, and no body hash exists to make a symbol a boundary.

## 4 — `contextKind` is a role inside a cluster, not a membership signal

> **Superseded by decision 17.** Kind is still never a membership signal; there is no cluster for it to have a role inside.

> Kind never decides membership. Kind decides **position**, using the ordering
> EPIC-131 already accepted.

The Epic's motivating example — a decision, the constraint behind it, its
supporting evidence, the current state, related gotchas, and what it superseded —
is one cluster because those records share a **subject or an anchor**. Their
kinds are what tell a reader where each sits *within* it. Clustering by kind
would produce a bag of constraints and a bag of decisions: the opposite of what
aggregation is for.

So `KIND_ORDER` and `orderStanding` are reused verbatim for intra-cluster
ordering. Two orderings deriving the same rank separately is one definition too
many — `src/domain/authority.ts` says so about `UNASSESSED_AUTHORITY`, and it
applies here.

## 5 — A cluster carries no epistemic field of its own

> **Superseded by decision 17,** which removes the cluster this rule was defending against.

> Every field on a cluster is either a **set** or a **count** of its members'
> fields. A cluster has no confidence, no authority, no lifecycle state and no
> verification verdict.

This single rule is what makes "aggregation must not hide contradictions"
enforceable rather than aspirational. There is no field on a cluster into which a
winner could be written, so:

- two conflicting active statements stay two members, and the cluster is
  `contested: true` — a flag naming a condition, not a resolution;
- a superseded member keeps `state: 'superseded'` and its own `verification`
  verdict of `superseded`;
- `verified`, `stale`, `unknown` and `unanchored` stay per member, and the
  cluster reports **counts** of each;
- `undecided` from `preferredEvidence` survives as the member's own field.

**Rejected:** a cluster-level `confidence`; a `primary`/`answer` member; a
cluster `verification` verdict; collapsing the four EPIC-137 verdicts into a
score. EPIC-137 §10 forbids the last of these outright, and the first three are
the same mistake wearing different names — Ferret deciding a question it has
recorded that it cannot decide (EPIC-126 AC-4, EPIC-127 AC-8/AC-9).

## 6 — Cluster identity is derived, and deliberately not durable

> **Superseded by decision 17.** Nothing in the index is durable; there is no `clusterId`.

> `clusterId = contentHash(sorted member ids)`. Nothing persists it, nothing
> references it across builds, and no table is added.

A cluster is a **view**, and the same argument EPIC-137 used against persisting
staleness applies: *"staleness is relative to the tree evaluated, so one stored
flag is wrong for any repo with two branches."* Membership is relative to the
caller's permitted scopes and to the page retrieval returned, so a stored
cluster is wrong for any second caller. Deriving the id from the member set also
makes the property testable: two builds of one pack against a fixed store
produce identical cluster ids, and adding a member changes the id, which is
correct because it is a different cluster.

**Rejected:** a `context_cluster` entity kind; a `cluster_id` column on
`entity`; a `context_in_cluster` relationship; caching clusters between calls.
Each would make a derived view into a source of truth that could disagree with
the records it derives from.

## 7 — Authority is preserved, not resolved

> Aggregation reports which source each claim came from and how it was obtained.
> It does not decide which source is authoritative for the question.

Governance §7 requires that *"authority rules must be configurable where multiple
systems provide competing representations of the same fact"* — and today's policy
is a fixed `AUTHORITY_BY_METHOD` table plus a per-provider `systemOfRecord` flag.
Authority in Ferret is therefore already a property of **how** evidence was
obtained, not of **who** supplied it, which is most of what
"question-dependent" needs: a Jira connector reading an issue status is
`SYSTEM_OF_RECORD` for that, and the same connector's inference about
architecture is `DERIVED`.

What aggregation must not do is turn that into a single ranking. Within a
cluster, `effectiveAuthority` is used **only** as a tiebreak inside one kind
band — precisely as `orderStanding` already uses it — never as a cross-member
verdict. The cluster surfaces the distinct `(sourceSystem, method, authority)`
triples present so the consuming agent can apply question-dependence itself.

**Why Ferret does not apply it.** Deciding that GitHub is authoritative *for this
question* requires knowing the question's fact type, and a task sentence does not
deterministically yield one. Inferring it would be manufacturing certainty, which
Governance §6 forbids. Reporting the distinction is the strongest honest answer,
and it is strictly more than the flat list gives today.

## 8 — A record the caller may not see cannot be a cluster bridge

> Clusters form **after** the permission filter, over visible members only. If A
> relates to B and B relates to C and B is withheld, A and C are **not** joined.

Joining them would disclose that a bridge exists — an existence fact about a
record the caller was refused, which is what EPIC-137 §11 and EPIC-058 both
refuse. This is EPIC-130's rule extended one hop: *"Clusters are formed after the
permission filter, so a cluster can never be formed through a record the caller
may not see."*

No per-cluster "1 member hidden" count either. The pack's existing `withheld`
report carries permission losses at pack level and category granularity; a
per-cluster count would reintroduce the disclosure at finer resolution.
EPIC-136 §9's rule — *"Nothing in this Epic may reduce what a caller is told
about what was withheld"* — is satisfied by leaving that channel exactly as it is
rather than by adding a second one.

## 9 — No new MCP tool

> Aggregation is an internal stage of `ContextPackBuilder`, consumed by
> `ferret_context_pack` and `ferret_context_find`. The tool count does not change.

**Why.** The capability's whole content is *which of the records you were just
handed are one belief*. That is only answerable relative to a page of records,
and the surfaces that produce such a page already exist. A separate tool would
have to take a question, re-run retrieval, and re-derive the page — a second
retrieval path with its own drift, to answer a question about a page the caller
already has.

EPIC-136 §4a makes the cost concrete and asymmetric: thirty tool definitions
cost ~8 000 tokens **per turn**, the surface cannot be reduced without breaking
four accepted refusal contracts, and the owner declined all three reduction
mechanisms. A thirty-first tool is therefore not a neutral addition; it is a
permanent per-turn tax on every session, paid to expose a stage the pack already
runs.

`ferret_context_trust` already answers the per-statement question
(`supersededBy`, `contradictedBy`, `supersedes`), and §3.1 of the measurement
shows what it costs to use it as an aggregation surface: 4 calls and ~2 295
tokens to recover one edge. Aggregation exists to make those calls unnecessary,
not to add a cheaper way to make them.

## 10 — Deterministic, with no model in the loop

> No LLM, no embedding, no read-time scoring. The stage is a pure function of
> the page and the edges between its members.

The bar an LLM would have to clear is written down here so a later proposal has
to meet it rather than restate the attraction: name the deterministic mechanism
that cannot do the job; state exactly what the model receives; state how a
fabricated membership is prevented; state how provenance for a model-derived
membership is recorded (it would be `EvidenceMethod.GENERATED`, authority
`ASSERTED` — the lowest rank, by `AUTHORITY_BY_METHOD`, which is itself an
argument against); state how the output is validated; bound the cost per pack;
and state how two builds of one pack agree.

The measured gap of §2 does not meet that bar: it is a *capture* gap, and a model
inferring a subject from prose is the failure mode, not the fix.

## 11 — The signal-density gate precedes implementation

> Before any production code, the signal counts of
> [the measurement](../evidence/FERRET-DO-THE-AGGREGATION-SIGNALS-EXIST.md) §2
> are re-taken against the store the experiment will run on. If no more than one
> multi-member cluster can form, the experiment is not run and the Epic is
> reported as not yet measurable.

This is EPIC-138's lesson applied before the money is spent rather than after.
EPIC-138 was implemented, measured over 36 real-agent sessions, and rejected
because the mechanism did not fire in the field. That rejection was cheap only
because it was measured; this gate makes the equivalent check cost one query.

The corollary, stated plainly: **on today's dogfood store, aggregation can form
exactly one two-member cluster.** That is enough to unit-test the mechanism and
not enough to measure whether it helps an agent. The gate is what keeps those
two facts from being confused.

## 12 — `subjectId` is unused, not unreachable (corrected 2026-09-08)

An earlier version of this decision recorded that Ferret's natural aggregation
key is *unusable* by the producer that writes context, and named a capture change
as the fix. The corpus-readiness study
([report](../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md) 3.2)
measured that claim and it does not hold:

```
ferret_find {"kind":"file","attributes":{"path":"src/context/code-state.ts"}}
-> 184a1d03-e050-8629-ab9f-7ba3f0b619eb  file  src/context/code-state.ts
```

So `subjectId` is formable in **two** tool calls and used in **0 of 7** records.
Nothing in the product blocks it. **No capture change is required, and none is
proposed.**

What replaces the old prerequisite is smaller and harder: the corpus has to be
populated, and an agent doing ordinary work supplies `anchors` and `supersedes`
and does not supply `subjectId`. EPIC-138 already measured that a sentence of
guidance does not reliably change that. So the question is a product decision
about whether subject adoption is routed or treated as an operator
responsibility — EPIC-139A 27.1 — and **no follow-on Epic is created for it.**

One constraint any future proposal must answer first:
`durableContextSourceId(contextKind, subjectId, normalized)` puts the subject
**in statement identity**. A subject cannot be backfilled onto an existing
record; recording the same words with a subject creates a different record. The
seven existing statements cannot be annotated, only re-recorded.

**Rejected outright:** having Ferret write `CONTEXT_CONCERNS_ENTITY`
automatically from a resolved anchor's file entity. It is deterministic and
non-inferential — anchor resolution already computes that entity — but for
clustering it is **the same signal twice**, producing exactly the clusters
`shared-anchor` already produces, at the cost of a write on the record path.

**One signal is genuinely missing, and it is not this one.** `candidates()`
filters on `contextKind`, so `restates` and `contradicts` are same-kind only and
no relate edge will ever join a `decision` to its `constraint`. That is recorded
in EPIC-139A 7.2.1, and it means the Epic's motivating example rests on
`same-subject` and `shared-anchor` alone.

## 13 — Aggregation mutates nothing

> The stage takes no store handle that can write. Lifecycle is never changed, no
> edge is asserted, no evidence is recorded, no `markStale` caller appears.

EPIC-137 decision 5 established the principle for drift — *"a changed anchor
must not automatically supersede, archive, delete, negate or demote"* — and the
same applies with more force here: aggregation observes that two records are one
belief, which is not a licence to merge them. Merging on evidence of sameness is
EPIC-126's job and happens on **write**, keyed on identity, never on a score
(EPIC-126 invariant 4: *"Nothing is merged on similarity"*).

## Contracts this creates

1. `standing` is byte-identical with clustering enabled and disabled against a
   fixed store.
2. Every cluster member id appears in `standing`; no cluster carries statement
   text.
3. A cluster's fields are sets or counts of its members' fields, and nothing
   else.
4. Every membership carries the relation that justifies it and the edge or field
   that records it.
5. A cluster is never formed through a record the caller may not see.
6. `clusterId` is derived from the sorted member ids and is not durable.
7. Aggregation performs no write of any kind.
8. Aggregation reads relations between the ids already retrieved — one query
   over a page of at most `MAX_STANDING_CONTEXT` members, never over the corpus.

---

# Design resolution, 2026-09-08 (second pass)

Recorded after the [population study](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md)
and still **before** any implementation. The corpus question is closed: what
remained were design questions, and decisions 14–18 answer them.

**In one sentence, and it reverses decision 1's shape:** the measured defect is
that the pack holds both endpoints of a recorded edge and never reads it — so the
fix is to **report the edge**, not to compute a component over five relations
that measurably do not mean the same thing.

Two code-level findings drive most of what follows, and neither was known when
decisions 1–13 were taken.

**Finding A — the mechanism decision 2 proposes is already shipped, for one
relation, and it folds that relation away.** `RetrievalStore.#equivalenceOf`
(`src/storage/retrieval.ts:1152`) reads `context_relates_to_context` between the
retrieved ids, **after** the permission filter, and runs **union-find over the
pool** (`src/storage/retrieval.ts:1164`) — the identical query shape, page bound,
permission rule and algorithm EPIC-139A §8.1 and §17.1 propose. `foldEquivalents`
(`src/retrieval/rank.ts:206`) then elects one survivor per component and reports
the rest in `subsumed`, which the pack carries as `StandingContext.restates`.
Both queries that populate `standing` — the record search and `#standingFor`'s
widened read (`src/context/pack.ts:476`) — go through it.

**Finding B — an anchor's entity id is not on the read path.** `locatorFor`
(`src/storage/durable-context.ts:743`) persists `{kind:'path', start, detail}`;
`ResolvedAnchor.fileId` is computed at write time and **not stored**. So the pack
holds the anchor's *path* and never its file entity id.

## 14 — `same-subject` is a group keyed on the subject, never a link between statements

> `subjectId` is retained for two purposes and removed as a membership signal:
> it is the precondition `contradicts()` requires, and it is reported as a
> **subject group** — which statements on this page name entity X. It forms no
> edge asserting that two statements are one belief.

**Why not retained as a link.** Measured, and the measurement is unusually clean:
**0 of 10** `ferret_context_record` calls across two real sessions, two trees and
two model runs set a `subjectId` — including a session that called `ferret_find`,
the tool that turns a path into an entity id
([population study](../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md) §3).
Every subject in either corpus is operator-supplied. And where it did appear,
leave-one-out says it added nothing: dropping `same-subject` left cluster 2
whole, because `shared-anchor` already connected the same members (§4.4 of the
same study).

**Why not removed outright.** Two things would go with it that are not redundant.
`contradicts(a, b)` returns `false` before it looks at the words unless both
statements carry the same `subjectId` (`src/context/durable.ts:125`), so removing
the subject removes contradiction detection with it. And a subject is the *only*
signal that reports **what a statement is about** as opposed to **what it rests
on**: an anchor group says two statements touch `ci.yml`, a subject group says a
producer declared `ci.yml` to be the thing the statement concerns. Those are
different claims and only one of them is producer-asserted.

**Why the redundancy finding does not survive the reframing.** `same-subject` was
measured redundant *as a connector* — it joined members `shared-anchor` had
already joined. Under decision 17 there are no connectors, so there is nothing
for it to be redundant with: as a group it reports a fact no other group reports.

**Reaffirmed, not reopened:** Ferret does not write `CONTEXT_CONCERNS_ENTITY`
automatically from a resolved anchor (decision 12), and no routing sentence is
added — EPIC-138 measured what that achieves.

**Consequence to state plainly:** on agent-recorded context, subject groups are
empty. They are an operator capability until something adopts them, and
EPIC-139A must not present them as an agent-facing one.

## 15 — `restates` is not read at all; `contradicts` is read and not claimed

> `restates` leaves the relation set. `contradicts` stays a read whose absence is
> reported, and is not claimed as a delivered capability.

Neither the 0.8 threshold nor the formation semantics change. The asymmetry
between the two is not a judgment call; it is Finding A.

**`restates` is structurally unreachable on this path, not merely absent.**
EPIC-130's fold elects one survivor per `context_relates_to_context` component
and drops the others from the result, so **both endpoints of a relate edge are
never both in `standing`** — the surviving statement carries the other's id in
`restates` instead. An aggregation `restates` relation would therefore be the
same query, the same union-find and the same signal a second time, over a page
from which retrieval has already removed one endpoint. Governance §5 settles it:
*Reuse Before Reinvent.* The corpus evidence — 0 edges over two stores, a maximum
observed pair of **0.634** where an agent restated **its own** statement, and
0.583 in the dogfood store — says the edge would rarely exist anyway; Finding A
says it could not be read from the page even when it did.

*A latent inconsistency this exposes, reported and not fixed:* `#standingFor`
unions two searches that fold **independently**, so two different pools could
elect two different survivors of one equivalence component and place both in
`standing`. That is not a capability to build on — it is a case where the pack
would show one belief twice — and it belongs to EPIC-130, not here.

**`contradicts` is not folded, and that is why it stays.** `#equivalenceOf` reads
`context_relates_to_context` only, so contradiction endpoints survive retrieval
and both can be members of a page. It is also the one relation carrying a claim
nothing else on the pack can make — that two active statements are **rivals** —
and its absence is a *safety* loss, not a convenience loss: without it, Ferret
presents two rivals as independent claims, which is the mandatory-safety failure
EPIC-139A §25 says outranks every saving.

**What is honestly true about it:** it has never formed. `contradicts()` needs the
conjunction *same `subjectId`* and *same `contextKind`* and *Jaccard at or above
0.8*, and the first conjunct has zero natural adoption (decision 14). So
`contradicts` is a **read path with no field evidence**, and EPIC-139A must say
so rather than list it as a signal it delivers.

**Rejected:** lowering `NEAR_DUPLICATE_SIMILARITY` (out of bounds, and 0.8 down
to 0.58 merges anything sharing vocabulary); removing `candidates()`'s
`contextKind` filter to obtain cross-kind relate edges. The second deserves its
reason, because §7.2.1 has been treating it as a defect: a `decision` and the
`constraint` behind it are **not restatements of each other**, whatever their
token overlap, so comparing across kinds would manufacture false relate edges.
The same-kind filter is *correct*. What was wrong was §7.2.1's implication that
the motivating cross-kind example was ever a relate case.

## 16 — The anchor bridge is `(scope, path)`, grouped by path, and never composed

> An anchor bridge is reported as a **group keyed on the shared path** — *these
> statements rest on `src/config/exclusions.ts`* — never as an edge between two
> statements, and never composed with a second bridge. The unit stays the
> **file**. `locator.detail` is displayed and is never a key.

**Why the file, and not the symbol.** Finding B plus what `detail` actually is.
`locator.start` is the one anchor component **resolved against the index**;
`locator.detail` is producer free text that concatenates the symbol with a line
range and passes through `redactSecrets` (`src/storage/durable-context.ts:743`).
Keying on it would mean parsing a producer's sentence back into a symbol — the
inference EPIC-137 decision 7 forbids — and would separate two statements that
genuinely name one symbol but differ in line range. So the symbol narrows a
reader's re-read, as EPIC-137 §7 said, and it is shown for exactly that.

EPIC-139A 27.2 asked whether symbol granularity should replace file granularity
as the mitigation for the hub risk. **Answer: no, because grouping and refusing
composition mitigate it at the root, and symbol keying does not.** A hub file with
twelve statements is still a hub under symbol keying whenever two statements name
the same symbol, and it silently splits when they spell the area differently.

**What the hub risk actually is, measured.** The population study §4.4 measured
structure, not yet a failure, and the distinction matters. Measured: 12 distinct
anchored paths over 8 statements; **9 carry exactly one statement**; one member
carries **6** anchors reaching `src/retrieval/`, `src/git/`,
`src/authorization/` and `src/security/`; zero singletons in an 8-record corpus.
Not measured: a transitive anchor bridge actually firing — the 4-member group is
a *clique* on one path, and every pair in it is a true direct bridge.

So the failure mode is **composition**, and it is arithmetic rather than
speculative. A statement may carry `MAX_ANCHORS = 20` anchors
(`src/context/code-state.ts:24`), so `shared-anchor` is anchor-set *intersection*
— which is **not** an equivalence relation. X on {A,B}, Y on {B,C}, Z on {C,D}
puts X and Z in one component sharing **nothing**, and the composed link names no
record. That is what the 9 single-statement paths are: each is one future
statement away from becoming a bridge.

**The definition this fixes, stated precisely.**

> A **safe aggregation bridge** is a link Ferret can name in full — the statement
> ids, the relation, and the *single record* that carries it — such that a reader
> can check the link against that record without Ferret having composed anything.
> A composed link is unsafe because there is no record to name.

**How transitive expansion is constrained: it is not permitted for association
relations at all.** Anchor and subject groups are keyed on the shared thing, so
there is nothing to compose — the group *is* the shared record. Composition is
permitted only along `ENTITY_SUPERSEDES_ENTITY`, where it preserves the relation's
own meaning (a version chain is still one belief) and where **each hop still names
its own edge**: the index reports the chain as its edges, and asserts nothing
beyond them.

**Also settled by Finding B:** §7.4's `concerns` cannot carry anchor **entity
ids**. They are not persisted, and resolving them would cost a per-path lookup
that AC-23's *exactly one store read* forbids. An anchor group is keyed on
`(scope, path)`; only a subject group is keyed on an entity id, because a producer
supplied it.

## 17 — The primitive is a relation index, not connected components

> Aggregation reports **named links and shared-key groups** over the page. It
> computes no components, no cluster identity, no cluster fields and no cluster
> ordering.

```
links    [{ from, to, relation: 'supersedes' | 'contradicts', via: <relationship id> }]
anchors  [{ scope, path, statements: [ids], details: [per-statement locator detail] }]
subjects [{ subject: <entity id>, statements: [ids] }]
```

`standing` is still untouched; ids still index into it; no statement text is
duplicated. `PACK_FORMAT_VERSION` still goes 2 to 3.

**Why connected components is the wrong primitive.** It requires the edges to be
interchangeable, and three independent lines of evidence say they are not.

*The relations divide into two kinds that do not mean the same thing.*
`supersedes`, `contradicts` and `restates` assert **sameness of subject matter** —
two statements occupying one slot, as versions, rivals or wordings. `same-subject`
and `shared-anchor` assert **association** — about one entity, resting on one
file. A component over the union answers *"is this one belief?"* with an edge that
only ever meant *"these are related"*. EPIC-139A §1 draws the distinction in its
own first sentence and §7.1 then discards it.

*Transitive composition is sound for one group and unsound for the other.* A
supersession chain is still one belief. `subjectId` equality is an equivalence
relation, so composing it cannot leave the subject. Anchor-set intersection is
neither, and its closure is the bridge failure of decision 16.

*And the component abstraction has no measured case where it differs from the
index except the cases where it is wrong.* Both corpora hold exactly **one**
sameness edge — one supersession, zero contradicts, zero restates — so a component
over sameness edges is a pair, which is an edge. Every multi-member structure
either corpus produced came from association edges, and in the one that formed
naturally the component's claim is the false one: cluster 1's four
`exclusions.ts` statements are two facts and two gotchas resting on one file.
*"These four rest on `src/config/exclusions.ts`"* is exactly true; *"these four
are one belief"* is not. The index says the first.

**What this removes, and why removing it is not a loss.** Decisions 4, 5, 6 and
EPIC-139A §10 to §15 exist to stop a cluster from acquiring an epistemic field, a
winner, a verdict or an identity. With no cluster there is nothing to hang one on,
so those defences become unnecessary rather than weakened:

- **bands** — `standing` already carries `state` and `current`; bands only ever
  ordered *within* a cluster;
- **`contested`** — a `contradicts` link *is* the flag, at the pair granularity
  where the condition actually holds rather than smeared over a group;
- **verdict counts** — EPIC-137's verdicts are already per member on `standing`;
  a count only existed to summarize a group;
- **authority triples** — `standing` already carries `authority`, and §26.2
  measured durable-context authority to be the constant
  `asserted`/`ferret`/`20`, so the triples were vacuous on any corpus that
  exists;
- **`clusterId`, the five inter-cluster ordering keys, and drop-whole for a
  nested structure** — all properties of a structure that is no longer built. A
  flat index sorts by `(relation, from, to)` and by `(scope, path)`, which is
  total without an argument.

**What it keeps.** The whole of the defect §2 measured. *"Entries 3 and 4 are one
belief in two versions, and the pack says so about neither"* is answered by one
link — `{from: 3, to: 4, relation: 'supersedes', via: <rel id>}` — and the 2 295
tokens and 4 round trips that recovering it costs today are the saving. Nothing
in that measurement needed a component.

**Cost is lower, not merely equal:** one query (extending `#equivalenceOf`'s shape
rather than adding a second copy of it — Finding A), no union-find, no 45 pairwise
comparisons, and path grouping over at most 10 times `MAX_ANCHORS` anchors already
in hand.

**Rejected:** components over sameness edges only, with association reported as
groups — it is the right *semantics*, and on every corpus measured or plausibly
reachable its components are pairs, so it buys an abstraction with no case;
components with a size cap or a hub threshold — an invented number, and the wrong
lever, since breadth is a symptom of composition; keeping clusters and adding a
`confidence`-free "association" flag per membership — that is the index, wearing a
structure it does not need.

**This supersedes:** decision 1's `ContextPack.clusters` shape, decision 2's
five-relation membership table, decision 3's anchor relation (replaced by 16),
decision 4, decision 5 and decision 6. Decisions 7 to 13 stand unchanged:
authority is preserved and not resolved, a withheld record is not a bridge, no new
MCP tool, no model in the loop, the gate precedes implementation, `subjectId` is
unused rather than unreachable, and aggregation mutates nothing.

## 18 — Readiness is measured by leave-one-out contribution, not by corpus shape

> For every relation or group the implementation **claims**, removing that one
> signal must change the index. A signal whose removal changes nothing is not
> shipped as a signal.

This replaces G2's *"at least 1 cluster resting on a single relation"*, which
asked the corpus for an arbitrary shape. Leave-one-out asks the capability for a
contribution, and the population study already ran it: cluster 1 had no
over-determined pair and isolated each relation cleanly, while cluster 2's
over-determination hid nothing because leave-one-out found it anyway.

**The clause that stops it being gamed:** a signal that is read but not claimed
fails the gate **if the store contains instances of it**. A relation cannot be
demoted to avoid being tested.

On the measured corpora, with decisions 14 to 17 applied: `supersedes` links,
anchor groups and subject groups each change the index when removed — **G2
passes**. `contradicts` is read, not claimed, and the store holds zero instances,
so the anti-gaming clause is satisfied and the absence is reported. `restates` is
not read at all, for the structural reason in decision 15.

## Contracts, revised

Contracts 1, 4, 5, 6, 7 and 8 of the first pass stand. Contracts 2 and 3 are
replaced, and three are added.

1. `standing` is byte-identical with the index enabled and disabled against a
   fixed store.
2. **Every entry in the index is either a recorded edge or a group keyed on the
   record the group shares. Nothing in it is composed.**
3. **Every link names the relationship row that carries it; every group names the
   path or entity it is keyed on.**
4. Nothing in the index is formed through a record the caller may not see.
5. Nothing in the index is durable.
6. Aggregation performs no write of any kind.
7. Relations are read between the ids already retrieved — one query over a page of
   at most `MAX_STANDING_CONTEXT` members, never over the corpus.
8. Aggregation neither computes nor consumes similarity at read time.
9. **No index entry carries statement text; every id in it appears in
   `standing`.**
10. **Transitive composition occurs only along `ENTITY_SUPERSEDES_ENTITY`, and
    each hop is reported as its own link.**
11. **A signal the implementation claims contributes independently under
    leave-one-out, and a signal it reads but does not claim is reported absent
    rather than omitted.**

## Implemented, 2026-09-08

Decisions 14–18 were approved by the owner and implemented on
`epic-139a-relation-index`. Validation:
[EPIC-139A-VALIDATION](../EPICs/validation/EPIC-139A-VALIDATION.md).

`src/context/aggregate.ts` is the pure function; `ContextRelationReader` in
`durable-port.ts` is the one-method port; `DurableContextStore.relationsAmong`
is the single bounded query; `ContextPackBuilder` reads it once per pack and
`renderPack` prints a line per link and per group. `PACK_FORMAT_VERSION` is 3.
Nothing durable was added.

**Two things the implementation settled that the design had not.**

**A partial index is a false negative, so the index is all-or-nothing on the
reader.** Anchor and subject groups need no store read — they come from the
observations step 4 already fetched — so a build with no relation reader emitted
groups and `links: []`. That reads as *no supersession exists* when the truth is
*nothing looked*, which is the silent false negative §17.3 already refuses for
the budget case. Found by a failing test, fixed in `pack.ts`, asserted twice.

**Finding B has a consequence for the shed order.** The index is derived *from*
the standing statements, so it is shed after the items and before any standing
entry: losing a statement to keep an index over it would be backwards.

**One first-pass claim did not survive contact with the code, and it is
Finding A's other half.** Decision 2 said the five signals were all "recorded
and unread on the assembly path". `context_relates_to_context` is not unread —
`RetrievalStore.#equivalenceOf` reads it, folds it, and reports the result as
`restates`. The signal was already delivered; what was unread was the
supersession edge, which is what shipped.
