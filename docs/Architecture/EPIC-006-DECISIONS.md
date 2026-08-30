# EPIC-006 — Architecture Decisions

Decisions taken while implementing the Canonical Entity Model, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19). Decisions marked *affects* constrain later Epics.

---

## D-001 — Canonical ids are derived, never allocated

**Decision.** An entity's id is a pure function of its natural identity:
`canonicalKey(kind, sourceSystem, scope, sourceId)` hashed to a UUID.

**Alternatives.** A random UUID with a unique index on the natural key; a
database sequence.

**Reason.** AC-2 requires ids to remain stable across repeated ingestion. With a
derived id, stability is a property of the *identifier* rather than something
every ingestion path has to remember to preserve — an upsert conflicts on a
value the caller could not have got wrong, and a provider cannot accidentally
create a duplicate by forgetting to look one up first.

It also means an id can be computed without touching the database, which
EPIC-007 needs in order to record a relationship to an entity it has not
ingested yet. *Affects every ingestion Epic.*

---

## D-002 — SHA-256, not the SHA-1 of UUIDv5

**Decision.** The digest is SHA-256, truncated to 128 bits and stamped as an
RFC 9562 **UUIDv8**.

**Alternatives.** UUIDv5, which is the conventional choice for a deterministic
UUID from a namespace and a name.

**Reason.** UUIDv5's digest is SHA-1, for which chosen-prefix collisions are
practical. Ferret derives ids from identifiers found in repositories it did not
write, and Governance §12 treats repository content as untrusted. A feasible
collision would let a hostile repository alias one entity onto another and
silently corrupt the knowledge base — the kind of failure that is invisible
until someone acts on a wrong answer.

UUIDv8 is the version RFC 9562 reserves for application-defined generation, so
the result is a well-formed UUID that stores in PostgreSQL's native type,
indexes as 16 bytes, and is honestly labelled as derived rather than passing
itself off as a random v4. The cost over SHA-1 is nothing.

---

## D-003 — Key parts are length-prefixed

**Decision.** `encodeKeyParts` writes `<byteLength>:<part>` for each part.

**Reason.** A plain separator cannot make the encoding unambiguous, because
source identifiers are arbitrary strings from systems Ferret does not control:
a branch really can be called `feature/a:b`. Length prefixing makes `["a","b:c"]`
and `["a:b","c"]` unable to collide *by construction* rather than by hoping the
separator is exotic enough. Bytes rather than characters, so a multi-byte part
does not reintroduce the ambiguity.

---

## D-004 — One table for every kind, not one table per kind

**Decision.** A single `ferret.entity` table, with kind-specific fields in a
`jsonb` `attributes` column validated against a per-kind Zod schema before any
write.

**Alternatives.** Sixteen typed tables; a table per kind plus a shared identity
table.

**Reason.** Sixteen tables would mean sixteen places to add a column when
EPIC-008 adds provenance, sixteen joins for a cross-kind query, and a DDL
migration every time a provider needed a kind the core did not ship — which AC-4
forbids outright. The schema is open; the *writes* are not, because validation
happens in `src/domain/attributes.ts` before anything reaches the database.

This is generalise-first, specialise-on-measurement (Governance §17). Where a
later Epic proves a query needs typed columns, it can add a table keyed by
`entity.id` without disturbing this one. *Affects EPIC-086.*

---

## D-005 — Canonical attributes are strict; unknown fields are untouched

**Decision.** Every attribute schema is `.strict()`. Anything the source
returned that Ferret does not model goes to `unknownFields`, retained verbatim
and never validated or interpreted.

**Reason.** AC-5 asks for two things at once — retain unsupported source fields,
*without corrupting the canonical model* — and one box cannot do both. Two boxes
satisfy both: a typo like `titel` fails validation rather than landing in the
model as a field nothing will ever read, while a genuinely unmodelled field
survives and can be promoted later without re-fetching from the source.

Unknown fields take part in the content fingerprint, so an upstream change to a
field Ferret does not yet understand is still detected as a change.

---

## D-006 — The kind is validated against the registry, not against an enum

**Decision.** The entity envelope validates `kind` for shape (lowercase
snake_case) and for existence against the kind registry.

**Reason.** Found by test. The first implementation used a `z.enum` of the
sixteen built-ins, which made `registerEntityKind` a no-op with a convincing
API: a provider could register a kind and still have every entity of it rejected
by the envelope before the registry was consulted. A hard-coded enum is exactly
the core change AC-4 forbids.

`CanonicalEntity.kind` is correspondingly typed as the union *plus* `string`.
Narrowing to the built-ins would be a type asserting that extensions are
impossible; the union half keeps autocomplete useful for the kinds the core
ships.

---

## D-007 — Unchanged content is not rewritten

**Decision.** Ingestion compares the stored `content_hash` first. An identical
re-ingestion moves `last_indexed_at` and nothing else; `first_indexed_at` is
never rewritten by an update.

