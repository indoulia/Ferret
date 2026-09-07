# EPIC-137 — Code-State Anchored Durable Context: architecture decisions

Recorded before implementation, per Governance §22.

**In one sentence:** the statement keeps its identity, the observation carries the content hash it was read from, and the verdict is a read-time comparison against a repository state Ferret has shown correspondence with.

## What already existed

The evidence model was built for this and never wired to it: `sourceContentHash` (`src/domain/evidence.ts:157`, "what makes staleness detectable"), `locator` (`:105`), `EvidenceState.STALE` (`:69`, required by Governance §6), believability ordering (`src/context/evidence-selection.ts:125`), and `EvidenceStore.markStale` (`src/storage/evidence.ts:493`) which has tests and no production caller. Nothing is rebuilt.

## 1 — Tree correspondence (owner, 2026-09-08, final)

> Ferret never claims verification merely because an anchor's content hash matches. Verification additionally requires correspondence between the indexed repository state and the state being evaluated.

Otherwise `unknown`, never `verified`. Latest `main`, latest indexed state and the agent's checked-out worktree are never equated.

**Why:** a hash answers "are these the bytes I read?" against whatever tree Ferret last indexed — not the tree the reader has. Only "matches what you have" is worth skipping verification for. The measured failure this prevents is exactly a correspondence failure: a record true at `144d478`, false after `70bcfca` (§7.4).

**Mechanism, all pre-existing:** indexed `branch.headCommit` (`src/domain/attributes.ts:77`) against live `readWorktreeState().headCommit` (`src/git/worktree-state.ts:40`, EPIC-038 — one `git status` read, no watcher), plus the anchored path not being uncommitted.

**Rejected:** commit SHA as key (names a whole tree, so any commit drifts everything; dies on rebase/squash; says nothing about which part the claim rests on — kept as provenance); tree hash (same, less diagnostic); verifying against latest indexed state alone (the equation this forbids); resolving an anchor at an arbitrary named commit (history traversal — that case is `unknown`); persisting a `stale` flag (staleness is relative to the tree evaluated, so one stored value is wrong for any repo with two branches — hence read-time derivation and no `markStale` caller); symbol-body hashing (no body hash exists — `src/code/entity.ts:33` has line spans only; a symbol locator names the area, never the key).

Failure direction is chosen: over-reporting costs one re-verification, under-reporting costs a confident wrong answer.

## 2 — Unanchored context (owner, 2026-09-08, final)

> Unanchored durable context remains supported for backward compatibility but is never considered verified.

Every existing statement reads `unanchored` — distinguishable from `unknown` in verdict and reason, because the action differs: `unknown` means verify from source, `unanchored` means this may not be a code claim. No migration, no backfill, no fabricated anchors. `anchors` is optional and recording is not rejected without it. An anchor arrives on a future observation through the ordinary EPIC-126 merge; that is the adoption path.

## 3 — The anchor belongs to the observation

Statement identity stays `durableContextSourceId(kind, subjectId, normalized)` (`src/context/durable.ts:196`). An anchor in identity would fork one finding per commit, break EPIC-126 merge and EPIC-130 convergence, and change every stored id. `CONTEXT_CONCERNS_ENTITY` is untouched — it means what the statement is *about*, a different question.

## 4 — `sourceId` carries the anchor hash

Found while formalizing; an earlier draft was wrong. `evidenceKey` covers subject, field, statement, method, producer, producer version, source system, `sourceId` and `locator` — **not** `sourceContentHash` (`src/domain/evidence.ts:289`) — and `record()` on an existing key only advances `lastCheckedAt`, because "rewriting the row would be exactly the silent rewrite §6 forbids" (`src/storage/evidence.ts:180`).

So re-recording with the same locator at a new hash produces an identical key, dedupes onto the existing row, and keeps the **old** hash. The refreshed observation would have had no effect and T3 would have failed with nothing pointing at the cause.

**Resolution:** an anchored observation sets `sourceId` and `sourceContentHash` to the anchored version's content hash, mirroring the Git provider (`src/git/provider.ts:1321`). `evidenceKey` is not changed — that would alter every existing row's id, a migration disguised as a refactor. Re-recording at an unchanged hash still dedupes, which is correct.

## 5 — Drift is not falsity

> A changed anchor must not automatically supersede, archive, delete, negate or demote. An unchanged anchor does not prove the statement correct; it proves the observed code state still matches the state the observation was made against.

Supersession stays a producer stating a replacement; the port exposes no bare `supersede` (`src/context/durable-port.ts:116`) and drift is precisely the case where nobody has stated one. Explicit supersession outranks every verdict. This also stays clear of EPIC-057 §8.2, which refused a decay curve because age is not evidence: a hash mismatch is an observation, not a half-life.

## 6 — No new machinery

No new entity kind, relationship type, lifecycle state, table, database subsystem, MCP tool, watcher, scheduler or agent. `LifecycleState` already refused a sixth `historical` value as meaning the same as `superseded` (`src/domain/kinds.ts:119`); the same argument forbids verification values there. Verification is the `EvidenceState` axis. The tool surface is not reduced — EPIC-136 §4a stands.

## 7 — The harness may not manufacture the capability (owner, 2026-09-08)

An earlier draft proposed a pre-flight that synthesized an anchor from statement prose inside `benchmark/agent/` to test agent behaviour before building the write path. Rejected: validation must run the product path, and a harness that manufactures the mechanism under test measures the harness. Prose-derived anchors are forbidden in the product for the stronger reason — an anchor parsed from a sentence is inference presented as evidence (Governance §6).
