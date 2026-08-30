# EPIC-019 — Git History Ingestion

**Status: APPROVED | Priority: P0**

> **Specification note.** Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry, Governance §6, §12 and §13, and the contracts EPIC-011,
> EPIC-012 and EPIC-017 publish. It introduces no capability the registry did not
> approve.

## 1. Objective

Read commit history — metadata, parentage and the files each commit changed —
bounded, paged, cancellable, and safe against a repository Ferret did not write.

## 2. Value

History is where most of Ferret's answers come from. *"Who last touched this"*,
*"what changed when this broke"*, *"which commits mention FER-12"* are all
history questions, and every later Epic that ranks, summarises or explains
depends on this one having read the log correctly.

Two properties dominate, and both are about failure rather than function.

**The output is unbounded.** A repository with a million commits produces
hundreds of megabytes from a single `git log`. EPIC-017's runner caps output at
16 MiB precisely so a naive read fails loudly instead of exhausting memory. That
cap is a feature; the correct response to hitting it is to page, never to raise
it.

**Every field is untrusted.** A commit message, an author name and a file path
are all written by whoever wrote the commit. They reach a terminal and an AI
client, and an escape sequence in a commit subject can rewrite what an operator
believes they are reading.

## 3. Scope

- Reading commits with metadata, parentage, and optionally the files they
  changed.
- Paging, and an incremental read bounded by an instant.
- Parsing `git log -z`, including the rename entry that is three tokens where
  everything else is two.
- Bounding and cleaning everything taken from a repository.
- Refusing a revision that Git would read as an option.

## 4. Non-scope

- Canonical identity and emission — EPIC-020.
- File content and versions — EPIC-022, EPIC-023.
- Reflog, tags and remote refs — EPIC-020.
- Storing what is read — EPIC-031.
- Submodules and `.gitmodules`.

## 5. Inputs

EPIC-017's `DiscoveredRepository` and Git runner; EPIC-012's cursors and
cancellation.

## 6. Outputs

`readHistory` on the `source.repository` capability, and an exported `parseLog`
that can be tested without a repository.

## 7. Dependencies

EPIC-011, EPIC-012, EPIC-017. Externally: the `git` executable.

## 8. Contracts

`git log -z` with a NUL-separated format. Not for elegance: a commit message
contains newlines and a file path may contain almost any byte, so any format
delimited by something a human would type is a parser waiting to be wrong.

Eleven fields per commit — object id, tree, parents, author name, address and
date, committer name, address and date, subject, body — followed, when changes
were requested, by NUL-separated status/path entries until the next commit
begins.

A commit boundary is recognised by an object id **and** the shape of the ten
fields after it. Checking the id alone would misread a file legitimately named
with forty hex characters, ending the commit there and attributing everything
after it to nothing.

A merge commit has **no** changes. `git log` prints none, because *"what did this
merge change"* has no single answer — it depends which parent you compare
against — and inventing one would be manufacturing certainty.

## 9. Acceptance criteria

- **AC-1** Commits are read newest first with their metadata and parentage.
- **AC-2** A multi-line commit message survives intact.
- **AC-3** The files a commit changed are read, with add, modify, delete, rename
  and copy distinguished, and a rename carries both paths.
- **AC-4** A merge commit reports two parents and no changes.
- **AC-5** History is paged, and an incremental read bounded by an instant reads
  only what is newer.
- **AC-6** A revision that Git would read as an option is refused.
- **AC-7** A ref that does not exist answers with nothing rather than failing.
- **AC-8** Control characters are stripped from every field, and every field and
  path is length-bounded.
- **AC-9** A malformed region costs the commits it touches, not the rest of the
  page.
- **AC-10** Reading history cannot make a repository's configuration execute a
  program.

## 10. Test requirements

- **Unit:** the parser against the exact output shape, including a rename among
  other entries, a merge, a root commit, a hash-shaped path, a malformed region,
  and every bound.
- **Integration:** all of it again against repositories built by real `git`,
  because the parser's assumptions about the format are exactly what a unit test
  cannot check.
- **Security:** control characters and length bounds; option-shaped revisions;
  a hostile repository configuration exercised through `git log`.

## 11. Security requirements

Commit fields are stripped of control characters — except the newlines and tabs
a commit body legitimately contains — and bounded at 8 KiB per field, 64 KiB per
body and 4 KiB per path. A revision reaches Git's argument vector, so it is
refused if it begins with `-`, is empty, exceeds 512 characters, or contains a
control character; a NUL in particular truncates an argument at the OS boundary,
so what Git receives would not be what was inspected.

Subprocess safety is inherited from EPIC-017's runner, which is still the only
module that executes Git — and `git log` consults the same repository-controlled
configuration, so the same overrides apply and are tested through this path too.

## 12. Observability

Every invocation is logged by the runner. An unreadable ref returns an empty page
rather than an exception, so a caller sees a repository with no history rather
than a failed index.

## 13. Performance constraints

One Git invocation per **page**, not per commit. At roughly 450 ms per process on
Windows, per-commit reading would be two orders of magnitude slower, and the
integration test's budget is set so that a regression to per-commit reading
cannot pass.

## 14. Definition of Done

Parser and reader implemented, both tested, criteria evidenced.

## 15. Governance alignment

- **§6 Evidence** — a merge's changes are absent because Git reports none.
- **§12 Security** — §11.
- **§13 Reliability** — a missing ref, an empty repository and a malformed
  region each reduce what Ferret knows without breaking what it knows.
- **§17 Performance** — §13.
