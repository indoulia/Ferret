# EPIC-083 — Authorization Enforcement

**Status: IMPLEMENTED | Priority: P0 | Domain: Security & Authorization**

> **Specification note.** The registry approved this Epic by name, domain and
> priority (`README.md:188`); no specification was ever written. This document
> supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> EPIC-068 §4, EPIC-058 §4, `Checkpoints/EPIC-008.md:128`,
> `Checkpoints/EPIC-009.md:102`, `validation/EPIC-008-VALIDATION.md:136`,
> `validation/EPIC-058-VALIDATION.md:250`, `validation/EPIC-066-VALIDATION.md:202`,
> and Governance §11 and §12. **Nothing here invents a requirement.** Where a
> plausible requirement is *not* on record, §4 excludes it and names the owner.
>
> §2 measures `57c6d21` and describes the code as it is. One defect it names
> was fixed in `2890824` while this Epic was being assessed, and §2 says so
> rather than quietly describing a repository that no longer exists.

## 1. Objective

Make authorization a property of every path that reads or changes indexed
knowledge — not only the MCP surface — and give a permission scope a defined
meaning.

## 2. Problem, measured

Measured on `57c6d21`.

**Enforcement exists in exactly one module.** `assertPermitted` is defined at
`src/authorization/authorization.ts:178`, exported, and called from
`src/mcp/guards.ts` and nowhere else. Every control EPIC-068 built is reachable
only by a caller who arrives over MCP.

**The CLI is not a caller Ferret authorizes.** `ferret index` builds a
`RepositoryIndexer` and runs it (`src/cli/commands/index-command.ts`);
`Permission.INDEX` exists and nothing consults it. The CLI touches authorization
once, at `src/cli/commands/mcp.ts:59`, and only to build the principal it hands
to the server it spawns. Governance §3 makes the CLI the bootstrap and recovery
interface — a real entry point, not a lesser one.

