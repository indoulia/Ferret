# EPIC-004 — Runtime Health & Diagnostics

**Status: APPROVED | Priority: P0**

## Objective
Give users and AI agents a dependable way to determine whether Ferret, its database, providers, synchronization, and indexes are healthy.

## Scope
`ferret status`; `ferret doctor`; health model; dependency checks; actionable diagnostics; safe structured errors; degraded-state reporting.

## Non-scope
Full observability platform; provider-specific dashboards.

## Acceptance criteria
- Status distinguishes healthy, degraded, unavailable, and unknown states.
- Doctor identifies common setup, database, migration, permission, and runtime failures.
- Diagnostics include actionable remediation without exposing secrets.
- Health checks do not mutate data unless explicitly requested.
- Health remains useful when optional providers are unavailable.
- Output is machine-readable for AI tooling.

## Tests
Healthy runtime; database unavailable; migration pending; invalid credentials; optional provider failure; malformed configuration; degraded index; secret-redaction tests.

## Definition of Done
CLI and machine-readable diagnostics documented and tested; failure modes have deterministic classifications.
