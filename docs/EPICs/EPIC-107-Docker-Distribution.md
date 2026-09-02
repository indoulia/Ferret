# EPIC-107 — Docker Distribution

**Status: VALIDATED | Priority: P2 | Domain: Distribution**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Distribution; only the
> specification is new.

## 1. Objective

Give someone with no PostgreSQL a working Ferret in one command — and answer
whether Ferret runs on musl, which EPIC-105 could not.

## 2. Value

`validation/EPIC-102-103-104-VALIDATION.md` carries two rows, and the second is
the one that costs a new user their first hour:

> *"**Onboarding assumes PostgreSQL already exists.** The README says how to
> point Ferret at one, not how to get one."*

Ferret is `npm install -g` and then a wall. Governance §15 requires Ferret to
provision *itself* — `ferret init` creates its schema — but nothing provisions
the **database**, and "install PostgreSQL 17 and the pgvector extension" is a
sentence that ends a lot of evaluations. The project already pins the exact
image its own tests use; nothing hands it to a user.

The first row is *"No Docker image"*, and it also answers a question EPIC-105
left open on 2026-09-03:

> *"Alpine and musl are unmeasured. A container-based deployment of Ferret is
> likely to be Alpine, and `tree-sitter`'s WASM loading is the part most likely
> to differ. EPIC-107 owns Docker distribution and is where that belongs."*

So this Epic is where "does Ferret work on musl" stops being a guess.

## 3. Scope

- **`docker-compose.yml`** — PostgreSQL 17 with pgvector, on the image the test
  suite already pins, with a volume so data survives a restart.
- **A `Dockerfile`** for Ferret itself, built on Alpine so **§8.4**'s musl
  question is answered rather than avoided.
- **A measured answer** about musl: does the WASM parser load, and do the
  suites pass in the image.
- **Documentation** — the two commands that take someone from nothing to an
  indexed repository.

## 4. Non-scope

- **Publishing an image to a registry.** Building one and proving it works is
  this Epic; deciding where it lives, who signs it and how it is versioned is a
  release decision no Epic owns. §16.
- **Kubernetes, Helm, or an operator.** A `compose` file for one developer's
  machine is what the row asks for.
- **Running the CLI's *indexing* in the container as the primary mode.** Ferret
  indexes local Git repositories; an image would need the repository
  bind-mounted, and the path inside the container is then what Ferret records as
  `localRoot` — which EPIC-078 §8.4a already established is a fact about *this
  machine*. §8.5 states the consequence rather than hiding it.
- **Replacing `pgvector/pgvector:pg17`.** EPIC-005 benchmarked and validated
  pgvector 0.8.6 against it; this uses the same image for the same reason.
- **A database Ferret manages.** The compose file is a convenience for getting
  started. Ferret does not own that container's lifecycle any more than it owns
  `dropdb` (EPIC-088 §4).

## 5. Inputs

`pgvector/pgvector:pg17`; the published npm package; the four WASM grammars
`scripts/copy-grammars.mjs` places in `dist/`.

## 6. Outputs

`docker-compose.yml`, `Dockerfile`, a README section, and
`validation/EPIC-107-VALIDATION.md` carrying the musl answer.

## 7. Dependencies

EPIC-002 (the schema the compose'd database receives), EPIC-005 (the pinned
image), EPIC-025 (the WASM grammars), EPIC-102/103/104 (the package being
installed), EPIC-105 (whose musl gap this closes).

## 8. Contracts

### 8.1 The compose file is the answer to the onboarding row

Two commands: `docker compose up -d` and `ferret init`. That is the whole
distance from nothing to a schema, and the row exists because it used to be
"install PostgreSQL 17, add pgvector, create a database, set four configuration
values".

The image is the one the test suite pins, so the database a new user gets is the
database Ferret is tested against — not a similar one.

### 8.2 A volume, because a lost index is a bad first impression

Named, so `docker compose down` does not silently discard an index that took
minutes to build. `down -v` still does, which is the documented way to start
over.

### 8.3 The compose file configures nothing about Ferret

It publishes a port and prints the connection details; Ferret is configured
through `ferret config set` or the environment, as it always was. A compose file
that wrote Ferret's configuration would be a second configuration writer, and
EPIC-003's is the only one (the argument EPIC-066 made about `ConfigStore`).

### 8.4 The image is Alpine, so the musl question is answered

EPIC-105 recorded musl as unmeasured and named this Epic. Building on Debian
would have been easier and would have left the question open, so the image is
`node:22-alpine` and the validation records what happened — **including if it
does not work**, which is the outcome that matters most to record.

`tree-sitter`'s WASM loading is the part EPIC-105 predicted would differ, so it
is the first thing the validation reports.

### 8.5 A containerised Ferret records container paths, and that is stated

