# EPIC-022 & EPIC-023 — Validation Evidence

**Epics:** EPIC-022 — File Discovery; EPIC-023 — File Identity & Content Hashing
**Branch:** `feat/epic-022-023-file-discovery`
**Recorded:** 2026-08-30

> **Specification note.** Neither Epic had a specification file. Both were
> written first, to the approved standard, as one document because the second is
> the first's identity decision. **The acceptance criteria below are ones this
> work authored.**

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Files listed with path, mode, object id and size | **PASS** | `files.test.ts` → "lists the files a revision holds, with size and object id" — exact size and a real object id. |
| AC-2 | A historical revision can be listed | **PASS** | "lists a historical revision, not just the current one" — a file added later is absent from the earlier tree. This is why the Epic reads a tree rather than walking a directory. |
| AC-3 | File, executable, symlink and submodule distinguished by mode | **PASS** | 5 parser cases covering every mode; "distinguishes an executable, a symlink and a regular file" against real Git. |
| AC-4 | Listing is paged and bounded | **PASS** | "pages through a listing" — 8 entries in pages of 3; `MAX_FILES_PER_READ` caps a single read. |
| AC-5 | A revision that does not exist answers with nothing | **PASS** | "answers with nothing for a revision that does not exist". |
| AC-6 | Identical bytes in two repositories share a content hash | **PASS** | "gives identical content identity to identical bytes in two repositories". |
| AC-7 | Content hashes name their algorithm | **PASS** | "prefixes a Git object id" — `git-blob:<oid>`. |
| AC-8 | A file listed and the same file in a commit are **one entity** | **PASS** | "gives a file the same identity whether it was listed or seen in a commit". **This is the criterion the pairing exists for**; see §3. |
| AC-9 | The same bytes at two paths are two versions of two files, sharing a hash | **PASS** | "gives the same bytes at two paths two versions of two files". |
| AC-10 | A symlink and a submodule are not emitted as files, with a reason | **PASS** | "does not emit a symlink or a submodule as a file, and says why". |
| AC-11 | Re-emitting an unchanged revision produces identical ids | **PASS** | "emits identical ids for an unchanged revision read twice". |
| AC-12 | Paths bounded, control-stripped, separator-normalised | **PASS** | "bounds and normalizes a path". |

**12 / 12 PASS.** (AC-1 to AC-5 are EPIC-022; AC-6 to AC-12 are EPIC-023.)

---

## 2. Tests

`npm run verify` — **1,138 passed, 3 skipped** across 45 files against live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**. 30 new cases: 14 parser and helper, 16 integration.

---

## 3. The criterion that justifies pairing the Epics

EPIC-020 chose **repository + path** as file identity, for files seen in commit
history. EPIC-023 had to choose file identity for files seen in a tree listing.
Had it chosen anything else — the object id, the path alone, a worktree-relative
path — a file found by listing and the same file found in a commit would be two
entities, and **every file in Ferret would exist twice**.

Nothing would have failed. There would simply have been twice as many files,
half of them never connected to any commit, and the discrepancy would surface in
EPIC-052 as retrieval returning duplicates nobody could explain.

"gives a file the same identity whether it was listed or seen in a commit" builds
one repository, emits its files both ways, and asserts the ids are equal. It is
the only test in this Epic that could not be written without the previous one,
and it is the reason the two were built together.

---

## 4. Design notes worth keeping

**Nothing here opens a file.** `git ls-tree --long` supplies the object id and
the size, so a four-hundred-file tree costs one process and zero file handles.
That is also why this Epic has no content-safety surface: a hostile file's bytes
cannot reach Ferret through it. That stops being true at EPIC-024, which is where
content safety belongs.

**Ferret does not compute the content hash.** A Git object id is
`sha1("blob <length>" + NUL + bytes)` over exactly the bytes Git stored. Hashing
the working copy instead would give a different number for the same content on a
machine with different line-ending settings, and two developers' identical files
would look like two versions.

**The `type` column is not enough.** It says `blob` for a regular file, an
executable *and* a symbolic link. Only the mode separates them — and a symlink's
blob holds a target path, so indexing it as source would record
`../../etc/passwd` as though someone had written it.

---

## 5. Security

| Concern | Handling | Test |
| --- | --- | --- |
| Repository-controlled paths | 4 KiB bound, control characters stripped, separators normalised. | "bounds and normalizes a path" |
| A symlink indexed as source | Not emitted as a file; the target path never becomes content. | "does not emit a symlink or a submodule as a file" |
| A submodule's object id treated as a blob | Not emitted; its id is a commit in a repository Ferret may not have. | Same test |
| An option-shaped revision | `assertSafeRevision`, shared with EPIC-019. | EPIC-019's suite |
| Unbounded listing | 50,000-entry read cap plus the runner's 16 MiB output cap. | Bound enforced in `listFiles` |
| File content | **Not reachable.** Nothing here opens a file. | By construction |

---

## 6. Performance

| Measurement | Observed | Budget |
| --- | --- | --- |
| Listing and emitting a 401-file tree | ~1.4 s | 20 s |

One Git invocation and no file handles. A per-file implementation could not fit
in this budget, which is how it was chosen.

---

## 7. Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Untracked and ignored files are invisible.** This reads a tree, not a directory. | Correct for indexing committed knowledge, and wrong for "what am I working on right now". A working-directory read is a different question with a different answer. | **EPIC-031** |
| No language, media type or binary detection. | All three need content, and nothing here opens a file — deliberately. | **EPIC-024** |
| A file version records no `commit`, although `fileVersionAttributes` has the field. | The listing knows the revision it was asked for, not which commit introduced *that blob*, which is a different and more expensive question. | **EPIC-031** |
| `commit_produces_file_version` is not emitted. | It needs both a commit and a version in one pass; EPIC-020 emits commits and this emits versions, and joining them is the indexing pipeline's job. | **EPIC-031** |
| Executable mode is not represented in the canonical model. | `fileAttributes` has no field for it. Carried on the `TreeEntry` and dropped at emission rather than smuggled into an unrelated field. | **EPIC-024** if it matters |
| Windows does not record the executable bit, so mode assertions are platform-guarded. | The test says so rather than passing quietly. | — |
| A SHA-1 object id inherits EPIC-020's collision limitation. | Same threat model, same owner. | **EPIC-082** |
