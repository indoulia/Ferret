# EPIC-017 — Local Repository Discovery

**Status: APPROVED | Priority: P0**

> **Specification note.** The Epic registry (v3.0) approved this capability by
> name, domain and priority. This specification elaborates it to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry, `docs/Governance/README.md` §9, §10 and §12,
> `docs/TECHNOLOGY-DECISIONS.md` §5 (Git executable via subprocess), and the
> contracts EPIC-011 and EPIC-012 publish. It introduces no capability the
> registry did not approve.

## 1. Objective

Find the Git repositories on a machine, identify each one canonically, and emit
them as canonical entities — through the provider contract, without the core
knowing Git exists.

## 2. Value

This is the first place Ferret touches the outside world, and three things
become real here that were previously only designed.

**The provider contract stops being theoretical.** EPIC-011 defined
`source.repository`; EPIC-012 built the machinery to implement one. Until a real
provider exists, "replacing a provider does not require unrelated core changes"
is a claim nobody has tested.

**Repository identity becomes a decision.** The same repository cloned twice, at
two paths, by two people, is *one* repository — and everything Ferret later
answers about "this codebase" depends on agreeing which repository a fact belongs
to. Getting it wrong here is not a bug that shows up here; it shows up in
EPIC-051 as two entities that should have been one, long after the evidence
that would explain it has scrolled past.

**Subprocess execution enters the product.** Governance §12 forbids establishing
unsafe subprocess primitives that later Epics inherit — and every Git Epic after
this one will inherit whatever this one builds. Running `git` inside a repository
Ferret did not create is a genuine remote-code-execution surface: Git consults
repository-controlled configuration for hooks, file-system monitors, pagers and
credential helpers, several of which name a program to run. A naive
`exec('git -C ' + path + ' status')` is both a shell-injection bug and an
arbitrary-execution bug, and it would be copied into the next four Epics before
anyone noticed.

## 3. Scope

- **A safe Git runner** — the single point at which Ferret executes `git`, with
  the argument vector, environment and configuration overrides that make it safe
  to run inside a repository Ferret does not trust.
- **Filesystem discovery** — walking declared roots for repositories, bounded in
  depth, breadth and time, honouring exclusions and cancellation.
- **Repository identification** — a canonical key that is stable across clones,
  paths and machines wherever the evidence supports it, and honest when it does
  not.
- **The `source.repository` capability interface** — pinned here, as EPIC-012 §8
  said the consuming Epic would.
- **Emission** — `repository` entities and observed evidence, through the SDK.
- **The Git source provider** — declaring the capability, extending
  `BaseProvider`, published as its own package subpath.

## 4. Non-scope

- Branches, worktrees and refs — EPIC-018.
- Commit history — EPIC-019, EPIC-020.
- Remote hosting providers — EPIC-021 (GitHub), EPIC-071 (Jira).
- File discovery within a repository — EPIC-022.
- Persisting what is discovered — the provider emits; EPIC-031 stores.
- Cross-source entity resolution — EPIC-051 decides *when* two identifiers denote
  the same thing; this Epic provides the identifiers.

## 5. Inputs

- EPIC-011 `Capability.SOURCE_REPOSITORY`, `CapabilityDeclaration`.
- EPIC-012 `BaseProvider`, `Emitter`, `Page`, cursors, cancellation, retry.
- EPIC-003 exclusion rules and their precedence.
- EPIC-006 `repository` entity kind and its attribute schema.
- EPIC-005/TECHNOLOGY-DECISIONS §5: the Git **executable**, via subprocess. No
  reimplementation of Git's object format, no in-process Git library.

## 6. Outputs

- `src/providers/contracts/source-repository.ts` — the capability interface.
- `src/git/` — the provider, published as `@indoulia/ferret/git`.
- `repository` canonical entities with observed evidence and provenance.

## 7. Dependencies

EPIC-001, EPIC-003, EPIC-006, EPIC-008, EPIC-011, EPIC-012. Externally: the
`git` executable. Its absence is a reportable state, not a crash — Governance §13.

## 8. Contracts

### The capability interface

```
discoverRepositories(request, context) -> Page<DiscoveredRepository>
describeRepository(root, context)      -> DiscoveredRepository
```

Both are declared operations, so a provider that can describe a repository it is
pointed at but cannot search a filesystem for one can say so (EPIC-011 AC-4).

### Repository identity

A repository's canonical key is derived, in order of preference:

1. **Its origin remote**, normalized: scheme dropped, userinfo dropped, host
   lowercased, port dropped when default, `.git` suffix and trailing slash
   removed. `git@github.com:Indoulia/Ferret.git` and
   `https://github.com/Indoulia/Ferret` are then the same repository, which is
   the whole point.
2. **The real path of its Git directory**, when it has no remote. Two remoteless
   repositories at two paths are genuinely different, and saying so is more
   honest than inventing a shared identity from a directory name.

A linked worktree resolves to its **common** Git directory, so five worktrees of
one clone are one repository with five worktrees — Governance §9's distinction
between a branch, a worktree and a repository, which EPIC-018 builds on.

### Discovery is bounded, and reports what it did not do

A walk states its depth limit, its repository limit and its exclusions, and
returns what it skipped and why. A discovery that silently stopped at a
permission error and reported success is the worst outcome available: Ferret
would confidently answer questions about a codebase it had only half seen.

