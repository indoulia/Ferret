# EPIC-137 — Code-State Anchored Durable Context

**Status:** APPROVED · **Priority:** P1 · **Domain:** Durable Context · **Classification:** CONTINUATION

Approved 2026-09-08. Decisions: [EPIC-137-DECISIONS](../Architecture/EPIC-137-DECISIONS.md). Not implemented.

## 1. Objective

A durable statement records the repo-relative paths and content hashes it was observed against; a reader is told whether that content still matches the repository state Ferret can establish.

## 2. Problem

`current: true` means unsuperseded, not still-true. A record has no relation to the tree it was true of; `ferret_why` returns the statement as its own evidence.

Measured 2026-09-07 ([evidence](../evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md)): retrieval and discovery already work (7/8 unprompted, durable context ranked first, §9); Agent A spent $1.40/1.0M tokens establishing a finding and B/C/D re-derived it in **both** arms for $3.94 (§7.5); the agent was right to — in Session C the record was false (§7.4). §9 names this the highest-value gap. [Continuity §4](../evidence/FERRET-DOES-CONTEXT-CARRY.md): a statement that quietly stopped being true is "the failure mode with no defence in either condition". Supersession needs a witness; this adds the pull side.

Primitives already present, never wired for agent-recorded context: `sourceContentHash` (`src/domain/evidence.ts:157`), `locator` (`:105`), `EvidenceState.STALE` (`:69`), believability order (`src/context/evidence-selection.ts:125`), `markStale` (`src/storage/evidence.ts:493`, no caller), `file` id from `(repo,path)` (`src/git/provider.ts:1240`), `file_version.contentHash` (`:1255`), `FILE_HAS_VERSION` (`:1287`), `branch.headCommit` (`src/domain/attributes.ts:77`), `readWorktreeState()` (`src/git/worktree-state.ts:40`).

## 3. Value

A checkable byte claim instead of a confidence score, and on failure the one file to re-read. First capability in the measured set with no notes-file equivalent: `notes-curated` matched Ferret and cost 30% less, but a grep cannot say whether a note still holds. Not claimed: that an agent *will* trust it — §14 measures that.

## 4. Goal

`ferret_context_record` takes optional anchors; the observed hash is stored on the observation; `ferret_context_find` and `ferret_context_pack` report `verified`/`stale`/`superseded`/`unknown`/`unanchored`.

## 5. Non-scope

Symbol-body or line verification; SHA or tree hash as verification key; history traversal to an uncorresponded revision; branch tracking; automatic supersession/archival/negation/decay; retroactive anchoring; prose-inferred anchors; ranking changes (EPIC-130/131); all of EPIC-136 incl. §4a; rationale carry; search default routing; non-code and cross-repo anchors; harness-synthesized pre-flight (Decision 7). No new agent, workflow engine, scheduler, watcher, entity kind, relationship type, lifecycle state, table or MCP tool.

## 6. Architecture

Durable context unchanged. Evidence carries the anchor in `locator` + `sourceContentHash`. File versions are the comparison target (`gitContentHash` = `git-blob:<oid>`, content-addressed, `src/git/files.ts:283`). Producer stays the composition root's; commit and `observedAt` stay provenance. Retrieval untouched. `trust()` computes the verdict (`src/storage/durable-context.ts:410`). Pack and `context_find` render it.

Derived at read time, never persisted — staleness is relative to the tree evaluated, so one stored flag is wrong for any repo with two branches. `markStale` gains no caller. Comparison is a pure function in `src/context/` behind a port; the core still imports no `storage/`.

## 7. Data and model

| Identity | Definition | Change |
| --- | --- | --- |
| Statement | `durableContextSourceId(kind, subjectId, normalized)` (`src/context/durable.ts:196`) | none |
| Observation | `evidenceKey(...)` (`src/domain/evidence.ts:289`) | none |
| Anchor | `(scope, path, observed hash, optional symbol)` on the observation | existing `locator` + `sourceContentHash` |
| Code state | current `file_version.contentHash`; indexed `branch.headCommit`; live worktree head | read only |

An anchor must not enter statement identity — it would fork one finding per commit and break EPIC-126 merge and EPIC-130 convergence.

**`sourceId` carries the anchor hash.** `evidenceKey` covers `sourceId` and `locator` but not `sourceContentHash`, and `record()` on an existing key only advances `lastCheckedAt` (`src/storage/evidence.ts:180`). Without it a re-anchored observation dedupes onto the old row and keeps the old hash — T3 fails invisibly. Mirrors `src/git/provider.ts:1321`. `evidenceKey` itself unchanged.

