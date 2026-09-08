# What does a populated corpus support?

**Corpus population and re-measurement — 2026-09-08.** The next step the
[corpus-readiness study](FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md)
identified, executed. Populated the durable-context corpus using only genuine
product-path observations, then re-measured the six readiness gates of
[EPIC-139A](../EPICs/EPIC-139A-Context-Aggregation.md) §26.1.

> **The objective was not to make the gates pass.** It was to discover what a
> naturally populated corpus supports. Two gates changed; one changed in the
> **wrong** direction, and that is reported as a result.

**Verdict: one gate passes unambiguously (G3), two more pass only on a reading
(G2 on its purpose but not its letter; G6 only on the other store), against a
baseline where G6 alone passed.** Counting strictly, the corpus moved from 1
clear pass to 1 clear pass — it changed *which* gate passes, not how many.
EPIC-139A is **not** ready for implementation. One product defect was found and, per the standing
instruction, is reported rather than fixed (§7).

## 1. What was run, and what was not

| step | what | outcome |
| --- | --- | --- |
| `npm run build` | required by `assertBuildIsCurrent` — `dist/` was stale | clean |
| `continuity.mjs --phase setup` | drops, creates, migrates and indexes `ferret_agent_ab` — **never the dogfood store** | indexed in 451s at `f3dd73d`, content on |
| `continuity.mjs --phase a` | one real headless Claude Code session, Opus, high effort, full published Ferret surface | 4 records from 5 `ferret_context_record` calls; $1.80; 264s; 39 tools; 10 files, 669 lines read |
| `.local/record-126.mjs` | the EPIC-126 material, verified against source first | 3 records, every anchor resolved |

**Not run, deliberately:** phases `b`, `c`, `d` and `maintain`. `b`/`c`/`d` run
as a read-only principal and record nothing, so they add no corpus. `maintain`
is discussed in §6 — its scenario is spent.

**Not done:** no synthetic statement, contradiction, supersession, anchor,
lifecycle transition or verification outcome; no threshold altered; no
relationship type added; no `CONTEXT_CONCERNS_ENTITY` auto-created; no MCP
routing or guidance changed; no production code written; the dogfood store's 7
records untouched.

**One consequence to record honestly:** `--phase setup` is the workflow's own
first phase and it drops `ferret_agent_ab`. A previous genuine Session A had left
5 records there (commit `68033a7`); those rows are gone from the store, though
every statement and every tool call survives verbatim in
`.local/agent-benchmark-run/continuity/state.json` and `a-transcript.json`, and
§3 uses them as evidence. Nothing in the dogfood store was affected.

## 2. What the corpus now holds

`ferret_agent_ab`, 8 durable statements — 5 agent-recorded, 3 operator-recorded.

| id | kind | lifecycle | verification | subject | anchored paths |
| --- | --- | --- | --- | --- | --- |
| `33b29c2e` | fact | active | `verified` | — | 6 |
| `0bb204f9` | fact | active | `verified` | — | 2 |
| `5bb9c0ac` | gotcha | active | `verified` | — | 3 |
| `637f7284` | gotcha | active | `verified` | — | 1 |
| `6e57b0eb` | fact | **superseded** | `superseded` | — | 0 |
| `21f6ad5b` | **constraint** | active | `verified` | `01110ce2` (`ci.yml`) | 2 |
| `e9294b8b` | **decision** | active | `verified` | `01110ce2` (`ci.yml`) | 2 |
| `ddbbbc89` | fact | active | `verified` | `29220b1e` (EPIC-115) | 1 |

Kinds present: **4 of 6** — `fact` 4, `gotcha` 2, `constraint` 1, `decision` 1.
Still absent: `preference`, `next-step`.

Verification: **7 `verified`, 1 `superseded`, 0 `stale`, 0 `unknown`, 0
`unanchored`.** This is the first corpus in Ferret's history to contain a
`verified` statement — the store was indexed at exactly the tree the statements
were observed against, so EPIC-137's six conditions hold.

Relationships: 1 `entity_supersedes_entity`, 3 `context_concerns_entity` (from
the operator-supplied `subjectId`, written by the existing record path), **0
`context_relates_to_context`, 0 `context_contradicts_context`**.

### 2.1 The operator-recorded statements, and why each is supported

Recorded through `ferret_context_record` only after verifying the claim against
the cited file. The citation is the anchor.

