# EPIC-012 — Distribution & Developer Experience

**Status: APPROVED**  
**Priority: P1**  
**Owner: Developer Experience**

## Objective

Deliver Ferret as an NPM-first product with an extremely simple installation, bootstrap, AI connection, and daily operating experience.

## Outcome

A developer installs Ferret globally, supplies database information and optional repository exclusions, connects an AI client using the generated instructions, and thereafter performs normal configuration and operations through the AI terminal/IDE.

## Scope

- global NPM distribution;
- `ferret init` bootstrap;
- minimal required configuration;
- automatic environment discovery;
- automatic provider/parser registration;
- automatic database schema and migration setup;
- AI integration instructions after installation;
- Claude Code/MCP first-class integration;
- future AI-client neutrality;
- status/doctor emergency CLI;
- clear upgrade and compatibility behavior;
- documentation focused on outcomes rather than operational complexity.

## Acceptance criteria

1. A clean installation has a short, predictable bootstrap path.
2. Normal users do not need to edit configuration files after initialization.
3. The AI client can perform routine Ferret configuration and administration.
4. The installation does not require users to manually provision unnecessary infrastructure.
5. `ferret status` and `ferret doctor` remain available when AI integration is unavailable.
6. Upgrade/migration behavior is automatic and safe for supported versions.
7. Documentation explains the minimal path first and advanced configuration second.
8. Future AI clients can integrate without redesigning Ferret core.
