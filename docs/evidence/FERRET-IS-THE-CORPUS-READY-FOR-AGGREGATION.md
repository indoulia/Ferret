# Is the corpus ready for aggregation?

**Aggregation Corpus Readiness Study — measured 2026-09-08** against the
dogfood store `ferret-dogfood`, through Ferret's own MCP surface and by direct
read of the store it serves. Commissioned by the owner after
[EPIC-139A](../EPICs/EPIC-139A-Context-Aggregation.md) §26 exposed the
prerequisite.

> **The question.** Does the current Ferret data model and existing dogfood
> corpus contain enough genuine related durable context to make Context
> Aggregation measurable **without manufacturing the evidence**?

**Answer: no — 1 of 6 readiness gates is met.** And the reason is not what the
first measurement concluded. Nothing in the product blocks the missing signals:
every one of them is **formable through today's surface with no product change**.
What is missing is a populated corpus, and populating it is dogfooding work
rather than an Epic.

Nothing was written to any store during this study. Every count below is a read.
One earlier claim is **corrected** in §3.2.

## 1. Method, and what was deliberately not done

Two instruments. Direct SQL against the store for counts and for constraint
definitions; `ferret mcp` through `.local/ask.mjs` for anything a caller would
see, because *"a defect that only SQL can see is not a defect a client will ever
hit"* (EPIC-118).

Formability was determined **statically** — from the tool schemas, the
`candidates()` query, and the `relationship` foreign keys — plus **read-only
probes** of the halves that are reads. No durable context was recorded, no
relationship asserted, no threshold changed, no relationship semantics touched,
and no store re-indexed. The one place a write would have settled a question is
named in §3.2 and was answered from the schema and a read probe instead.

## 2. Corpus inventory

### 2.1 Durable context records — 7

| id | lifecycle | kind | subjectId | scope | obs | anchored obs |
| --- | --- | --- | --- | --- | --- | --- |
| `47a0bfcd` | active | decision | — | — | 1 | 0 |
| `c894a630` | active | fact | — | `162fed2e` | 1 | 1 |
| `4e215770` | active | fact | — | `162fed2e` | 1 | 0 |
| `622e1122` | active | fact | — | — | 1 | 0 |
| `8e13befb` | active | fact | — | — | 3 | 0 |
| `88c0d4c7` | candidate | next-step | — | — | 1 | 0 |
| `68fc0c86` | superseded | fact | — | `162fed2e` | 2 | 2 |

Three `contextKind`s of six are present: `fact` (5), `decision` (1),
`next-step` (1). **No `constraint`, `gotcha` or `preference` record exists** —
which matters, because `constraint` is the highest-cost kind in `KIND_ORDER` and
the Epic's motivating example is built on it.

### 2.2 Relationships

Every relationship type in the store, and the three that concern aggregation:

```
file_declares_symbol 4051 · commit_modifies_file 2504 · symbol_references_symbol 1517
file_has_version 1118 · repository_contains_file 992 · file_references_symbol 663
commit_parent_of_commit 262 · developer_authored_commit 262 · repository_contains_commit 262
repository_contains_branch 18 · worktree_checks_out_branch 13 · repository_contains_worktree 4
entity_supersedes_entity 1
```

| aggregation signal | count |
| --- | --- |
| `ENTITY_SUPERSEDES_ENTITY` between two `context` | **1** |
| `context_relates_to_context` | **0** |
| `context_contradicts_context` | **0** |
| `CONTEXT_CONCERNS_ENTITY` | **0** |

The single supersession edge is `c894a630 → 68fc0c86`, and it is genuine: an
agent recorded a corrected verification rule and passed `supersedes`.

### 2.3 EPIC-137 anchors

Three anchored observations across two statements, and **all three name the same
file**:

```
c894a630 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:fbd28c171c5
68fc0c86 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:6a1f6b75a46
68fc0c86 | {"kind":"path","start":"src/context/code-state.ts","detail":"verifyAnchors"} | git-blob:fbd28c171c5
```

Every one carries a symbol (`verifyAnchors`). That is worth noting because
EPIC-139A §7.3 declined to use the symbol as a membership discriminator — §5.3
revisits it.

### 2.4 Lifecycle states

`active` 5 · `superseded` 1 · `candidate` 1 · `archived` 0 · `deleted` 0.
Three of the five states EPIC-127 defines are exercised.

### 2.5 Verification states, through the product path

`ferret_context_find {states: [], limit: 50}`:

