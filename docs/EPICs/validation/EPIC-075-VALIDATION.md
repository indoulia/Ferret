# EPIC-075 — Sync Cursor Management · Validation Evidence

**Assessed against:** working tree on top of `2a7c4e0`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, and Ferret's own index.

## What changed

Ferret already resumed, and that mechanism was correct. Three things were wrong
with it as *the* answer:

| before | now |
| --- | --- |
| the position is `{ lastCommitAt }` — a commit timestamp, which is how nothing but Git resumes | the position is **opaque to the core**; a page token round-trips as readily as a timestamp |
| `#readWatermark` / `#writeWatermark` are private to `RepositoryIndexer` | `SyncCursorStore`, reachable by any caller, with the version-staleness rule in one place instead of inline |
| `synchronization` reports a hard-coded `"No source synchronization is configured yet"` | `1 source, last advanced 1125s ago` |

`Checkpoints/EPIC-004.md:94` called that placeholder "a to-do list" and named
this Epic as its replacement. It has been replaced.

**This is a generalisation, not a second mechanism.** The store reads and writes
the *same* `derived_artifact` rows the indexer already used — same kind, same
scope, same metadata, same version gate. Changing the kind would have orphaned
every watermark in every existing installation and silently triggered a full
re-read: a migration disguised as a refactor. A parallel `sync-cursor` kind that
nothing wrote would have been speculative generality wearing the shape of an
abstraction, and that was my first design before I discarded it.

Verified against Ferret's own index, through the CLI:

```
+ index-integrity   ok   1 derived artefact(s), all built by this version; no unfinished runs
+ synchronization   ok   1 source, last advanced 1125s ago (optional)

Ferret is healthy — 9 checks passed.
```

## A regression I introduced in EPIC-095, found by running the product

That "healthy" line is the second half of this Epic's evidence, because before
it `ferret status` said:

> *Ferret is usable but degraded: 584 of 585 indexed scope(s) were built by a
> different Ferret (ferret.parser.code@1.0.0+wts0.25.10+typescript@14/…, none)*

**On a completely healthy index.** EPIC-095 widened `#checkIndex` from
`kind = 'index'` to every `producer LIKE 'ferret.%'`, which swept in
`content-index` artefacts whose `producer_version` is a *parser identity*
rather than a Ferret version.

It is the exact category error EPIC-094's sweep identified and excluded — and I
reintroduced it in the probe two Epics later. Nothing failed: no test asserted
the probe's verdict on a database with content artefacts in it. It was found by
running `ferret status` against the dogfood index while checking this Epic's
own work.

Fixed by restricting the probe to `producer = 'ferret.indexer'`, the same rule
the sweep applies, with the reasoning in the SQL so the next person to widen it
sees why not.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 a position is stored per scope and returned untouched | MET | a Git-shaped position and a `{ pageToken, updatedSince, etag }` one both round-trip; scopes stay apart |
| AC-2 advancing is explicit | MET | reading twice does not move `advancedAt`; advancing does |
| AC-3 another build's cursor is not returned | MET | `read` returns `undefined` and `list` omits it — *no* cursor, not an old one, because any value returned would be resumed from |
| AC-4 `list` reports every cursor with its age | MET | asserted, and asserted to carry **no position** |
| AC-5 a Git run resumes from what it always did | MET | same kind, scope and metadata; the existing indexing suites pass unchanged, which is the proof — a change to what a run resumes from would show up there |
| AC-6 the indexer holds no private watermark logic | MET | both methods delegate to the port; the version check moved into the store |
| AC-7 `synchronization` reports a real status | MET | `ok` with newest and oldest ages, `unknown` when nothing has synced |
| AC-8 never synced is not zero seconds behind | MET | an empty cursor list is `unknown` with a remediation, never `ok` |
| AC-9 the EPIC-004 records discharged | MET | both restated |

## Two judgements worth review

**No staleness threshold.** `synchronization` reports an age and makes no
verdict on it — a cursor thirty days old is still `ok`. Deciding that four hours
behind is degraded would invent a number nobody argued for: how stale is too
stale depends on how often the operator indexes, which Ferret cannot know and
EPIC-078 will when scheduling exists. Asserted as a test, so the absence is
deliberate rather than forgotten.

**`plannedCapabilityComponents` is now empty and kept.** The pattern it
establishes is right — a planned capability belongs in the report as `unknown`
rather than missing from it — and the next Epic to need it should find it rather
than reinvent it.

## Verification

`npm run verify` green: 122 files, 2 545 passed, 3 skipped. New:
`src/storage/cursors.ts`, `tests/integration/storage/cursors.test.ts` (13).

## Raised, not absorbed

- **Only one provider uses this.** Git is the only source Ferret has, so the
  generalisation is justified by the *existing* mechanism being expressed
  through it, not by a second caller. If EPIC-071 needs something this shape
  does not offer, that is the point at which the shape is wrong and should
  change — better than guessing now.
- **`synchronization` reports on Git alone** and its wording says "sources"
  generically. Accurate today because Git is the only source; worth revisiting
  when a second one exists.
- **The cursor port is optional on the indexer**, and its absence falls back to
  the artefact store with the version check restated inline. Two paths to keep
  in step, which is the thing this codebase warns about — accepted because
  making it required would break every existing composition, and the fallback is
  three lines that the integration suites exercise.
- **EPIC-076 is unaffected.** This Epic records position; deciding when to read
  again is that Epic's, and nothing here schedules anything.
