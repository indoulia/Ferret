# EPIC-001 — Core Runtime & Package

**Status: IMPLEMENTED | Priority: P0**

**Implementation:** branch `feat/epic-001-core-runtime`. 
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

The Epic moves to VALIDATING once CI is green on both platforms, and to DONE
only after post-merge verification. macOS remains unvalidated and is carried to
EPIC-105, as already established by EPIC-005.
