---
name: ferret-epic
description: Execute one approved Ferret Epic at a time with governance, dependency, acceptance-criteria, testing, PR, and merge checkpoints.
---

# Ferret Epic Execution

Use this skill when implementing or validating a Functional Epic.

## Before implementation

1. Read the Epic specification and registry entry.
2. Inspect current `main`, dependencies, existing implementation, open issues, and related validated Epics.
3. Compare the specification with current code; do not assume the spec describes current reality.
4. Produce a short readiness assessment.
5. Identify only decisions that are genuinely governance-level: ownership, contract changes, acceptance-criteria changes, or material scope expansion.

## Implementation rules

- One Epic at a time.
- One focused branch and PR at a time.
- Implement only approved scope and acceptance criteria.
- Reuse validated primitives before creating new mechanisms.
- Preserve provider and architecture boundaries.
- If a defect belongs to an existing Epic, fix it there rather than inventing a duplicate Epic.
- If behavior is ambiguous and no existing contract resolves it, stop for governance.

## Validation

For every acceptance criterion, classify it as:

- `MET` — directly demonstrated by appropriate evidence.
- `PENDING` — not yet observed or requires a later environment/session.
- `BLOCKED` — cannot be demonstrated because of an external or unresolved dependency.
- `NOT APPLICABLE` — explicitly justified by the Epic contract.

Do not mark an integration or production criterion MET from a unit test alone.

## PR discipline

Before commit:
- diff check
- intended files only
- no unrelated changes
- focused tests
- relevant regression suite
- lint/typecheck/build/verify as applicable

After push:
- wait for CI
- inspect the actual PR state and changed files
- report merge readiness
- do not merge without explicit authorization

After merge authorization:
- verify the merge landed on `main`
- update local state
- verify a clean tree
- only then begin the next Epic

## Stop conditions

Stop and ask when:
- governance ownership is ambiguous
- an acceptance criterion needs to change
- the implementation requires material scope expansion
- production mutation is required but not authorized
- a historical validation claim would need to be rewritten