| verdict | count | which |
| --- | --- | --- |
| `unanchored` | 5 | every statement with no anchor |
| `unknown` | 1 | `c894a630` — reason `index-does-not-correspond` |
| `superseded` | 1 | `68fc0c86` |
| **`verified`** | **0** | — |
| **`stale`** | **0** | — |

**Neither `verified` nor `stale` exists in the corpus**, and re-indexing would
not produce a `verified`. The pack reports `c894a630`'s observed hash as
`git-blob:fbd28c171c5…` against a current `git-blob:d3cf0ed830e…`: the indexed
content has already moved past the observation, so once the indexed head
corresponds to the live head that statement resolves to `stale`, not `verified`.
Re-indexing is therefore a **precondition** for a verification mixture, not a
means of achieving one.

### 2.6 Provenance and authority combinations

| method | source system | authority | producer | confidence | count |
| --- | --- | --- | --- | --- | --- |
| `asserted` | `ferret` | 20 | `ferret.agent` | — | 6 |
| `asserted` | `ferret` | 20 | `ferret.dogfood` | — | 4 |

**Durable-context authority is a constant.** All ten observations are
`asserted` / `ferret` / `20`, with no confidence and no permission scope. For
contrast, the rest of the store has real spread — `inferred`/git/40 (8 167),
`parsed`/git/60 (4 561), `observed`/git/80 (2 413) — but those are source
records, which EPIC-139A §7.4 excludes from cluster membership.

So EPIC-139A §12's authority-triple reporting can only ever emit **one triple**
for agent-recorded context. That is not a defect in §12; it is a statement that
the case §12 exists for is currently unexercisable (§4.4).

## 3. Existing · formable · missing

The distinction the owner asked for, applied without rounding anything upward.

### 3.1 Existing — recorded naturally, present now

| signal | evidence |
| --- | --- |
| `ENTITY_SUPERSEDES_ENTITY` between context | 1 edge, agent-supplied via `supersedes` |
| anchors, and one shared-path pair | 3 observations, 2 statements, 1 pair |
| lifecycle `active`/`superseded`/`candidate` | 5 / 1 / 1 |
| verification `unanchored`/`unknown`/`superseded` | 5 / 1 / 1 |
| a genuine near-miss negative control | the 0.583 pair, §4.1 |

Two signals fire, and they fire on **the same pair** — the cluster is
over-determined, which means today's corpus cannot tell a working `shared-anchor`
implementation from a broken one masked by a working `supersedes`.

### 3.2 Formable — an agent can create these today, and has not

**This corrects the earlier measurement.** The first report and EPIC-139A §2
called `subjectId` *"structurally unreachable"* because it demands a UUID while
an agent holds a path. That is **wrong**. Measured live, one call converts a path
into the entity UUID:

```
ferret_find {"kind":"file","attributes":{"path":"src/context/code-state.ts"}}
→ 184a1d03-e050-8629-ab9f-7ba3f0b619eb  file  src/context/code-state.ts
```

`relationship.to_id` carries a foreign key to `entity(id)`, so the UUID must name
a real entity — and that one does. So `subjectId` is formable in **two** tool
calls, `ferret_find` then `ferret_context_record`. It is not blocked; it is
**never used**, in 0 of 7 records. That is a routing and discoverability fact,
not a structural one — and EPIC-138 is the measurement of how well
routing-by-description works, which is badly.

| signal | how an agent forms it today | calls | ever formed |
| --- | --- | --- | --- |
| `subjectId` → `CONTEXT_CONCERNS_ENTITY` | `ferret_find` for the entity, then `record` with `subjectId` | 2 | **no** |
| `context_relates_to_context` | two statements, same kind + scope, both active, Jaccard ≥ 0.8 | 2 | no |
| `context_contradicts_context` | as above **and** the same `subjectId` on both | 4 | no |
| cross-kind cluster via `shared-anchor` | two statements of *different* kinds anchored to one path | 2 | no |
| `stale` verification | anchor a statement, then change the file | — | no |
| `verified` verification | anchor a statement, re-index so indexed head = live head, content unchanged | — | no |

Two of these deserve their measured reason for being absent rather than an
assumption.

**`context_relates_to_context` is absent because of the content, not the
mechanism.** `candidates()` blocks on scope, kind and `active`, so the corpus
offers exactly three comparable pairs. All three were scored with the product's
own `normalizeStatement`/`statementTokens`/`similarity`:

```
c894a630 / 4e215770   0.174   distinct
622e1122 / 8e13befb   0.583   distinct
68fc0c86 / c894a630   0.125   distinct
```

