# EPIC-139A — validation record

**Branch:** `epic-139a-relation-index` · **Store:** `ferret` (dogfood), `ferret_agent_ab` (populated corpus)
**Suites:** `tests/unit/context-aggregate.test.ts` (28), `tests/integration/retrieval/context-relation-index.test.ts` (19)

Correctness evidence only. The design argument is in
[the decisions record](../../Architecture/EPIC-139A-DECISIONS.md), decisions 14–18;
the corpus measurements are in
[the readiness study](../../evidence/FERRET-IS-THE-CORPUS-READY-FOR-AGGREGATION.md)
and [the population study](../../evidence/FERRET-WHAT-DOES-A-POPULATED-CORPUS-SUPPORT.md).

**What shipped is not what was first specified.** Connected components over five
relations was rejected on measurement and replaced by a **relation index** —
named links and shared-key groups, composing nothing (§7.5). The owner approved
that change before implementation. So the acceptance criteria below are read
against §7.5, and §7.6 records which of the original §23 criteria were restated.

## The measured defect, before and after

The §2 measurement, re-run through `ferret mcp` against the dogfood store on the
same question and the same budget.

| | before (EPIC-138 `main`) | after |
| --- | --- | --- |
| standing entries | 4 | 4, byte-identical |
| entries 3 and 4 are one belief in two versions | **said about neither** | `statement 3 supersedes statement 4`, naming relationship row `61a4526c` |
| cost of learning that edge | **4 round trips, ~2 295 tokens** (63% of the pack) | **0 extra round trips, 229 tokens** (6% of the pack) |
| pack total | 3 622 of 4 000 | 3 693 of 4 000 |

```
standing:  1 47a0bfcd decision active  ·  2 4e215770 fact active
           3 c894a630 fact active unknown  ·  4 68fc0c86 fact superseded superseded
relations: links    3 supersedes 4  via 61a4526c-da06-87e2-836c-2a3bb8f15c28
           anchors  src/context/code-state.ts -> 3, 4   (details: verifyAnchors, verifyAnchors)
           subjects (none)
           absent   contradicts, same-subject
           229 estimated tokens
```

The superseded entry is still delivered and still reads `superseded` — keeping it
is what makes the replacement checkable.

## Acceptance criteria