Additive optional changes: anchor list on `AgentProvenance`, `verification` on `ContextBelief` (`durable-port.ts`); anchors through `ContextProvenance`, used by `record()`/`trust()` (`storage/durable-context.ts`); comparison function and port (`src/context/`); `anchors` and verdict in `mcp/context-tools.ts`; rendering in `pack.ts`/`standing.ts`. No migration. `CONTEXT_CONCERNS_ENTITY` untouched.

## 8. Tree correspondence

> `verified` only when correspondence between the indexed repository state and the state being evaluated is established. Otherwise `unknown`, never `verified`.

Latest `main`, latest indexed state and the agent's checkout are never equated. SHA is provenance; content hash is the key.

Six conditions: (1) lifecycle `active`; (2) a supporting observation visible under `permittedScopes` with a complete anchor; (3) each anchor path resolves to an indexed `file` in scope; (4) each `sourceContentHash` equals the current open-interval `file_version.contentHash`; (5) indexed `branch.headCommit` equals live `readWorktreeState().headCommit`; (6) no anchored path uncommitted. Any one unestablished → `unknown`. Over-reporting costs a re-verification; under-reporting costs a wrong answer.

**Which observation:** any anchored observation satisfying 3–6 → `verified`, reporting that one; else any anchored → `stale` over the most recent; else `unanchored`, or `unknown` if an anchor exists but could not be resolved. Rule 1 is how a re-anchored confirmation takes effect without superseding anything.

| Verdict | Meaning | Action |
| --- | --- | --- |
| `verified` | all six hold | may skip the anchored file |
| `current` | lifecycle `active` = unsuperseded only | not sufficient |
| `stale` | anchored content moved; still `active` | re-read the named anchor |
| `superseded` | replacement named | use the replacement |
| `unknown` | correspondence or anchor not establishable | verify from source |
| `unanchored` | no anchor recorded | judge on its own terms |

Precedence: lifecycle, then verification. No new lifecycle state — `LifecycleState` refused a sixth `historical` value for the same reason (`src/domain/kinds.ts:119`).

Cases: index behind → `unknown` naming the category. Relevant file changed → `stale` naming anchor, both hashes, symbol. Unrelated file changed → still `verified`. Revert → `verified` again with no write. Commit-id change with identical content → `verified` where (5) holds. Dirty anchored path → `unknown`; a truncated `MAX_SAMPLED_PATHS = 50` sample that cannot exclude the anchor is also `unknown`.

## 9. Recording

`anchors: [{ path, symbol?, lineRange? }]` — repo-relative paths, **no entity UUID** (today's `subjectId`/`scope` are `uuid()`, `src/mcp/context-tools.ts:204`). Ferret resolves path → `file` → current version and writes `locator`, `sourceContentHash`, `sourceId`. Scope as today; where none is given and exactly one repository is establishable, that one, else refused with a reason. An unresolvable anchor is **reported per anchor**, never dropped (EPIC-135's lesson). Never inferred from prose, subject or touched files. Producer from the composition root. Re-anchoring is the ordinary record path (§7); correction still means `supersedes` — no bare `supersede` transition (`src/context/durable-port.ts:116`).

## 10. Trust and retrieval

No new tool; EPIC-136 §4a's four refusal contracts stand. Both read surfaces add: verdict; per anchor the path, hash observed, hash now; one sentence in the existing `trustReason` voice. Pack charges it to `estimatedTokens`. Only `verified` licenses skipping source, stated as a byte claim not a score. Absence of an anchor is never verification; nor is recency (EPIC-057 §8.2). `trust()` currently filters support to `EvidenceState.CURRENT` (`:416`) — the derivation must **label, not filter**.

## 11. Security and failure boundaries

**Drift means re-verification is required; drift does not mean the statement is false.** An unchanged anchor proves only that the observed code state still matches what the observation was made against.

`trust()` keeps requiring `permittedScopes`; anchors use the same scoped reads. An unreadable or excluded anchor → `unknown`, reason distinguishing permission / exclusion / not-indexed at **category** level, disclosing no path, hash or existence fact. `redactStatement` covers `locator.detail`.

Never inferred: unchanged anchor ⇒ true; changed anchor ⇒ false (no auto supersede/archive/delete/demote); anchor from prose; verification from a missing anchor or any age signal; correspondence from anything but an established equality. Explicit supersession outranks every verdict.

