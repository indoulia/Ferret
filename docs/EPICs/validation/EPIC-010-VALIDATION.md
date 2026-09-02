# EPIC-010 — Validation Evidence

**Epic:** EPIC-010 — Schema Versioning & Compatibility
**Branch:** `feat/epic-010-schema-versioning-and-compatibility`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Persisted schema has an explicit version | **PASS** | Five surfaces, each versioned and each stated in [`docs/Architecture/COMPATIBILITY.md`](../../Architecture/COMPATIBILITY.md) §1: database schema, entity envelope, configuration file, provider contract, derived artefact. `compatibility.test.ts` asserts `SURFACE_POLICIES` covers exactly those five, so a new surface cannot be added without appearing in the policy. |
| AC-2 | Supported upgrade paths are deterministic and tested | **PASS** | `compatibility.test.ts` (integration) builds the schema **as it stood at every historical version**, then brings it forward — `it.each` over `0..n`, generic across the shipped migration set so it keeps holding as migrations are added. Determinism is asserted separately: upgrading from `0` and from `n-1` produces a byte-identical column shape, so the version a user happened to be on does not change what they end up with. |
| AC-3 | Incompatible versions fail clearly before unsafe writes | **PASS** | `safeToWrite` is false for `upgradable`, `too-old` and `too-new` alike, and `assertSafeToWrite` raises before any write. Distinct codes: `E_MIGRATION_PENDING` for something fixable by `ferret init`, `E_SCHEMA_UNSUPPORTED` for something needing a different Ferret. `compatibility.test.ts` → "an incompatible installation" (3 cases). |
| AC-4 | Provider contract compatibility is explicit | **PASS** | `MINIMUM_PROVIDER_CONTRACT_VERSION`…`PROVIDER_CONTRACT_VERSION` replaces EPIC-001's exact-equality check, with `isSupportedContractVersion` as the single predicate and the registry's error naming the supported span. `compatibility.test.ts` → "provider contract compatibility" (4 cases). |
| AC-5 | Derived indexes can identify the schema/parser/model version that produced them | **PASS** | `ferret.derived_artifact` records producer, producer version, entity schema version and source content hash for any derived thing. `compatibility.test.ts` → "derived artefacts" (5 cases), including detecting an artefact built by a superseded producer version and reporting *why* it is stale. |
| AC-6 | Migration operations are idempotent and recoverable | **PASS** | Established by EPIC-002 and unchanged: atomic apply, advisory-lock serialization, recorded failure state, exactly-once application under 8 racing starters. EPIC-010 adds that compatibility reporting stays truthful **mid-upgrade** — `compatibility.test.ts` → "an interrupted upgrade" asserts a partially migrated database reports the version it has reached, refuses writes, and completes when resumed. |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names six test areas. All six exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Upgrade from every supported prior version | PASS | `compatibility.test.ts` → `it.each` over every version from `0` to the newest migration |
| Interrupted migration | PASS | `compatibility.test.ts` → "an interrupted upgrade"; EPIC-002's `durability.test.ts` covers a `SIGKILL`ed process |
| Incompatible version | PASS | `compatibility.test.ts` → database too new, entity too new, migration pending |
| Concurrent startup | PASS | EPIC-002's `reliability.test.ts` (8 racing starters); EPIC-010 adds "answers compatibility consistently while writes are in flight" |
| Derived-index version mismatch | PASS | `compatibility.test.ts` → "detects an artefact built by a superseded producer version" |
| Downgrade refusal where unsupported | PASS | `compatibility.test.ts` → a database or entity from a newer build is refused with `E_SCHEMA_UNSUPPORTED`; the position is stated in COMPATIBILITY.md §2 |

### Coverage beyond the required list

- **Upgrade determinism** — two different starting versions must produce the same
  schema, asserted by comparing `information_schema` output.
- **The policy is exhaustively unit-tested** — every combination of current,
  upgradable, too-old and too-new, without a database, so the rules can be
  reasoned about independently of the subsystems that apply them.