**The access context is optional with an unsafe default.**
`permissionFilter(undefined)` returns no `WHERE` clause
(`src/storage/evidence.ts:84–88`), so a caller-facing read that omits the
parameter sees everything. Defect [#85](https://github.com/indoulia/Ferret/issues/85)
was exactly that: `ferret_why` omitted it and returned in full a scoped statement
`ferret_search` withheld. One call site was wrong and was fixed.
**[#87](https://github.com/indoulia/Ferret/issues/87) is the same defect ten lines
below it**, found while assessing this Epic: the same handler called
`conflictsFor(id)` with no options, and reported to a caller holding nothing a
disagreement between two records it may not see — naming the field and both record
ids. Fixed in `2890824`. Two instances, one shape, and
`validation/EPIC-058-VALIDATION.md:250` had already assigned the remedy here —

> Making the access context impossible to omit on a caller-facing read — rather
> than optional with an unsafe default — is that Epic's work, and this defect is
> the demonstration that it is needed.

**A permission scope means nothing yet.** It is an opaque token compared by
string equality (`src/retrieval/access.ts:160`). `permission_scope` is a column
(`src/storage/schema/evidence.ts:78`) the indexer passes through
(`src/indexing/indexer.ts:849`), and no provider sets one. Four records assign
its interpretation here: `Checkpoints/EPIC-008.md:128`,
`validation/EPIC-008-VALIDATION.md:136`, EPIC-058 §4, and
`validation/EPIC-066-VALIDATION.md:202` — *"EPIC-083 still owns what a scope
means."*

## 3. Scope

1. **Enforcement at every caller-facing entry**, the CLI included — one point per
   operation, not one per surface.
2. **An access context that cannot be omitted** on a caller-facing read: the
   unsafe default removed at the type, not by discipline.
3. **A defined meaning for a permission scope** — a hierarchical token and a
   matching rule, so a grant covers what it obviously should and nothing more.
4. **A test that proves enforcement** by enumerating entry points from the
   source, rather than trusting review to notice the one that was missed.
5. **A default grant for the CLI**, because enforcing a permission on a surface
   that never had one requires deciding what an unconfigured operator holds. §16
   records this as the one decision no record dictated.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Authenticating a principal.** Declined by EPIC-068 §4 for a reason that has
  not changed: Ferret is spawned over stdio and there is no channel on which a
  credential could be presented. This Epic enforces a *configured* grant.
- **The MCP guard.** EPIC-068 built it; this Epic composes with it and does not
  rebuild it.
- **Audit events** for a decision or a denial — EPIC-085.
- **Confirming a destructive operation** — EPIC-069. Permitted and intended are
  different questions and both must hold.
- **Credential isolation** — EPIC-081.
- **Users, roles, groups or tenants.** Scope *hierarchy* is on record as this
  Epic's (EPIC-058 §4); a role system is not, and EPIC-068 §4's objection stands —
  with no authentication behind it, it is a configuration file with extra steps.
- **Adding `permission_scope` to `entity` or `relationship`.** EPIC-058 §4
  records this as a governance change. It still is.
- **A provider that sets a scope.** The producer belongs to whichever source Epic
  has scoped content; this Epic defines what the token means when one arrives.
- **Row-level security in PostgreSQL.** Governance §12 puts the control in
  Ferret's queries (EPIC-058 §4).
- **Deleting withheld content** — EPIC-088. Enforcement hides; it never erases.

## 5. Inputs

- `Principal`, `Permission`, `authorize`, `assertPermitted`, `accessContextFor`,
  `principalFrom`, `ANONYMOUS_PRINCIPAL` (EPIC-068).
- `AccessContext`, `PUBLIC_ACCESS`, `permits` (EPIC-058).
- `permittedScopes` in the configuration schema, `src/config/schema.ts:103`
  (EPIC-003).
- `ErrorCode.NOT_PERMITTED`, `FerretError` (EPIC-068/001).

## 6. Outputs

- A caller-facing read signature that carries an access context by construction,
  replacing `permittedScopes?:` on the evidence port and store.
- A named, greppable entry for the one legitimate unrestricted reader — the
  indexer reading back what it wrote.
- `scopeGrants(grant, scope)` — the single place a token becomes a membership
  decision.
- Authorization on the CLI's mutating commands.
- `LOCAL_OPERATOR_PRINCIPAL` and `localOperatorFrom(config)` — what an
  unconfigured CLI holds, and the one place that fallback is applied (§16).
- An architecture test enumerating enforcement points.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-003 Configuration Engine | VALIDATED | the grant surface |
| EPIC-058 Permission-Aware Retrieval | IMPLEMENTED | the access context and its filter |
| EPIC-068 AI Authorization Model | IMPLEMENTED | principal, permission, decision |
| EPIC-069 Destructive Confirmation | IMPLEMENTED | the second control on a mutation |
| EPIC-066 MCP Configuration Tools | IMPLEMENTED | the first permission-declaring tools |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **A caller-facing read cannot omit its access context.** Not "must not" —
  *cannot*: there is no signature that compiles without one. Defect #85 is the
  proof that a parameter which is optional with an unsafe default will eventually
  be omitted on the path nobody tests.
- **Unrestricted is a named decision, never a default.** The indexer's read-back
  is the one legitimate unrestricted reader and says so at a call a reviewer can
  grep for — the same reasoning that gave EPIC-058 `PUBLIC_ACCESS` and denied it
  an `UNRESTRICTED_ACCESS`.
- **One enforcement point per operation, not per surface.** A second surface
  reaching the same operation inherits the check rather than repeating it, so the
  two cannot drift.
- **The CLI is a principal.** Wherever configuration declares a grant, the CLI
  reads it through EPIC-068's `principalFrom` — one grant surface, so a CLI grant
  and an MCP grant cannot disagree. Only the *fallback* differs, and §16 says why.
- **A grant matches by hierarchical segment, never by substring.** This replaces
  EPIC-058's explicitly provisional "not a prefix match, not a hierarchy", which
  that Epic recorded as this one's to decide. Its test is inverted here, with the
  original reasoning preserved in place. `jira:proj-a`
  grants `jira:proj-a:issue-1` and does **not** grant `jira:proj-ab`. Substring
  matching on an opaque token is a silent over-grant.
- **Matching is pure and total.** No clock, no I/O, and a malformed token is
  denied rather than throwing — a scope parser that can crash is a denial of
  service on the read path.
- **Deny by default survives.** Nothing here widens a grant; a scope nobody
  granted stays withheld.
- **Withhold on read, raise on operation.** EPIC-058's rule and EPIC-068's rule
  both continue to hold, unchanged, on every path this Epic reaches.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | No caller-facing read accepts an omitted access context; the `undefined`-means-unrestricted default is gone from that path. | 058-VAL:250 |
| AC-2 | The indexer's read-back is a distinct, named unrestricted entry, greppable at its call site. | 058-VAL §9.1; EPIC-058 §4 |
| AC-3 | A CLI command that indexes asserts `Permission.INDEX` before the repository is read or a row is written, and refuses with `NOT_PERMITTED`. | EPIC-068 §4; Gov §3 |
| AC-4 | Wherever configuration declares a grant, the CLI reads it through `principalFrom` — the same function the MCP path uses. | EPIC-068 §8 |
| AC-13 | An unconfigured CLI may still index, and a configured one that withholds `INDEX` may not. | §16, and see the decision recorded there |
| AC-5 | A grant matches a scope by hierarchical segment prefix: `jira:proj-a` grants `jira:proj-a:issue-1`, not `jira:proj-ab`. | CP-008:128; EPIC-058 §4 |
| AC-6 | An exact grant still matches exactly, and unscoped content stays visible to everyone. | EPIC-058 `permits` |
| AC-7 | Matching is pure and total; a malformed token is denied, never thrown. | EPIC-068 §8 |
| AC-8 | A scope nobody granted is withheld, and a permission added later is denied to existing principals. | EPIC-068 §8 |
| AC-9 | A denial names the missing permission and nothing about the protected thing. | EPIC-068 §8; Gov §12 |
| AC-10 | A read withholds; an operation raises. Both rules hold on every path this Epic reaches. | EPIC-058 §4; EPIC-068 §8 |
| AC-11 | An architecture test enumerates caller-facing entries and fails when one reaches storage without a context, or performs an operation without a permission. | 058-VAL §9.1 |
| AC-12 | Neither tool input nor indexed repository content can widen a grant. | Gov §12, §13 |

## 10. Test requirements

- Unit: `scopeGrants` — exact match, hierarchical descendant, the `proj-ab`
  near-miss, unscoped content, empty grant, malformed token.
- Integration, real PostgreSQL and the real MCP protocol: reproduce #85's *shape*
  on a path that is not `ferret_why`, and assert the withheld value never appears.
  Assert the control case in the same test, so a pass cannot be the fixture
  failing to protect anything.
- Integration, CLI: `ferret index` refuses with `NOT_PERMITTED` under a principal
  without `INDEX`, and succeeds under one holding it.
- Architecture: AC-11's enumeration, failing on an unguarded entry.
- Regression: the indexer's read-back still reads everything it wrote.

## 11. Security

- Trust boundary: the grant comes from configuration on the machine. Tool input,
  indexed content, and anything a principal says about itself are untrusted
  (Governance §12, §13).
- Failure is closed. An error inside matching or enforcement withholds rather
  than admitting.
- A denial carries the missing permission and never the path, id, scope or value
  behind it.
- The CLI gaining a check must not become a way to discover what exists: a
  refusal reads the same whether or not the target is present.

## 12. Observability

A denial logs the operation and the missing permission, never the protected
value. Structured audit events remain EPIC-085's; this Epic must not pre-empt
their shape.

## 13. Performance constraints

Matching is pure string work over token segments — no query, no I/O, no
allocation per row beyond the comparison. No new index: the filter already has
`evidence_permission_idx` (`src/storage/schema/evidence.ts:94`). Enforcement adds
no measurable latency to a read.

## 14. Definition of Done

All acceptance criteria pass against real PostgreSQL and the real MCP protocol;
`npm run verify` green; #85's shape not reproducible on any caller-facing path;
limitations recorded in §16 and in the validation document.

## 15. Governance alignment

- **§12 Security** — "Security controls are enforced by Ferret, not by AI
  prompts. Authorization must be evaluated before protected information enters
  retrieval results." This Epic makes that true of the paths that are not
  retrieval.
- **§11 Retrieval** — retrieval must be permission-aware *and explainable*; a
  withheld result keeps its reason.
- **§3** — the CLI is the bootstrap and recovery interface, so it is an entry
  point that must be governed, not an exception.
- **§2** — coarse, configurable, simple. No role model, no second grant surface.

## 16. Raised, not absorbed

- **The CLI's default grant is a decision, not a finding.** Enforcing
  `Permission.INDEX` against `ANONYMOUS_PRINCIPAL` would have stopped
  `ferret index` working out of the box, because that principal holds `READ` and
  nothing else (EPIC-068 AC-3). Two options were possible and both change
  something: widen the anonymous grant, which contradicts a shipped and validated
  acceptance criterion, or give the CLI a different **default** under the same
  rule. This Epic took the second — `LOCAL_OPERATOR_PRINCIPAL`, holding `READ` and
  `INDEX`, used only when no `authorization` block exists. Three things support
  it: `PrincipalClass.OPERATOR` has existed unused since EPIC-068 documented as "a
  person operating Ferret directly, through the CLI"; Governance §3 makes the CLI
  a real entry point; and EPIC-068 §8 granted the anonymous principal `READ` on
  exactly this reasoning — refusing what the caller could already do with `cat`
  protects nobody. What is genuinely new is the *ability to deny*: a configured
  grant now locks `ferret index`, which was impossible before. It is raised here
  because no record dictated it.
- **Authentication is still absent.** The grant is asserted by configuration and
  trusted because the operating system already trusts whoever can run the
  process. EPIC-068 §16 recorded this limit; this Epic does not change it.
- **No provider sets a permission scope.** Hierarchical matching therefore ships
  proved against fixtures, not against a real scoped source. That is a gap in the
  evidence, not a claim about behaviour.
- **`entity` and `relationship` still carry no `permission_scope`.** EPIC-058 §16
  raised it as a governance question; it remains open.
