# EPIC-022 — File Discovery · EPIC-023 — File Identity & Content Hashing

**Status: APPROVED | Priority: P0 (both)**

> **Specification note.** Two registry entries, one document, because the second
> is the first one's identity decision and neither is coherent alone. Elaborated
> to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the
> approved registry entries and Governance §6, §9, §10 and §12. Neither
> introduces a capability the registry did not approve.

## 1. Objective

**EPIC-022:** list the files a repository holds at a revision, bounded and paged.
**EPIC-023:** give those files and their contents canonical identity.

## 2. Value

Files are what most questions are actually *about*. Every retrieval, every
context pack, every "who last touched this" resolves to a file in the end.

Two decisions carry the weight.

**How Ferret finds files.** A filesystem walk answers "what is on disk in this
checkout right now" — a question that has no answer for a bare repository, for a
commit nobody checked out, or for the ninety-nine per cent of history that is not
the working tree. Reading a **tree at a revision** answers all of them, and gives
Ferret the content hash and the size without opening a single file.

**What makes two files the same file.** This must match EPIC-020's answer, which
already chose repository + path for files seen in commit history. If the two
schemes disagreed, a file found by listing and the same file found in a commit
would be two entities, and *every file in Ferret would exist twice.* That is the
kind of mistake that is cheap now and unrecoverable in six months.

## 3. Scope

- Listing tree entries at a revision: path, mode, object id, size.
- Distinguishing a file, an executable, a symbolic link and a submodule.
- Paging and bounding.
- File identity, file-version identity, and content hashes that name their
  algorithm.
- Emission of `file` and `file_version` entities with
  `repository_contains_file` and `file_has_version`.

## 4. Non-scope

- Reading file **content** — EPIC-024 onward. Nothing here opens a file.
- Untracked and ignored files on disk.
- Language, media type and binary detection, which need content.
- Following a file across renames — the graph answers that (EPIC-049).
- Storing any of it — EPIC-031.

## 5. Inputs

EPIC-017's `DiscoveredRepository` and Git runner; EPIC-019's revision validation;
EPIC-020's file identity decision; EPIC-006's `file` and `file_version` kinds.

## 6. Outputs

`listFiles` on the capability, an exported `parseTree`, and `emitFiles`.

## 7. Dependencies

EPIC-006, EPIC-007, EPIC-012, EPIC-017, EPIC-019, EPIC-020.

## 8. Contracts — the decisions

### Read a tree, not a directory

`git ls-tree -r -z --long <revision>`. One invocation gives mode, object id, size
and path for every file, works on a bare repository, and opens nothing.

### A content hash is Git's object id, and it says so

A Git object id is `sha1("blob <length>" + NUL + bytes)` — **not** the SHA-1 of
the bytes, and not comparable with anything else called a hash. Ferret therefore
stores it as `git-blob:<oid>`, prefixed with its algorithm. Two values that mean
different things must not share a column without saying which they are, or a
later Epic compares them and finds them different for the wrong reason.

Ferret does not recompute the hash from the working copy. It would produce a
different number for the same content on a machine with different line-ending
settings, and two developers' identical files would look like two versions.

### File identity is repository + path; version identity is content, scoped to the file

The first matches EPIC-020, deliberately and testably.

The second is scoped to the **file**, not the repository: the same bytes at two
paths are two versions of two files, because a version is a version *of
something*. The content hash stays equal, which is what makes duplication
detectable at all.

### A symlink is not a file, and a submodule is not a file

The `type` column says `blob` for a regular file, an executable **and** a
symbolic link. Only the **mode** distinguishes them, and a symlink's blob holds a
target path rather than content — indexing it as source would record
`../../etc/passwd` as though someone had written it. A submodule's "object id" is
a commit id in a repository Ferret may not even have.

Both are listed, neither becomes a `file`, and the emitter reports why.

## 9. Acceptance criteria

- **AC-1** Files at a revision are listed with path, mode, object id and size.
- **AC-2** A historical revision can be listed, not only the current one.
- **AC-3** File, executable, symlink and submodule are distinguished by mode.
- **AC-4** Listing is paged and bounded.
- **AC-5** A revision that does not exist answers with nothing.
- **AC-6** Identical bytes in two repositories share a content hash.
- **AC-7** Content hashes name their algorithm.
- **AC-8** A file listed and the same file seen in a commit are **one entity**.
- **AC-9** The same bytes at two paths are two versions of two files, sharing a
  content hash.
- **AC-10** A symlink and a submodule are not emitted as files, and the reason is
  reported.
- **AC-11** Re-emitting an unchanged revision produces identical ids.
- **AC-12** Paths are bounded, control-stripped and separator-normalised.

## 10. Test requirements

- **Unit:** the tree parser — every mode, a path containing spaces, an absent
  size, a malformed entry, the path bounds. Extensions, including the dotfile
  case.
- **Integration:** all of it against real repositories, plus the identity
  agreement between listing and history, which is the criterion that cannot be
  checked any other way.
- **Performance:** a four-hundred-file tree listed and emitted within budget.

## 11. Security requirements

Paths are repository-controlled: bounded at 4 KiB, stripped of control
characters, and normalised to forward slashes. Nothing opens a file, so a
hostile file's *content* cannot reach Ferret through this Epic at all — which is
worth stating, because it will stop being true at EPIC-024 and that is where the
content-safety work belongs.

Subprocess safety is inherited from EPIC-017's runner.

## 12. Observability

`emitFiles` reports every entry it declined and why, so a repository whose files
are mostly symlinks is visible as such rather than as a repository with no files.

## 13. Performance constraints

One Git invocation per page, no file opened. A four-hundred-file tree listed and
emitted in under 20 s, which a per-file implementation could not achieve.

## 14. Definition of Done

Listing and emission implemented, the identity agreement with EPIC-020 asserted
by test, criteria evidenced.

## 15. Governance alignment

- **§6 Evidence** — a declined entry is reported, not dropped.
- **§9 Context** — a file version is not a file, and a symlink is neither.
- **§10 Idempotent ingestion** — content-derived identity throughout.
- **§12 Security** — §11.
- **§21 Versioning** — a hash that names its algorithm is a hash that can be
  migrated.