Original numbering kept. Criteria restated by §7.6 are marked ⟳ and read against
the shipped primitive.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 `standing` byte-identical with and without the index | PASS | integration *leaves `standing` byte-identical* — `JSON.stringify` equality; dogfood, 4 entries unchanged |
| AC-2 ⟳ a supersession is reported, naming the replacement | PASS | integration ×2 (link present; `via` resolves to a real `relationship` row); dogfood above |
| AC-3 ⟳ statements sharing an anchor `(scope, path)` are one **group** | PASS | integration *groups the statements resting on the CI workflow*; unit ×3 |
| AC-4 statements sharing only a `scope` are not grouped | PASS | unit *does not make a group of statements that share only a scope* |
| AC-5 ⟳ a statement with no recorded relation appears in no entry and is not attached | PASS | integration *never puts a statement sharing no record with the CI group into it* |
| AC-6 shared vocabulary with no recorded relation is not joined | PASS | integration, same test — the packaging statement shares "macOS" with every CI member and appears in no CI entry |
| AC-7 ⟳ **replaced**: no maximality. A chain is its hops | PASS | unit *reports a supersession chain as its own hops* — two links, and no link from A to C |
| AC-8 ⟳ every entry names the record that justifies it | PASS | unit (`via` is the row id; groups are keyed on path or entity); integration (the row resolves) |
| AC-9 an anchor path in different scopes does not group | PASS | unit *does not group one path across two scopes*; integration *does not group one path across two repositories* |
| AC-10 ⟳ `subjectId` forms a **group**, never a link | PASS | integration *groups the statements naming the CI workflow as their subject*; unit *never emits a link for a shared subject* |
| AC-11 ⟳ a contradiction is a link; nothing is resolved | PASS (mechanism), NOT EXERCISED (corpus) | unit *reports a contradiction*. No `contradicts` edge has ever formed in either corpus — reported in `absent`, never manufactured |
| AC-12 ⟳ no epistemic field: no confidence, authority, state or verdict | PASS | unit *carries no statement text*; integration asserts the serialized index contains neither `verified` nor `stale`; the type has no such field |
| AC-13 aggregating writes nothing | PASS | integration *writes nothing* — full `entity`/`relationship`/`evidence` counts plus every lifecycle, before and after |
| AC-14 ⟳ EPIC-137 verdicts unchanged per member, not summarized | PASS | integration *holds a verified and a stale statement in one group* — verdicts unchanged for every member not resting on the moved path |
| AC-15 the index cannot produce `verified` | PASS | integration *carries no index at all* (no reader → no index); the index reads no hash and calls no code-state reader |
| AC-16 ⟳ a superseded member stays delivered and is not made trustworthy | PASS | integration *reports the supersession…* asserts `current: false` on the superseded end and `true` on the replacement; dogfood |
| AC-17 a `candidate` is not promoted by appearing in the index | PASS | unaffected: the index carries no lifecycle field. `standing` byte-identity (AC-1) covers it |
| AC-18 ⟳ **withdrawn** — authority triples | N/A | §7.6. Authority stays on `standing`; §26.2 measured durable-context authority as the constant `asserted`/`ferret`/`20`, so the triples were vacuous |
| AC-19 a withheld record is not a member and not a bridge | PASS | unit *drops an edge whose other endpoint is not on the page*; integration *asks only about ids the caller was already given* |
| AC-20 no per-cluster withheld count; pack `withheld` unchanged | PASS | the index has no such field; `withheld` untouched in every integration pack |
| AC-21 a path is contained the way `locator.detail` already is | PASS | unit *inspects the path and detail it emits*. **Stated honestly:** `contentSafety.inspected` rises by the number of index strings, because containment inspects them; `contained`, `marked` and `neutralised` are unchanged for ordinary values, and a multi-word `detail` is wrapped exactly as a statement is |
| AC-22 the four MCP refusal contracts still pass | PASS | `tests/integration/mcp/` — no tool added, removed or unpublished |
| AC-23 exactly one extra store read, zero extra anchor reads | PASS | integration *costs exactly one relation read* — the port is instrumented and called once; anchors come from the observations step 4 already fetched |
| AC-24 reads bounded to the retrieved ids | PASS | integration *asks only about ids the caller was already given*; `relationsAmong` is `inArray(from) AND inArray(to)` over the page |
| AC-25 ⟳ totally ordered, and two builds agree | PASS | unit *orders links by relation then endpoints* (both arrival orders identical) and *orders anchor groups by scope then path*; integration *produces an identical index on two builds* |
| AC-26 ⟳ **withdrawn** — `clusterId` | N/A | §7.6. Nothing in the index is durable and there is no derived identity to hash |
| AC-27 no statement text; every id appears in `standing` | PASS | unit *carries no statement text*; integration checks every group id against `pack.standing` |
| AC-28 ⟳ charged, and dropped **whole** when it does not fit | PASS | integration *charges the index* and *drops the index whole rather than partially, and says so*. Also strengthened beyond the AC: a build with **no reader** reports no index at all rather than groups with empty links (see below) |
| AC-29 nothing durable added | PASS | no migration, table, entity kind, relationship type or lifecycle state in the diff |
| AC-30 `boundaries.test.ts` holds | PASS | `src/context/aggregate.ts` imports only `../security/index.js`; suite green |
| AC-31 EPIC-130/131 suites and the golden dataset unchanged | PASS | full suite green; `task-assembly`, `context-duplicates`, `context-standing`, `context-pack` unchanged in behaviour |

**One criterion was strengthened during implementation, and it was found by a
failing test.** A build with no relation reader still emitted anchor and subject
groups, because those need no store read — leaving `links: []` on a pack where
nothing had looked. That is indistinguishable from a pack where no supersession
exists, which is the silent false negative §17.3 refuses in the budget case. The
index is now all-or-nothing on the reader (`src/context/pack.ts`), and two
integration tests assert it.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| **G1 — clusters** | N/A as written | Counts *multi-member clusters*, which the shipped primitive does not build. Restating it is an owner decision (§27.0) and was deliberately not done here |
| **G2 — independent contribution** | **PASS** | Measured on the populated corpus through the product path (below). All three claimed signals fire and each is independently observable; `contradicts` is read, not claimed, and the store holds zero instances, so the anti-gaming clause is satisfied |
| **G3 — kind combinations** | **PASS** | Populated corpus: `ci.yml` groups `constraint`+`decision`; EPIC-115 groups `decision`+`fact`; `exclusions.ts` groups `gotcha`+`fact`. Three cross-kind groups, formed naturally |
| **G4 — supersession and contradiction** | **PARTIAL** | Supersession: PASS, genuine and agent-authored, in both stores. Contradiction: **still 0**, never formed, nothing manufactured. §7.2.2 records that `contradicts` is a read path with no field evidence |
| **G5 — verification mixture** | **NOT YET PROVEN on a real corpus** | The capability is proven in the suite against real PostgreSQL by moving one indexed path (integration *holds a verified and a stale statement in one group*). On the real corpora it is **not** proven: the dogfood store reads `unknown` (`index-does-not-correspond`) and `ferret_agent_ab` holds 7 `verified` and 0 `stale`. A mixture needs a genuine change under a path a statement is anchored to, and **none of the twelve anchored paths is a file this branch changed** — so producing one would have meant manufacturing a change. Reported as not proven |
| **G6 — negative control** | N/A as written | Phrased as *"correctly not clustered"*. The property it protects holds and is tested — integration *never puts a statement sharing no record with the CI group into it* — but restating the gate is an owner decision (§27.0) |