## 9. Acceptance criteria

- **AC-1** Ferret discovers Git repositories under declared roots, including
  bare repositories and linked worktrees.
- **AC-2** A repository has a canonical key that is identical across two clones
  of the same remote at different paths, and different for genuinely different
  repositories.
- **AC-3** Discovery honours exclusion rules, a depth bound and a result bound,
  and reports what it skipped and why.
- **AC-4** Discovery is cancellable and resumable: it observes its signal, and
  returns a cursor a caller can resume from.
- **AC-5** Git is never executed through a shell, and never with a
  caller-controlled string as a command.
- **AC-6** Executing Git inside an untrusted repository cannot run a program that
  repository chose.
- **AC-7** A credential embedded in a remote URL is never emitted, stored or
  logged.
- **AC-8** A symbolic link cannot make discovery leave its declared root, and
  cannot make it loop.
- **AC-9** The absence of Git, an unreadable directory, or a corrupt repository
  each degrade to a reported state rather than a failure of the whole walk.
- **AC-10** Discovered repositories are emitted as canonical entities with
  observed evidence, carrying the provider's identity and version.
- **AC-11** The core cannot reach the Git provider, enforced by test.

## 10. Test requirements

- **Unit:** URL normalization across every remote form Git accepts; identity
  equality and inequality; argument construction; environment scrubbing.
- **Integration:** discovery against **real repositories created by real `git`** —
  a clone, a bare repository, a linked worktree, a submodule, a repository with
  no remote, a repository with several remotes.
- **Security:** shell metacharacters in a path; a path beginning with `-`; a
  repository whose configuration names a hook, a pager, a file-system monitor or
  a credential helper; a remote URL containing a token; a symlink pointing
  outside the root; a symlink loop; a `.git` file pointing outside the root.
- **Failure:** Git absent; a directory that cannot be read; a `.git` that is
  neither a directory nor a valid link; a Git invocation that hangs; output
  larger than the buffer.
- **Concurrency:** many discoveries in flight at once; cancellation mid-walk;
  shutdown during a walk.
- **Durability:** a deep tree, a wide tree, and a walk of a large repository
  count, without unbounded memory.
- **Performance:** discovery over a synthetic tree, held to a ceiling.
- **Architecture:** the core reaches no Git module; the provider reaches no CLI.

## 11. Security requirements

Governance §12 — repository content is data, never policy — applied to the first
Epic where Ferret runs a program near untrusted content.

| Threat | Requirement |
| --- | --- |
| Shell injection through a path | Git is invoked with an argument vector and `shell: false`. There is no string form of a command anywhere in this Epic. |
| Argument injection through a path beginning with `-` | Paths are passed after `--`, or as `-C <path>` where Git treats the next token as a value. Paths are resolved to absolute before use. |
| Arbitrary execution through repository configuration | Every invocation overrides the configuration keys that name a program: hooks path, file-system monitor, pager, credential helper, SSH command, and external protocol handlers. |
| Credential prompting turning into a hang | Terminal prompting and ask-pass helpers are disabled; a repository needing credentials fails fast rather than blocking a background index. |
| Environment-variable redirection | `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` are removed from the inherited environment, so a stray variable cannot point Ferret at a different repository than the one it resolved. |
| A token in a remote URL | Userinfo is stripped during normalization, before the URL reaches an entity, a log or an error. |
| Escaping the scan root by symlink | Symbolic links are not followed by default; when following is enabled, every candidate is resolved and rejected if it leaves the root. |
| A walk that never ends | Depth, result count, per-invocation timeout, output size and the real paths already visited are all bounded. |
| Ownership | Git's own `safe.directory` refusal is surfaced as a reported state, never bypassed. Ferret does not set `safe.directory=*`. |

## 12. Observability

- Each Git invocation is logged at `trace` with its argument vector and duration;
  never with its environment, and never with its output.
- A walk reports roots scanned, directories visited, repositories found, and
  every skip with its reason.
- A repository whose identity fell back to its path says so, so an operator can
  see why two clones were not unified.

## 13. Performance constraints

| Operation | Ceiling |
| --- | --- |
| Walking a 5,000-directory tree with no repositories | 5 s |
| Identifying 200 already-located repositories | 30 s |

Discovery is I/O-bound and runs against a filesystem Ferret does not control, so
these are regression ceilings rather than targets.

## 14. Definition of Done

- The capability interface is pinned and exported from the core.
- The Git provider implements it, extends `BaseProvider`, declares its
  capability and its limits, and is published under its own subpath.
- Every security requirement in §11 has a test that would fail without it.
- Integration tests run against repositories created by real `git`, and skip
  loudly rather than silently when Git is unavailable.
- Validation evidence records every criterion with a named artefact.

## 15. Governance alignment

- **§4 Provider-First** — the core asks for `source.repository`.
- **§5 Reuse** — Git is the Git implementation; Ferret shells out to it.
- **§6 Evidence** — every discovered fact carries how it was observed.
- **§9 Context is first-class** — a repository, a worktree and a branch are
  distinct things, and this Epic establishes the first of them.
- **§10 Idempotent ingestion** — discovering twice yields identical canonical
  ids.
- **§12 Security** — §11.
- **§13 Reliability** — a missing Git, an unreadable directory or a corrupt
  repository reduces what Ferret knows without breaking what it knows.
