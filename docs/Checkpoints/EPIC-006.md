# Development Checkpoint — EPIC-006

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-006 — Canonical Entity Model (P0, Canonical Knowledge Model)

**Objective:** The provider-neutral durable entity model that represents
Ferret's knowledge without coupling core logic to GitHub, Jira, files, or any
future source.

**Branch:** `feat/epic-006-canonical-entity-model`, cut from `main` at `a18e02d`.

**Epic status:** VALIDATED — 6/6 acceptance criteria PASS, 6/6 required tests
PASS. Evidence in
[`docs/EPICs/validation/EPIC-006-VALIDATION.md`](../EPICs/validation/EPIC-006-VALIDATION.md).

---

## Completed

- **Derived identity.** `canonicalKey` → SHA-256 → RFC 9562 UUIDv8. Stable
  across re-ingestion by construction, and computable without a database.
- **Sixteen entity kinds**, provider-neutral, with `branch`/`worktree` and
  `file`/`file_version` deliberately separate.
- **Two boxes for source data.** `attributes` validated strictly per kind;
  `unknownFields` retained verbatim and never interpreted.
- **External identifiers** in their own indexed table, for cross-source lookup.
- **An extensible kind registry** — `registerEntityKind` genuinely works, which
  it did not at first (see below).
- **Content fingerprints** so unchanged content is never rewritten.
- **Tombstones** — `deleted` retains the entity.
- **Persistence** — `EntityStore` with idempotent upsert, external-id
  replacement, tombstone, and lookups by id, canonical key and external id.
- **drizzle-kit** added and wired: `npm run migration:generate -- <name>`.
- **Migration 0002**, generated and reviewed.

## Files

```text
src/domain/identity.ts          canonical keys, derived ids, content fingerprints
src/domain/kinds.ts             the sixteen kinds and the lifecycle states
src/domain/attributes.ts        per-kind canonical attribute schemas (strict)
src/domain/entity.ts            the entity envelope, validation, kind registry
src/domain/index.ts             the canonical model's public surface

src/storage/schema/entities.ts  Drizzle tables for entity and entity_external_id
src/storage/entities.ts         EntityStore — idempotent persistence
src/storage/migrations/0002_canonical_entities.sql
scripts/generate-migration.mjs  drizzle-kit -> Ferret's migration sequence
drizzle.config.ts

tests/unit/canonical-entity.test.ts               40 cases
tests/integration/domain/entity-store.test.ts     30 cases
```

Modified: `src/errors/codes.ts` (`E_ENTITY_INVALID`, `E_ENTITY_NOT_FOUND`),
`src/cli/exit-codes.ts`, `src/index.ts`, `src/storage/index.ts`,
`tests/unit/boundaries.test.ts` (canonical-model boundary),
`tests/integration/storage/migrations.test.ts` (one test assumed a single
migration existed), `package.json` (drizzle-kit + an `overrides` entry).

## Tests

`npm run verify` — lint, typecheck, build, **567 passed, 3 skipped** across 27
files. `npm audit` — **0 vulnerabilities**.

## Decisions

Full rationale in [`docs/Architecture/EPIC-006-DECISIONS.md`](../Architecture/EPIC-006-DECISIONS.md).

- **D-001** ids are derived, never allocated
- **D-002** SHA-256/UUIDv8, not UUIDv5 — SHA-1 collisions are practical and the
  inputs come from untrusted repositories
- **D-003** key parts are length-prefixed, so identities cannot collide
- **D-004** one table for every kind, not one table per kind
- **D-005** strict canonical attributes; unknown fields retained untouched
- **D-006** kind is validated against the registry, not an enum
- **D-007** unchanged content is not rewritten; `first_indexed_at` is immutable
- **D-008** fingerprints ignore object key order, respect array order
- **D-009** `deleted` is a tombstone
- **D-010** external ids are an indexed table, replaced wholesale
- **D-011** branch/worktree and file/file_version stay distinct
- **D-012** drizzle-kit generates migrations; a script adapts the numbering
- **D-013** the applied schema is asserted against the declared schema
- **D-014** an entity from a newer Ferret is refused, not guessed at

## The defect these tests caught

**`registerEntityKind` did not work.** The envelope validated `kind` against a
`z.enum` of the built-ins, so a registered kind was rejected before the registry
was consulted — AC-4 ("extensions do not require core redesign") was not
satisfied, by an API that looked as though it was. Fixed by D-006.

## Notes for whoever picks this up

- **Adding a migration:** `npm run migration:generate -- <snake_case_name>`,
  then **read the SQL**. drizzle-kit does not know what EPIC-002's bootstrap DDL
  already created, and it does not know that dropping a column loses evidence.
- **Adding an entity kind that Ferret should ship:** add its schema to
  `src/domain/attributes.ts` and its constant to `src/domain/kinds.ts`. Nothing
  else needs to change — no DDL, no persistence change.
- **Adding a kind a provider owns:** call `registerEntityKind`. Do not extend the
  core enum.
- **Do not add typed columns per kind** without a measurement that shows the
  `jsonb` path is too slow. D-004 is a deliberate ordering, not an oversight.
- `src/domain` must stay provider-neutral. `tests/unit/boundaries.test.ts`
  enforces it: no provider package, no storage import, no source system named in
  an import.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- No relationships between entities → **EPIC-007**
- No provenance beyond `source`/`sourceObservedAt` → **EPIC-008**
- No identity resolution; `developer.emails` collects the evidence for it → **EPIC-036**, **EPIC-051**
- No entity history — an update overwrites previous attributes → **EPIC-007**
- `upsertMany` is not one transaction for the whole batch → **EPIC-080**
- Replacing external ids resets `first_seen_at` → **EPIC-008** if needed
- Attributes are `jsonb` with no typed columns, deliberately → **EPIC-086**
- macOS unvalidated → **EPIC-105**

## Next step

**EPIC-007 — Relationship & Temporal Model.** Its dependencies are now
satisfied, and the entity model was shaped with it in mind:

- ids are derivable without a database lookup, so a relationship can be recorded
  to an entity that has not been ingested yet;
- `sourceObservedAt` already separates source time from index time, which is
  EPIC-007's "observed time versus indexed time" criterion;
- `branch` and `worktree` are distinct kinds, which is what lets EPIC-007 keep
  their relationships distinct as its AC-4 requires.

EPIC-007 needs: a typed directed relationship table keyed by
`(fromId, type, toId)`, relationship metadata, valid-from/valid-to so historical
and current relationships coexist, idempotent updates, and traversal primitives.
Note that out-of-order and duplicate events are explicit test requirements, so
the design must not assume events arrive in order.

Then **EPIC-008** (Evidence & Provenance), **EPIC-009** (Identity & Scope — build
on `ferret.instance` from EPIC-002 migration 0001 rather than replacing it), and
**EPIC-010** (Schema Versioning, which owns the compatibility rules D-014 defers
to it).
