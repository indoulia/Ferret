# EPIC-032 — Index Lifecycle & Tombstones

**Status: APPROVED | Priority: P0**

> **Specification note.** Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry and Governance §6, §10, §13, §18 and §20. It introduces no
> capability the registry did not approve.

## 1. Objective

Make Ferret's index reflect that things stop existing.

Everything up to EPIC-031 taught Ferret to observe and remember. Nothing taught
it to stop believing. A file deleted from a repository stays in the graph,
marked `active`, and is returned to any client that asks what the repository
contains. This Epic closes that gap, and it closes it with **evidence rather
than inference**.

## 2. Value

The gap is not theoretical. It was measured against Ferret's own index of its
own repository, through the MCP surface an AI client uses:

| Measure | Value |
| --- | --- |
| `file` entities indexed | 318 |
| Files that no longer exist in the repository | 13 |
| Of those, recorded `lifecycle: active` | 13 |
| Of those, holding an **open** `repository_contains_file` edge | 13 |
| Deletions Ferret had already observed and recorded | 13 |

Four per cent of the answer to "what files are in this repository" is wrong, and
**Ferret already holds the evidence that it is wrong**. Every one of those files
has a `commit_modifies_file` relationship whose metadata reads
`change: deleted`, attributed to the commit that removed it. The observation was
made, stored, and never acted on.

Worse than the staleness is what the temporal model asserts. The
`repository_contains_file` edge for a deleted file has `validFrom` set to the
instant of the **deleting commit**, and no `validTo`. Ferret's own answer to
"when did this repository start containing this file" is *the moment it stopped*.
A client asking what was true at a past instant gets a confidently wrong answer,
which Governance §6 treats as worse than no answer at all.

## 3. Scope

1. **Tombstoning from observed deletion.** A file whose newest observed change
   is a deletion becomes `lifecycle: deleted`, and its
   `repository_contains_file` interval is closed at the deleting commit's
   instant.
2. **Reinstatement from observed presence.** A file present in a *complete*
   listing of the indexed revision's tree is `active` with an open interval,
   whatever an older deletion said. This is what makes re-adds and branch
   switches correct.
3. **Deletion is never inferred from absence in a partial read.** Every rule
   above is gated on a complete observation. A truncated, bounded, disabled or
   aborted read tombstones nothing.
4. **Reference lifecycle.** A branch or worktree absent from a complete
   enumeration is retired. Unlike files, Git reports no deletion event for a
   ref, and a complete enumeration *is* the positive observation.