Zero edges is what this corpus's wording produces under the accepted 0.8
threshold. It is not a broken merger.

**A cross-kind cluster needs no product change at all.** `shared-anchor` is
kind-agnostic: two statements of different kinds anchored to one path cluster.
Nobody has recorded such a pair — both anchored statements are `fact` — but
nothing prevents it.

### 3.3 Missing — the design wants these and the product cannot naturally create them

| signal | why the product cannot | consequence |
| --- | --- | --- |
| **cross-kind `relates`/`contradicts` edges** | `candidates()` filters `e.attributes->>'contextKind' = context.contextKind` (`src/storage/durable-context.ts:322`). A `decision` is never compared to a `constraint`. | The Epic's motivating example has **no** relate-edge route. It depends entirely on `shared-anchor` or `same-subject`. |
| **authority variation within durable context** | `ferret_context_record` accepts no method or authority; every write is `asserted`, and `AUTHORITY_BY_METHOD[ASSERTED] = 20`. Only `ferret_context_promote` varies anything, and it varies *confidence*. | §12 can emit one authority triple per cluster and no more. |
| **cross-source durable statements** | the store holds repository-connector output only — no `issue`, `pull_request` or `page` entity, GitHub enabled and unsynced | §21's worked example and tasks C2/C3 are unexercisable as written |

**These three are genuinely missing, and only the first is a design problem.**
The second is a scope statement about what agent-recorded context can be. The
third is an operational gap — sync the connectors.

## 4. Stress-testing the connected-component definition

EPIC-139A defines a cluster as connected components over recorded relations.
Tested against the real corpus, case by case. **Not solved here.**

### 4.1 Records that clearly belong together with no explicit relation

Two real instances.

`622e1122` — *"Ferret dogfoods itself through a surface no agent uses"* — against
`8e13befb` — *"…through the surface an agent actually uses"*. The corpus's one
genuine disagreement. Same kind, same (null) scope, both active, and **0.583**
against the 0.8 threshold: `classifyPair` returns `distinct`, `contradicts()`
returns `false` before it looks at the words because neither has a subject, and
neither is anchored. **Connected components produce two singletons where a reader
needs one contested cluster.**

`47a0bfcd` (decision, durable context reachable through `ferret_search` only when
`kinds` is restricted) and `4e215770` (fact, a statement anchored to a
nonexistent path) are both about durable-context behaviour and share no relation
of any kind — and here two singletons is arguably **right**. The two cases are
indistinguishable from inside the graph, which is the finding: connected
components cannot tell "should be together and isn't" from "correctly apart".

**Design implication.** The definition is sound and its recall is bounded by
capture quality. The 0.583 pair is not reachable by lowering the threshold —
0.583 is far below 0.8, and a threshold that catches it merges anything sharing
vocabulary. It is reachable by **either** statement naming a subject, which costs
two tool calls.

### 4.2 Records with explicit relations that should not be presented together

The `shared-anchor` hub risk, and it is the strongest objection to the design.

Anchor granularity is a **file**. Measured over the 290 `src/` files: median
**7** declared symbols, p90 **21**, max **40** (`src/github/provider.ts`).
`src/context/pack.ts` is 1 290 lines. So a budget constraint, a rendering gotcha
and a supersession rule all anchored to `pack.ts` become one cluster, and they
are three situations.

Today this is invisible — all three anchored observations name one file, and both
statements really are about one thing. It becomes visible at the first hub file
with two unrelated statements.

**Design implication.** `shared-anchor` needs a narrower unit or a bound on
cluster size, and §5.3 names the unit that is already being recorded.

### 4.3 Multiple relationship types connecting the same records

The corpus's one pair is joined by **both** `superseded-by` and `shared-anchor`,
so `because: ['superseded-by','shared-anchor']` is a real case and the
multi-relation membership shape in §13 is exercised on the first pair.

**Design implication.** Also a measurement hazard: because the only cluster is
over-determined, a `shared-anchor` implementation that never fires would still
produce the correct cluster. The gate must require at least one
**single-relation** cluster (G2).

### 4.4 A relation crossing an authority or lifecycle boundary

**Lifecycle: exercised.** The one pair spans `active` ↔ `superseded`, so the
`current`/`history` banding is testable now.

**Authority: unexercisable.** All ten observations are `asserted`/20 (§2.6), so
no cluster can span an authority boundary. §12's rules are correct and, on this
corpus, vacuous.

