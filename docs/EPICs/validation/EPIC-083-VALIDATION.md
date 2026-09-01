# EPIC-083 — Authorization Enforcement · Validation Evidence

**Assessed against:** working tree on top of `2890824`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, the installed CLI as a child process, the
real MCP protocol over stdio.

## Before

Measured on `57c6d21`.

`assertPermitted` was called from one module, `src/mcp/guards.ts`. Every control
EPIC-068 built was reachable only by a caller who arrived over MCP.

`ferret index` built a `RepositoryIndexer` and ran it. `Permission.INDEX` had
existed since EPIC-068 shipped and nothing consulted it, so there was no
configuration a user could write that would stop the CLI indexing.

`permissionFilter(undefined)` returned no `WHERE` clause. Two caller-facing reads
had reached it that way: [#85](https://github.com/indoulia/Ferret/issues/85),
fixed in `57c6d21`, and [#87](https://github.com/indoulia/Ferret/issues/87) —
found while assessing this Epic, ten lines below the first, fixed in `2890824`.

A permission scope was an opaque token compared by string equality. Nothing
decided what one meant.

## After

The port cannot be called unscoped: six calls that previously compiled now do not,
and `tsc --noEmit` is what says so. `ferret index` refuses with exit 7 under a
configuration that withholds `INDEX`. A grant covers its descendants and not its
near-misses, in the checker and in SQL, proved from one table of cases.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 no caller-facing read omits its context | MET | `authorization-enforcement.test.ts` — *"rejects an unscoped read at compile time"*: six `@ts-expect-error` directives, each on a call that used to compile. An unused directive fails `tsc --noEmit`, so the build is the assertion |
| AC-2 unrestricted is named, not defaulted | MET | `UNRESTRICTED_READ` exported and used at `verifyAll`; *"has no other unrestricted read inside the store"* enumerates every internal `this.forSubject` from source |
| AC-3 CLI asserts `INDEX` and refuses | MET | `cli-authorization.test.ts` against real PostgreSQL, driving the installed binary: exit 7 and `E_NOT_PERMITTED` when configuration grants only `read`; exit 0 when it grants `index` |
| AC-4 one grant surface | MET | `authorization.test.ts` — *"yields to configuration wherever configuration speaks"*: `localOperatorFrom(locked)` equals `principalFrom(locked)`; architecture test asserts every `principalFrom`/`localOperatorFrom` argument is `context.config` |
| AC-5 hierarchical, never substring | MET | `permission-scope.test.ts` (unit) and `permission.test.ts` (real PostgreSQL): `jira:restricted-team` shows `jira:restricted-team:alpha` and withholds `jira:restricted-teamwork`, through both search and the evidence read |
| AC-6 exact match and unscoped unchanged | MET | `permission-scope.test.ts` `permits` block; every EPIC-058 case still passes, one with a changed assertion — see below |
| AC-7 pure and total | MET | *"never throws, whatever it is handed"* over six non-string values; *"is pure"* over 100 iterations |
| AC-8 deny by default survives | MET | EPIC-068's `authorize` untouched; empty and blank grants denied — *"withholds everything scoped from a caller holding an empty string"*, against real PostgreSQL |
| AC-9 denial names the permission only | MET | `cli-authorization.test.ts` asserts the refusal contains `index`, does not contain the repository path, and does not contain the database password |
| AC-10 read withholds, operation raises | MET | `permission.test.ts` (withholds, no error) and `cli-authorization.test.ts` (raises, exit 7) in the same suite run |
| AC-11 architecture test enumerates entries | MET | `authorization-enforcement.test.ts`, 11 assertions, all reading source: the port's method list, the absence of `permittedScopes?:`, and every CLI command that mentions `RepositoryIndexer` |
| AC-12 grant cannot be widened by input | MET | Architecture test asserts no `principalFrom`/`localOperatorFrom` call takes anything but `context.config`; EPIC-068 AC-7 covers the MCP half and still passes |
| AC-13 unconfigured CLI indexes; configured one is deniable | MET | `cli-authorization.test.ts` — *"indexes with no authorization configured at all"* (exit 0) and *"refuses to index when configuration withholds the permission"* (exit 7) |

## The defect this Epic was argued from, twice

`validation/EPIC-058-VALIDATION.md:250` assigned the structural remedy here on the
strength of one defect. A second arrived before the work started, in the same
handler, ten lines below the first, after the first had been fixed and reviewed.

That is the whole case for AC-1 and AC-11, and it is why neither is a runtime
assertion. #87 lived in the gap a runtime test cannot see: every read in EPIC-058's
suite exercised the store, where the filter was always correct, and nothing
asserted what the *tool above it* passed. A source-scanning test and a compile
error are the two controls that do not depend on someone driving the path.

Both defects are now impossible to reintroduce in the same shape: `conflictsFor(id)`
does not compile.

## One EPIC-058 assertion changed, and why that is not a rewrite

`tests/unit/permission-aware-retrieval.test.ts` asserted that a caller holding
`jira:team-a` could **not** see `jira:team-a:sub`, with this reason:

> Not a prefix match, not a hierarchy. The token is opaque
> (`Checkpoints/EPIC-008.md:128`); turning it into a membership decision is
> EPIC-083, and guessing at one here would be inventing a policy.

EPIC-083 has now made that decision and it is the opposite. The assertion is
inverted, and the old text is kept in the test as a comment rather than deleted:
EPIC-058 was right to refuse to guess, and the answer arriving later is not the
same as that Epic having been wrong.

The failure was found by `npm run verify` on the full suite, not by review — the
change passed in isolation. What EPIC-058 was protecting against is still
protected, by a stricter rule than "not a hierarchy": the test now also asserts
that `jira:team-ab` is refused, which "not a hierarchy" never checked.

## AC-5, and the near-miss that matters

The rule is exact-or-descendant on `:`-separated segments. The test that carries
the weight is the negative one — `jira:proj-a` must not grant `jira:proj-ab` —
because a bare `startsWith` satisfies every positive case and silently over-grants
every sibling with a longer name.

Proved in three places, deliberately: the pure checker, the evidence store's
`LIKE` filter, and the retrieval store's `LIKE` predicate. A membership decision
that differs between the filter and the checker is two decisions, so the SQL
carries an escaped pattern (`%`, `_` and `\` escaped) and a grant containing a
wildcard matches only what it names — asserted against real PostgreSQL.

## What is not demonstrated

- **No provider sets a permission scope.** Every scoped record in evidence is a
  fixture. Hierarchical matching is proved correct; it is not proved against a
  real scoped source, because none exists yet. This is a gap in the evidence, not
  a claim about behaviour.
- **Authentication remains absent.** The grant is asserted by configuration and
  trusted because the operating system already trusts whoever can run the process.
  EPIC-068 §16 recorded this and it is unchanged.
- **`entity` and `relationship` still carry no `permission_scope`.** EPIC-058 §16
  raised it as a governance question; it is still open.

## Decision raised, not absorbed

The CLI's unconfigured default is `LOCAL_OPERATOR_PRINCIPAL` — `READ` and `INDEX`.
No record dictated it, and specification §16 states the reasoning and the
alternative that was rejected. What changed for a user: nothing, unless they
configure an `authorization` block, in which case `ferret index` becomes deniable
for the first time.

## Run

`npm run verify` green: 100 files, 2225 passed, 3 skipped. Suites bearing on
this Epic: `permission-scope.test.ts`
(20), `authorization-enforcement.test.ts` (11), `authorization.test.ts` (28),
`cli-authorization.test.ts` (4, real PostgreSQL, real CLI process),
`permission.test.ts` (30, real PostgreSQL, real MCP protocol).