**Constraint** — *"The storage integration suites need a Linux service container
for PostgreSQL 17 with pgvector, so they run only on ubuntu-latest. A runner that
cannot run Linux containers cannot host them, and attempting it there would
produce a silent skip rather than coverage."* Supported by
`.github/workflows/ci.yml:120-135` in the repository's own words: *"GitHub's
Windows runners cannot run Linux containers… a Linux service container is the
only way to get a real PostgreSQL 17 + pgvector in CI"*, with the `storage` job
on `runs-on: ubuntu-latest`.

**Decision** — *"A macos-latest CI job was designed and declined by the owner on
2026-09-05: macOS was dropped from the verify matrix and remote CI for macOS is
not enabled. The clause that survives is that no record may claim macOS is
validated unless the packaging path actually ran on macOS."* Supported by
EPIC-115 §Outcome and §Problem: *"do not enable remote CI for macOS… a
macos-latest job was designed and is **not** implemented"*.

**Fact** — *"macOS was never unmeasurable: EPIC-105 ran macos-latest on pull
request 140 and 112 test files and 2463 tests passed… dropped by owner decision
rather than by failure."* Supported verbatim by EPIC-115 §Problem.

This is EPIC-126's own motivating problem being closed, not a corpus assembled to
order: *"Ferret's own durable knowledge lived in `docs/`, in PR bodies and in
agent memory files outside the product."* The statements were already written
down; recording them changed their location, not their content.

## 3. Does signal adoption occur naturally? The headline finding

**Two real Session A runs behaved in opposite ways, and the difference is larger
than anything else measured here.**

| | previous run (`68033a7`) | this run (`f3dd73d`) |
| --- | --- | --- |
| `ferret_context_record` calls | 5 | 5 |
| calls supplying `anchors` | **0** | **5** |
| calls supplying `scope` | 0 | 4 |
| calls supplying `supersedes` | 0 | **1** |
| calls supplying `subjectId` | **0** | **0** |
| kinds recorded | constraint, fact ×2, gotcha ×2 | fact ×3, gotcha ×2 |
| cost | $1.62 | $1.80 |

So:

**`subjectId` adoption is zero and looks robustly zero.** Ten record calls across
two sessions, two trees and two model runs: not one set a subject. This session
even called `ferret_find` once — the exact tool that turns a path into an entity
id — and still recorded nothing about a subject. All three subjects in the corpus
were supplied by the operator.

**Anchor adoption is real but *variable*, not reliable.** This corrects two
earlier claims of mine. EPIC-139A decision 3 and the readiness study §5.2 said
anchors are *"the one signal agents actually produce, unprompted"*; the previous
run produced none. Checking the producer column settles which is which: the
dogfood store's 3 anchored observations were all written by `ferret.dogfood` — the
EPIC-137 dogfood **script** — while all 6 of its `ferret.agent` observations are
unanchored. So before this session, **no agent had ever supplied an anchor**;
in this session one supplied twenty. Both statements are true of different
sessions, and a capability that fires on one session in two is not something to
build a measurement on.

**The supersession was genuinely agent-authored, and it was caused by a defect.**
Call 1 omitted `scope`; all five of its anchors were refused
`repository-not-indexed`; the agent noticed, re-recorded the same finding with
`scope` set, and passed `supersedes: 6e57b0eb`. That is EPIC-137's per-anchor
failure reporting (AC-3, *"not dropped, not guessed"*) working exactly as
specified and an agent acting on it. It is also the corpus's **only** supersession
— see §7 for why fixing the defect would remove it.

## 4. Cluster analysis

Computed by `.local/clusters-139a.mjs`, which applies EPIC-139A §7.2's five
relations to the store. Deliberately outside the product: this measures the
corpus, it does not implement aggregation.

```
records 8 · links 10 · clusters 2 multi-member, 0 singletons
relations present: same-subject, shared-anchor, superseded-by
relations absent:  contradicts, restates
```

### Cluster 1 — 5 members, agent-recorded

- **members** `0bb204f9`, `33b29c2e`, `5bb9c0ac`, `637f7284`, `6e57b0eb`
- **relations** `shared-anchor` ×6 (all via `src/config/exclusions.ts`), `superseded-by` ×1
- **single-signal or over-determined** — **single-signal on every pair.** No pair
  is joined by two relations.
- **contextKinds** `fact`, `gotcha` — **cross-kind, formed naturally**
- **lifecycle** `active` ×4, `superseded` ×1
- **verification** `verified` ×4, `superseded` ×1
- **leave-one-out** drop `shared-anchor` → collapses to 1 member; drop
  `superseded-by` → 4 members. **Neither relation is redundant**, and each one's
  contribution is independently observable.

