# EPIC-002 — Database Bootstrap & Migrations

**Status: APPROVED | Priority: P0**

## Objective
Make PostgreSQL provisioning and schema evolution automatic, safe, repeatable, and recoverable.

## Scope
Connection handling; initial schema creation; versioned migrations; migration locking; startup migration policy; rollback/recovery guidance; schema version tracking.

## Non-scope
Canonical domain design beyond what is required to bootstrap the persistence foundation.

## Dependencies
EPIC-001; final data-access technology from EPIC-005; canonical model migrations must remain versioned.

## Acceptance criteria
- A fresh database can be initialized automatically.
- Existing compatible databases migrate without manual SQL.
- Concurrent startup cannot corrupt migration state.
- Re-running initialization is idempotent.
- Failed migrations leave an explicit recoverable state.
- Schema version is queryable.
- Credentials are never logged.

## Tests
Fresh DB; existing DB; concurrent migration; failed migration; interrupted process; repeated startup; unsupported schema version; permission failure.

## Definition of Done
Migration suite passes against supported PostgreSQL versions; recovery behavior is documented; schema changes are reproducible in CI.
