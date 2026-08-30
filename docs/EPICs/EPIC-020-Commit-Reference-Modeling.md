# EPIC-020 — Commit & Reference Modeling

**Status: APPROVED | Priority: P0**

> **Specification note.** Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry and Governance §6, §9 and §10. It introduces no capability the
> registry did not approve.

## 1. Objective

Give commits, their authors and the files they touched canonical identity, and
connect them into the graph the history implies.

## 2. Value

EPIC-019 reads history. This Epic decides **what a commit *is*** — and that
decision propagates into every question Ferret will later answer.

Get it wrong and nothing fails immediately. It fails months later, as two
entities that should have been one, in a query nobody can explain.

## 3. Scope

- Commit, developer and file identity.
- Emission of commits, parents, authors and changed files as canonical entities
  and relationships.
- The valid time of a commit relationship, which unlike a branch's containment is
  something Git actually knows.

## 4. Non-scope

- File *content* and versions — EPIC-022, EPIC-023.
- Resolving one person's several addresses — EPIC-036.
- Tags and remote-tracking refs.
- Issue references in commit messages — EPIC-073.
- Storing what is emitted — EPIC-031.

## 5. Inputs

EPIC-019's `CommitRecord`, EPIC-006's `commit`, `developer` and `file` kinds,
EPIC-007's relationship types, EPIC-012's `Emitter`.

## 6. Outputs

`emitHistory`, producing entities, relationships and evidence together.

## 7. Dependencies

EPIC-006, EPIC-007, EPIC-012, EPIC-019.

## 8. Contracts — the three identity decisions

### A commit is its object id, unscoped

A Git commit hash is a content hash of the commit object. **The same commit in a
fork and in its upstream is the same commit, byte for byte.** Scoping it to a
repository would create two entities for one object and make *"which release
contains the fix for FER-12"* unanswerable across a fork — one of the questions
Ferret exists to answer.

Which repositories *hold* a commit is `repository_contains_commit`, which is
exactly what that relationship type is for.

The risk this accepts is a hash collision. Git's own SHA-1 implementation carries
collision detection and rejects known-colliding inputs, and repositories are
migrating to SHA-256, but a deliberate collision would merge two commits. That is
recorded rather than dismissed, and owned by **EPIC-082**.

### A developer is an email address, lowercased — for now

One person commits as several addresses. EPIC-006 models `emails` as a **list**
precisely so that EPIC-036 has somewhere to put a resolution; collapsing to one
address here would destroy the evidence that resolution depends on, and merging
two addresses here would make EPIC-036's decision by accident.

A commit with **no** author address produces no developer. Inventing an identity
from a display name would merge every anonymous author in the repository into one
person.

### A file is its repository and its path

Which means a rename produces a *different* file entity, and the continuity
between the two is the rename relationship rather than a shared id. That matches
what Git actually recorded: a similarity score, not an identity claim. Both paths
are emitted, because the old one may be a file Ferret never otherwise hears about
— deleted in the same commit that created its successor.

This identity scheme is inherited by **EPIC-023**, which formalises file identity
for files discovered in a worktree; the two must agree, or a file found by
walking and the same file found in history would be two entities.

### Valid time

A commit's relationships take the **commit time** as their valid-from, because
Git knows it. This is the difference from EPIC-018, where a branch's containment
has no knowable start and Ferret records its own observation time instead. Where
the source knows, use what the source knows.

## 9. Acceptance criteria

- **AC-1** Commits, developers and files are emitted as canonical entities.
- **AC-2** A commit has the same identity in every repository that holds it.
- **AC-3** Two repositories' files at the same path are two entities.
- **AC-4** Many commits by one address collapse to one developer; two addresses
  do not collapse.
- **AC-5** A commit with no author address produces no developer and no
  authorship edge.
- **AC-6** Both paths of a rename are reachable.
- **AC-7** Parentage, authorship and file modification are emitted as
  relationships with the declared types.
- **AC-8** Re-emitting the same history produces identical entity ids and
  identical commit-derived relationship ids.

## 10. Test requirements

- **Integration:** a real clone of a real repository, to prove a commit's
  identity survives the fork boundary; two repositories to prove files do not
  collapse; a rename; an anonymous author; many commits by one author.
- **Idempotence:** the same history emitted twice.
- **Performance:** a bulk history emitted within budget.

## 11. Security requirements

Everything emitted has already been bounded and stripped by EPIC-019. Emission
adds EPIC-008's redaction, so a credential pasted into a commit message is masked
before it becomes evidence — which is not hypothetical, since committed secrets
are among the most common things a repository contains.

## 12. Observability

The graph reports what it emitted. A commit whose author had no address is
visible as a commit with no authorship edge, rather than as an edge to a
fabricated person.

## 13. Performance constraints

Emission is in-memory and deduplicating; the cost is dominated by entity
validation and hashing, which EPIC-012's emission budget already covers.

## 14. Definition of Done

The three identity decisions implemented, tested and documented; criteria
evidenced.

## 15. Governance alignment

- **§6 Evidence** — no developer without an address; no merge changes.
- **§9 Context** — a commit is not a repository, and a file is not a path.
- **§10 Idempotent ingestion** — content-derived identity throughout.
- **§18 Provenance** — every record carries producer and version.
