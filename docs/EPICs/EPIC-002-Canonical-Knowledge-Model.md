# EPIC-002 — Canonical Knowledge Model

**Status: APPROVED**  
**Priority: P0**  
**Owner: Ferret Core**

## Objective

Define a provider-neutral canonical model that can represent engineering entities, files, evidence, identities, events, relationships, and historical state without coupling the core to any source system.

## Outcome

All providers normalize their data into one stable model, allowing Ferret to correlate Git, GitHub, Jira, files, sessions, developers, releases, and future systems consistently.

## Core concepts

- Entity — a durable identifiable object.
- Artifact/File — a versioned source artifact.
- Evidence — an observed source fact or source payload reference.
- Relationship — a typed connection between entities.
- Event — an occurrence in time.
- Identity — a person, agent, or external identity mapping.
- Context — scoped engineering state.
- Checkpoint — durable session state for recovery.
- Source — the authoritative originating system.
- Observation time and indexing time — distinct timestamps.

## Scope

- canonical identifiers;
- entity types and extensibility;
- relationship model;
- provenance;
- temporal validity/history;
- source authority;
- evidence lifecycle;
- content hashes and deduplication identity;
- confidence/completeness representation;
- conflict representation;
- schema versioning;
- provider normalization contracts.

## Acceptance criteria

1. Providers can represent their data without leaking provider-specific models into core services.
2. The model can represent repository, branch, worktree, developer, agent, session, file, commit, PR, review, issue, release, deployment, and document concepts.
3. Every important derived fact can be traced to evidence.
4. Historical versions can coexist without destructive overwrite.
5. Duplicate observations resolve to stable logical identities.
6. Conflicting observations can be retained and surfaced.
7. Schema evolution has explicit compatibility/versioning rules.
8. The model supports both structured retrieval and graph traversal.

## Non-scope

The Epic does not select a particular graph database, search engine, embedding model, or external provider implementation.