5. **Per-revision watermarks**, closing
   [issue #19](https://github.com/indoulia/Ferret/issues/19).
6. **A real `index-integrity` probe**, replacing the stub that reports "no index
   exists yet" to an operator whose database holds one.
7. **Lifecycle changes are reported** — in `IndexReport`, in `ferret index`
   output, and through the MCP surface.

## 4. Non-scope

- **Deleting rows.** A tombstone is a record, not an erasure. Governance §6
  forbids discarding source evidence, and "when did this file go" is exactly the
  question Ferret exists to answer.
- **Per-branch file membership.** One `file` entity per `(repository, path)` is
  EPIC-006's model. Lifecycle therefore reflects the last revision Ferret read,
  which is honest but not the whole truth on a repository with divergent
  branches. Recorded as a limitation; the union across branches belongs to
  EPIC-037 and EPIC-038.
- **Commit tombstones.** History is read incrementally, so Ferret never holds a
  complete observation of the commit set and can never conclude a commit is
  gone. A force-push leaves unreachable commits in the graph. Recorded, not
  guessed at.
- **Scheduled or unattended indexing.** Not this Epic and not this registry
  entry; EPIC-075/076 own synchronization.
- **Integrity repair.** `index-integrity` reports; EPIC-094 repairs.

## 5. Inputs

- The change records EPIC-019/020 already emit (`change: added | modified |
  deleted`, attributed to a commit and an instant).
- The tree listing EPIC-022 already produces, and its truncation signal.
- The branch and worktree enumerations from EPIC-018.
- The derived-artefact store from EPIC-010.

## 6. Outputs

- Entities carrying a truthful `lifecycle`.
- Relationship intervals closed at the instant the relationship stopped being
  true.
- `IndexReport.lifecycle`, counting what was retired and what was reinstated.
- An `index-integrity` health component derived from real state.

## 7. Dependencies

EPIC-006 (lifecycle states), EPIC-007 (`retire`, intervals), EPIC-010 (derived
artefacts), EPIC-019/020 (change observation), EPIC-022 (tree listing),
EPIC-031 (the indexer). All VALIDATED.

## 8. Contracts

### Deletion is observed, not inferred

The rule Ferret applies to a file is: **what is the newest thing anyone
observed about it?** A deletion at `T` is a statement that the file was gone at
`T`. A tree listing at revision `R` is a statement that the file was present
when `R` was read. The later statement wins, and both are attributable.

The rejected alternative was to diff the tree against the graph and tombstone
whatever was missing. It is cheaper and it is wrong: absence from a listing is
only evidence of deletion if the listing was complete, and Ferret cannot always
know that it was. Building the rule on positive observation means the safety
property holds by construction rather than by a flag being set correctly.

### Completeness is a value, not an assumption

`listFiles` already reports truncation by returning a cursor. The sweep consumes
that signal: a cursor means the observation was partial, and a partial
observation retires nothing. The same gate covers `--history-limit`,
`--no-files` and a cancelled run.

This is the property most worth testing, because its failure mode is silent and
catastrophic: a sweep that ran on a truncated listing would tombstone most of a
large repository, and every subsequent answer would be wrong in a way that looks
like a correct answer.

### The watermark is scoped to what was read

Issue #19: the watermark records one instant per repository, but `--revision`
lets a run read something other than the last thing read. Indexing `HEAD`, then
a feature branch, then `HEAD` again skips every `HEAD` commit older than the
feature branch's tip. Nothing fails; commits are silently missing.

The scope becomes `(repository, revision)`, derived through EPIC-009's existing
identity function so that `derived_artifact`'s unique `(kind, scope_id)` index
keeps holding. The alternative — recording the revision in metadata and forcing
a full read on mismatch — was rejected because alternating between two branches
would then re-read all of history every run, which is how a tool becomes one
people turn off.

### Retirement closes at the source instant, not at now

A file deleted in January and indexed in August has `validTo` of January. The
interval records when the fact stopped being true, not when Ferret found out —
those are different questions, and EPIC-007 already separates valid time from
index time to keep them so.

## 9. Acceptance criteria

- **AC-1** A file whose newest observed change is a deletion is `lifecycle:
  deleted` after indexing.
- **AC-2** Its `repository_contains_file` interval is closed at the deleting
  commit's instant.
- **AC-3** A file deleted and later re-added is `active`, with an open interval.
- **AC-4** A file present in a complete tree listing is `active`, even if an
  older commit deleted it.
- **AC-5** A truncated tree listing retires nothing.
- **AC-6** `--no-files`, a bounded history read, and a cancelled run retire
  nothing.
- **AC-7** A branch absent from a complete enumeration is retired; a bounded
  enumeration retires nothing.
- **AC-8** Indexing `HEAD`, then another revision, then `HEAD` reads every
  `HEAD` commit — issue #19.
- **AC-9** Indexing twice changes nothing the second time, tombstones included.
- **AC-10** `index-integrity` reports the repositories indexed, when, and by
  which producer version, and reports `degraded` when a watermark was written by
  a different build.
- **AC-11** `IndexReport` and `ferret index` report what was retired and
  reinstated.
- **AC-12** A client can see that a change was a deletion.

## 10. Test requirements

- Unit tests for the lifecycle decision, against observation sequences
  including out-of-order arrival.
- Integration tests against real PostgreSQL and real `git`, covering AC-1 to
  AC-9 with repositories built by the test fixture.
- **A completeness test that proves the gate by violating it**: a listing capped
  below the file count must leave every entity `active`.
- **Concurrency**: two indexers sweeping one repository at once must not
  interleave into a state where a file is both retired and open. Advisory
  locking already covers the edge; the test proves it covers this path.
- **Idempotence**: a third and fourth run after a deletion write nothing.
- A dogfooding run against Ferret's own repository must reduce the 13 phantom
  files to zero, verified through the MCP surface rather than through SQL.

## 11. Security requirements

- Path values reaching a tombstone query are bind parameters, never
  interpolated.
- A repository cannot cause Ferret to retire another repository's entities: the
  sweep is scoped by the repository entity id, and that scoping is tested.
- A hostile repository cannot force mass tombstoning by making a read look
  complete when it was not — completeness comes from Ferret's own reader, never
  from repository content.

## 12. Observability

`index.lifecycle` log events carry the repository, the counts retired and
reinstated, and the reason a sweep was skipped when it was. A skipped sweep is
logged at `info`, not silence: an operator wondering why deleted files persist
deserves to find the answer in the log.

## 13. Performance constraints

The sweep adds one indexed query per repository per run plus one write per
changed entity. A run over an unchanged repository performs no lifecycle writes,
which is the case that must stay cheap because it is the common one.

## 14. Definition of Done

All acceptance criteria pass against real infrastructure; `npm run verify` is
green; the dogfooding run reports zero phantom files through MCP; issue #19 is
closed with evidence; limitations are recorded in the validation document.

## 15. Governance alignment

§6 (evidence, never manufactured certainty — the whole shape of this Epic),
§10 (idempotent ingestion), §13 (reliability: partial reads never destroy),
§18 (provenance: retirement is attributed to the commit that caused it),
§20 (observability), §21 (producer versioning).