### Cluster 2 — 3 members, operator-recorded

- **members** `21f6ad5b`, `e9294b8b`, `ddbbbc89`
- **relations** `same-subject` ×1 (`ci.yml`), `shared-anchor` ×2 (`ci.yml`,
  EPIC-115)
- **single-signal or over-determined** — **1 pair over-determined**:
  `21f6ad5b`~`e9294b8b` is joined by both `same-subject` and `shared-anchor`.
  Per the counting rule, this cluster is **one** piece of evidence, not two.
- **contextKinds** `constraint`, `decision`, `fact` — **the Epic's motivating
  example, formed from three genuine relations**
- **lifecycle** all `active`
- **verification** `verified` ×3
- **leave-one-out** drop `same-subject` → **survives whole** (`shared-anchor`
  carries it); drop `shared-anchor` → breaks to 2 members. So `same-subject`
  contributes **nothing** this cluster does not already have.

### 4.1 Cross-context-kind relations

Cross-kind clustering happened, twice, and **only** through `shared-anchor` and
`same-subject` — exactly as EPIC-139A §7.2.1 predicted. `restates` and
`contradicts` produced no edge and structurally could not have produced a
cross-kind one.

### 4.2 Genuine contradiction

**None, and none was created.** `context_contradicts_context` requires the same
`subjectId`, the same `contextKind` and Jaccard ≥ 0.8. Two statements now share a
subject (`21f6ad5b`, `e9294b8b`) and they are different kinds, so no edge — which
is correct, because a constraint and a decision about one file do not contradict
each other. Manufacturing one was out of bounds.

### 4.3 `restates` is close to unreachable in practice

Every one of the 28 pairs scores `distinct`. The **highest** score in the corpus
is **0.634** — and it is `33b29c2e` against `6e57b0eb`, *an agent's own corrected
restatement of its own statement*. If rewriting one's own sentence does not clear
0.8, very little will. With the dogfood store's 0.583 pair that is two
independent measurements pointing the same way.

**This is not a recommendation to lower the threshold.** EPIC-126 chose 0.8 so
that a false positive costs an edge rather than a belief, and lowering it was
explicitly out of bounds. It is a finding that **aggregation must not depend on
`restates`.**

Only 2 of the 10 pairs are even *comparable* under `candidates()` — same kind,
same scope, both active. Both score far below threshold: the two `gotcha`s at
0.196, the two active `fact`s at 0.097.

### 4.4 Do file-level anchors create overly broad clusters?

**Yes, and the risk is now concrete rather than predicted.** Twelve distinct
anchored paths carry the 8 statements:

```
4  src/config/exclusions.ts          <- the hub joining all of cluster 1
2  docs/EPICs/EPIC-115-macOS-Packaging-Validation.md
2  .github/workflows/ci.yml
1  each: docs/Architecture/EPIC-003-DECISIONS.md · src/authorization/authorization.ts
       src/config/schema.ts · src/git/discovery.ts · src/git/provider.ts
       src/retrieval/access.ts · src/security/secrets.ts
       tests/global-setup.ts · tests/unit/config-layers.test.ts
```

Cluster 1 is *about glob expansion in exclusion patterns*. Through
`33b29c2e`'s six anchors it already holds **latent attachment points in
`src/retrieval/`, `src/git/`, `src/authorization/` and `src/security/`**. Any
future statement anchored to `src/retrieval/access.ts` — a retrieval-permissions
concern with nothing to do with glob syntax — joins a cluster about glob syntax.
Nine of the twelve paths carry exactly one statement today and are all such
bridges.

The corpus also has **zero singletons**: every record is in a cluster. On 8
records that is a precision signal and a breadth warning at once.

### 4.5 Shared-vocabulary negative control

**Absent from this store.** The strongest cross-cluster overlap is **0.080**
(`5bb9c0ac`/`21f6ad5b`) — the two clusters are lexically almost disjoint. Every
meaningful overlap in the corpus (0.634, 0.201, 0.196, 0.177) is *inside* a
cluster. Good for precision, and it leaves EPIC-139A's C4 false-attribution task
with nothing to run against here.

The dogfood store still holds the real negative control: `622e1122`/`8e13befb` at
**0.583**, correctly two singletons. So the two corpora are complementary and
**neither alone satisfies the gates.**

## 5. The six-gate assessment

