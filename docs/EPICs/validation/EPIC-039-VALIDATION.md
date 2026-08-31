# EPIC-039 — Session Model: validation evidence

**Status: VALIDATED** · domain-only Epic; no database, no provider, no new
runtime dependency.

## What a session is

An identity envelope, not a transcript. `sessionId` + `provider` name the AI
session; `actorId` names whoever operates it; repository, worktree, branch and
parent are optional and absent unless the caller supplied them. Lifecycle is
`active → completed | abandoned`, one way.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 stable identifier, neutral fields | PASS | `creates a stable active session without fabricating optional scope`, `uses a provider-neutral deterministic session key` |
| AC-2 session distinct from actor | PASS | `actorId` is a separate required field; identity derives from `sessionId` alone, so one actor's two sessions never collide |
| AC-3 optional scope never fabricated | PASS | the minimal session in AC-1's test leaves `repositoryId`, `worktreeId`, `branch` `undefined` |
| AC-4 lifecycle constrained | PASS | `SessionStatus` is a closed union; `endSession` excludes `'active'` in its own signature |
| AC-5 start required, end only after terminal | PASS | schema requires `startedAt`; `endedAt` is `null` until `endSession`, asserted in `supports completed and abandoned terminal transitions` |
| AC-6 terminal transitions monotonic | PASS | same test: touching or re-ending a completed session throws; `creates a linked continuation rather than reopening a terminal session` |
| AC-7 deterministic Ferret errors | PASS | every rejection throws `FerretError` with `ErrorCode.IDENTITY_INVALID`, details and a remediation |
| AC-8 no transcript, no credentials | PASS | `rejects invalid input and impossible boundaries` asserts `.strict()` refuses a `credentials` key; the model has no content field |
| AC-9 tests cover the boundaries | PASS | 7 tests: creation, optional scope, key determinism, monotonic activity, offset ordering, both terminal transitions, continuation, invalid input |
| AC-10 documentation and evidence | PASS | this file; spec and `docs/EPICs/README.md` updated |

## Defect found while recording this

**Activity was ordered as text.** `touchSession` and `endSession` compared
`at.toISOString()` — always UTC — against `lastActivityAt`, which is
`startedAt` exactly as the caller wrote it, and the schema accepts an offset.
So a session started at `'2026-08-31T23:00:00+05:30'` (17:30Z) refused a touch
at 18:00Z, and one started at `'2026-08-31T01:00:00-05:00'` (06:00Z) accepted a
touch at 05:00Z — an hour before it began. Compared as instants now, covered by
`orders activity by instant, not by the written form of startedAt`.

Found while validating EPIC-041, which had the same defect in
`advanceSessionCheckpoint`; see that Epic's evidence.

## Limitations

- **Nothing persists a session.** No table, no repository; storage Epics own it.
- **`continueSession` does not check that the continuation starts after its
  parent ended.** It refuses to continue an *active* session, which is AC-6's
  requirement, but a continuation timestamped before its parent's end is
  accepted. Ordering across two sessions is not in this Epic's criteria.
- **`startedAt` is stored as written**, so two sessions describing the same
  instant in different offsets are not textually equal. Ordering is correct
  regardless; identity does not involve the timestamp.
- **No actor resolution.** `actorId` is an opaque string here; EPIC-009 owns
  alias and collision handling.

## Suite

`58 files, 1071 passed, 288 skipped` with the database suites skipped, which is
the `verify` job's configuration. `npm audit --omit=dev`: 0 vulnerabilities.