## 12. Backward compatibility

Unanchored statements are accepted, read `unanchored`, never `verified`, always distinguishable from `unknown`. No migration, backfill or fabricated anchors. `anchors` optional; existing recording not rejected without it. All existing lifecycle operations unchanged. An anchor arrives on a future observation via EPIC-126 merge. Reads keep their shape; no schema enumerates the verdicts.

## 13. Acceptance criteria

- **AC-1** `anchors` accepted as repo-relative paths + optional symbol, no UUID required, persisted as `locator` + `sourceContentHash`.
- **AC-2** An anchor resolves to the `file` derived from `(scope, path)` and that file's current open-interval `file_version.contentHash`.
- **AC-3** An anchor naming no indexed file returns an explicit per-anchor failure; not dropped, not guessed.
- **AC-4** Statement identity unchanged by anchoring; anchored and unanchored recordings of one statement merge, with EPIC-126 outcome, support count and near-duplicate relation unchanged.
- **AC-5** Producer, producer version and actor come from the composition root.
- **AC-6** All six §8 conditions → `verified`, each anchor reported with hash observed and hash now.
- **AC-7** Anchored content changed → `stale`, lifecycle still `active`, anchor and both hashes named.
- **AC-8** Non-anchored file changed → still `verified`; no path outside the anchor set consulted.
- **AC-9** Revert to original content → `verified` again, no write to statement or evidence.
- **AC-10** Commit-id change with identical content → `verified` where (5) holds, `unknown` where not.
- **AC-11** `unknown` with a distinguishable reason, never `verified`, for: repository not indexed; indexed head ≠ live head; anchored path uncommitted; truncated dirty sample; scope not locally readable.
- **AC-12** No anchor → `unanchored`, distinct from `unknown`, never `verified`.
- **AC-13** A prose citation without `anchors` → `unanchored`.
- **AC-14** Drift changes no lifecycle and writes nothing.
- **AC-15** Superseded → `superseded` regardless of anchor state, replacement named, not rendered trustworthy.
- **AC-16** Anchor outside `permittedScopes` → `unknown`, category-level reason, no path/hash/existence disclosure.
- **AC-17** EPIC-066 AC-6, EPIC-067 AC-12, EPIC-068 AC-5/AC-6, EPIC-117 AC-5 still pass.
- **AC-18** `redactStatement` applies to `locator.detail`.
- **AC-19** Both surfaces render the verdict; pack charges it; selection and ordering unchanged against a fixed store.
- **AC-20** Verification cost bounded and flat in store size at 27/67/150 statements.
- **AC-21** Re-record at a **new** hash → second observation (`evidenceKey` differing by `sourceId`), verdict `verified` against the new hash, no supersession.
- **AC-22** Re-record at an **unchanged** hash → dedupe: no second row, support count unchanged, `lastCheckedAt` advanced.
- **AC-23** `evidenceKey` inputs unchanged: a fixed input's id is identical before and after.

## 14. Real-agent validation

`benchmark/agent/`, one model, one repo, one variable. Product path only: `ferret_context_record` → real anchor resolution → real indexed `file_version` → real `trust()` → fresh agent. The harness may not synthesize an anchor or verdict. Control = today's surface; treatment = same statement and ranking plus the verification field. Agent A records; Agent B is fresh, no transcript.

| Task | Setup | Required treatment behaviour |
| --- | --- | --- |
| T1 | relevant code unchanged | inherits without re-reading the anchored file |
| T2 | relevant code changed | verifies before trusting; reaches the correct current answer |
| T3 | re-anchored against new content | uses the refreshed observation |
| T4 | explicit replacement exists | uses the replacement |
| T5 | unrelated file changed | does not become stale |