### 4.5 A stale member beside verified members

**Not exercisable.** 0 `verified`, 0 `stale` (§2.5), and re-indexing yields
`stale` without yielding `verified`. Task C3 cannot run.

### 4.6 A superseded statement beside its replacement

**Fully exercisable, and the only case that is.** This is the pair the pack
already delivers while naming no link, and it is the case the 2 295-token
measurement priced. Task C1 can run today.

### 4.7 A decision, a constraint and evidence with different contextKinds

**Not exercisable, and structurally not reachable by relate edges** (§3.3). No
`constraint` record exists; no two anchored statements differ in kind; and
`candidates()` cannot compare across kinds however the corpus grows.

**Design implication, and it is the most consequential in this study.** The
Epic's motivating example rests entirely on `shared-anchor` and `same-subject` —
the two signals with, respectively, a granularity problem (§4.2) and a zero
adoption rate (§3.2). Neither relate nor contradict edges will ever carry it.
EPIC-139A should say so plainly rather than list five relations as though they
were interchangeable.

### 4.8 So: useful capability, or another presentation layer?

**On the corpus as it exists today: a presentation layer.** One cluster, two
members, over-determined by two signals, and the pack already prints both
members adjacently.

**On its own terms: a real capability, for a reason that is not cluster count.**
What aggregation prevents is a superseded statement being trusted because
nothing said what replaced it — a *safety* property, measured at 4 round trips
and 2 295 tokens to recover one edge. One pair is enough to unit-test that
property and nowhere near enough to measure whether an agent's behaviour
changes.

Those two facts point in different directions and the recommendation splits
accordingly (§8).

## 5. The subject and anchor question

### 5.1 How much clustering could they provide

`same-subject` is the only signal that can carry the motivating example at a
useful granularity: a subject is an entity, so a decision, its constraint and its
gotchas about one file, symbol, commit or issue cluster regardless of kind. Its
ceiling is high and its adoption is **zero**.

`shared-anchor` is kind-agnostic and free — the pack already reads every anchored
path for verification — and it is the only signal agents actually produce (3 of
10 observations, against 0 subjects). Its granularity is a file (§4.2).

### 5.2 Does current recording produce them

`shared-anchor`: **yes**, unprompted — but *variably*, and this sentence was
corrected on 2026-09-08 by the
[population study](FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md) §3. All three
anchored observations counted here were written by the `ferret.dogfood`
**script**, not by an agent; every `ferret.agent` observation in this store is
unanchored. A later real session supplied anchors on all five of its record
calls, and the session before it supplied none. So anchor adoption is real and
fires on roughly one session in two.

`same-subject`: **no** — 0 of 7 — and not because it is blocked (§3.2) but
because reaching it costs a prior `ferret_find` and nothing routes an agent
there. An agent doing ordinary work supplies `anchors` and `supersedes` and does
not supply `subjectId`.

### 5.3 Do they require a prerequisite change

**No product change is required, and one is worth considering.**

Not required: every gate in §7 except G4 is reachable through today's surface with
no code change. Cross-kind clusters need two differently-kinded statements
anchored to one path. A contradiction needs `subjectId` on two statements, which
is four tool calls.

Worth considering, and **not proposed**: EPIC-139A §7.3 rejected symbol-level
anchor overlap, citing EPIC-137 §7 — *"a symbol locator names the area, never the
key"*. That reason is about **verification**: there is no symbol body hash to
compare against, so a symbol cannot be a verification key. It does not transfer
to **clustering**, where a symbol is only a producer-supplied grouping label —
and every anchored observation in the store already carries one. Given median 7
and max 40 symbols per file, symbol-level overlap is the obvious mitigation for
§4.2's hub risk.

Considered and rejected outright: having Ferret write `CONTEXT_CONCERNS_ENTITY`
automatically from a resolved anchor's file entity. It is deterministic and
non-inferential — anchor resolution already computes that entity — but for
clustering it is **the same signal twice**: it would produce exactly the clusters
`shared-anchor` already produces, at the cost of a write on the record path.

### 5.4 Does the prerequisite belong inside 139A

**Neither.** There is no prerequisite *capability*, so there is nothing to place.
What is needed is corpus population, and that is neither a product change nor an
Epic: EPIC-134 settled that *"self-dogfooding is an acceptance discipline across
the roadmap, not a separate product or agent workflow"*, and it built an oracle
that verifies rather than a generator that populates.

The symbol-level anchor question (§5.3) is a **139A design amendment**, not a
prerequisite — it changes one membership relation's granularity and nothing else.

