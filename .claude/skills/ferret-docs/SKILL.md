---
name: ferret-docs
description: Maintain Ferret Epic specifications, architecture records, validation evidence, decision records, and operational documentation without corrupting historical truth.
---

# Ferret Documentation

Use this skill when creating or updating repository documentation.

## Document classes

Treat these differently:

- **Specifications:** describe approved intended behavior and scope.
- **Architecture/decision records:** record why a design choice exists.
- **Validation evidence:** record what was actually demonstrated.
- **Operational documentation:** describe current procedures and live identifiers.
- **Historical evidence:** preserve what was true at the time; do not rewrite it to match today's state.

## Required discipline

1. Read the existing document before editing it.
2. Preserve its terminology and structure unless there is a reason to change them.
3. Cite concrete code paths, tests, commits, or runtime observations where the document claims evidence.
4. Separate `observed`, `measured`, `inferred`, `historical`, and `pending` claims.
5. Never upgrade a pending claim to validated without new evidence.
6. Never erase a failed experiment or disproved hypothesis when it explains how the conclusion was reached.
7. If a specification changes, identify whether the change is cosmetic, corrective, or governance-level.
8. Do not modify acceptance criteria from an implementation task without explicit governance authorization.

## Epic documentation

For Epic work, keep the registry, specification, implementation, and validation states consistent:

`PROPOSED → REVIEWED → APPROVED → READY → IN_PROGRESS → BLOCKED → IMPLEMENTED → VALIDATING → VALIDATED → DONE`

An Epic is not validated by code existence alone.

## Evidence writing

Prefer compact tables with:
- criterion
- status
- exact evidence
- environment/run
- timestamp
- gaps

Do not pad evidence with narrative that cannot be independently verified.
