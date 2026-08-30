# Ferret Functional Epic Specification Standard

**Status: APPROVED**

Every Functional Epic specification must contain:

1. Objective — one clear capability outcome.
2. Value — why the capability exists.
3. Scope — what is included.
4. Non-scope — what is explicitly excluded.
5. Inputs — source/configuration/dependencies consumed.
6. Outputs — entities, APIs, files, events, or behavior produced.
7. Dependencies — prerequisite Epics and external requirements.
8. Contracts — interfaces and invariants that other Epics may rely on.
9. Acceptance criteria — objective, testable conditions.
10. Test requirements — unit, integration, failure, security, and performance cases as applicable.
11. Security requirements — trust boundaries and protected data.
12. Observability — health, metrics, logs, and diagnostics where applicable.
13. Performance constraints — measurable limits where relevant.
14. Definition of Done — evidence required before DONE.
15. Governance alignment — relevant approved rules.

## Granularity rule

An Epic is the smallest independently meaningful, independently governable, independently testable capability. Do not split artificially. Do not combine unrelated capabilities merely to reduce the Epic count.

## Status rule

An Epic may be marked APPROVED only after objective scope and acceptance criteria are defined. It may be marked DONE only after validation evidence exists.

## AI implementation rule

An AI agent must read this standard, the Governance documents, the target Epic, and dependency specifications before implementation. It must not silently expand scope.
