# EPIC-010 — Schema Versioning & Compatibility

**Status: APPROVED | Priority: P0**

## Objective
Allow Ferret's canonical schema, provider contracts, indexes, and persisted data to evolve without corrupting existing knowledge or forcing unsafe manual migrations.

## Scope
Schema versions; compatibility policy; migration metadata; forward/backward compatibility rules; provider contract versions; index/derived-data versions; migration validation.

## Acceptance criteria
- Persisted schema has an explicit version.
- Supported upgrade paths are deterministic and tested.
- Incompatible versions fail clearly before unsafe writes.
- Provider contract compatibility is explicit.
- Derived indexes can identify the schema/parser/model version that produced them.
- Migration operations are idempotent and recoverable.

## Tests
Upgrade from every supported prior version; interrupted migration; incompatible version; concurrent startup; derived-index version mismatch; downgrade refusal where unsupported.

## Definition of Done
Compatibility matrix and migration strategy are documented; automated migration tests pass; unsafe downgrade behavior is explicit.
