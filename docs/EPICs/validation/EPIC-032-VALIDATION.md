# EPIC-032 — Index Lifecycle & Tombstones: validation evidence

**Status: VALIDATED**

Every result below was produced against a real PostgreSQL 17 with pgvector and a
real `git` executable. No lifecycle behaviour is asserted against a fake.

## 1. What was wrong, measured

Found by asking Ferret about Ferret through the MCP surface an AI client uses,
then checking its answers against `git`:

| Measure | Before | After |
| --- | --- | --- |
| `file` entities indexed | 318 | 321 |
| Files reported `active` that no longer exist | **13** | **0** |
| Of those, holding an open `repository_contains_file` edge | 13 | 0 |
| Deletions Ferret had already observed and recorded | 13 | 13 |
| Files tracked by `git ls-files` and absent from the index | 0 | 0 |

The thirteen were not a gap in observation. Every one already carried a
`commit_modifies_file` relationship whose metadata read `change: deleted`,
attributed to the commit that removed it. **The evidence was recorded and never
acted on.**

A second, larger error surfaced while fixing the first. `git log` returns
newest-first, so the first assertion of a containment edge won and every earlier
one was absorbed as "already open". Ferret claimed to have begun containing
`README.md` at `14:28` — the instant of its most recent edit — when the file had
been present since `09:33`. Asking what a repository held at a past instant
therefore returned nothing that had been modified since, which is the one
question the temporal model exists to answer. Fixed at the source
(`src/git/provider.ts`), and in `RelationshipStore.assert`, which now extends an
open interval backwards when it learns the fact began earlier.

## 2. Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 file with a newest deletion is `deleted` | PASS | `is tombstoned, and its containment closed at the deleting commit` |
| AC-2 containment closed at the deleting commit's instant | PASS | same test, compared against `git log -1 --format=%cI` |
| AC-3 re-added file is active again | PASS | `comes back when it is added again` |
| AC-4 presence in a complete tree keeps a file active | PASS | `comes back when the delete and the re-add share an instant` — see §2.1 |
| AC-5 a truncated tree listing retires nothing | PASS | `does nothing when the file tree came back truncated` |
| AC-6 `--no-files` and a missing store retire nothing | PASS | two tests in `a partial observation retires nothing` |
| AC-7 reference lifecycle | **NOT APPLICABLE** | see §5 |
| AC-8 issue #19 — no commits skipped across revisions | PASS | `does not skip commits when revisions are indexed in turn` |
| AC-9 idempotent | PASS | `changes nothing on the runs after the first`; runs 2 and 3 write nothing |
| AC-10 `index-integrity` reports real state | PASS | §4 |
| AC-11 report states what changed | PASS | `lifecycle  13 deleted, 0 restored` in `ferret index` |
| AC-12 a client can see a change was a deletion | PASS | `surfaces the change a commit made to a file` |

### 2.1 AC-4 passed for the wrong reason first

Worth recording, because it is the failure mode this project keeps guarding
against and it still happened.

`comes back when it is added again` passed on Windows and **failed on Linux CI**.
Git commit timestamps have one-second resolution, so on a fast enough machine a
delete and a re-add land in the same second. No ordering of history can separate
them, and the winner was whichever row PostgreSQL happened to return first.

The failure exposed something larger: **the tree-listing override AC-4 specifies
had never been implemented.** The Windows run passed on the luck of two commits
falling in different seconds, and the acceptance criterion would have been marked
PASS on that evidence had CI not run on a second platform.

Both halves are fixed. The tie is now broken deterministically *toward deletion*
— the direction that can be corrected — and the file tree at the indexed
revision reinstates anything it can actually see. Breaking the tie toward
presence instead would require absence from the tree to condemn a file, and
inferring deletion from absence is the one thing this design refuses to do.

The regression test pins the commit instant rather than relying on the clock, so
the case is reproduced on every machine instead of on whichever one is quick.

## 3. Safety: a partial observation retires nothing

The property whose failure is silent and total. A sweep run against a truncated
listing would tombstone most of a large repository and look exactly like a
successful run.

It is proved **by violating the gate**, not by asserting a flag: the provider is
wrapped so its listing reports a cursor, the deletion is real, and the file stays
`active` with the reason recorded in the report and the log.

