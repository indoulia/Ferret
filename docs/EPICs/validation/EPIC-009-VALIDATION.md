# EPIC-009 — Validation Evidence

**Epic:** EPIC-009 — Identity & Scope Model
**Branch:** `feat/epic-009-identity-and-scope-model`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Developers and AI agents are distinct identity classes | **PASS** | `ActorClass` has exactly two members mapping to distinct entity kinds. `assertSameActorClass` refuses to reconcile across them, `IdentityStore.merge` refuses a cross-class merge, and `link` refuses an alias whose claimed class disagrees with the entity it names. `scope.test.ts` → "actor classes" (4 cases); `identity-store.test.ts` → cross-class merge refused with the target left `active`. |
| AC-2 | A worktree cannot be incorrectly treated as a branch | **PASS** | `ScopeKind` has separate `repository`, `worktree` and `session` members; a worktree rule matches only that checkout. `scope.test.ts` → "keeps a worktree scope distinct from its repository". Reinforced upstream: EPIC-006 made them separate entity kinds and EPIC-007 made their relationships structurally distinct. |
| AC-3 | The same external identity can map to one canonical identity with auditable evidence | **PASS** | An alias carries `evidenceId` and `confidence`. `identity-store.test.ts` → "lets one actor hold several identities across systems" asserts the *inferred* alias carries its basis while a *stated* one need not, and "attaches the evidence to the moved alias" reads the supporting statement back through `EvidenceStore` after a merge. |
| AC-4 | Repository and session scopes can be included/excluded independently | **PASS** | Dimensions are evaluated separately and combined, not flattened into one ordered list. `scope.test.ts` → "treats repository and session as independent dimensions" asserts all four combinations of "in repository A" × "during session S". |
| AC-5 | Identity collisions are detected rather than silently merged | **PASS** | `link` returns a structured `collision` and **writes nothing**; a merge is a separate, deliberate call that requires evidence. `identity-store.test.ts` → "reports a second actor claiming an identity, and writes nothing" asserts the existing mapping is unchanged and the row count is still one. A partial unique index backs it at the database level. |
| AC-6 | Identity history is retained when mappings change | **PASS** | `unlink` closes the interval rather than deleting it, and `merge` closes the old mapping and opens a new one rather than repointing the row. `identity-store.test.ts` → "keeps the history of who held the identity" (both rows, one closed) and "answers who held it at a past instant". |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names seven test areas. All seven exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Identity creation | PASS | `scope.test.ts` → "identity aliases" (7 cases); `identity-store.test.ts` → "linking an identity" (5 cases) |
| Alias mapping | PASS | `identity-store.test.ts` → one actor holding three identities across two systems |
| Collisions | PASS | `identity-store.test.ts` → "collisions" (3 cases), including a cross-class collision |
| Branch/worktree separation | PASS | `scope.test.ts` → worktree scope distinct from repository scope |
| Scope filtering | PASS | `scope.test.ts` → "scope evaluation" (9 cases) and "merging selectors" (4 cases) |
| Changed identity | PASS | `identity-store.test.ts` → "an identity that is reassigned" (3 cases) |
| Concurrent reconciliation | PASS | `identity-store.test.ts` → 12 racing actors; a whole-table invariant; a check that contention is scoped |

### Coverage beyond the required list

- **Exclusion cannot be overridden** — a later, broader selector cannot widen
  what an earlier one refused, the same one-way rule as EPIC-003's exclusions.
- **Absent ≠ wildcard** — a context with no session is not matched by a session
  exclusion, so an unrelated item is not excluded by a rule about something it
  is not part of.
- **A self-merge is refused**, as is linking an identity to an entity that is not
  an actor at all.
- **A whole-table invariant** asserts no external identity ever has two current
  mappings, so a future change cannot break it on one code path and still pass.
- **Contention is scoped** — reconciling different people does not queue, which
  a lock keyed on the type alone would have caused.
- **An alias outlives its evidence.** Deleting the supporting evidence leaves the
  mapping with its justification gone rather than the mapping silently gone.

---

## 3. Concurrency

"Concurrent reconciliation" is an explicit test requirement, and the
read-decide-write shape here is the same one that produced write skew in
EPIC-007. The same remedy applies: a **transaction-scoped advisory lock keyed on
the external identity**, so writers contending for one identity serialize and
writers reconciling different people do not.

| Property | Test |
| --- | --- |
| Exactly one of 12 racing actors claims an identity | 1 `linked`, 11 `collision` |
| No external identity ever has two current mappings | whole-table group-by finds zero |
| Reconciling different identities runs in parallel | 4 links complete within 5 s |