## 6. Is semantic similarity required?

**No, and not for the first useful version.**

The existing relationship graph is sufficient because the capability's value is
the *safety* property of §4.8 — a superseded or stale statement not being trusted
silently — and that rests on `ENTITY_SUPERSEDES_ENTITY` and EPIC-137 verdicts,
both of which are recorded, deterministic and present. A model adds nothing to
either.

**The smallest missing deterministic signal is not a similarity signal.** It is
`subjectId` adoption — a field that exists, is formable in two calls, is part of
statement identity, and is used zero times. Adding embeddings to compensate for
an unused field would be inferring a subject from prose, which EPIC-137 decision
7 already refused for anchors: *"an anchor parsed from a sentence is inference
presented as evidence"*.

The one case similarity would reach is the 0.583 pair, and the deterministic
route to it costs two tool calls. A model-based route would cost a per-pack model
call, `EvidenceMethod.GENERATED`, authority `ASSERTED: 20` — the lowest assessed
rank — and reproducibility work, to reach a pair that naming a subject reaches
for free.

**One consequence must be stated rather than hidden:** because `same-subject`
adoption is zero and `context_relates_to_context` cannot cross kinds, the
deterministic graph currently delivers *one* cluster. "Sufficient" here means
sufficient **once the corpus carries the signals it can already carry** — not
sufficient on today's corpus. That is what §7 gates.

**A note on `subjectId` and identity.** `durableContextSourceId(contextKind,
subjectId, normalized)` puts the subject **in the identity hash**. So a subject
cannot be added to an existing statement: recording the same words with a subject
creates a **different record**, not an annotation. The 7 existing statements
therefore cannot be retrofitted, and any corpus population that wants subjects
must record new statements. Any future proposal to backfill subjects has to
answer this first.

## 7. Recommended implementation gate

Each gate is derived from a task in EPIC-139A §25 or from a failure mode this
study measured. None is a round number chosen for its own sake.

| gate | threshold | derived from | met today |
| --- | --- | --- | --- |
| **G1 — clusters** | ≥ 5 multi-member clusters, ≥ 2 members each | one per experiment task C1–C5; a shared cluster makes the arms confounded | **no** — 1 |
| **G2 — relation coverage** | ≥ 3 of the 5 membership relations represented, **and** ≥ 1 cluster resting on a *single* relation | §4.3: the only cluster is over-determined, so a dead signal would pass unnoticed | **no** — 2 relations, 0 single-relation clusters |
| **G3 — kind combinations** | ≥ 2 clusters spanning two different `contextKind`s, at least one including a `constraint` | §4.7: the motivating example, currently at 0, and no `constraint` record exists | **no** — 0 |
| **G4 — contradiction and supersession** | ≥ 1 supersession cluster **and** ≥ 1 contradiction cluster | C1 and C2; forces the `subjectId` question to be answered rather than deferred | **partial** — supersession yes, contradiction no |
| **G5 — verification mixture** | ≥ 1 cluster containing both a `verified` and a `stale` member | C3, the mandatory-safety task; §4.5 | **no** — 0 verified, 0 stale |
| **G6 — negative control** | ≥ 1 pair sharing vocabulary and correctly **not** clustered | C4, false attribution | **yes** — the 0.583 pair |

**1 of 6.** G5 additionally requires the store to be re-indexed so the indexed
head corresponds to the live head — a precondition, not a gate, and standing
practice after every merge.

**What the gate is for.** EPIC-138 was implemented, then measured over 36
real-agent sessions, then rejected because the mechanism did not fire in the
field. These six checks cost a handful of queries. Failing G1–G5 means the
experiment cannot distinguish *aggregation does not help* from *aggregation had
nothing to aggregate* — and those imply opposite next steps, which is the exact
distinction `benchmark/agent/README.md` was built to preserve.

**Not a gate, deliberately:** number of clusters formed at run time, number of
aggregation calls, or any count of Ferret invocations. Those measure the
mechanism firing, not the capability working.

## 8. Recommended next step

**Do not implement EPIC-139A yet. Populate the corpus first, then re-run this
study.** Three steps, in order, none of which manufactures evidence.

**Step 1 — run the corpus generator that already exists.**
`benchmark/agent/continuity-tasks.json` describes five real sessions over one
store about one subject — what Ferret's `exclude` patterns actually match — and
its design records exactly what aggregation needs:

> The supersession is **real**: it is the exclusion trailing-slash defect this
> phase found and fixed, so A's record is true when made and false afterwards.

