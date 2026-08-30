# EPIC-017 — Architecture Decisions

Decisions taken while building local repository discovery, with the reasoning
that produced them. Recorded per Governance §22 so a later reader can tell a
considered choice from an accident.

---

## D1 — One module executes Git, and it overrides configuration on every call

**Context.** Governance §12 forbids establishing unsafe subprocess primitives
that later Epics inherit. Four Git Epics follow this one.

**Decision.** All Git execution goes through `src/git/runner.ts`, which prepends
`-c key=value` overrides for every configuration key whose value names a program,
scrubs twenty environment variables, and uses `execFile` with `shell: false`.

**Why.** Running `git` inside a repository consults that repository's own
`.git/config`, and `core.hooksPath`, `core.fsmonitor`, `core.pager`,
`credential.helper` and `core.sshCommand` each name something to execute. A
repository Ferret clones for indexing can therefore run code **by being looked
at**. That is not a theoretical concern for a product whose purpose is to index
repositories it did not write.

Keeping execution in one place is what makes the overrides unavoidable rather
than conventional: the next Git Epic reaches for `runGit` and gets them, and an
architecture test asserts that `node:child_process` is imported from exactly two
named modules in the whole reachable tree.

**Explicitly not done.** `safe.directory=*` is *not* set. Git's ownership check
exists to protect against precisely this class of attack, and disabling it to
make an inconvenient error go away is the wrong trade every time. Its refusal is
surfaced as a reported skip.

---

## D2 — Repository identity is the normalized remote, falling back to the path

**Context.** The same repository appears cloned over SSH on one machine and
HTTPS on another, at different paths, with and without `.git`, in five worktrees.

**Decision.** Identity is `host/path` from the origin remote — scheme, userinfo,
default port and `.git` suffix removed, host lowercased, **path case preserved**.
Without a remote, identity is the real path of the common Git directory, and the
result records *which* of the two it used.

**Why case is preserved.** GitHub treats `Team/Repo` and `team/repo` as one
repository; a self-hosted server on a case-sensitive filesystem does not.
Lowercasing would silently merge two distinct repositories, and nothing
downstream could detect that it had happened. Preserving case can only ever fail
to merge — a mistake EPIC-051 can correct with evidence. Merging wrongly cannot
be corrected by anything.

**Why the fallback is reported.** A repository identified by path cannot be
unified with the same repository on another machine. An operator wondering why
two clones did not merge should be able to *see* the reason rather than deduce
it.

---

## D3 — Credentials are stripped during normalization, not at the point of display

**Context.** `git clone https://user:TOKEN@host/repo` writes the token into
`.git/config`, where it stays. Ferret reads that config.

**Decision.** `normalizeRemote` returns both a canonical identity with no
userinfo and a `display` form with userinfo masked. Nothing downstream ever sees
the raw URL.

**Why.** Masking at the point of display means every future call site is one
forgotten call away from writing a token into the database. Masking at parse time
means the raw value does not survive the boundary at all. The identity is
unaffected — a token is not part of what a repository *is* — so a credentialled
and a clean clone still unify, which is also the correct answer.

`git@host:path` is treated as conventional rather than as a credential: it is
overwhelmingly the common SSH form, and masking it would destroy information for
no benefit. Any *other* SSH username is masked.

---

## D4 — Symbolic links are not followed by default

**Context.** A developer's home directory is full of links, and one of them
points at `/`.

**Decision.** Off by default. When enabled, every candidate is resolved with
`realpath` and refused if it leaves the declared root; every visited real path is
remembered so a link back up the tree terminates.

**Why.** Following links turns "index my projects" into "index this machine",
and the containment check has to be path arithmetic rather than string prefix —
`/home/user2` starts with `/home/user` as a string and is not inside it. That
trap is unit-tested directly, because it is the version that looks correct.

---

## D5 — A page is not a snapshot

**Context.** Discovery pages, and the cursor has to encode a position.

**Decision.** The cursor holds the last repository returned, and resuming
re-walks the tree to that position. The walk is deterministic — directory entries
are sorted — so the sequence is reproducible.

**Why not carry the frontier.** A breadth-first frontier is unbounded in size,
would blow the 4 KiB cursor cap on any real tree, and is stale the moment a
directory is created. A cursor travels out to an AI client over MCP and comes
back minutes later.

**Consequence, declared rather than hidden.** A repository created between two
pages may appear; one deleted may vanish. This is stated in the provider's
`limits.notes`, where a caller reads it before deciding, rather than discovered
afterwards. A caller needing a snapshot takes one walk with no limit.

---

## D6 — Machine-local paths are not canonical attributes

**Context.** EPIC-006 models `repository.attributes.path` — "absolute path, when
the repository is local".

**Decision.** Do not populate it. Carry `localRoot`, `gitDir` and `commonGitDir`
verbatim in `unknownFields` instead.

**Why.** Two machines sharing one Ferret database would overwrite each other's
copy of the same row for ever, each re-asserting its own path. More importantly,
Governance §9 has a better home for it: a checkout is a **worktree**, which is
its own entity with its own identity, and EPIC-018 is the Epic that creates it.

Populating the attribute now would put a fact about one machine into an entity
every machine shares, and moving it later would be a migration. Nothing is lost:
the paths are carried verbatim for EPIC-018 to model properly.

---

## D7 — Accept a partial `rev-parse` answer for a bare repository

**Context.** `git rev-parse --absolute-git-dir --git-common-dir
--is-bare-repository --show-toplevel` fails in a bare repository, because there
is no work tree — after printing the first three answers.

**Decision.** Run it with `allowFailure`, and accept the partial answer when
`--is-bare-repository` has already said `true`. Anything else is treated as "not
a repository".

**Why.** The alternative is a separate invocation for `--show-toplevel`, which
costs a third subprocess for **every ordinary repository** to accommodate the
rare one — and process creation is the dominant cost here, at roughly 480 ms per
invocation on Windows. The partial answer is unambiguous: the bare flag has
already been printed by the time Git refuses.

Both this and the detection bug that preceded it were found by one fixture — a
bare repository created by real `git`. Neither would have been found by a fake,
which is the argument for the fixtures existing at all.

---

## D8 — Discovery does not descend into a repository it has found

**Context.** Monorepos vendor dependencies; `node_modules` contains repositories.

**Decision.** Stop at a repository unless `includeNested` is set.

**Why.** A submodule is reachable from its parent's configuration, which
EPIC-018 and EPIC-019 will read directly and correctly. Descending through every
repository looking for a stray nested one turns a walk that should take a second
into a minute, and finds mostly dependencies that belong to their own
repositories — which is why they are in the default exclusions already.
