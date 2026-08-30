# Development Checkpoint — EPIC-009

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-009 — Identity & Scope Model (P0, Canonical Knowledge Model)

**Objective:** Represent developers, AI agents, repositories, worktrees, sessions
and configuration scopes independently and consistently across providers.

**Branch:** `feat/epic-009-identity-and-scope-model`, cut from `main` at `347fc81`.

**Epic status:** VALIDATED — 6/6 acceptance criteria PASS, 7/7 required tests
PASS. Evidence in
[`docs/EPICs/validation/EPIC-009-VALIDATION.md`](../EPICs/validation/EPIC-009-VALIDATION.md).

---

## Completed

- **Actor classes** — developer and agent, enforced at three points so a record
  cannot contradict itself.
- **Identity aliases with history** — temporal validity, evidence link,
  confidence, in their own table.
- **Collision detection** that reports and writes nothing, with a partial unique
  index as a database-level backstop.
- **Deliberate merges** requiring evidence, moving aliases by closing and
  reopening rather than repointing, superseding rather than deleting, and
  recording the merge as a relationship.
- **Point-in-time resolution** — who held an address when a commit was authored.
- **Scope model** — repository, worktree and session as independent dimensions;
  exclusion wins and cannot be widened; a decision that says which rule decided.
- **Migration 0005**, generated and reviewed.

## Files

```text
src/domain/actor.ts                  actor classes, alias model, collision type
src/domain/scope.ts                  scope kinds, selectors, evaluation, merging
src/storage/schema/identities.ts     identity_alias table
src/storage/identities.ts            IdentityStore — link, resolve, merge, history
src/storage/migrations/0005_identity_aliases.sql

tests/unit/scope.test.ts                              24 cases
tests/integration/domain/identity-store.test.ts       25 cases
```

Modified: `src/errors/codes.ts` (`E_IDENTITY_INVALID`, `E_IDENTITY_COLLISION`),
`src/cli/exit-codes.ts`, `src/domain/index.ts`, `src/index.ts`,
`src/storage/index.ts`.

## Tests

`npm run verify` — **761 passed, 3 skipped** across 34 files, zero unhandled
errors. `npm audit` — **0 vulnerabilities**.

## Decisions

Full rationale in [`docs/Architecture/EPIC-009-DECISIONS.md`](../Architecture/EPIC-009-DECISIONS.md).

- **D-001** actor aliases are a separate table from `entity_external_id`
- **D-002** collisions are reported, never resolved
- **D-003** developers and agents never merge
- **D-004** alias identity includes the interval start
- **D-005** reconciliation takes a transaction-scoped advisory lock
- **D-006** scope dimensions are evaluated independently
- **D-007** exclusion wins, and cannot be widened
- **D-008** absent is not a wildcard
- **D-009** the merge relationship is recorded outside the transaction

## Notes for whoever picks this up

- **Do not make `link` resolve a collision.** Reporting it is the requirement;
  merging automatically is the failure it exists to prevent. A caller that means
  to merge calls `merge`, which requires evidence.
- **Do not merge `identity_alias` back into `entity_external_id`.** EPIC-006
  replaces external ids wholesale on re-ingestion, which would destroy the
  history AC-6 requires. See D-001.
- **The advisory lock key must stay `(system, externalId)`.** Keying it more
  broadly would serialize reconciliation across unrelated people, and a test
  asserts it does not.
- **Scope evaluation is pure and returns which rule decided.** Keep it that way —
  Governance §18 needs the explanation, and a bare boolean cannot give it.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- Nothing *proposes* reconciliations; Ferret adjudicates what a caller asserts → **EPIC-036**, **EPIC-051**
- No `unmerge`; history makes manual repair possible
- Scope selectors are not persisted → **EPIC-066**, **EPIC-083**
- Scope is not yet applied to retrieval → **EPIC-058**
- Alias confidence is stored but never computed → **EPIC-046**
- No "acted on behalf of" modelling between an agent and a developer → **EPIC-039**
- macOS unvalidated → **EPIC-105**

## Next step

**EPIC-010 — Schema Versioning & Compatibility**, the last Epic in the Canonical
Knowledge Model domain.

Its substrate exists in three places, each currently taking the same stance —
refuse anything newer than this build understands:

- the **database schema** version (EPIC-002), with `E_SCHEMA_UNSUPPORTED` and
  checksum drift detection;
- the **entity envelope** version (EPIC-006 D-014), refusing a row from a newer
  Ferret;
- the **configuration file** version (EPIC-003 D-009), refusing a newer file.

There is also a **provider contract version** (EPIC-001) that the registry
already checks, and **producer versions** on evidence (EPIC-008) that identify
which parser produced a derived index.

EPIC-010's job is to turn three separate "refuse" behaviours into one stated
compatibility policy: a documented matrix, deterministic and *tested* upgrade
paths from every supported prior version, explicit provider-contract
compatibility, derived-index version identification, and an explicit position on
downgrade. Note that "upgrade from every supported prior version" and
"interrupted migration" are required tests — EPIC-002 already covers interrupted
migration and concurrent startup, so those can be built on rather than redone.

After EPIC-010 the Canonical Knowledge Model domain is complete, and the critical
path moves to the **Provider Platform** (EPIC-011–016), then source discovery and
the first vertical slice.
