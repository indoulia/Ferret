# EPIC-058 — Permission-Aware Retrieval

**Status: IMPLEMENTED | Priority: P0 | Domain: Search & Retrieval**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Unusually, almost every requirement here was written down by another Epic. Six
> shipped Epics name EPIC-058 as the owner of a control they deliberately did not
> apply, and §2 quotes each. **Nothing here invents a requirement.** Where a
> plausible requirement is *not* on record, §4 excludes it and names the owner.
>
> Authored after a readiness review against `e586a97` measured what exists; §2, §3
> and §8 describe the code as it is.

## 1. Objective

Evaluate authorization before information enters a retrieval result, on every
retrieval read, and make it impossible for a retrieval caller to forget.

## 2. Value

Governance §12 is unambiguous:

> Security controls are enforced by Ferret, not by AI prompts. **Authorization
> must be evaluated before protected information enters retrieval results.**

Six Epics have written down what this one owes them.

> **Permission filtering is opt-in at the call site.** EPIC-058 must make it
> mandatory on the retrieval path — an internal caller omitting it is correct, a
> retrieval caller omitting it is a leak.
> — `Checkpoints/EPIC-008.md:112`

> Scope is not yet applied to retrieval → **EPIC-058**
> — `Checkpoints/EPIC-009.md:103`

> No permission filtering → **EPIC-058**
> — `Checkpoints/EPIC-052-053.md:81`

> EPIC-022 consumes this at discovery time and **EPIC-058 at retrieval time**.
> — `Architecture/EPIC-003-DECISIONS.md:71` (D-003, exclusions)

> Authority governs which answer is preferred; it never governs whether evidence
> may be *seen*. That is EPIC-058 and EPIC-083, and conflating the two would let
> a low-authority source become invisible rather than merely outranked.
> — `EPIC-044-045-…md:152`

> **Permission-scoped relationship reads** — EPIC-058. The table has no
> `permission_scope` and this Epic does not add one.
> — `EPIC-049-Relationship-Storage.md:51`

Measured on `e586a97`, the position is worse than "not yet done".

1. **`RetrievalPort` has no authorization parameter at all.** `search`,
   `findEntities`, `getEntity` and `neighbours` take a query and nothing else, so
   no caller *can* filter, and no reviewer can see that one failed to.

2. **A search hit carries a permission scope it never checks.**
   `storage/retrieval.ts` selects evidence rows into a hit and maps
   `permission_scope` onto the result (`:519`) — the value is *carried* and never
   *consulted*. Full-text search covers evidence statements, so a protected
   observation's content is matched and returned verbatim. This is the precise
   failure §12 names, in the one path an AI client uses most.

3. **The one filter that exists has no caller.** `EvidenceStore.forSubject`
   filters on `permittedScopes` correctly, and its own doc says why: "Omitted
   means unrestricted, which is correct for internal callers and wrong for a
   query on a user's behalf." Three shipped Epics — 048, 060, 062 — thread the
   parameter through their contracts and every one of them passes nothing. The
   seam was built; nothing was ever put through it.

4. **Exclusions stop at discovery.** EPIC-003 made exclusion incapable of
   deletion precisely so a rule added later could take effect without erasing
   history, and D-003 assigns retrieval-time application here. A path excluded
   after it was indexed is still fully answerable today.

So Ferret currently has a permission model, a scope model, an exclusion model,
one working filter, and no enforcement.

## 3. Scope

- An **access context** — the permitted permission scopes, the EPIC-009 scope
  selector, and the EPIC-003 exclusion rules in force — as one value.
- **A mandatory parameter** on every `RetrievalPort` read, so omission is a
  compile error rather than a leak.
- **Filtering in SQL** for permission scope and repository scope, so protected
  rows are never assembled into a result.
- **Retrieval-time exclusion** of paths a rule excludes, evaluated as policy
  stands (or as it stood, for a question about the past).
- **Permission-scoped evidence reads**, so the traceability and selection
  surfaces filter as well as the search surface.
- **Withholding reported as a count**, so a partial answer is distinguishable
  from a complete one without disclosing what was withheld.
- **Composition** through the context pack, the answer pack and the MCP server,
  with the context derived from configuration.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Deciding who the caller is.** There is no authentication and no identity
  assertion. The access context comes from **configuration** — registered,
  trusted input — never from the AI client, and never from repository content.
  Authenticating a principal is **EPIC-068** (AI Authorization Model);
  enforcement beyond retrieval is **EPIC-083**.
- **Adding `permission_scope` to `entity` or `relationship`.** EPIC-049 states
  the relationship table has none and did not add one; the entity table has none
  either. No schema change here: this Epic enforces what is stored. A column, if
  wanted, is a governance change — see §16.
- **Interpreting a permission scope's meaning.** It is an opaque token
  (`Checkpoints/EPIC-008.md:128`). Ferret compares it; it does not parse it into
  groups, roles or hierarchies. That is EPIC-083.