The partial unique index `(system, external_id) WHERE valid_to IS NULL` is a
backstop rather than the mechanism — a judgement call is a poor thing to learn
about from a constraint violation, but a code path that forgets to check must
still be unable to corrupt the mapping.

---

## 4. Security

| Concern | Handling |
| --- | --- |
| **Attribution correctness** | The developer/agent boundary is enforced in three places: alias creation, merge, and the class-versus-entity check. Merging them would answer "who wrote this" with a bot, which is a security-relevant wrong answer, not a cosmetic one. |
| Silent identity merging | Refused. A collision is reported and nothing is written; merging requires a separate call **with evidence**. |
| Historical misattribution | A reassigned identity keeps its history, so an old commit is attributed to whoever held the address at the time rather than to whoever holds it now. |
| Scope as a protection | Exclusion always wins and cannot be widened by a later layer, so a narrower scope's refusal survives merging. |
| Injection | Every value is a bind parameter; the advisory-lock key is hashed server-side by `hashtextextended`. |

---

## 5. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical identity semantics documented | **PASS** | `src/domain/actor.ts` and `docs/Architecture/EPIC-009-DECISIONS.md`, including why aliases are a separate table from `entity_external_id`. |
| Scope semantics documented | **PASS** | `src/domain/scope.ts`; independence of dimensions, exclusion precedence and the merge rule each stated and tested. |
| Persisted | **PASS** | Migration `0005`, with temporal validity, evidence link, confidence and a partial unique index. |
| Tested | **PASS** | 24 unit + 25 integration cases. Total suite: 761 passing, 3 skipped. |
| Usable by providers and retrieval | **PASS at the interface** | `IdentityStore` (link, resolve, resolve-at, aliases, history, unlink, merge, collisionFor) and the pure scope evaluator are exported. No provider or retrieval layer exists yet to consume them — same honest caveat as EPIC-008. |

---

## 6. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| Nothing *proposes* reconciliations. Ferret records and adjudicates a mapping a caller asserts; it does not go looking for two addresses that are probably one person. | Identity resolution across sources remains manual until a provider or heuristic supplies candidates. | **EPIC-036** (Developer Identity), **EPIC-051** (Cross-Source Entity Resolution) |
| A merge is not reversible by a single call. The history is retained, so it can be undone by hand, but there is no `unmerge`. | An incorrect merge needs manual repair. | EPIC-009 follow-up if a provider makes merges routine |
| Scope selectors are not persisted. They are evaluated from whatever a caller supplies. | Storing a user's scope preferences belongs with configuration or the AI control plane. | **EPIC-066**, **EPIC-083** |
| Scope is not yet applied to retrieval. The evaluator exists; nothing filters by it. | Same caveat as EPIC-008's permission scopes. | **EPIC-058** — Permission-Aware Retrieval |
| Confidence on an alias is stored but never computed. | A provider must supply it, and most will not. | **EPIC-046** |
| No agent-to-agent or agent-to-developer "acted on behalf of" modelling. | An AI client acting for a developer is two actors with a session between them, which EPIC-039 will need to express. | **EPIC-039** — Session Model |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |

## Addendum — 2026-09-02, after EPIC-046

**The confidence limitation recorded above is closed in the part EPIC-046 owns.**
The table is left as written, for the reason EPIC-048's addendum gave: a record
that edited itself whenever a later Epic closed something would stop being
evidence of anything.

`confidence` now has a named scale, a propagation rule through `derivedFrom` — a
conclusion is no more certain than what it rests on — and one real producer: the
Git provider emits `RULE_CONFIDENCE[MAILMAP]` on the evidence it records when
`.mailmap` rewrote an address.

The decision worth knowing is a negative one. **Confidence is not derived from
`method`**, because EPIC-045's authority table already is, and a second number
keyed on the same input would restate it on a different scale. Confidence comes
from the specific rule that produced a statement — a distinction already
load-bearing, since `SAME_ADDRESS` and `SAME_NAME_AND_LOCAL_PART` are both
`inferred` and 0.45 apart.

So **most evidence remains unassessed, and that is the correct outcome** rather
than a shortfall: Git observation has no rule and needs none. The Epics that will
populate the field are the inferring ones — EPIC-035, EPIC-047, EPIC-051 — and
all three are unbuilt.

Evidence: `validation/EPIC-046-VALIDATION.md`.
