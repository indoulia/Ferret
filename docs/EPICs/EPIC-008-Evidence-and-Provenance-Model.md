# EPIC-008 — Evidence & Provenance Model

**Status: VALIDATED | Priority: P0**

Evidence: [`validation/EPIC-008-VALIDATION.md`](validation/EPIC-008-VALIDATION.md) · Decisions: [`../Architecture/EPIC-008-DECISIONS.md`](../Architecture/EPIC-008-DECISIONS.md) · Checkpoint: [`../Checkpoints/EPIC-008.md`](../Checkpoints/EPIC-008.md)

## Objective
Ensure every important fact can be traced back to source evidence and that Ferret distinguishes observed evidence from derived knowledge.

## Scope
Evidence records; source references; locations; hashes; observation/index timestamps; derivation metadata; parser/provider versions; authority; confidence/completeness; immutable evidence semantics.

## Acceptance criteria
- Important derived facts have evidence references.
- Evidence identifies source and source location where available.
- Source evidence is not silently rewritten as a new fact.
- Derived data records its derivation/version where material.
- Stale, partial, unavailable, unknown, and conflicting states are representable.
- Evidence integrity can be checked.

## Security
Evidence access must honor source permissions. Credentials and secrets are never stored as evidence content merely because they were encountered.

## Tests
Provenance chain; evidence deduplication; stale evidence; conflicting evidence; missing source; tampered content hash; permission filtering.

## Definition of Done
Evidence schema and provenance invariants are documented, queryable, tested, and consumed by downstream retrieval contracts.