- **Audit events** for a denial — EPIC-085.
- **Deleting excluded content** — EPIC-088. Exclusion hides; it never erases.
- **Ranking** — EPIC-056/057. Exclusion is not demotion, and §2 quotes the reason
  authority and visibility must stay separate.
- **Row-level security in PostgreSQL.** The filter is in Ferret's queries, which
  is where Governance §12 puts the control ("enforced by Ferret").
- **Destructive-operation confirmation** — EPIC-069.

## 5. Inputs

- `ScopeSelector`, `ScopeContext`, `evaluateScope`, `isInScope` (EPIC-009).
- `ExclusionRule`, `evaluateExclusion` (EPIC-003).
- `evidence.permission_scope` and `entity.source_scope` as stored (EPIC-008,
  EPIC-006).
- `EvidenceQuery.permittedScopes`, already implemented (EPIC-044).
- Resolved configuration, for the context the MCP server is composed with.

## 6. Outputs

- `AccessContext` and `PUBLIC_ACCESS` in the core.
- `RetrievalPort` methods taking `access` as a **required** parameter.
- `RetrievalResult` — hits plus `withheld`, a count.
- `EvidenceReader` reads taking the same context.
- `ContextPack.withheld` and `AnswerPack.withheld`, reported as omissions.
- The MCP server composed with a context derived from configuration.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-003 Configuration Engine | VALIDATED | `ExclusionRule`, `evaluateExclusion`, `effectiveFrom` |
| EPIC-006 Canonical Entity Model | VALIDATED | `entity.source_scope` |
| EPIC-008 Evidence & Provenance Model | VALIDATED | `permission_scope` on every record |
| EPIC-009 Identity & Scope Model | VALIDATED | the selector, the context, the evaluator |
| EPIC-044 Evidence Store | VALIDATED | the existing `permittedScopes` filter |
| EPIC-052/053 Retrieval | VALIDATED | the read paths being gated |
| EPIC-048/060/062 | IMPLEMENTED | the surfaces that must pass a context |
| EPIC-064/065 MCP | VALIDATED | the composition root that supplies it |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **Scoped content is denied by default.** An access context with no permitted
  scopes sees unscoped content and nothing else. Unscoped content stays visible,
  because everything Ferret indexes today is unscoped and a default that hid it
  would be a different product rather than a safer one. A provider that sets a
  scope is protected from the moment it does so, without anyone remembering to
  configure anything.
- **Authorization is a parameter, not a default.** Every `RetrievalPort` read
  requires an `AccessContext`. `PUBLIC_ACCESS` exists and is named, so a caller
  that means "no restriction" says so in code a reviewer can grep for — which is
  the difference between an audited decision and a forgotten one.
- **Filtering happens before assembly.** Permission scope and repository scope
  are `WHERE` clauses. A protected row is never read into a hit, so it cannot
  leak through a log, an error, a highlight or a partially-built result.
- **Exclusion never widens.** Exclusion is evaluated after inclusion and always
  wins, which is EPIC-003's and EPIC-009's rule, not a new one.
- **Withholding is counted, never described.** `withheld` is a number. No id, no
  kind, no path, no source system, no reason naming the rule. A count says an
  answer is partial; anything more would answer the question the filter exists to
  refuse. See §16.
- **A denial is not an error.** Withheld content produces a smaller result, not a
  thrown error, because an error is itself a disclosure and because a partial
  answer is a normal outcome.
- **A policy Ferret cannot evaluate withholds, and says so at composition.**
  Per row, an unparseable selector or exclusion instant withholds rather than
  throwing: this runs on the answer path, and a configuration defect must not
  turn every query into an error. `assertUsableAccess`, called once by the
  composition root, is where an operator hears about it — because failing closed
  silently would leave them looking at an empty index and blaming Ferret.
- **Visibility never depends on repository content.** The context comes from
  configuration only. A file that declares itself public is data, not policy
  (Governance §12).
- **Authority and visibility stay separate.** Nothing here changes a rank, and
  nothing about a rank changes visibility.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | Every `RetrievalPort` read requires an access context; omitting it does not compile. | `Checkpoints/EPIC-008.md:112` |