Deletion itself is never inferred from absence. The rule is "what is the newest
thing anyone observed about this file", which is why the reconciliation reads the
graph rather than the current run's changes — an incremental run reads no commit
that mentions a file deleted years ago, so a delta-only sweep would have left all
thirteen wrong for ever.

## 4. Health

`index-integrity` was a hard-coded component reporting *"No index exists yet, so
its integrity cannot be assessed"* — to every operator, including one whose
database held 318 indexed files, and with a remediation naming EPIC-031 two Epics
after EPIC-031 shipped. A health check that reports a constant is worse than no
health check, because it is believed.

It now derives from `derived_artifact`:

```
+ index-integrity   ok   1 indexed scope(s), all built by this version; last indexed 2026-08-31T01:52:25.702Z
```

`degraded` when a watermark was written by a different build, `unknown` when
there is no database to ask.

## 5. Limitations, recorded rather than resolved

- **Per-branch file membership.** One `file` entity per `(repository, path)` is
  EPIC-006's model, so lifecycle reflects the last revision Ferret read. A file
  deleted on one branch and alive on another is reported by whichever was
  indexed most recently. Owned by EPIC-037 and EPIC-038.
- **AC-7, reference lifecycle — NOT APPLICABLE.** A branch or worktree absent
  from a complete enumeration would be retired by inference from absence, which
  is the one thing this Epic's design refuses to do for files. Applying a weaker
  standard to refs than to files would be inconsistent, and Git offers no
  deletion event for a ref. Deferred with the reasoning recorded rather than
  implemented to a lower bar. **Not converted to PASS.**
- **Commit tombstones.** History is read incrementally, so Ferret never holds a
  complete observation of the commit set and cannot conclude a commit is gone. A
  force-push leaves unreachable commits in the graph.
- **Existing indexes built before this change** carry containment intervals that
  open too late. `ferret index --full` repairs them, because the relationship
  store now extends an open interval backwards. Verified on Ferret's own index.

## 6. Defects fixed, all found by dogfooding

Seven, none of which any test had caught:

1. Deleted files reported `active` with open containment edges — this Epic.
2. Containment intervals opening at a file's last edit rather than its first
   appearance.
3. `ferret_find` silently discarded unknown arguments; a misspelled filter
   returned an unfiltered list indistinguishable from an exact answer. All five
   tools now use `z.strictObject`.
4. `ferret_find` accepted `limit` up to 500 and silently returned 50, and never
   said an answer was partial. It now honours the limit it advertises and
   reports truncation.
5. `ferret_neighbours` dropped relationship metadata, so `change: deleted` was
   held and unreachable. It also had no way to ask for ended relationships,
   making "when did this file go" unanswerable.
6. `index-integrity` reported a constant.
7. A commit could not be found by its abbreviated object id — full-text search
   matches whole lexemes, so `b9559ab` never matched `b9559ab55755eee…`. The
   commit was indexed, findable by its full forty characters, and unreachable by
   the seven anyone actually has.

## 7. Dogfooding is now a command

`npm run dogfood` indexes this repository with the built CLI, connects to it over
MCP as a real client, and checks every answer against `git`. It is an **oracle**,
not a demo: a disagreement is a defect rather than a matter of opinion.

```
  ok    content notice
  ok    repository indexed  (Ferret)
  ok    no phantom files  (308 active)
  ok    no missing files  (308 tracked)
  ok    commits carry content  (EPIC-102/103/104: Distribution, Global CLI and A)
  ok    exact lookup filters
  ok    change kind is visible
  ok    health reflects the index

Ferret agrees with the repository on every question asked.
```

Findings 1, 4 and 7 were each caught by a check in this script failing.

## 8. Suite

```
Test Files  51 passed (51)
     Tests  1264 passed | 3 skipped (1267)
```

`npm audit`: 0 vulnerabilities.

One pre-existing flake was fixed while here: `identifies repositories at a
bounded cost per repository` asserts a 60-second ceiling under Vitest's default
30-second timeout, so it could never reach its own budget — it died of the
timeout intermittently and read as a failure of what it measures.
