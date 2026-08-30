# EPIC-009 — Security, Provenance & Trust

**Status: APPROVED**  
**Priority: P0**  
**Owner: Security**

## Objective

Make Ferret trustworthy for persistent engineering knowledge by enforcing authorization, protecting secrets, preserving provenance, detecting conflicts, and clearly distinguishing evidence from inference.

## Outcome

A Ferret answer can be trusted, challenged, and audited: users can determine where important facts came from, whether information is current, whether sources disagree, and whether access was authorized.

## Scope

- authentication and authorization boundaries;
- least-privilege provider access;
- secret exclusion and detection;
- provenance model;
- evidence integrity;
- confidence/completeness;
- source authority;
- conflict detection;
- stale/unknown states;
- audit events;
- prompt-injection resistance;
- destructive-operation confirmation;
- secure credential handling.

## Acceptance criteria

1. Unauthorized evidence cannot enter a retrieval response.
2. Secrets are excluded from indexing by default.
3. Provider credentials are never treated as knowledge content.
4. Important derived facts retain traceable evidence.
5. Conflicting source observations are retained and surfaced rather than silently collapsed.
6. Stale and incomplete knowledge is distinguishable from current knowledge.
7. Repository content cannot override Ferret security or configuration policy.
8. Sensitive operations are auditable.
9. Security tests cover access boundaries and prompt-injection scenarios.

## Non-scope

This Epic does not make Ferret the authoritative security system for external providers; it enforces the permissions available from those providers.