### G2, measured on the populated corpus

`ferret_agent_ab`, through `ferret_context_pack` on the real MCP surface, 8
statements delivered:

```
links            5 supersedes 8
anchor groups    .github/workflows/ci.yml                 -> 1, 2
                 docs/EPICs/EPIC-115-macOS-…md            -> 2, 7
                 src/config/exclusions.ts                 -> 3, 4, 5, 6
subject groups   01110ce2 (ci.yml)                        -> 1, 2
absent           contradicts
601 estimated tokens of a 7 773-token pack
```

Leave-one-out, read directly off that index:

| signal | claimed | removing it alone | verdict |
| --- | --- | --- | --- |
| `supersedes` | yes | statement 8 appears in no other entry and is lost | **contributes** |
| shared anchor | yes | statements 3–7 lose every entry; 7 appears nowhere else | **contributes** |
| same subject | yes | the `ci.yml` subject group is lost; no other entry reports which entity a producer named | **contributes** |
| `contradicts` | no — read only | 0 instances in the store | anti-gaming clause satisfied; absence reported |
| `restates` | no — not read | structurally unreachable: EPIC-130 folds one endpoint before assembly (§7.2.3) | reason recorded |

**Two design claims are visible in that output and are worth naming.** The
`exclusions.ts` hub arrives as **one group of four statements resting on one
file**, not as a four-member cluster asserting they are one belief — the group is
true and the cluster's claim was not. And statements 1 and 7 are **not** joined,
although 1–2 and 2–7 both are: under connected components they would have been
one cluster through a statement that bridges two unrelated files. Composition is
refused, so they are two named groups and nothing claims a relationship that no
record carries.

## Suites

| Suite | Result |
| --- | --- |
| `tests/unit/context-aggregate.test.ts` | 28 pass |
| `tests/integration/retrieval/context-relation-index.test.ts` | 19 pass (real PostgreSQL 17 + pgvector) |
| `npm run test:unit` | 2 541 pass, 103 files |
| `npm run test:integration` | 1 640 pass, 7 skipped |
| `npm run test:security` | 166 pass |
| lint · typecheck · build | clean |

Each targeted test was observed failing before the code that satisfies it. Three
failures were genuine and are recorded rather than smoothed over:

1. `context-pack.test.ts` pinned `formatVersion` to `2`. It failed, which is what
   the literal is for; it is now `3`.
2. The anchor groups did not form, because the fixture set a file's `source_id`
   to a composite rather than the repo-relative path — the value
   `CodeStateStore` resolves against. A fixture defect, and it found nothing
   wrong in the product.
3. A build with no relation reader emitted groups and no links. That was a
   product defect, and it is the strengthening recorded above.

One package-size guard was crossed and raised with the measurement, per that
file's own convention: non-grammar output 3 562 203 at `main` (`f3dd73d`) against
3 589 679 with this change — 27 476 bytes, every one of them Ferret's own output,
grammars unchanged at 5 881 661, no dependency added. Measured in a second
worktree on both sides before the number moved.

## What remains unproven

Stated plainly, because the alternative is a validation record that reads as more
than it is.

- **Whether the index changes what an agent does.** §25 is not run. C5 is
  withdrawn (EPIC-130 already folds restatements), C2 is operator-dependent
  (contradiction needs a `subjectId`, adoption 0), so C1 and C4 are the runnable
  pair — the same *two of five* §26.3 already calls insufficient. EPIC-137 was
  correct and safe and produced no rediscovery saving; nothing here claims more
  than that until it is measured.
- **G5 on a real corpus** — see above.
- **`contradicts` in the field.** Never formed. The read is one branch of an
  existing query and its absence is reported, but it is not a demonstrated
  capability.
- **Subject groups from an agent.** Every subject in either corpus is
  operator-supplied. On agent-recorded context the subject group is empty.
