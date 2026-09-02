# EPIC-107 — Docker Distribution · Validation Evidence

**Assessed against:** working tree on top of `a185d67`
**Date:** 2026-09-03
**Environment:** Docker 29.6.2 on Windows, `pgvector/pgvector:pg17` and an image
built from this repository's `Dockerfile` (`node:22-alpine`).

## The musl answer

EPIC-105 recorded on 2026-09-03 that Alpine and musl were unmeasured, and
predicted where it would break: *"`tree-sitter`'s WASM loading is the part most
likely to differ."*

**It does not differ.** Run inside the image, against a TypeScript file with an
arrow function, a declaration and a class:

```json
{"parserId":"ferret.parser.code","symbols":["arrow","named","Thing"],"segments":4}
```

Three symbols, four segments, from the WASM grammar loaded on musl. `arrow` is
there because EPIC-014's change set fixed issue #106 — so the image also
confirms that fix travels.

That is the question this Epic existed to answer, and §8.4 chose Alpine
precisely so it could not be avoided. Debian would have been easier and would
have left it open.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 `docker compose up -d` gives PostgreSQL with pgvector | **MET** | `up -d --wait` reported the container **Healthy**; `SELECT extname FROM pg_extension` returned `vector` |
| AC-2 `ferret init` succeeds against it | **MET** | 12 migrations applied, `schema_migrations` holds 12 rows |
| AC-3 the pinned image | **MET** | `pgvector/pgvector:pg17` — the image `tests/global-setup.ts` starts and EPIC-005 benchmarked |
| AC-4 a named volume | **MET** | `ferret-pgdata`, asserted in `docker.test.ts` |
| AC-5 the compose file writes no Ferret configuration | **MET** | asserted — no `FERRET_CONFIG`, no `config.json` |
| AC-6 the image builds | **MET** | `docker build -t ferret:epic-107 .` — 538 MB |
| AC-7 `ferret --version` runs in it | **MET** | `@indoulia/ferret 0.1.0` |
| AC-8 four WASM grammars present | **MET** | `typescript`, `tsx`, `javascript`, `python` — listed from inside the image |
| AC-9 the parser loads a grammar **inside** the image | **MET** | the JSON above |
| AC-10 `ferret mcp` answers a handshake | **MET** | a real `initialize` over stdio returned `protocolVersion`, `capabilities.tools` and the server instructions, connected to the composed database |
| AC-11 no source, no tests, no secret | **MET** | the installed package is `LICENSE`, `README.md`, `dist`, `node_modules`, `package.json` — `src` and `tests` absent |
| AC-12 the README documents the two-command start | **MET** | a "Getting a database" section |
| AC-13 the musl outcome recorded plainly | **MET** | above, and it passed |

Thirteen of thirteen MET. `npm run verify` green: 153 files, 3 094 passed,
7 skipped — the four extra skips are the image tests, which are opt-in.

## Found while implementing

**Port 5432 was already taken**, on the first `docker compose up` — by an
unrelated project's PostgreSQL on the machine this was written on:

```
Bind for 0.0.0.0:5432 failed: port is already allocated
```

That is not an unusual state for a developer machine; it is the common one. So
the host port is `${FERRET_POSTGRES_PORT:-5432}` and the file says why, with the
override in the comment beside it. A compose file whose first command fails on a
common machine is a compose file that does not answer the onboarding row.

The rest of the validation ran on 5433 through exactly that override, so the
mechanism is exercised rather than asserted.

**Ferret reads discrete `FERRET_DATABASE_*` variables, not a connection URL.**
The first draft of the compose comment documented
`ferret init --database-url …`, which does not exist — `init` has `--check`,
`--no-extensions`, `--save` and `--lock-timeout`. `src/config/resolve.ts`'s
`ENV_BINDINGS` is the real list, and the documented commands now match it. Worth
recording because a comment nobody runs is exactly how onboarding documentation
goes stale, and this one was wrong before it was ever committed.

**The image needs `git` and `postgresql-client`, and neither is obvious.** Git
because EPIC-005 chose the executable over a library binding, so an image
without it installs cleanly and fails on the first `ferret index`. The
PostgreSQL client because EPIC-089 §8.1 prints a `pg_dump` command rather than
wrapping it — and a command an operator cannot run in the image where they read
it is advice that does not work.

## Decisions worth recording

**The image installs a packed tarball rather than copying `dist/`.**
`packaging.test.ts` already asserts what the tarball contains — no source, no
tests, no fixtures, no secret-shaped strings, all four grammars, every migration
— so installing that tarball inherits every one of those guarantees instead of
restating them in a second place that could drift. `--ignore-scripts` on the
pack, because `prepack` would clean `dist/` and rebuild what the build stage
just made.

**Not root.** Ferret reads a repository and writes to a database; neither needs
root, and an image running as root is one whose bind-mounted repository can be
rewritten by a bug.

**Published on `127.0.0.1` only.** A bare `5432:5432` exposes the database on
every interface the host has, which for a container holding an index of
someone's source code is the wrong default.

**The compose file says it is not a deployment**, in the file. No backups, no
replication, no resource limits, and a password anyone can read. A compose file
that looked production-ready would be the more dangerous document.

**The image is not published**, and §16 says why: a registry, a signing story
and a version policy are a release decision no Epic owns, and a published image
nobody signed is worse than none.

## Limitations, recorded

- **No image is published.** Building and proving one is this Epic. Publishing
  is unassigned.
- **A containerised index records container paths.** Ferret records a repository
  by its local path and EPIC-078 §8.4a established that the path is a fact about
  *this machine* — so an index built in the container reports `/repo`, which the
  host does not have. Nothing translates between them, and nothing should. The
  `Dockerfile` says so where a reader will meet it.
- **One architecture.** Built for whatever the building machine is. Multi-arch
  needs `buildx` and a registry to push manifests to.
- **538 MB**, dominated by the Node base image and `node_modules`. Not budgeted:
  the tarball gate already bounds what Ferret contributes, and an image budget
  would mostly measure `node:22-alpine`.
- **The image tests are opt-in.** `FERRET_DOCKER_IMAGE=ferret:epic-107 npm test`
  runs them; a suite that built a container image on every run would be deleted.
  The artefact assertions — the pinned image, the named volume, the localhost
  bind, no root — run always, because those are the properties that regress
  quietly.
- **The compose file is not tested in CI.** Bringing up a container from a test
  is what `tests/global-setup.ts` already does for PostgreSQL, and doing it a
  second time for the same image would double a slow step to assert a
  `docker-compose.yml` that `docker.test.ts` already reads.
