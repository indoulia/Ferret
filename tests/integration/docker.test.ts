import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Docker distribution — EPIC-107.
 *
 * Two kinds of assertion, and the split is deliberate.
 *
 * **The artefacts** are asserted always: a `docker-compose.yml` that pinned a
 * different image, published on every interface, or lost its named volume would
 * be a regression nobody notices until a user loses an index. Those are
 * properties of two files and cost nothing to check.
 *
 * **The image** is asserted only when one has been built and named, because
 * building it takes about a minute and a test suite that built a container
 * image on every run would be deleted. `FERRET_DOCKER_IMAGE=ferret:epic-107 npm
 * test` opts in; `validation/EPIC-107-VALIDATION.md` records what the run
 * measured.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/** An image to exercise, when a caller has built one. */
const IMAGE = process.env['FERRET_DOCKER_IMAGE'];
const describeImage = IMAGE === undefined ? describe.skip : describe;

function inImage(args: readonly string[]): string {
  return execFileSync('docker', ['run', '--rm', ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('the composed database — AC-1 to AC-5', () => {
  it('pins the image the test suite pins — AC-3', () => {
    // So the database a new user gets is the database Ferret is tested
    // against, rather than a similar one. EPIC-005 benchmarked and validated
    // pgvector 0.8.6 against exactly this image.
    expect(compose).toContain('pgvector/pgvector:pg17');
  });

  it('names the data volume, so `down` does not discard an index — AC-4', () => {
    expect(compose).toContain('ferret-pgdata');
    expect(compose).toMatch(/volumes:\s*\n\s*ferret-pgdata:/);
  });

  it('publishes on localhost only', () => {
    // A bare `5432:5432` would expose the database on every interface the host
    // has, which for a container holding an index of someone's source code is
    // the wrong default.
    expect(compose).toContain('127.0.0.1:');
    expect(compose).not.toMatch(/^\s*-\s*'?\d+:5432/m);
  });

  it('lets the host port be overridden, because 5432 is often taken', () => {
    // Found immediately on the machine this was written on: another project's
    // PostgreSQL held 5432, and `up` failed with "port is already allocated".
    expect(compose).toContain('${FERRET_POSTGRES_PORT:-5432}');
  });

  it('has a healthcheck, so `up --wait` means ready — AC-1', () => {
    // A `ferret init` against a still-starting PostgreSQL fails with a
    // connection error that looks like a configuration problem.
    expect(compose).toContain('pg_isready');
  });

  it('writes no Ferret configuration — AC-5', () => {
    // EPIC-003's `ConfigStore` is the only writer of Ferret's configuration; a
    // compose file that wrote it would be a second one.
    expect(compose).not.toContain('FERRET_CONFIG');
    expect(compose).not.toMatch(/config\.json/);
  });

  it('says plainly that it is not a deployment', () => {
    // A compose file that looked production-ready would be the more dangerous
    // document.
    expect(compose).toContain('not a deployment');
    expect(compose).toContain('development default');
  });
});

describe('the image definition — AC-6, AC-11', () => {
  it('is built on Alpine, which is what answers the musl question — AC-9', () => {
    // EPIC-105 recorded musl as unmeasured and named this Epic. Debian would
    // have been easier and would have left the question open.
    expect(dockerfile).toContain('node:22-alpine');
  });

  it('installs git, because Ferret shells out to it', () => {
    // EPIC-005 chose the executable over a library binding. Without this the
    // image installs and every `ferret index` fails on a missing binary.
    expect(dockerfile).toMatch(/apk add[^\n]*git/);
  });

  it('installs the PostgreSQL client, so the printed pg_dump command can run', () => {
    // EPIC-089 §8.1 prints the command rather than wrapping it, and a command
    // an operator cannot run where they read it is advice that does not work.
    expect(dockerfile).toMatch(/apk add[^\n]*postgresql-client/);
  });

  it('installs from a packed tarball, so the image is what npm would give — AC-11', () => {
    // Rather than copying `dist/` in: `packaging.test.ts` already asserts what
    // the tarball contains, so installing the tarball inherits every one of
    // those guarantees instead of restating them.
    expect(dockerfile).toContain('npm pack');
    expect(dockerfile).toContain('npm install -g');
  });

  it('does not run as root', () => {
    // Ferret reads a repository and writes to a database; neither needs root,
    // and an image running as root is one whose bind-mounted repository can be
    // rewritten by a bug.
    expect(dockerfile).toMatch(/USER ferret/);
  });

  it('is two-stage, so no build tooling reaches the runtime', () => {
    expect(dockerfile).toMatch(/FROM node:22-alpine AS build/);
    expect(dockerfile).toMatch(/FROM node:22-alpine AS runtime/);
  });

  it('records why a containerised index reports container paths — §8.5', () => {
    // EPIC-078 §8.4a established that a repository's path is a fact about
    // *this machine*. A bind-mounted repository is recorded at its container
    // path, and nothing translates between them.
    expect(dockerfile).toContain('fact about this machine');
  });
});

describeImage(`the built image (${IMAGE ?? 'set FERRET_DOCKER_IMAGE to run'})`, () => {
  const image = IMAGE as string;

  it('runs and reports its version — AC-7', () => {
    expect(inImage([image, '--version'])).toContain('@indoulia/ferret');
  });

  it('carries all four WASM grammars — AC-8', () => {
    // A missing grammar produces a working install that fails on the first
    // file — the failure mode EPIC-102/103/104 recorded for migrations and
    // grammars both.
    const listing = inImage([
      '--entrypoint',
      'sh',
      image,
      '-c',
      'ls /usr/local/lib/node_modules/@indoulia/ferret/dist/parsers/code/grammars/',
    ]);

    for (const grammar of ['typescript', 'tsx', 'javascript', 'python']) {
      expect(listing, grammar).toContain(`tree-sitter-${grammar}.wasm`);
    }
  });

  it('carries the migrations, so `init` can provision', () => {
    const listing = inImage([
      '--entrypoint',
      'sh',
      image,
      '-c',
      'ls /usr/local/lib/node_modules/@indoulia/ferret/dist/storage/migrations/',
    ]);

    expect(listing).toContain('0001_bootstrap.sql');
  });

  it('ships no source and no tests — AC-11', () => {
    const listing = inImage([
      '--entrypoint',
      'sh',
      image,
      '-c',
      'ls /usr/local/lib/node_modules/@indoulia/ferret',
    ]);

    expect(listing).toContain('dist');
    expect(listing).not.toContain('src');
    expect(listing).not.toContain('tests');
  });
});
