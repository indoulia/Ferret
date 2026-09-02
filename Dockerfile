# Ferret as a container image — EPIC-107.
#
# **Alpine on purpose.** EPIC-105 recorded musl as unmeasured on 2026-09-03 and
# named this Epic:
#
#   "Alpine and musl are unmeasured. A container-based deployment of Ferret is
#    likely to be Alpine, and `tree-sitter`'s WASM loading is the part most
#    likely to differ. EPIC-107 owns Docker distribution and is where that
#    belongs."
#
# Building on Debian would have been easier and would have left the question
# open. §8.4 chose Alpine so the answer is measured, and §8.13 requires the
# validation to record it either way.
#
# Two stages, and the reason is the same one `packaging.test.ts` asserts of the
# tarball: the runtime image must carry `dist/` and the production dependencies
# and nothing else — no source, no tests, no dev dependencies.

# --- Stage one: build from source, exactly as a publish would.
FROM node:22-alpine AS build

WORKDIR /build

# `npm ci` before the sources, so a dependency change is the only thing that
# invalidates the install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
COPY datasets ./datasets
COPY README.md LICENSE ./

# The build is what places the four WASM grammars in `dist/`
# (`scripts/copy-grammars.mjs`) and the migrations beside them
# (`scripts/copy-migrations.mjs`). An image missing either installs cleanly and
# fails on the first file or the first `init` — the failure mode
# EPIC-102/103/104 recorded for both.
RUN npm run build

# `npm pack` rather than copying `dist/` directly, so the image contains exactly
# what a user installing from npm would get. `--ignore-scripts` because the
# build has already run and `prepack` would clean `dist/` and redo it.
RUN npm pack --ignore-scripts && mv indoulia-ferret-*.tgz /ferret.tgz

# --- Stage two: the runtime.
FROM node:22-alpine AS runtime

# `git` because Ferret indexes Git repositories and shells out to it — EPIC-005
# chose the executable over a library binding deliberately. Without this the
# image installs and every `ferret index` fails on a missing binary.
#
# `postgresql-client` for `pg_dump`: EPIC-089 §8.1 decided Ferret does not wrap
# it and prints the command instead, and a command an operator cannot run in
# the image where they read it is advice that does not work.
RUN apk add --no-cache git postgresql-client

COPY --from=build /ferret.tgz /tmp/ferret.tgz
RUN npm install -g /tmp/ferret.tgz && rm /tmp/ferret.tgz

# Not root. Ferret reads a repository and writes to a database; neither needs
# root, and an image that runs as root by default is one whose bind-mounted
# repository can be rewritten by a bug.
RUN addgroup -S ferret && adduser -S -G ferret ferret
USER ferret

# Where a repository is expected to be mounted:
#
#     docker run --rm -v "$PWD:/repo" ferret index /repo
#
# §8.5, and it is a real consequence rather than a footnote: Ferret records a
# repository by its local path, and EPIC-078 §8.4a established that the path is
# *a fact about this machine*. An index built here records `/repo`, so reading
# it from the host reports a path the host does not have. Nothing translates
# between them, and nothing should.
WORKDIR /repo

ENTRYPOINT ["ferret"]
CMD ["--help"]