| AC-2 | Evidence carrying a permission scope the caller does not hold is absent from search results, and its statement never appears. | Gov §12; `retrieval.ts:519` |
| AC-3 | Evidence carrying a scope the caller **does** hold is returned. | Gov §12 (a filter that hides everything is not a filter) |
| AC-4 | Unscoped content is returned to a caller with no permitted scopes. | §8 |
| AC-5 | Filtering is expressed in SQL, so a protected row is not read into a result. | Gov §12 "before … enters" |
| AC-6 | An entity outside the caller's scope selector is absent from search, exact lookup, entity query and traversal. | `Checkpoints/EPIC-009.md:103` |
| AC-7 | Exclusion wins over inclusion in every case. | EPIC-003; EPIC-009 |
| AC-8 | A path excluded by a rule is absent from retrieval results even though it is indexed. | EPIC-003 D-003 |
| AC-9 | A question answered as of an earlier instant applies the rules in force then. | EPIC-003 `effectiveFrom` |
| AC-10 | Withheld content is reported as a count and nothing else — no id, kind, path, source or rule. | Gov §12; Gov §6 |
| AC-11 | Withholding produces a smaller result, never a thrown error. | §8 |
| AC-12 | Evidence reads on the traceability and selection paths filter by the same context. | EPIC-048 AC-11 (PARTIAL); EPIC-062 §11 |
| AC-13 | A context pack reports withheld content as an omission and a count; an answer pack reports it through `unknowns`, which is that surface's omission channel. | EPIC-059; EPIC-060 |
| AC-14 | The MCP surface derives its context from configuration and never from tool input. | Gov §12; §4 |
| AC-15 | Nothing about a permission scope changes a ranking or an authority rank. | `EPIC-044-045-…md:152` |

## 10. Test requirements

**Unit.** The access context and its evaluation: deny by default, hold-the-scope,
unscoped visibility, exclusion beating inclusion, point-in-time rules, and that a
withheld report carries no identifying field.

**Integration.** Against a real PostgreSQL: scoped evidence recorded and then
searched by a caller who does not hold the scope — absent from the results and
its statement absent from the response; the same caller holding the scope — 
present. An excluded path indexed and then withheld. An entity outside the scope
selector absent from all four read paths.

**Failure.** A malformed selector, an unparseable pattern, and an empty permitted
set must all deny rather than throw or admit.

**Security.** The regression that matters: a full-text query whose terms appear
**only** in protected evidence must return nothing, and the response must not
disclose that anything matched. Asserted through the MCP surface, not only at the
store.

**Performance.** The filter is a `WHERE` clause on indexed columns
(`evidence_permission_idx`, `entity_scope_idx` both exist), so it must not change
the query plan's order of magnitude.

## 11. Security requirements

- Authorization is evaluated in SQL, before rows become results (Gov §12).
- The access context originates in configuration. No tool input, no repository
  content, and no evidence statement can widen it.
- A withheld item is counted and never described.
- A denial is not an error, so no error path can be used to probe for existence.
- Nothing in this Epic parses a permission scope; comparison only.

## 12. Observability

- `withheld` on every retrieval result, and as an omission on a pack.
- A debug-level log line per read recording *how many* were withheld and by which
  mechanism (permission, scope, exclusion) — never which items. Enough to answer
  "why is this answer short" without answering "what am I not allowed to see".

## 13. Performance constraints

- One additional `WHERE` clause per read.
- **One additional query per search**, and only to count what was withheld:
  `count(*)` over the same text predicate with the permission predicate negated,
  selecting no content columns at all. A windowed count over the main query would
  have saved the round trip and broken AC-5, because the protected rows would have
  had to be read to be counted. The search path already issues one
  `#readEvidence` per evidence hit, so an aggregate is not this file's
  performance frontier — recorded here as a known cost rather than discovered
  later.
- Exclusion is evaluated in the core against paths already fetched, because glob
  matching is not SQL. Bounded by the page size, and the volume is small by
  construction: EPIC-022 already excludes at discovery, so retrieval-time
  exclusion catches only rules added after indexing.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, integration, failure and security tests pass; the regression suite passes.
- `docs/EPICs/validation/EPIC-058-VALIDATION.md` records the evidence.
- Registry entry updated, and the EPIC-008 `PARTIAL` row it closes is named.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§12 Security** — the requirement, quoted in §2. Enforced by Ferret, before
  information enters results, never by prompt.
- **§11 Retrieval** — "Retrieval must be evidence-aware, permission-aware,
  freshness-aware, and explainable." This Epic supplies the second.
- **§6 Evidence Before Inference** — a withheld result makes an answer partial,
  and partial is represented rather than flattened.
- **§7 Source Authority** — authority and visibility stay separate.
- **§5 Reuse Before Reinvent** — the scope model, the exclusion evaluator and the
  evidence filter already exist and are consumed.

## 16. Raised for governance

**Two decisions this specification makes rather than finds on record.**

**Withholding is disclosed as a count.** Governance §6 asks Ferret to represent a
partial answer; §12 asks it not to disclose protected information. A count
satisfies the first with the least exposure to the second — but a count is not
*zero* disclosure: it tells a caller that something exists which they cannot see.
No approved document decides this. The alternative, silent filtering, was rejected
because an answer that is quietly short is the failure mode every honesty contract
in Ferret exists to prevent. If a deployment needs the stricter behaviour, that is
a configuration decision and an Epic.

**Scoped content is denied by default; unscoped content is not.** Also not on
record. A default that hid unscoped content would hide everything Ferret indexes
today, which is a different product. A default that showed scoped content would
make the control opt-in, which is the defect this Epic exists to fix.