Session A investigates and records; B and C are fresh agents; C asks B's question
after the repository changed; `maintain` brings the record up to date. Running
`npm run bench:agent:continuity` produces genuine multi-statement context about
one engineering situation, a genuine supersession, and a genuine
`verified → stale` transition — recorded by real agents through the product path.
That is dogfooding, not fabrication. Two operational notes: it costs real agent
sessions, and the Docker backend wedged during this study, so gate the run with
`FERRET_SKIP_DOCKER_POSTGRES=1` afterwards.

Expected to reach G1 partially, G4's supersession half, G5 and G6. Expected **not**
to reach G3 or G4's contradiction half, because nothing routes an agent to set a
`subjectId`.

**Step 2 — record the durable knowledge this repository already holds, through
the real surface.** EPIC-126's own problem statement is the mandate:

> Ferret's own durable knowledge lived in `docs/`, in PR bodies and in agent
> memory files outside the product — the decision *"the storage suites need a
> Linux container and macOS runners cannot run one"* written in four places,
> none of them in Ferret and none aware of the others.

Those statements are true, already written down, and reviewable against their
source. Recording them changes their *location*, not their content — and the
owner's permission to *"use genuine existing engineering context to demonstrate
formability"* is exactly this. Recorded with real anchors and, where the
statement is about one entity, a real `subjectId` obtained through
`ferret_find`, this reaches G2, G3 and G4 without a product change. Recording
statements that are false, or inventing relations to join them, is out of bounds
and is the line this step must not cross.

**Step 3 — re-run this study and evaluate the six gates.** If G1–G5 pass,
EPIC-139A is measurable and implementation can be approved. If they do not,
report which signal the corpus still will not produce — that is a finding about
capture, and it is worth more than a rejected read-side Epic.

**Two decisions the owner should take before Step 2**, because they change what
gets recorded:

1. **Should `subjectId` be routed?** It is formable in two calls and used zero
   times. EPIC-138 measured that a sentence of guidance does not reliably change
   agent behaviour, so the honest options are: accept zero adoption and let
   aggregation rest on `shared-anchor` alone; or treat subject adoption as an
   operator responsibility during Step 2. **No follow-on Epic is proposed
   either way.**
2. **Should `shared-anchor` cluster at symbol granularity rather than file?**
   §5.3. It is a one-relation amendment to EPIC-139A, the data is already being
   recorded, and it is the mitigation for the hub risk of §4.2.

## 9. Reproducing this

```bash
# corpus, relationships, anchors, provenance
docker exec ferret-dogfood psql -U ferret -d ferret -At -F' | ' -c "
  select left(e.id::text,8), e.lifecycle, e.attributes->>'contextKind',
         coalesce(e.attributes->>'subjectId','-'),
         coalesce(left(e.source_scope::text,8),'-'),
         (select count(*) from evidence v where v.subject_id=e.id),
         (select count(*) from evidence v where v.subject_id=e.id and v.source_content_hash is not null)
    from entity e where e.kind='context' order by e.lifecycle;"
docker exec ferret-dogfood psql -U ferret -d ferret -At -F'|' -c "
  select type, count(*) from relationship group by type order by 2 desc;"
docker exec ferret-dogfood psql -U ferret -d ferret -At -F' | ' -c "
  select method, source_system, authority, producer, count(*) from evidence
   where subject_id in (select id from entity where kind='context')
   group by 1,2,3,4 order by 5 desc;"

# the formability probe that corrected §3.2 — a read, and it writes nothing
cd .local && node ask.mjs ferret_find \
  '{"kind":"file","attributes":{"path":"src/context/code-state.ts"},"limit":2}'

# verification states through the product path
cd .local && node ask.mjs ferret_context_find '{"states":[],"limit":50}'

# anchor hub risk
docker exec ferret-dogfood psql -U ferret -d ferret -At -F' | ' -c "
  with c as (select f.id, count(r.to_id) n from entity f
      left join relationship r on r.from_id=f.id and r.type='file_declares_symbol'
     where f.kind='file' and f.attributes->>'path' like 'src/%' group by 1)
  select percentile_disc(0.5) within group (order by n),
         percentile_disc(0.9) within group (order by n), max(n) from c;"
```

Jaccard scores were computed with the product's own functions from
`dist/context/durable.js` — `normalizeStatement`, `statementTokens`,
`similarity`, `NEAR_DUPLICATE_SIMILARITY` — so no second definition of
similarity exists in this study.
