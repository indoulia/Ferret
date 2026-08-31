# EPIC-041 — Durable Checkpoints: validation evidence

**Status: VALIDATED** · domain-only Epic; no database, no provider, no new
runtime dependency.

## What a checkpoint is

A frozen value derived from a session: identity from `sessionId` +
`checkpointSequence`, a capture watermark, a compact summary, and an opaque
`continuationState` restricted to JSON. Raw capture (EPIC-040) remains the
evidence; the checkpoint is the part a later session reads first.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 bound to a session and provider | PASS | `sessionCheckpointInputSchema` requires both, non-empty |
| AC-2 deterministic identity | PASS | `creates deterministic immutable first checkpoints`, `uses session plus checkpoint sequence for identity` |
| AC-3 non-negative capture watermark | PASS | `rejects invalid, empty, negative, non-finite, and extra input` |
| AC-4 monotonic, no sequence reuse | PASS | `advances checkpoint and capture watermarks monotonically`; `<=` rejected, so reuse is rejected |
| AC-5 summary plus neutral continuation state | PASS | `continuationState` is `Record<string, JsonValue>`; no provider field exists to set |
| AC-6 stable content hash over the payload | PASS | `serializes stably and verifies integrity`; hash covers `payloadOf`, excludes itself and `id` |
| AC-7 immutable, invalid input rejected | PASS | `Object.isFrozen` on the checkpoint and on `continuationState`; `.strict()` rejects extra keys |
| AC-8 tests cover the boundaries | PASS | 6 tests: first, progression, out-of-order sequence, receding watermark, receding timestamp, offset ordering, hashing, serialization, immutability, invalid input |
| AC-9 provider-neutral, no new dependency | PASS | imports `zod`, `./identity.js`, `../errors/index.js` only; boundary test covers the directory |
| AC-10 documentation and evidence | PASS | this file; spec and `docs/EPICs/README.md` updated |

## Defects found while building

1. **The branch did not compile.** `bd68f00 fix: remove duplicate domain
   export` deleted the wrong line — the duplicated export was
   `RelationshipTypeDefinition`, so removing one occurrence also took
   `RelationshipInput` off the domain barrel and broke four importers. All
   three CI jobs failed on it, each at its `tsc` step, which is why the
   failure looked like three unrelated problems.
2. **`z.ZodType<JsonValue>` types the schema's *input* as `unknown`** in Zod 4.
   `SessionCheckpointInput.continuationState` widened to
   `Record<string, unknown>`, which will not build. Both type arguments are now
   named, and the array variant is `readonly` so an `as const` continuation
   state satisfies it.
3. **Checkpoint timestamps were ordered as text.** The schema accepts an
   offset, and `'2026-08-31T23:00:00+05:30'` (17:30Z) sorts *after*
   `'2026-08-31T18:00:00Z'` as a string while preceding it as an instant — so a
   legitimate advance was rejected and a receding one accepted. Compared with
   `Date.parse` now, covered by `orders checkpoint timestamps by instant, not
   by their written form`.

## Limitations

- **Nothing persists a checkpoint.** `serializeSessionCheckpoint` produces the
  durable form and no storage writes it; the table, retention and encryption
  are storage/security Epics, per Non-scope.
- **Monotonicity is enforced between two values in hand**, not across a
  session's history. Nothing prevents two callers each advancing the same
  `previous` to sequence 2 — a uniqueness constraint on
  (`sessionId`, `checkpointSequence`) is the storage Epic's job.
- **`checkpointedAt` is stored as written.** Two checkpoints of the same instant
  in different offsets hash differently. Ordering is correct regardless;
  identity does not involve the timestamp.
- **No decision extraction** (EPIC-042) and **no recovery orchestration**
  (EPIC-043), so a later session must read the summary itself.
- ~~**EPIC-039 compares timestamps as text too**~~ — `touchSession` and
  `endSession` measured a normalized `Date` against a possibly-offset stored
  `startedAt`. Found here, fixed in EPIC-039's validation pass; see
  [its evidence](EPIC-039-VALIDATION.md).

## Suite

`54 files, 1018 passed, 271 skipped` with the database suites skipped, which is
the `verify` job's configuration. `npm audit`: 0 high or critical.
