# Ferret Compatibility Matrix

**Status: APPROVED**
**Owner: EPIC-010 — Schema Versioning & Compatibility**
**Effective: 2026-08-30**

This is the single statement of what Ferret can read, what it will refuse, and
what happens in between. Governance §21 requires versioning wherever a change can
affect reproducibility; this document says what the versions *mean*.

---

## 1. Versioned surfaces

Ferret versions five things independently, because they change for different
reasons and at different rates.

| Surface | What it versions | Where it lives | Current | Minimum supported |
| --- | --- | --- | --- | --- |
| **Database schema** | Applied migrations | `ferret.schema_migrations` | the newest shipped migration | `0` — an empty database |
| **Entity schema** | The canonical entity envelope | `ferret.entity.schema_version` | `1` | `1` |
| **Configuration file** | The persisted config format | `version` in the config file | `1` | `1` |
| **Provider contract** | The interface a provider is built against | declared by the provider | `1` | `1` |
| **Derived artefact** | An index, embedding or summary, plus what produced it | `ferret.derived_artifact` | `1` | `1` |

Everything is at `1` because nothing has evolved yet — which is the right moment
to fix the rules, before there is pressure to bend them for a particular
migration.

---

## 2. The policy

For any surface, given the version found and the version this build writes:

| Condition | Verdict | Safe to write? | What Ferret does |
| --- | --- | --- | --- |
| `found == current` | `current` | **Yes** | Proceeds |
| `found < current`, `>= minimum` | `upgradable` | **No** | Refuses to write, and says how to upgrade |
| `found < minimum` | `too-old` | **No** | Refuses, naming the version that can read it |
| `found > current` | `too-new` | **No** | Refuses, and says to upgrade Ferret |

### Why `upgradable` is not safe to write

A write that landed *before* the upgrade would be in a shape the upgrade then has
to reconcile. That is how a migration acquires special cases: each one is a
record written by a build that did not know what was coming. Refusing the write
keeps every migration a function of the schema alone.

### Why `too-new` is always refused

A newer version may have moved a field. Reading it under the old meaning applies
an interpretation the writer never intended — silently, which is the worst way to
be wrong. Ferret refuses rather than guessing.

### Downgrade

**Not supported, and not silently attempted.** Ferret never writes data an older
build can read, and an older build encountering newer data refuses it as
`too-new`. Recovering an older installation means restoring a backup taken before
the upgrade; EPIC-089 owns backup and export.

This is a deliberate position rather than an omission. A downgrade path would
have to discard whatever the newer version added, and doing that automatically
would destroy data the user has no reason to expect to lose.

---

## 3. Upgrade paths

**Every supported prior version is tested**, not asserted. `tests/integration/storage/compatibility.test.ts`
builds the schema as it stood at each historical version, then brings it forward,
which is exactly what an upgrading user does:

- for every version `v` from `0` to the newest shipped migration, apply migrations
  `1..v`, then run the full set and assert the result reaches the target with
  nothing pending, no drift and no recorded failure;
- and assert that upgrading from `0` and upgrading from `n-1` produce a **byte-
  identical schema shape**, so the version a user happened to be on does not
  change what they end up with.

The test is generic over the shipped migration set, so it keeps holding as
migrations are added rather than needing a new case for each.

### Interruption and concurrency

Both are already guaranteed by EPIC-002 and were not re-derived here:

- a migration and the record that it ran commit in one transaction, so an
  interrupted upgrade leaves the database at its last good version;
- concurrent starters serialize on an advisory lock, so each migration is applied
  exactly once;
- a failed migration records why, in the database, where `ferret doctor` finds it.

EPIC-010 adds that compatibility reporting stays **truthful mid-upgrade**: a
partially migrated database reports the version it has actually reached, not the
one it is heading for, and refuses writes until it gets there.

---

## 4. Provider contracts

A provider declares the contract version it was built against. The runtime
accepts anything within `[MINIMUM_PROVIDER_CONTRACT_VERSION, PROVIDER_CONTRACT_VERSION]`.

EPIC-001 compared for exact equality, which made every contract change a flag day:
a provider built against version 1 would be refused by a runtime implementing
version 2 even where nothing it used had changed. The range is currently a single
version, so behaviour is unchanged — the rule is simply stated rather than
implied.

**Raising the minimum drops support for existing providers** and belongs in a
release note, not a refactor.

---

## 5. Derived artefacts

An index, embedding or summary records what produced it and at which version. An
artefact is stale when **any** of these differ from the current build:

- the producer (`ferret.parser.pdf` → `ferret.parser.pdfium`);
- the producer version (`6.3.289` → `7.0.0`);
- the entity schema version it was built against;
- the hash of the source content it was derived from.

Ferret compares producer versions as **opaque strings**, not semver. A producer
version may be a semver, a git sha or a model name, and Ferret cannot know
whether a given change was breaking — so any difference marks the artefact for
rebuild. That is the conservative direction, and the only one that cannot serve a
result nobody could reproduce (Governance §21).

`validateArtifact` reports *why* an artefact is stale. "The parser changed" and
"the file changed" call for the same action but mean different things, and an
operator asking why everything is rebuilding deserves the real answer.

---

## 6. Adding a version

When a surface changes incompatibly:

1. Increment `current` in `SURFACE_POLICIES` (or ship the migration, for the
   database schema).
2. Decide whether `minimumSupported` moves. It should not, unless supporting the
   old version is genuinely impractical — and if it moves, say so in the release
   notes and update the table in §1.
3. Write the upgrade. For the database, `npm run migration:generate` and **read
   the SQL**; for the entity envelope, a migration that rewrites affected rows.
4. The upgrade-path test picks up a new migration automatically. A new *surface*
   needs a row in §1 and an entry in `SURFACE_POLICIES`; `compatibility.test.ts`
   asserts the two stay in step.

---

## 7. What this does not cover

| Not covered | Owner |
| --- | --- |
| ~~Backup and restore, which is the real recovery path for a downgrade~~ **Half closed 2026-09-02 by EPIC-089:** `ferret export` writes a schema-version-stamped NDJSON document a *lower* version can read, which is the half a `pg_dump` cannot be. The backup half stays out of scope deliberately — that is `pg_dump`, and Ferret prints the command rather than wrapping it (`ferret export --backup-command`). **Restore** is still open. | **EPIC-090** (import), and `pg_dump` |
| ~~Import of data exported by another installation~~ **Closed 2026-09-02 by EPIC-090:** `ferret import` reads a document `ferret export` wrote, refusing a newer entity schema version and accepting an older one — which is the downgrade path §7 pointed at. A round trip through two databases is what validates the format. | closed |
| Rebuilding derived artefacts once marked stale — the marking exists, the rebuild does not | **EPIC-031**, **EPIC-054**, **EPIC-094** |
| The upgrade *experience* — what a user sees and is asked | **EPIC-106** |
| Embedding-model versioning specifics | **EPIC-054** |
