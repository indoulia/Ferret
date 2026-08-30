# EPIC-001 — Core Runtime & Package

**Status: VALIDATED | Priority: P0**

**Implementation:** merged to `main` as `4cbead2` (PR #2). 
**Validation evidence:** [`validation/EPIC-001-VALIDATION.md`](validation/EPIC-001-VALIDATION.md). 
**Implementation decisions:** [`../Architecture/EPIC-001-DECISIONS.md`](../Architecture/EPIC-001-DECISIONS.md). 
**Runtime architecture:** [`../Architecture/RUNTIME.md`](../Architecture/RUNTIME.md).

## Objective
Deliver the minimal installable Ferret runtime and stable application boundary.

## Scope
NPM package layout; runtime bootstrap; dependency boundaries; startup/shutdown; environment detection hooks; version reporting; safe error handling; public core entry points.

## Non-scope
Database schema, provider implementations, indexing algorithms, MCP tools, and domain-specific parsers.

## Dependencies
EPIC-005 Technology Evaluation & Selection may select the final runtime/language before implementation is locked.

## Acceptance criteria
- `npm install -g ferret` installs a usable CLI/runtime package.
- Runtime startup is deterministic and reports its version.
- Core imports do not depend directly on GitHub/Jira/parser/vendor implementations.
- Startup/shutdown are safe and idempotent.
- Errors are structured and never expose credentials.
- Package contents are reproducible and do not contain development secrets.

## Tests
Fresh install; startup/shutdown; malformed configuration; missing optional dependencies; package smoke test; cross-platform package test.

## Definition of Done
All acceptance criteria pass; package-size/dependency footprint is reviewed; public boundaries are documented; CI validates the package.

---

## Implementation notes

Added after implementation. The scope, non-scope, acceptance criteria, tests and
Definition of Done above are unchanged.

All six acceptance criteria PASS. One deviation is recorded: the package is
published as `@indoulia/ferret` rather than the unscoped `ferret`, which belongs
to an unrelated npm package and is unobtainable. The binary is `ferret`, so a
global install yields exactly the CLI the criterion describes. Carried to
EPIC-102 — see decision D-001.

`ferret status` and `ferret doctor` (EPIC-004), `ferret init` and `ferret config`
(EPIC-002/EPIC-003) and `ferret mcp` (EPIC-064) appear in `--help` marked
`(planned)` and exit with `E_NOT_IMPLEMENTED` / code 5. The command *structure*
is EPIC-001's; the *behaviour* remains with the owning Epic.

### Validation

Every acceptance criterion is verified with evidence, CI is green on
`ubuntu-latest` and `windows-latest`, and post-merge verification passed from a
clean checkout of `main`: build, lint, typecheck, 253 passed / 3 skipped,
`npm pack`, global install, and the installed `ferret` binary exercised for
help, version, lifecycle, planned-command and unknown-command behaviour, with a
real credential confirmed absent from output at trace level.

The Epic is **VALIDATED**, not DONE. One item needs ratification rather than
work: AC-1 is written as `npm install -g ferret`, and that unscoped npm name is
permanently unobtainable, so the package ships as `@indoulia/ferret` with the
binary `ferret`. The criterion's substance is delivered and evidenced, but its
literal text is not met, and accepting that deviation is a product decision
rather than one the implementation can make for itself. It is recorded as
decision D-001 and owned by EPIC-102 (NPM Distribution).

macOS remains unvalidated and is carried to EPIC-105, as already established by
EPIC-005 §11.
