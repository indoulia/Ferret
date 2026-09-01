# EPIC-058 — Permission-Aware Retrieval · Validation Evidence

**Assessed against:** working tree on top of `e586a97`
**Date:** 2026-09-01
**Specification:** [`../EPIC-058-Permission-Aware-Retrieval.md`](../EPIC-058-Permission-Aware-Retrieval.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

This Epic is unusual: almost every requirement was written down by another Epic.
Six shipped Epics named EPIC-058 as the owner of a control they deliberately did
not apply, and §2 of the specification quotes each. The specification was
authored as the first part of this change; nothing in it was invented.

The evaluation rules are pure and are demonstrated by unit tests. The property
Governance §12 actually asks for — that authorization is evaluated *before*
protected information enters a result — is a **fetching** claim, not a filtering
one, and no mock can make it: it is demonstrated against a real PostgreSQL by
searching for a phrase that exists nowhere but inside a protected evidence
statement. The whole path is then demonstrated over **real stdio against a real
index** with a protected row actually present.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** Every `RetrievalPort` read requires an access context; omitting it does not compile | **MET** | `findEntities`, `getEntity`, `neighbours` and `search` take `access` as a required second parameter (`src/retrieval/query.ts`). Demonstrated by the change itself: adding the parameter produced **117 type errors across 6 test files and 4 source files** — every one a call site that had been filtering nothing. A convention would have found none of them. |
| **AC-2** Protected evidence is absent from search results, and its statement never appears | **MET** | `permission.test.ts` — *"never returns a protected statement to a caller holding nothing"*: a phrase existing only inside the protected statement returns no hits, and the assertion is on the **whole serialized response**, not on the hit list — a `ts_headline` of a protected statement is the same disclosure as the statement. Confirmed in production (§3). |
| **AC-3** Evidence carrying a scope the caller holds is returned | **MET** | `permission.test.ts` — *"returns it to a caller holding the scope"*. The assertion that makes AC-2 mean something: a filter that hides everything proves nothing about authorization. |
| **AC-4** Unscoped content is returned to a caller with no permitted scopes | **MET** | `permission.test.ts` — *"still returns unscoped evidence to a caller holding nothing"*, and `permission-aware-retrieval.test.ts` — *"shows unscoped content to a caller holding nothing"*. |
| **AC-5** Filtering is in SQL, so a protected row is not read into a result | **MET** | `permissionPredicate` is a `WHERE` clause on the evidence branch of `search` and on every evidence read in `storage/evidence.ts`. The withheld count is a **separate query selecting no content columns**, precisely so counting does not read what filtering excluded — see §5. |
| **AC-6** An entity outside the scope selector is absent from search, exact lookup, entity query and traversal | **MET** | `permission.test.ts` — four tests, one per read path: `findEntities`, `getEntity`, `search`, `byIdentifier`. `getEntity` returns `undefined` for withheld *and* absent, so an exact lookup cannot be used to probe for existence. |
| **AC-7** Exclusion wins over inclusion in every case | **MET** | `permission-aware-retrieval.test.ts` — *"lets exclusion beat inclusion"*. EPIC-009's own rule, evaluated by `evaluateScope` rather than re-implemented, so precedence cannot drift between the two. |
| **AC-8** A path excluded by a rule is absent from results even though it is indexed | **MET** | `permission.test.ts` — *"withholds an indexed path a rule now excludes"*, over a real store, with a companion asserting an unexcluded path is untouched. This is the case EPIC-003 made exclusion incapable of deletion for. |
| **AC-9** A question answered as of an earlier instant applies the rules in force then | **MET** | `permission-aware-retrieval.test.ts` — *"applies the rules in force at the instant asked about"*: the same rule and entity withheld at one instant and visible at another. |
| **AC-10** Withheld content is reported as a count and nothing else | **MET** | `permission-aware-retrieval.test.ts` — *"carries counts and no identifying field at all"* asserts the report's key set is exactly `{total, byReason}` **and** that its serialization matches no `id|kind|path|source|rule|pattern` — so a field added later that named any of them fails this test. Confirmed in production: `withheld=1` with the phrase absent from the response. |
| **AC-11** Withholding produces a smaller result, never a thrown error | **MET** | `permission.test.ts` — *"does not throw when everything matching is protected"*. An error is itself a disclosure and would let a caller probe for existence by watching which queries fail. |
| **AC-12** Evidence reads on the traceability and selection paths filter by the same context | **MET** | `permission.test.ts` — five tests: `forSubject`, `forSubjectWithState`, `conflictsFor`, `verify` (which fails as *not found*, not as *forbidden*), and a companion asserting an internal caller supplying no scopes still reads everything, which is the distinction `Checkpoints/EPIC-008.md:112` draws. `provenanceOf` filters in the query and continues past a withheld ancestor, so the chain's shape does not disclose where the protected row sits. |
| **AC-13** A context pack and an answer pack report withheld content as an omission | **MET** | `ContextPack.withheld` plus a `TruncationReason.PERMISSION` omission — a new reason, because every other one is about *room* and a client that conflated them would report a budget problem where there is an authorization boundary. The answer pack reports through `unknowns`, which is that surface's omission channel. Confirmed in production (§3). |
| **AC-14** The MCP surface derives its context from configuration and never from tool input | **MET** | `access` is a `createMcpServer` dependency built in `cli/commands/mcp.ts` from `effectiveExclusions(context.config)`. No tool accepts a scope, a selector or an exclusion — verified by enumerating every tool's input schema in production (§3). `ferret_find`'s existing `scope` filter is ANDed with the access predicate, so it can only narrow; `permission.test.ts` — *"cannot be widened by a caller-supplied scope"* asserts that rather than reasoning about it. |
| **AC-15** Nothing about a permission scope changes a ranking or an authority rank | **MET** | No ranking code was touched: `fuse`, `preferredEvidence` and `selectEvidence` are unchanged by this Epic. `EPIC-044-045-…md:152` is the requirement — "conflating the two would let a low-authority source become invisible rather than merely outranked" — and the two mechanisms remain in different modules with no reference between them. |

**Summary: 15 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite: **87 files, 2052
passed, 3 skipped**, database suites against a real PostgreSQL. New:
`tests/unit/permission-aware-retrieval.test.ts` (20 tests),
`tests/integration/retrieval/permission.test.ts` (18 tests), 2 tests added to
`query-planner.test.ts`.

Enforcement demonstrated over **real stdio** against a real index of Ferret's own
repository, with a protected evidence row present and a phrase that appears
nowhere else:

```
SEARCH count=0 withheld=1
  phrase present in response:  false
  restricted summary leaked:   false

PACK items=0 withheld={"total":1,"byReason":{"permission":1}}
  omissions: permission-withheld

FIND files=465 node_modules=false dist=false

tool input schemas — nothing accepts a scope, a selector or an exclusion:
  ferret_search: query,kinds,limit
  ferret_get_entity: id
  ferret_neighbours: id,types,direction,at,includeHistorical,limit
  ferret_context_pack: question,budget,kinds,withNeighbours,format
  ferret_find: kind,attributes,scope,lifecycle,limit
  ferret_answer: question,budget,format
  ferret_why: id,field,depth
```

The one occurrence of the phrase anywhere in the pack response is
`"question": "zarquonembargo"` — the caller's own input, echoed back. The
protected statement appears nowhere.

Two things only production shows. The enforcement is reached by the **actual CLI
composition**, which is the failure EPIC-108 was caught by. And the withheld
count reaches a real client, which it did not until dogfooding found otherwise —
see §5.

## 4. Where the evidence is weaker than the criterion

**No production data is scoped, so the protected row was inserted for the
check.** Nothing in Ferret sets `permission_scope` today: the Git provider does
not, and no external provider exists yet (EPIC-071 is P1). The row in §3 was
written directly to the dogfood database. That is honest as a demonstration of
*enforcement* and it is not a demonstration of enforcement over data a provider
produced — which cannot exist until a provider produces some.

**The scope selector is always empty in production.** `cli/commands/mcp.ts`
supplies exclusions from configuration and leaves `permittedScopes` and `scope`
at their `PUBLIC_ACCESS` defaults, because Ferret has no authentication: there is
no principal whose scopes could be looked up, and asserting one from
configuration would be inventing a caller. So AC-6 is demonstrated in tests and
not in production. EPIC-068 is where a principal comes from; §4 of the
specification excludes it by name.

**Retrieval-time exclusion is demonstrated in tests, not in production.**
`node_modules` and `dist/` are absent from a production `ferret_find` — but they
were also excluded at *discovery*, so that result does not distinguish the two
mechanisms. The case that does — a path indexed before a rule arrived — is
`permission.test.ts` against a real store.

**One extra query per search.** Counting what was withheld is a second
`count(*)`. §13 records the cost and the reason a windowed count was rejected:
the protected rows would have had to be read to be counted, which is AC-5.

**`neighbours` filters on the reached entity, not on the edge.** EPIC-049 states
the relationship table has no `permission_scope` and did not add one; §4 declines
to add it here. So an edge is exactly as visible as the entity it reaches, which
is the whole control available without a schema change.

## 5. What dogfooding found

**The withheld count reached nobody.** The count was implemented on
`retrieval.search` and surfaced on `ferret_search`'s unplanned branch — and the
CLI wires a planner, so every real client takes the *planned* branch, where the
adapter mapped `.hits` and dropped the count. The production probe printed
`withheld=undefined`. The fix makes `TextStrategy.search` return a `SearchResult`
so the count survives the planner, and surfaces it on both branches of the tool.

This is the exact class of defect EPIC-048 was written to correct — a capability
that exists on a path nobody takes — and it was invisible to the test suite,
which exercised the store directly. Two planner tests now pin it, including one
asserting that an *exact* answer reports nothing withheld, because the ranked
branches never ran and a count from a branch that did not contribute would
describe a different answer.

**A malformed policy made every query throw.** `evaluateScope` rejects an invalid
selector, which is right — but it runs per row on the answer path, and the
integration test's first run failed with `Scope selector is not valid` on every
read rather than returning nothing. Failing loudly is wrong here and failing
silently is worse: an operator with a typo would see an empty index and conclude
Ferret was broken. `withholds` now fails **closed** per row and never throws, and
`assertUsableAccess` is called once by the composition root, where a `FerretError`
reaches a person who can fix it. Three tests pin both halves.

**A tool input that looked like a way in, and was not.** The probe enumerated
every tool's schema and flagged `ferret_find`'s `scope` parameter. It is an
EPIC-052 narrowing filter, ANDed with the access predicate, so it can only ever
narrow — but "it can only narrow" is precisely the kind of claim that stops being
true after a refactor, so it is now an assertion rather than an argument.

## 6. What this closes

- **EPIC-008's `PARTIAL` row** at `validation/EPIC-008-VALIDATION.md:121` —
  "Consumed by downstream retrieval contracts … No retrieval layer exists yet to
  consume them, so this is demonstrated against the interface rather than against
  a consumer." Permission-scoped reads now have a consumer, and it is the
  retrieval path.
- **EPIC-048's AC-11**, recorded as `PARTIAL`: "`permittedScopes` is on the port
  and `EvidenceStore.forSubject` already filters on it, but no caller supplies it
  and no test exercises the filter through this surface." Both now do.
- **`Checkpoints/EPIC-009.md:103`** — "Scope is not yet applied to retrieval".
- **`Checkpoints/EPIC-052-053.md:81`** — "No permission filtering".
- **`Architecture/EPIC-003-DECISIONS.md:71`** — exclusions at retrieval time.

## 7. Raised, not absorbed

Both recorded in the specification §16, because neither is on record anywhere and
both are decisions rather than findings:

- **Withholding is disclosed as a count.** A count is not zero disclosure: it
  tells a caller something exists that they cannot see. Silent filtering was
  rejected because an answer that is quietly short is the failure mode every
  honesty contract in Ferret exists to prevent.
- **Scoped content is denied by default; unscoped content is not.** A default
  that hid unscoped content would hide everything Ferret indexes today; one that
  showed scoped content would make the control opt-in, which is the defect this
  Epic exists to fix.

## 8. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 15 MET |
| Unit tests | Yes — 20 new, plus 2 on the planner |
| Integration tests | Yes — 18 against a real PostgreSQL |
| Failure and boundary cases | Yes — malformed selector, unusable instant, empty permitted set, entity with no path, caller-supplied scope |
| Security implications | The Epic *is* a security control; the leak it closes is demonstrated closed against a real database and over real stdio |
| Observability | `withheld` on every search result, on the pack, and on the MCP surface — counts only |
| Documentation | Specification and this document |
| Governance | §12, §11, §6, §7, §5 |
| Dependencies validated | EPIC-003, 006, 008, 009, 044, 048, 052, 053, 055, 059, 060, 062, 064, 065 |
| Known blockers | None |
