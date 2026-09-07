# EPIC-135 — Exclusion Enforcement at Ingestion

**Status: PROPOSED | Priority: P0**
**Domain:** Security & Authorization
**Classification:** CORRECTIVE

> **Awaiting owner approval.** Scope and acceptance criteria are defined below so
> the Epic can be reviewed, but nothing here is approved and nothing has been
> implemented. The defect was found on 2026-09-07 while verifying the continuity
> benchmark's corpus and was **deliberately not fixed** in that work — see
> [§16](#16-why-this-was-deferred).

## 1. Objective

A configured exclusion prevents a path from being **acquired and stored**, not
merely from being returned.

## 2. Problem, observed

`exclude` is documented as *"Paths excluded from indexing"*
(`src/config/schema.ts:130`). It is currently enforced on the **read** path only.
Excluded files are read from disk, written to the store as entities, and their
full text is retained; queries then filter them out.

Observed on the `ferret-dogfood` store on 2026-09-07, immediately after
`node scripts/dogfood-db.mjs --index` at merge `b8ea20c`:

| Observation | Value | How it was obtained |
| --- | --- | --- |
| `file` entities for excluded paths | 27 | `SELECT count(*) … kind='file' AND path LIKE 'benchmark/%' OR path LIKE 'docs/evidence/FERRET-DOES%'` |
| `file_version` entities for `benchmark/` | 43 | same table, `kind='file_version'` |
| Excluded file content retained in `content_blob` | **1 463 485 bytes** | sum of `byte_size` over blobs reachable from those `file_version` rows |
| Text of an excluded file readable in the store | yes | `SELECT left(text_content, 90) …` returned the file's opening comment verbatim |
| `first_indexed_at` of `benchmark/continuity/*` | `2026-09-07` | the rows were **created** by that run |
| `exclude` in force at that run | `["benchmark", "docs/evidence/FERRET-DOES-IT-HELP.md", "docs/evidence/FERRET-DOES-CONTEXT-CARRY.md"]` | `ferret config list` |

**The timing rules out the obvious alternative.** `benchmark` has been excluded
since 2026-09-06. `benchmark/continuity/` did not exist until 2026-09-07 and was
first indexed by the run above — so the rows were created *while the exclusion
was in force*, rather than surviving from before it.

`ferret_config_exclusions` reports each of these paths as `excluded: true`, and
the read path agrees with it:

| Surface | Excluded path returned? |
| --- | --- |
| `ferret_find` (`kind: file`, exact path) | no |
| `ferret_search`, three queries worded to match the harness | no — 0 of 30 results |
| `ferret_context_pack` | no — 0 of 5 items |

So the read controls work. What does not happen is the acquisition being
prevented in the first place.

### Two different things are called "exclusion"

This distinction is why the defect can look deliberate, and resolving it is part
of the Epic.

| | **Indexing exclusion** | **Permission withholding** |
| --- | --- | --- |
| Configured as | `exclude` (top-level) | `authorization.scope.exclude`, permission scopes |
| Owned by | EPIC-003, EPIC-017, EPIC-082 | EPIC-058, EPIC-083 |
| Documented intent | *"Paths excluded from indexing"* | hide from a caller who may not see it |
| Approved position on deletion | none stated | *"Exclusion hides; it never erases"* (EPIC-058 §4); *"Enforcement hides; it never erases"* (EPIC-083 §4) |

EPIC-088 §4 declines *"Deleting excluded content"* and cites EPIC-058 and
EPIC-083 for it. Both of those are speaking about **permission withholding** —
EPIC-083's own wording is "withheld content" — so the approved
hides-never-erases position is about content a *caller* may not see, not about a
path an *operator* told Ferret not to read.

Read as covering indexing exclusions too, that sentence makes the observed
behaviour sound intentional. It is not the same mechanism, and EPIC-082 §3 is
explicit in the other direction for the indexing kind: *"Redaction at
**ingestion**, before anything is written."*

**Observed:** `effectiveExclusions(config)` — the *indexing* rules — is placed
into the read-side access context at `src/authorization/authorization.ts:287`.
That is why reads filter these paths, and it is the mechanism currently standing
in for the ingestion gate.

An outcome of this Epic is that the two are named distinctly wherever they are
specified, so neither is read as licence for the other.

### Status of claims

| Claim | Class |
| --- | --- |
| Excluded paths are present as entities with retained content after re-indexing | **observed**, table above |
| Those rows were created while the exclusion was in force | **observed**, `first_indexed_at` |
| The read path excludes them from `ferret_find`, `ferret_search`, `ferret_context_pack` | **observed** |
| `effectiveExclusions` reaches repository *discovery* (`src/git/provider.ts:191` → `walkForRepositories`) and no per-file ingestion path was found applying it | **inferred** — a starting point for design, not a root cause |
| Which component should own the gate, and how already-stored content is removed | **pending** — §11 and §12 |

## 3. Value

Three things currently rest on an exclusion meaning less than it says.

**A user excluding a secret-bearing path does not get what they asked for.**
EPIC-082 §3 lists *"Redaction at **ingestion**, before anything is written"* and
*"Default path exclusions for secret-bearing files"* as the same scope item, and
its §2 records the demonstrated problem as `.env` and
`secrets/prod-db-password.txt` *"indexed as file entities"*. A path exclusion
that stores the file and hides it from queries does not close that problem; it
relocates it behind an access control. Credential **redaction** is unaffected and
still runs — this is about the path-exclusion half.

**Retention is not what an operator would infer.** Excluding a path today leaves
its content in the database indefinitely, with no signal that it is there.

**A read-time-only control has a wider blast radius than a gate.** Every future
surface, export, diagnostic and backup has to remember to apply it. A gate at
ingestion has to be right once.

## 4. Scope

1. Exclusion evaluated and enforced at **acquisition**, so an excluded path is
   not read into the product and no entity, version, blob or derived artefact is
   written for it.
2. Coverage of every ingestion route that can reach a file, not only repository
   discovery — including content indexing, re-index, incremental sync, and
   connector-driven ingestion where a path exclusion applies.
3. Defined semantics for content already stored under a path that is *now*
   excluded (§11).
4. Defined semantics for **changing** an exclusion set — adding, removing and
   narrowing (§12).
5. Reporting: an index run states how many paths it skipped for exclusion, and
   under which rule, without naming what it did not read where that would
   disclose it.
6. Regression coverage proving excluded paths never enter the corpus (§10).

## 5. Non-scope

- **Weakening or replacing the read-path controls.** EPIC-058's permission-aware
  retrieval and EPIC-083's authorization enforcement stay exactly as they are.
  Ingestion enforcement is defence in depth added *beneath* them, not a
  substitute, and an acceptance criterion below pins that they still hold.
- **Credential detection and redaction.** EPIC-082 owns it and it is working.
- **Retroactive scrubbing as a general capability.** EPIC-088 owns deletion and
  is the only place Ferret deletes anything. This Epic must define what happens
  to already-stored excluded content, and should reach EPIC-088's mechanism
  rather than build a second one. Its §4 currently declines *"deleting excluded
  content"*; whether that decline covers indexing exclusions is the ambiguity
  §2 identifies, and resolving it is in scope.
- **Changing what permission withholding means.** EPIC-058 and EPIC-083 keep
  "hides, never erases" exactly as approved.
- **Changing the exclusion pattern language** or the `exclude` configuration
  shape. The rules are evaluated correctly; where they are evaluated is the
  defect.
- **Choosing the implementation.** See §16.

## 6. Inputs

- `exclude` from configuration, plus `DEFAULT_EXCLUSIONS` — via
  `effectiveExclusions`, unchanged.
- Repository policy files (`.ferret/config.json`) at their existing precedence.
- The existing rule evaluator (`evaluateExclusion`), unchanged.

## 7. Outputs

- An ingestion path that emits nothing for an excluded file.
- A per-run exclusion report (counts and rules).
- Defined, documented behaviour for pre-existing stored content under a
  newly-excluded path.

## 8. Dependencies

| Epic | Why |
| --- | --- |
| EPIC-003 — Configuration Engine | supplies the rules and their precedence |
| EPIC-082 — Secret Detection & Exclusion | states the ingestion-time requirement this Epic did not meet |
| EPIC-088 — Retention & Exclusion Policies | owns deletion; §11 likely depends on `ferret prune` rather than a second mechanism, and §4 of that Epic must be reconciled with this one |
| EPIC-017 — Local Repository Discovery | current holder of the only observed enforcement point |
| EPIC-058 / EPIC-083 | the read-path controls that must remain intact |

## 9. Contracts

- **An excluded path produces no observable artefact.** No entity, no version,
  no blob, no derived artefact, no evidence, no search-vector contribution.
- **Exclusion is evaluated before content is read**, not after.
- **A skip is reported, not silent.** A run that excluded nothing and a run that
  excluded a thousand paths are distinguishable — the discipline
  `src/git/provider.ts` already applies to a directory it refuses to walk.
- **Read-path exclusion remains in force** regardless, so a store written by an
  older build is no less protected than it is today.

## 10. Acceptance criteria

| # | Criterion |
| --- | --- |
| AC-1 | Indexing a repository with a configured exclusion writes **no** entity, version, blob or derived artefact for any matching path. |
| AC-2 | The content of an excluded file is not present in the store in any column, verified by querying storage directly rather than through a Ferret surface. |
| AC-3 | AC-1 and AC-2 hold on a re-index and on an incremental sync, not only on a first index. |
| AC-4 | AC-1 and AC-2 hold with content indexing enabled — the configuration under which the defect was observed. |
| AC-5 | A default exclusion and a user-configured exclusion are enforced identically. |
| AC-6 | An index run reports the number of paths skipped for exclusion, and the rule each was skipped by. |
| AC-7 | Adding an exclusion to a store that already holds matching content produces the behaviour defined in §11, and that behaviour is documented. |
| AC-8 | Removing an exclusion causes previously excluded paths to be ingested on the next run, with no stale state left over. |
| AC-9 | `ferret_find`, `ferret_search` and `ferret_context_pack` continue to exclude matching paths — the read-path control is verified still in force, not assumed. |
| AC-10 | A store written by a build predating this Epic is no less protected than before it. |

## 11. Already-stored excluded content

**Required outcome, not mechanism.** The Epic must answer, and document, what
happens when an exclusion is added to a store that already holds matching
content. At minimum it must be:

- **Detectable** — an operator can find out that excluded content is present.
- **Removable** — there is a supported way to remove it, including the content
  blob and anything derived from it, not merely the entity row.
- **Not silently retained** — the current behaviour, and the one that makes this
  a data-retention defect rather than a ranking bug.

Whether removal is automatic on the next run, an explicit operator command, or a
mode of EPIC-088's `ferret prune` is **an implementation and design decision and
is deliberately not made here.** The migration and purge mechanics,
including whether a migration is required at all, belong to that design.

## 12. Changing an exclusion set

Also required-outcome-only. The Epic must define, for each case, what the next
run does and what the store then holds:

| Change | Must be defined |
| --- | --- |
| exclusion added | §11 applies |
| exclusion removed | previously excluded paths become ingestable; no stale marker blocks them |
| exclusion narrowed or widened | the newly-covered and newly-uncovered sets both behave as above |
| exclusion added between runs, no re-index | what an operator is told, and whether the store is misleading in the interim |

## 13. Security requirements

- **Trust boundary.** An exclusion is a statement about what Ferret may read. It
  is currently enforced as a statement about what Ferret may *return*, and the
  two are different guarantees. This Epic moves the boundary to where the
  documentation already places it.
- **Sensitive paths.** The realistic case is a path excluded *because* it holds
  secrets — a `.env`, a key directory, a customer data fixture. EPIC-082's
  credential redaction still runs and is unaffected, but redaction covers known
  credential *formats*; a path exclusion is the control for everything else, and
  it must not be the weaker of the two.
- **No disclosure through the fix.** Exclusion reporting must not name or
  characterise the content it did not read where doing so would leak it. Counts
  and rule identifiers, on the pattern EPIC-058 already sets for withheld
  results.
- **No weakening.** AC-9 and AC-10 exist so this cannot be delivered by moving
  the control rather than adding one.

## 14. Test requirements

| Class | Case |
| --- | --- |
| unit | the exclusion gate refuses a matching path before any read occurs |
| integration | index a fixture repository with an excluded directory; assert **against storage directly** that no entity, version or blob exists for it |
| integration | the same, with content indexing enabled |
| integration | re-index and incremental sync, asserting the same |
| integration | remove the exclusion, re-run, assert the path is now ingested |
| integration | add an exclusion to a store already holding the content; assert §11's defined behaviour |
| security | an excluded secret-bearing fixture leaves no trace in any column |
| security | the read-path controls still exclude matching paths (AC-9) |
| regression | a guard that fails if any excluded path acquires a row — the check that would have caught this |

The integration and security cases must query **storage**, not a Ferret surface.
This defect was invisible from every MCP tool: `ferret_find` reported the file
absent while the row existed. A test written against the tool surface would have
passed throughout.

> This inverts `scripts/dogfood.mjs`'s rule — *"a defect that only SQL can see is
> not a defect a client will ever hit"* — and the inversion is the point. That
> rule is about defects a client experiences. This is a defect **defined** by
> what is retained rather than by what is served, so storage is the only place
> its acceptance criteria can be evaluated. Both rules stand; they answer
> different questions.

## 15. Observability

- Per-run counts of paths skipped for exclusion, by rule.
- A means for an operator to determine whether a store holds content under a
  currently-excluded path (§11, detectable).

## 16. Why this was deferred

Found on 2026-09-07 while verifying that the continuity benchmark had not
contaminated the corpus it measures. The verification succeeded — no excluded
path is returned by any surface — and the storage observation was incidental to
it.

It was **not** fixed in that work, by owner decision on the same day:

- It is outside the benchmark phase's scope, and folding a security and
  data-retention change into a measurement branch would make both harder to
  review.
- It is not a contained patch. It changes ingestion semantics, requires defined
  behaviour for existing stores, and may require a migration.
- It needs governance review as product and security work, which is what this
  Epic exists to obtain.

The benchmark documentation was updated in the same decision to state precisely
what its no-leakage guard proves and what it does not — `benchmark/README.md`
and `docs/evidence/FERRET-DOES-IT-HELP.md`. No benchmark scoring or semantics
changed.

## 16a. Ambiguity to resolve before implementation

Named separately because it is a governance question, not a coding one, and it
is what let the defect persist:

1. Does EPIC-088 §4's decline of *"deleting excluded content"* cover **indexing**
   exclusions, or only permission withholding? §2 argues the latter; the
   specification does not say.
2. Does EPIC-082's ingestion-time requirement bind path exclusions, or only
   credential redaction? Its §3 lists both under one scope item.
3. Whichever answers are given, the two mechanisms must be named distinctly in
   every specification that mentions either.

## 17. Definition of Done

- Every acceptance criterion in §10 met, with evidence in
  `validation/EPIC-135-VALIDATION.md`.
- §11 and §12 answered in this specification, reviewed, before implementation.
- The regression guard in §14 present and demonstrated to fail against the
  unfixed behaviour.
- `src/config/schema.ts`'s description of `exclude` true as written, or amended
  to match what is delivered.
- EPIC-082 updated to record that its ingestion-time requirement is met for path
  exclusions, or to state what remains.
- §16a answered, and EPIC-058, EPIC-083 and EPIC-088 amended only so far as
  naming the two mechanisms distinctly requires. No approved position on
  permission withholding is changed.

## 18. Governance alignment

- **§9 No Fake Completion** — the read-path control passing is not evidence that
  the documented control is enforced. Every acceptance criterion in §10 is
  evaluated against storage for that reason.
- **§10 Explicit Uncertainty** — the root cause is marked *inferred* and §11/§12
  *pending* in §2 rather than stated as known.
- **§13 Security Boundaries** — an exclusion is how an operator keeps sensitive
  data out of Ferret. Retaining the content of a path the operator excluded is a
  boundary enforced in the wrong place.
- **§15 Data Integrity** — indexing must be idempotent, which makes §12's
  "exclusion changed between runs" case a requirement rather than an edge case.
- **§21 Definition of Done** — DONE requires acceptance criteria, security
  review and validation evidence, not a passing surface test.
- **EPIC Specification Standard** — status may reach APPROVED only once scope and
  acceptance criteria are defined, and DONE only once validation evidence exists.
  This Epic is PROPOSED.