| gate | before | now | why |
| --- | --- | --- | --- |
| **G1 — ≥5 multi-member clusters** | FAIL (1) | **FAIL** (2) | 2 clusters, and one is operator-built. Five would need roughly five separate investigations. |
| **G2 — ≥3 relations, and ≥1 single-relation cluster** | FAIL | **FAIL (letter) / PASS (purpose)** | 3 of 5 relations now present ✓. No cluster rests on exactly one relation, so the letter fails. The purpose — that a dead signal cannot hide behind a working one — is met better than the clause asks: cluster 1 has no over-determined pair and leave-one-out isolates each relation. **The clause is the wrong test and should be reworded** (§8). |
| **G3 — ≥2 clusters spanning two kinds, one with a `constraint`** | FAIL (0) | **PASS** | Cluster 1 spans `fact`+`gotcha`; cluster 2 spans `constraint`+`decision`+`fact` and contains the `constraint`. |
| **G4 — a supersession cluster and a contradiction cluster** | PARTIAL | **FAIL** | Supersession ✓ (genuine, agent-authored). Contradiction still 0, and it needs two same-kind statements sharing a `subjectId` at ≥ 0.8 — a conjunction the corpus has never produced. |
| **G5 — a cluster holding both `verified` and `stale`** | FAIL (0/0) | **FAIL** — and closer | `verified` now exists for the first time (7 of 8). `stale` is 0 and requires a genuine change under an anchored path. **NOT TESTABLE without either waiting for real work to land or manufacturing a change**, and manufacturing was out of bounds. |
| **G6 — a shared-vocabulary pair correctly not clustered** | PASS | **FAIL on this store** | Max cross-cluster overlap 0.080; no singletons. Still PASS on the dogfood store (0.583). **This gate moved backwards**, and it moved backwards *because* population improved precision. |

**Counted strictly: 1 unambiguous PASS (G3), against a baseline of 1 (G6).**
G2 fails as written and passes on its purpose; G6 passes only on the dogfood
store, not on the store the experiment would run on. So population **exchanged**
one passing gate for another rather than adding one, and that is the honest
headline — the corpus got better in the way G3 measures and worse in the way G6
measures.

**What changed, and why**

- **G3 FAIL → PASS.** The real gain. Cross-kind clustering turned out to happen
  naturally through `shared-anchor` once an agent anchored richly, and the
  `constraint` came from the EPIC-126 material.
- **G2 FAIL → the letter still fails, and the letter is wrong.** Population
  revealed the clause tests the wrong property.
- **G4 PARTIAL → FAIL.** No movement on contradiction. It is the one gate whose
  blocker is a *conjunction the product makes hard*, not a corpus shortfall.
- **G5 FAIL → FAIL, but the missing half changed.** Before, both `verified` and
  `stale` were absent; now only `stale` is, and it arrives free with the next
  real change under an anchored file.
- **G6 PASS → FAIL.** Reported as a regression rather than smoothed over. It is
  an artifact of a small, tightly-clustered corpus, and it says the gate needs
  to be evaluated over a corpus with more than one subject area.

## 6. The `maintain` scenario is spent

The continuity fixture's supersession depends on a defect that has since been
fixed. `continuity-tasks.json` states the trailing-slash finding is *"The finding
that exists on the tree Session A runs against… that Session C's change
supersedes"* — but `withoutTrailingSlash` now exists (`src/config/exclusions.ts`,
with the comment *"`secrets/` must exclude, not silently match nothing"*), so the
defect is gone and no change can supersede a record of it.

Observable in the grade: Session A scored **2 of 3 facts**, with
`read-path-enforcement` uncovered. `trailing-slash-matches-nothing` scored
covered only because a statement *narrates the historical* behaviour
(*"…before that fix it expanded to…"*), not because the tree exhibits it.

**This is a stale fixture, not a broken workflow** — the harness executed
correctly end to end — so nothing was changed. It does mean the workflow can no
longer manufacture a supersession-plus-staleness sequence on demand, which is
precisely why G5 has no route that is not either waiting or fabrication.

## 7. Defect found, reported and not fixed

> **An anchor is refused when `scope` is omitted, even where exactly one
> repository is indexed — contrary to EPIC-137 §9.**

EPIC-137 §9 specifies: *"Scope as today; where none is given and **exactly one
repository is establishable, that one**, else refused with a reason."*

`src/storage/code-state.ts:85-89` implements only the second half:

```ts
if (scope === undefined) {
  return anchors.map((one) =>
    failed(one.path, UnknownReason.NOT_INDEXED, 'no repository scope was established for this anchor'),
  );
}
```

Measured: the store holds **exactly one** repository entity,
`162fed2e-7d79-83d2-8384-571f0d142eab`. Session A's first call omitted `scope`
and all five anchors were refused `repository-not-indexed`. The agent then
supplied that same id explicitly and the identical anchors resolved. So the
single establishable repository was there to be found and was never looked for.

