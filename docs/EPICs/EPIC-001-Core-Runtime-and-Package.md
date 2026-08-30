# EPIC-001 — Core Runtime & Package

**Status: APPROVED | Priority: P0**

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
