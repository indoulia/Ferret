# EPIC-133 — Context Governance & Security: validation evidence

**Status: VALIDATED** · one agent can no longer read, publish or enumerate
another's working state; retention is the caller's choice and refuses three
states outright. **No new permission, no new principal class, no second
authorization architecture. No migration.**

## Environment

| | |
| --- | --- |
| Tree | `7899ef7` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | real `McpServer` and `Client` per principal |
| Database | PostgreSQL 17 + pgvector, per-file database |
| Date | 2026-09-06 |

## What changed, and how little

| | |
| --- | --- |
| Ownership on session reads | `src/mcp/session-tools.ts` — one predicate, `ownedBy` |
| Non-disclosing refusal | same — `notYours`, stated once |
| `ferret_session_list` actor field | **removed** |
| Retention target | `src/storage/retention.ts` — `RetentionTarget.CONTEXT` |

No new permission. No new principal class. No policy engine. The access control
is the `Permission` vocabulary EPIC-068 closed and EPIC-117 amended once, and
the check is a comparison against the principal the guard already enforces
permissions for.

## The defect this Epic inherited, closed

`ferret_session_recall` and `ferret_session_show` took an identifier and
enforced no ownership. Found while proving EPIC-132, and recorded there for this
Epic rather than folded in.

**Proven against the unfixed code.** Reverting the ownership predicate:

```
× refuses to read another agent's session
× says the same thing whether the session is absent or another's
```

Both are one agent reading the other's private note through a tool that only
ever asked for an identifier.

## `ferret_session_list` no longer takes an actor

The field is **removed**, not defaulted. A parameter that is ignored is a
parameter someone will believe, and listing another agent's sessions disclosed
how much work it had done and when — while handing over the identifiers every
other session read takes.

The local CLI operator surface is untouched: `ferret session` composes
`SessionStore` directly and never these tools, so an operator on their own
machine still sees what they always saw.

## Retention, and the three states it refuses

```
reclaims nothing without an age the caller named          ✓  note: age required
reclaims archived context and the observations behind it  ✓  1 row, evidence gone
never reclaims current, proposed, or superseded           ✓  all three survive
plans without deleting when not told to apply             ✓  0 deleted
```

The refusals are the substance:

- **`superseded`** is the record of a decision that changed. Deleting the
  replaced half destroys *"why did we change our mind"* — the same reasoning
  `LifecycleState.DELETED` gives for a tombstone.
- **`active`** is what Ferret currently holds; age is not evidence that
  something stopped being true. EPIC-057 refused a decay curve for this reason.
- **`candidate`** is unanswered, not abandoned. Reclaiming it would decide by
  timeout what nobody decided.

`archivedOlderThanDays` is required, on EPIC-088 §8.3's rule that Ferret does
not choose how long the record of its own work lasts.

## What a trust report will not say

A statement whose supporting observation carries a permission scope the caller
does not hold is **visible**, and its support counts **zero**:

```
found                                   true
supportCount                               0
preferredEvidenceId                undefined
response contains "team:restricted"     false
```

The record exists and the caller is not told what it rests on — which is
EPIC-058's rule applied to a surface EPIC-127 added.

## A producer cannot promote itself

```
method                              asserted
authority                                 20
producer                    agent.owner/1.0
```

And the recording tool's schema contains no `producer`, `method`, `authority`,
`confidence` or `permissionScope` field — asserted directly, so the absence is a
test rather than a convention.

## Deliberately not built

**Targeted deletion of a single statement.** Credentials are removed *before* a
statement acquires an identity (EPIC-126), so the case that would justify a
destructive per-record tool is already prevented. Adding one for a case that
cannot arise is surface without a reason.

**Ownership of a statement.** A durable statement is the organization's, and its
provenance already names who said it. Inventing an owner would make shared
knowledge somebody's property, which is the opposite of what this tier is for.

## Two pinned lists objected, and both were right

`RETENTION_TARGETS` is pinned in two places — `tests/unit/retention.test.ts` and
`tests/integration/storage/prune-cli.test.ts` — precisely so that adding a target
is a visible decision rather than something that happens quietly. Both failed.

The second is the one that mattered. `ferret prune` with no target reports what
could go across **all** of them, so `--context` would have appeared in an
operator's plan output **with no flag to give it an age** — permanently
reporting "an age in days is required" and unusable. A half-wired target that
the unit test alone would not have shown. `--context` and
`--archived-older-than` now exist, and the README documents both.

The unit pin also asserts `not.toContain('entities')`, and durable context *is*
an entity. That was checked rather than waved past: the target reaches exactly
one registered kind in exactly one state that an agent holding `mutate` chose,
and a tombstone is `deleted`, is not among the eligible states, and remains
unnameable. The reasoning is written into the pin rather than the array simply
being extended.

## A performance budget under contention

One full run failed `records evidence in under 250 ms at p95` at **311 ms**. It
passes in isolation, and this Epic adds no evidence write path — retention only
reads and deletes, and only when invoked.

**Cause: machine contention, not this change.** The host is running a
19-container Docker workload including a k8s cluster, and the full suite has
been taking 710–790 s against a ~520 s baseline. A p95 latency budget is the
first thing that suffers.

**The budget was not relaxed.** It is the control, it names its measurement in
the failure, and lowering it to accommodate a loaded laptop would remove the
signal for the case it exists to catch. CI is the authoritative gate and runs on
a dedicated runner.

## Suites

| Suite | Result |
| --- | --- |
| `tests/security/context-governance.test.ts` | 13 passed |
| `tests/security/*` | 166 passed |
| `tests/integration/mcp/*` | 213 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
