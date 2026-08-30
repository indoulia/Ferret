# EPIC-001 — Foundation & Bootstrap

**Status: APPROVED**  
**Priority: P0**  
**Owner: Ferret Core**

## Objective

Create the smallest dependable Ferret runtime that a developer can install globally, connect to an existing database, and leave running without manual infrastructure administration.

## Outcome

A clean `npm`-distributed Ferret installation can initialize its database, apply migrations, discover the local environment, expose health/status information, and provide the base runtime required by every later Epic.

## Scope

- global NPM package and CLI bootstrap;
- database connection configuration;
- automatic schema initialization;
- automatic migrations;
- safe defaults;
- environment discovery;
- runtime lifecycle;
- health checks;
- status and doctor commands;
- configuration storage and precedence;
- graceful startup/shutdown;
- structured logging and error reporting.

## Non-scope

- domain-specific source providers;
- advanced search algorithms;
- production-scale distributed infrastructure;
- user-facing web application.

## Acceptance criteria

1. A new installation can be initialized with database host, port, name, username, password, and optional repository exclusions.
2. No mandatory configuration exists for parsers, embeddings, search engines, queues, object stores, providers, or AI clients when safe defaults are available.
3. Database migrations run automatically and are versioned.
4. Re-running initialization is safe and idempotent.
5. `ferret status` reports runtime, database, indexing, and provider health at a useful level.
6. `ferret doctor` diagnoses common configuration and connectivity failures with actionable guidance.
7. Runtime failures are reported clearly without exposing secrets.
8. The architecture does not require unnecessary auxiliary infrastructure.
9. The implementation is covered by automated bootstrap, migration, failure, and configuration tests.

## Dependencies

None beyond the selected foundational runtime and database technologies.

## Governance alignment

Must comply with zero-config, reuse-first, provider-first, lightweight infrastructure, security, and automatic-operation rules.