Ferret indexes a repository by its local path, and EPIC-078 §8.4a established
that the path is *a fact about this machine*. A bind-mounted repository is
recorded at its **container** path, so an index built inside the container and
read from outside it will report paths that do not exist on the host.

That is not a defect to be worked around; it is what "the path is machine-local"
means. §16 records it, and the documentation says which mode to use for which
purpose.

### 8.6 The image ships the grammars, or it is broken and says so

`scripts/copy-grammars.mjs` puts four WASM files in `dist/`, and
`packaging.test.ts` already asserts they reach the tarball. An image built from
that tarball must carry them; a test that runs the parser inside the image is
what proves it, because a missing grammar produces a working install that fails
on the first file — the failure mode EPIC-102/103/104 recorded for migrations
and grammars both.

## 9. Acceptance criteria

- **AC-1** `docker compose up -d` starts PostgreSQL 17 with pgvector available.
- **AC-2** `ferret init` succeeds against the composed database.
- **AC-3** The composed database uses the image the test suite pins.
- **AC-4** The data volume is named, so `down` preserves an index.
- **AC-5** The compose file writes no Ferret configuration.
- **AC-6** The Ferret image builds.
- **AC-7** `ferret --version` runs in the image.
- **AC-8** The four WASM grammars are present in the image.
- **AC-9** The parser loads a grammar **inside** the image — the musl answer.
- **AC-10** `ferret mcp` starts in the image and answers a protocol handshake,
  or the validation records why it cannot.
- **AC-11** The image ships no source, no tests and no secret — the same
  properties `packaging.test.ts` asserts of the tarball.
- **AC-12** The README documents the two-command start.
- **AC-13** The validation records the musl outcome plainly, pass or fail.

## 10. Test requirements

**Integration (real Docker)** — AC-1 to AC-11, skipped with a stated reason when
Docker is unavailable, exactly as the database suites do.

**Failure** — a compose'd database that has not finished starting; an image
built without the grammars.

**Regression** — `packaging.test.ts` unchanged.

## 11. Security requirements

AC-11: no source, no tests, no `.env`, no credential in the image. The compose
file's password is a **development** default and says so where a reader will see
it — a compose file that looked production-ready would be the more dangerous
document.

## 12. Observability

The compose file prints the connection string on start. The validation carries
the image size and the musl answer.

## 13. Performance constraints

Image size is reported, not budgeted: EPIC-102/103/104's tarball gate already
bounds what goes in, and an image budget would mostly measure the Node base
image.

## 14. Definition of Done

Scope implemented; AC-1 to AC-13 with evidence in
`validation/EPIC-107-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-102/103/104's two rows and EPIC-105's musl limitation struck with
dated notes.

## 15. Governance alignment

- **§15 Self-Provisioning** — extended one step: Ferret provisions its schema,
  and now the documentation provisions the database Ferret needs.
- **§6 Evidence Before Inference** — §8.4: Alpine is chosen *because* it answers
  the open question, and §8.13 requires the answer recorded either way.
- **§5 Reuse Before Reinvent** — the pinned image, and no second configuration
  writer.

## 16. Raised, not absorbed

- **No image is published.** Building and proving one is this Epic; a registry,
  a signing story and a version policy are a release decision. A published image
  nobody signed is worse than none.
- **A containerised index records container paths** — §8.5. An index built in
  the container and read on the host reports paths that do not exist there.
  Nothing translates between them, and nothing should: the path is machine-local
  by design.
- **One architecture.** The image is built for whatever the building machine is.
  A multi-arch build needs `buildx` and a registry to push manifests to, which
  §4 excludes.
- **The compose file is not a deployment.** No backups, no replication, no
  resource limits, and a development password. It is the shortest path to a
  working Ferret, and a reader who mistakes it for production has been warned in
  the file itself.

## 17. Recorded during implementation

**Port 5432 was already taken on the first `docker compose up`** — by an
unrelated project's PostgreSQL on the machine this was written on. That is the
common state of a developer machine, not an unusual one, so the host port is
`${FERRET_POSTGRES_PORT:-5432}` with the override documented beside it. A
compose file whose first command fails on a common machine does not answer the
onboarding row. The rest of the validation ran through that override.

**Ferret reads discrete `FERRET_DATABASE_*` variables, not a connection URL.**
The first draft of §8.1's two commands documented `ferret init --database-url`,
which does not exist. `src/config/resolve.ts`'s `ENV_BINDINGS` is the real list.
Worth recording because a comment nobody runs is exactly how onboarding
documentation goes stale, and this one was wrong before it was committed.

**musl works.** §8.4's question is answered: the WASM parser loads inside the
Alpine image and extracts symbols. EPIC-105 predicted `tree-sitter`'s WASM
loading as the part most likely to differ, and it does not.

Full evidence in [validation](validation/EPIC-107-VALIDATION.md).