**Not fixed, per the standing instruction.** Two reasons beyond that: the smallest
change is a sole-repository lookup, but whether Ferret *should* infer a scope is
a design question — in a multi-repository store, inferring one silently anchors a
statement to a repository the producer did not name — so it deserves a decision
rather than a patch. And it has a measurement consequence worth stating: this
defect **caused** the corpus's only supersession. Fixing it would have made
Session A's first record resolve, and G4's supersession half would have gone
unmet.

## 8. Is EPIC-139A ready for implementation?

**No.** Four of six gates fail, and two of the failures are not corpus-volume
problems.

**What population proved.** The mechanism has genuine material to work on: a
5-member single-signal cross-kind cluster with a real supersession and four
`verified` members, plus a 3-member cluster carrying the exact
constraint-plus-decision-plus-evidence shape the Epic was written for. Connected
components over recorded relations produced clean, defensible clusters with no
false joins.

**What population did not fix.**

1. **`subjectId` adoption is zero and looks structural in behaviour rather than
   in code** — 10 calls, 2 sessions, 0 subjects, including a session holding
   `ferret_find`. Every subject in the corpus is operator-supplied, and
   leave-one-out shows `same-subject` contributed nothing cluster 2 did not
   already have from anchors. So the signal is simultaneously unadopted and, so
   far, redundant.
2. **`restates` is effectively dead** at 0.8, evidenced twice (0.583, 0.634).
3. **Contradiction has never formed** and needs a conjunction the product makes
   hard.
4. **Anchor breadth is a live design risk**, with latent bridges into four
   unrelated modules from a single cluster.

**Remaining decisions that genuinely block implementation** — two, both already
open in EPIC-139A §27 and both now backed by measurement:

- **§27.1 `subjectId`.** The evidence now says: do not build aggregation
  expecting it. Either accept that `same-subject` is operator-only, or drop it
  from §7.2's relation list until something adopts it. This is a decision, not
  code.
- **§27.2 anchor granularity.** §4.4 measured the hub risk on a real corpus.
  Symbol-level overlap is available — every anchor in this corpus carries a
  symbol or a line range — and would split cluster 1's `exclusions.ts` hub from
  its `access.ts` and `provider.ts` bridges.

**A third decision this study adds:** whether `restates` and `contradicts` stay
in §7.2 at all. Both are zero across two corpora, both are same-kind-only by
construction, and one of them cannot clear its threshold even for an agent
restating itself. A relation list with three live members and two dead ones
invites an implementation that tests all five and measures none.

**Recommended next step, and it is not more population.** Take the three
decisions above, then re-scope §7.2 to the relations that demonstrably fire.
G1 and G6 need a corpus spanning several subject areas, which arrives from
ordinary dogfooding rather than from a benchmark run; G5 arrives free with the
next real change under an anchored file. None of that is worth another directed
population pass — the marginal finding per session has dropped sharply, and the
blockers are now design questions rather than data questions.

## 9. Reproducing this

```bash
npm run build
node benchmark/agent/continuity.mjs --phase setup     # own store; never the dogfood one
node benchmark/agent/continuity.mjs --phase a         # one real session, ~$1.80
node .local/record-126.mjs                            # verified EPIC-126 material
node .local/clusters-139a.mjs ferret_agent_ab         # cluster analysis + leave-one-out
node .local/clusters-139a.mjs ferret                  # the dogfood store, unchanged
node .local/negcontrol-139a.mjs ferret_agent_ab       # cross-cluster vocabulary overlap
node .local/jaccard-ab.mjs                            # pairwise similarity, product functions
node .local/ask-ab.mjs ferret_context_find '{"states":[],"limit":50}'
```

Adoption figures come from the `ferret_context_record` inputs in
`.local/agent-benchmark-run/continuity/a-transcript.json` and, for the previous
run, from `state.json` — both kept. Similarity uses the product's own
`normalizeStatement`/`statementTokens`/`similarity` from `dist/`, so no second
definition exists in this study. `.local/` is gitignored; the scripts are
read-only apart from `record-126.mjs`, whose three statements are quoted in §2.1.

`docker exec` into the container wedged repeatedly during this work with
`could not dial Hyper-V socket … queue was full` — the known post-benchmark
Rancher Desktop failure. Every measurement above was therefore taken over the
mapped port (127.0.0.1:55432) or through `ferret mcp`, neither of which is
affected.
