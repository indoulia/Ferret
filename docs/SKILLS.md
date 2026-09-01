# Ferret Skills Registry

**Status: APPROVED**  
**Registry Version: 1.0**  
**Effective: 2026-09-01**

## Purpose

This registry lists the repository-local Claude Code skills that encode Ferret's development, architecture, validation, and documentation practices. The skills are operational guidance; they do not replace the Functional Epic Registry or its governance.

Skills live under `.claude/skills/<skill-name>/SKILL.md` and are independently discoverable by Claude Code.

## Principles

- Repository-local skills encode Ferret-specific knowledge that should not be repeated in every prompt.
- Skills must preserve Epic governance and existing architecture boundaries.
- Skills must prefer measurement and verification over inference.
- Skills must distinguish implementation, test, integration, production, and historical evidence.
- A skill may guide work but may not authorize production mutation, scope expansion, acceptance-criteria changes, or merges.
- Keep skills small and composable; add a new skill when a workflow has a distinct owner and repeatable decision process.

## Approved skills

| Skill | Purpose | Primary use |
| --- | --- | --- |
| `ferret-investigate` | Reproduce, measure, trace ownership, prove root cause, and design the smallest regression fix. | Bugs, regressions, flaky tests, unexpected behavior |
| `ferret-epic` | Execute one approved Epic through readiness, implementation, validation, PR, and merge checkpoints. | Epic implementation |
| `ferret-architecture` | Navigate Epic ownership, contracts, dependencies, boundaries, and evidence rules before design changes. | Architecture and cross-cutting design |
| `ferret-production-validation` | Validate live behavior safely and distinguish observed, measured, inferred, and historical evidence. | Production/gate validation |
| `ferret-docs` | Maintain specifications, decisions, validation evidence, and operational docs without corrupting historical truth. | Documentation |

## Ownership and change control

The Functional Epic Registry at `docs/EPICs/README.md` remains authoritative for product scope and Epic lifecycle. This registry is authoritative only for the local skill set.

Adding a skill is not a feature and does not authorize implementation work. Changes that alter an Epic's scope, acceptance criteria, contracts, or governance remain subject to the Functional Epic Registry.

## Future skills

Potential future additions should be proposed only when repeated Ferret work demonstrates a distinct workflow that is not adequately covered by the current five skills. Do not create skills merely to shorten a prompt by a few lines.
