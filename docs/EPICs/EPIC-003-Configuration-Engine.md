# EPIC-003 — Configuration Engine

**Status: APPROVED | Priority: P0**

## Objective
Provide one secure configuration system that makes ordinary Ferret setup require only database details and optional repository exclusions.

## Scope
Configuration schema; validation; persistence; environment variables; defaults; precedence; repository/session scope; secret references; configuration introspection; change auditing.

## Non-scope
AI control-plane UI itself; provider-specific business logic.

## Acceptance criteria
- Required bootstrap inputs are database host, port, database, username, password plus optional repository exclusions.
- Safe defaults eliminate unnecessary configuration questions.
- Configuration precedence is deterministic.
- Invalid values produce actionable errors.
- Secrets are redacted from output/logs.
- Configuration changes are validated before activation.
- Configuration can be queried by the future AI control plane.
- Repository/session exclusions can be represented without deleting historical evidence.

## Tests
Defaults; precedence; malformed values; secret redaction; persistence; concurrent changes; exclusions; invalid provider configuration.

## Definition of Done
Schema documented; validation covered; secrets protected; migration path defined; deterministic behavior proven by tests.