- **Concurrency** — 8 racing artefact rebuilds leave one row; compatibility
  reporting stays consistent under concurrent writes.
- **Cycle safety** — the error-unwrapping walk gives up rather than looping on a
  self-referencing `cause`.

---

## 3. Two defects this Epic found in shared code

### F-1 — Compatibility checking crashed on a partially migrated database

Reading the entity envelope version failed when the `entity` table did not exist
yet, because a later migration creates it. That is precisely the state in which
an operator most needs a compatibility answer.

Fixed by treating a missing relation as "nothing incompatible here" — the same
stance `readSchemaStatus` already takes toward a database Ferret has never
touched.

### F-2 — Every error arriving through Drizzle was losing its classification

Chasing F-1 revealed the larger problem. **Drizzle wraps a failing query in its
own error and puts the `pg` error in `cause`**, so `error.code` finds nothing.
Every error on a Drizzle path — the entity, relationship, evidence and identity
stores, all of EPIC-006 onwards — was falling through to the generic
`E_STORAGE_UNAVAILABLE` branch, discarding the SQLSTATE, the specific
classification and the remediation that EPIC-002 built.

A permission failure, a missing table and an unreachable server were all
reporting the same thing. Fixed by walking the `cause` chain to a bounded depth
in `errorCodeOf`, with three regression cases including a self-referencing cause.

This is the second time a defect in shared error handling has surfaced from a
later Epic's tests (EPIC-008 found the redaction gap). Both were invisible while
every test still passed.

---

## 4. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Compatibility matrix documented | **PASS** | [`docs/Architecture/COMPATIBILITY.md`](../../Architecture/COMPATIBILITY.md) — five surfaces, the four verdicts, why `upgradable` is not writable, why `too-new` is always refused, and how to add a version. |
| Migration strategy documented | **PASS** | COMPATIBILITY.md §3, including what EPIC-002 already guarantees and what EPIC-010 adds on top. |
| Automated migration tests pass | **PASS** | Upgrade from every version, determinism across paths, interruption, concurrency. Total suite: 807 passing, 3 skipped. |
| Unsafe downgrade behaviour is explicit | **PASS** | COMPATIBILITY.md §2 states the position — never attempted, never silent, recovery is a restore — and `too-new` refusal is tested for both the database and the entity envelope. |

---

## 5. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| Only one version exists for every surface, so no *real* incompatibility has been exercised — only synthetic ones. | The rules are tested; the experience of a genuine breaking change is not. The upgrade-path test is generic, so it will exercise the real thing when it arrives. | EPIC-010, at the first breaking change |
| Nothing rebuilds a stale derived artefact. The marking exists, the rebuild does not. | An operator can find what is stale but must trigger the rebuild themselves. | **EPIC-031**, **EPIC-054**, **EPIC-094** |
| `assertSafeToWrite` is available but not yet called on every write path. | The entity, relationship and evidence stores check their *own* version on read; the aggregate gate is not wired into ingestion, because there is no ingestion yet. | **EPIC-031** — wire it into the indexing entry point |
| Downgrade recovery depends on a backup Ferret cannot yet take. | The position is stated and the refusal is enforced, but the recovery path is another Epic's. | **EPIC-089**, **EPIC-090** |
| Configuration file and provider contract versions are checked by their own subsystems, not by `CompatibilityService.check()`. | The policy covers all five surfaces; the live aggregate reads the two that live in the database. A config file is read before a database connection exists, so folding it in would invert the dependency. | EPIC-010 follow-up if `ferret doctor` should report all five together |
| No user-facing upgrade experience. | `ferret init` applies migrations and `ferret doctor` reports state; nothing guides an upgrade. | **EPIC-106** — Upgrade & Migration UX |
| ~~macOS unvalidated.~~ **Measured 2026-09-03 by EPIC-105:** macOS passes — 112 test files and 2 463 tests on `macos-latest`, including the packaging suite and all seven signal tests. The database suites skip there (no Linux containers), so PostgreSQL behaviour stays validated on Linux only. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |
