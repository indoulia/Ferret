# EPIC-006 — Validation Evidence

**Epic:** EPIC-006 — Canonical Entity Model
**Branch:** `feat/epic-006-canonical-entity-model`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Every supported source object can map to a canonical entity | **PASS** | All sixteen kinds the Epic names are modelled — repository, branch, worktree, developer, agent, session, file, file version, commit, pull request, review, issue, release, deployment, document, evidence. `entity-store.test.ts` → "every kind round-trips" stores and reads back one of each against real PostgreSQL, not just against the schemas. `canonical-entity.test.ts` asserts the count and that each is registered. |
| AC-2 | Canonical IDs remain stable across repeated ingestion | **PASS** | Ids are *derived*, never allocated: `canonicalId` is a pure function of the entity's natural identity, so stability is a property of the identifier rather than something ingestion must remember. `canonical-entity.test.ts` → "canonical ids" (5 cases). Proven end to end in `entity-store.test.ts` → "never creates a second row for the same source object" (10 ingestions, one row) and "updates in place when the content changes, keeping the same id". |
| AC-3 | External IDs remain traceable to their source | **PASS** | Every entity carries its own `source` (system, id, url, scope) plus any number of `externalIds` from other systems, in a table indexed for lookup. `entity-store.test.ts` → "cross-source identity" resolves an entity by a GitHub node id and a Jira key, and stops resolving an identifier the source has stopped reporting. |
| AC-4 | Entity extensions do not require core redesign | **PASS** | `registerEntityKind` adds a kind with its own schema; nothing in persistence, validation or retrieval branches on kind. `canonical-entity.test.ts` → "extensibility" (4 cases) registers `build_pipeline`, creates and validates entities of it, and refuses to redefine an existing kind. **This criterion initially failed** — see §3. |
| AC-5 | Unknown/unsupported source fields can be retained without corrupting the canonical model | **PASS** | Two boxes: `attributes` is validated strictly against the kind's schema; `unknownFields` is retained verbatim and never validated or interpreted. `canonical-entity.test.ts` → "unknown source fields" (3 cases) and `entity-store.test.ts` → "returns exactly what was stored, including unknown source fields". Unknown fields take part in the content fingerprint, so an upstream change is still detected as a change. |
| AC-6 | Schema validation rejects invalid canonical entities | **PASS** | `canonical-entity.test.ts` → "validation" (7 cases): unknown kind, missing required attribute, **misspelled canonical field** (the attribute schemas are `.strict()`, so `titel` fails rather than landing in the model as a field nothing will read), malformed source, and a corrupted value read back from storage. `entity-store.test.ts` → "rejects an invalid entity before writing anything", asserting the row count is unchanged. |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names six test areas. All six exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Entity creation | PASS | `canonical-entity.test.ts` → "creating entities" (7 cases); `entity-store.test.ts` → "every kind round-trips" |
| Duplicate identity | PASS | `entity-store.test.ts` → 10 identical ingestions produce one row; a second entity claiming the same canonical key is refused by a unique index |
| External ID mapping | PASS | `entity-store.test.ts` → "cross-source identity" (2 cases); `canonical-entity.test.ts` → "external identifiers" (2 cases) |
| Unknown fields | PASS | `canonical-entity.test.ts` → "unknown source fields" (3 cases) |
| Invalid entities | PASS | `canonical-entity.test.ts` → "validation" (7 cases) |
| Schema version compatibility | PASS | `entity-store.test.ts` → "refuses to read an entity written by a newer Ferret" (`E_SCHEMA_UNSUPPORTED`) |

### Coverage beyond the required list

- **Schema/code drift** — `entity-store.test.ts` introspects `information_schema`
  after migration and asserts the real columns, types and nullability match what
  the Drizzle schema declares. Drizzle types the queries; only the migration
  shapes the database, and nothing else notices when they disagree until a query
  fails in production.
- **Index coverage** — an `EXPLAIN` asserts canonical-key lookup uses its index
  rather than scanning. A scan is invisible at test scale and fatal at
  repository scale.
- **Referential integrity** — external ids cascade, so a removed entity leaves no
  orphan mapping that would resolve to nothing.
- **Tombstones** — a deleted entity keeps its content and stays addressable.
- **Batch atomicity** — a batch validates entirely before any of it is written.
- **Durability** — an entity and its external ids commit together; data survives
  the server terminating every connection; PostgreSQL itself rejects a malformed
  id, because the column is `uuid` rather than text.
- **Adversarial identity** — length-prefixed key encoding, so two different
  identities cannot collide through a separator appearing inside a part.

---

## 3. The defect this Epic's own tests caught

**AC-4 did not hold when first implemented.** `registerEntityKind` recorded a
kind and `createEntity` consulted the registry — but the input envelope
validated `kind` against a `z.enum` of the sixteen built-ins, so a registered
kind was rejected before the registry was ever reached. Registration was a
no-op with a convincing API.