Measured per arm and task: anchored-file reads, files and lines read, session tokens, wall-clock, dollar cost, correctness, evidence quality, stale assertions, false-drift assertions. Compared to the Phase 5/6 baseline where tasks correspond (2.9 files / 355 lines vs 6.1 / 807; A's $1.40; $3.94 re-derivation).

**Success:** on T1, T3, T5 the treatment answers correctly without re-reading the anchored file while the control re-reads it, well below A's cost; T4 uses the replacement.

**Mandatory safety:** on T2 the treatment verifies before trusting and reaches the correct answer; stale assertions zero in every task, both arms.

> If T1 saves rediscovery but T2 causes stale knowledge to be trusted, EPIC-137 fails regardless of every other metric.

T5 guards the mirror failure: false drift must be zero. A negative result is a valid outcome and must be reported as one.

## 15. Implementation sequence

1. Anchor on the observation — types, resolution, `sourceId`, per-anchor failures. AC-1–5, 21–23. Dogfood: record an anchored statement through `ferret mcp`; inspect the row.
2. Verification derivation — pure comparison, correspondence, label-not-filter. AC-6–15. Dogfood: edit → `stale`; revert → `verified`.
3. Permission and disclosure. AC-16–18, coverage built as EPIC-135's withheld-path tests were.
4. Surface — `context_find`, then pack/standing with the estimate charged. AC-19, 20, full MCP contract suite for AC-17. Dogfood: pack a real question, record the token delta.
5. T1–T5, both arms, product path. Keep failing runs.
6. Evidence report + `validation/EPIC-137-VALIDATION.md`.

## 16. Open decisions

Locked, not reopened: §8 correspondence, §12 unanchored acceptance, EPIC-136 §4a.

1. **Dirty-worktree strictness.** §8(6) makes any uncommitted change to an anchored path `unknown`. Hashing the working file would let a dirty tree verify but reads content outside the index (EPIC-135 semantics). §8 is the conservative default.
2. **Whether re-anchoring requires actually re-reading the code.** An agent can re-record against the current hash without opening the file and Ferret cannot detect it. Alternative: a distinct `EvidenceMethod` with different authority.
3. **Whether `stale` may influence ordering.** Assumed not. Drift is an observation rather than age, so EPIC-057 §8.2 does not forbid it, but it needs EPIC-130/131 amendment.

## 17. Definition of Done

Every AC met with evidence in `validation/EPIC-137-VALIDATION.md`; each targeted test observed failing first; full suite, lint, typecheck, build green with `boundaries.test.ts` holding; dogfood steps 1, 2, 4 through `ferret mcp` with output recorded; T1–T5 on the product path, both arms, failures kept, §14 safety met or the Epic reported failed; evidence report, validation record, decisions updated; registry and ROADMAP rows in the same PR; Windows CI green after any rebase; PR merged, `main` clean, Ferret re-indexed.

## 18. Inputs and outputs

**In:** explicit `anchors`; the `file`/`file_version`/`FILE_HAS_VERSION` graph; `branch.headCommit`; `readWorktreeState()`; `permittedScopes`; exclusions. **Out:** `locator`, `sourceId`, `sourceContentHash` on durable-context evidence; `verification` on `ContextBelief`; the verdict in `context_find` and the pack's standing section, charged to `estimatedTokens`.

## 19. Dependencies

EPIC-006, 007, 008, 022/023, 031, 038, 057, 083, 126, 127, 128, 133, 135; EPIC-136 §4a honoured not extended. EPIC-130/131 only in that this must not change them. None requires amendment.

## 20. Contracts

Statement identity is independent of anchors and code state. An anchor belongs to an observation. `verified` only under §8. Drift never changes lifecycle and never writes. A verdict discloses nothing about a file the caller may not see. The verdict is derived at read time; nothing persisted to depend on.

## 21. Test requirements

**Unit:** six verdicts; correspondence and its five failure categories; lifecycle-over-verification precedence; reason wording. **Integration:** row shape; verified, stale, unrelated change, revert, commit-id change, dirty path, missing index; unanchored legacy; EPIC-126 merge parity; re-anchor at new and unchanged hash; `evidenceKey` stability. **Security:** scoped resolution; three reason categories; no disclosure; `locator.detail` redaction; AC-17's contracts. **Failure:** unresolvable anchor; truncated sample; non-local scope; branch absent. **Regression:** a read must not mutate evidence or lifecycle. **Performance:** AC-20 at three sizes.

## 22. Observability and performance

Per statement: one file and one version lookup per anchor, plus one worktree-state read per scope per request, cached for that request. Nothing proportional to store size; no background work. The `reason` string is the diagnostic surface; no new metric or health check.

## 23. Governance alignment

§6 producer-supplied evidence, explicit `unknown`. §7 Git authoritative for content. §9/§10 the four identities stay distinct; branch and worktree not conflated. §12 authorization precedes resolution. §18 every verdict carries a reason. §21 no derived-result format changes shape. §22 decisions recorded before implementation. Standard: APPROVED on defined scope and ACs; DONE requires §17 evidence.