**Reason.** Governance §10 requires reprocessing unchanged content not to create
duplicate logical entities, and the weaker reading — "do not insert twice" —
misses the more damaging failure. Rewriting the row on every scan would destroy
the record of when the content *actually* last changed, and "when did this last
change" is one of the questions Ferret exists to answer.

Recording that Ferret looked is still valuable — it is how staleness is measured
(EPIC-057) — so the two timestamps are separate. *Affects EPIC-031, EPIC-076.*

---

## D-008 — Fingerprints are order-insensitive for objects, order-sensitive for arrays

**Decision.** `stableStringify` sorts object keys and preserves array order.
`undefined` is treated as absent.

**Reason.** A provider returning the same fields in a different order must not
look like a change, or every re-index would report churn that did not happen.
Arrays are different: a list of commit parents is ordered, and the first parent
means something specific — sorting them would erase which side of a merge was
which.

---

## D-009 — `deleted` is a tombstone, not a delete

**Decision.** `EntityStore.tombstone` sets the lifecycle. Nothing in the store
removes an entity.

**Reason.** Governance §6 forbids silently rewriting source evidence, and "what
happened to this file, when was it deleted, what did it contain" are precisely
the questions Ferret indexes history to answer. Erasing the row would erase the
answer along with the file. EPIC-032 owns the index lifecycle this feeds;
EPIC-088 owns retention, which is where genuine deletion must be asked for
explicitly.

---

## D-010 — External ids are a table, not a JSON array

**Decision.** `ferret.entity_external_id`, indexed on `(system, external_id)`.

**Reason.** These are looked *up*, not just read back: "which entity does GitHub
node id X refer to" is a question EPIC-051 and every synchronization Epic asks
constantly, and an array inside the entity row would make it a scan.

Replacement is delete-then-insert rather than merge, because an identifier a
source has stopped reporting should stop resolving — a stale mapping points at
the wrong entity, which is worse than no mapping. The cost is that `first_seen_at`
is re-set, which is recorded as a known limitation rather than hidden.

---

## D-011 — `branch` and `worktree`, `file` and `file_version` are separate kinds

**Decision.** Four kinds, not two.

**Reason.** Governance §9 forbids conflating branch and worktree identity, and
the reason is concrete: one branch can be checked out in several worktrees, and
a worktree can be detached from any branch. Modelling a worktree as "a branch
with a path" makes both facts unrepresentable.

The file split is the same shape of argument. A file has continuing identity
across a rename or an edit; a version is immutable content at a point in time.
Merging them makes "what did this file look like at that commit" unanswerable,
which is most of the point of indexing history. *Affects EPIC-018, EPIC-023,
EPIC-031.*

---

## D-012 — drizzle-kit generates migrations; a script adapts the numbering

**Decision.** `npm run migration:generate -- <name>` runs drizzle-kit into
`src/storage/migrations/staging/`, then promotes one file into Ferret's
`NNNN_name.sql` sequence.

**Reason.** TECHNOLOGY-DECISIONS §3 selected Drizzle over Kysely *specifically*
for generated, diffed migrations, and EPIC-002 D-013 deferred adding the tool
until there was a schema to generate from. Hand-writing the diffs instead would
undercut the stated reason for the technology choice.

The adapter exists because the two numbering schemes disagree and neither is
negotiable: drizzle-kit numbers from `0000` and needs its `meta/` snapshot in
order to diff, while Ferret's migrator requires a gap-free sequence from `0001`.

**Generated SQL is reviewed before it is committed**, and the first migration
proved why: drizzle-kit emitted a bare `CREATE SCHEMA "ferret"`, which fails on
every database Ferret has already touched, because EPIC-002's bootstrap DDL
creates that schema before any migration runs. A schema diff knows what changed,
not what else already exists. The edit is recorded in the migration's header.

---

## D-013 — The applied schema is asserted against the declared schema

**Decision.** An integration test introspects `information_schema` after
migration and compares columns, types and nullability to what the Drizzle schema
declares.

**Reason.** Drizzle types the *queries*; only the migration shapes the
*database*. Nothing else notices when they disagree until a query fails in
production — and a generated migration makes that more likely, not less, because
the generation step is the thing that could silently produce nothing.

An `EXPLAIN` assertion sits alongside it, checking that canonical-key lookup uses
its index. At test scale a sequential scan is fast; only the plan reveals that it
would not stay so at repository scale.

---

## D-014 — An entity written by a newer Ferret is refused, not guessed at

**Decision.** Reading a row whose `schema_version` exceeds
`ENTITY_SCHEMA_VERSION` raises `E_SCHEMA_UNSUPPORTED`.

**Reason.** The same stance EPIC-002 takes with the database schema and EPIC-003
with the configuration file: a newer envelope may have moved a field, and
reading it under the old meaning would apply an interpretation the writer never
intended, quietly. EPIC-010 owns the compatibility rules that will let some of
these be read rather than refused.