The extensibility test failed immediately, and the fix was to validate `kind`
for *shape* (lowercase snake_case) and for *existence* against the registry,
never against a hard-coded list. A hard-coded enum is exactly the core change
AC-4 forbids.

A pleasing side effect: three `as unknown as EntityInput` casts in the tests
became unnecessary, because arbitrary kinds are now legal at the type level too.
`CanonicalEntity.kind` is typed as the union plus `string` — narrowing to the
built-ins would be a type asserting that extensions are impossible.

---

## 4. Security

| Concern | Handling |
| --- | --- |
| **Identity collision from untrusted input** | Canonical ids are derived from identifiers found in repositories Ferret did not write (Governance §12). UUIDv5 would be conventional, but its digest is SHA-1, for which chosen-prefix collisions are practical — a feasible collision would let a hostile repository alias one entity onto another and silently corrupt the knowledge base. Ferret uses **SHA-256**, formatted as an RFC 9562 UUIDv8. Asserted directly: the version nibble is `8`, not `5`. |
| Key ambiguity | Key parts are length-prefixed, so `["a","b:c"]` and `["a:b","c"]` cannot produce the same key. Source identifiers are arbitrary strings — a branch really can be called `feature/a:b`. |
| Injection | Every value is a bind parameter; Drizzle builds the statements. No identifier is interpolated. |
| Content disclosure in errors | A rejected value is never echoed — an entity can carry content from an untrusted repository. Asserted directly. |
| Schema poisoning | Attribute schemas are `.strict()`, so a provider cannot smuggle unmodelled fields into `attributes`; they go to `unknownFields`, which is retained but never interpreted. |
| Dependencies | `drizzle-kit` added as a devDependency. It pulled a deprecated `@esbuild-kit` chain carrying a moderate esbuild advisory; an `overrides` entry pins that path forward. `npm audit` reports **0 vulnerabilities**. |

---

## 5. Performance

Ingestion writes entities in bulk, so per-entity cost is multiplied by the size
of a repository. Budgets are regression ceilings asserted in
`entity-store.test.ts`.

| Measurement | Budget |
| --- | --- |
| Upsert one entity (p95 of 40) | 250 ms |
| Read one entity by id (p95 of 50) | 100 ms |
| Resolve an external id (p95 of 50) | 100 ms |
| Canonical-key lookup uses its index | asserted via `EXPLAIN` |

The index assertion matters more than the timings: at test scale a sequential
scan is fast, and only the plan reveals that it would not stay so.

---

## 6. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical schema documented and versioned | **PASS** | `ENTITY_SCHEMA_VERSION` on every entity, refused when newer than this build understands. Documented in `docs/Architecture/EPIC-006-DECISIONS.md` and in doc comments naming the governance rule each field serves. |
| Representative source mappings validated | **PASS** | All sixteen kinds round-trip through real PostgreSQL with source-shaped data — a Git remote, a Jira key, a GitHub node id, a commit SHA, a worktree path. |
| Persistence tests pass | **PASS** | 30 integration cases against PostgreSQL 17 + pgvector; 40 unit cases on the model. Total suite: 567 passing. |

---

## 7. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| No relationships between entities yet. | "Which commit fixed which issue" is not representable. The entity model is the substrate for it. | **EPIC-007** — Relationship & Temporal Model |
| No provenance beyond `source` and `sourceObservedAt`. | Ferret can say where an entity came from, not why it believes each fact within it. | **EPIC-008** — Evidence & Provenance |
| Identity resolution is not implemented. | Two identifiers for the same developer stay two entities; `developer.emails` collects the evidence resolution will need. | **EPIC-036**, **EPIC-051** |
| Attributes are stored as `jsonb` with no typed columns. | Deliberate — see decision D-002. Where a later Epic measures a query that needs typed columns, it can add a table keyed by `entity.id` without disturbing this one. | **EPIC-086** |
| `upsertMany` applies entities one transaction at a time, not one transaction for the batch. | A batch is validated entirely before any write, so a partial batch cannot contain invalid data — but a mid-batch database failure can leave some entities applied. | **EPIC-080** — resolved by statement rather than by change: validation is atomic for the batch and application is per entity, which is sufficient because the batch is idempotent (a partial batch plus a retry equals a complete one). Making it one transaction would lengthen the lock on large batches, which is EPIC-006's trade to make deliberately. |
| Replacing external ids resets `first_seen_at`. | The simpler delete-then-insert rule costs the original timestamp. Accepted knowingly. | **EPIC-008** if provenance needs it |
| No entity history — an update overwrites the previous attributes. | "What did this issue's title used to be" is unanswerable. Temporal state is the next Epic's subject. | **EPIC-007** |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |
