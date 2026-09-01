#!/usr/bin/env node
/**
 * The database Ferret answers questions about *itself* from.
 *
 * Ferret is wired into this repository as an MCP server (`.mcp.json`), so an AI
 * client working on Ferret navigates Ferret's own code through Ferret. That is
 * dogfooding in the only sense that finds anything: four defects in EPIC-058,
 * EPIC-060 and issue #71 were found by running the product, and none of them was
 * visible from the test suite.
 *
 * This script starts the container that server connects to, indexes this
 * repository into it, and prints the one environment variable that is not
 * committed.
 *
 * Usage:
 *   node scripts/dogfood-db.mjs               # start, migrate, index with content
 *   node scripts/dogfood-db.mjs --index       # re-index only, after a merge
 *   node scripts/dogfood-db.mjs --no-content  # paths and history only, much faster
 *   node scripts/dogfood-db.mjs --stop        # remove the container
 *
 * Deliberately separate from the test database. `tests/global-setup.ts` creates
 * a fresh database per test file and drops it; this one persists, because an
 * index built over ten minutes is not something to rebuild per question.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

const CONTAINER = 'ferret-dogfood';
/** Pinned to the image EPIC-005 benchmarked, like the test harness. */
const IMAGE = 'pgvector/pgvector:pg17';
const PORT = process.env['FERRET_DATABASE_PORT'] ?? '55432';
const USER = 'ferret';
const DATABASE = 'ferret';

/**
 * Local-only, and not a secret worth protecting — but still not committed.
 *
 * The container is published on **127.0.0.1** and holds one thing: an index of a
 * public repository. What makes this safe is the binding, not the password — and
 * the binding is explicit for that reason, because `-p 55432:5432` would bind
 * `0.0.0.0` and quietly invalidate the whole argument. It stays out of
 * `.mcp.json` regardless, because a committed credential teaches the wrong habit
 * far more reliably than it protects anything.
 */
const PASSWORD = process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood';

const env = {
  ...process.env,
  FERRET_DATABASE_HOST: '127.0.0.1',
  FERRET_DATABASE_PORT: PORT,
  FERRET_DATABASE_NAME: DATABASE,
  FERRET_DATABASE_USER: USER,
  FERRET_DATABASE_PASSWORD: PASSWORD,
  FERRET_CONFIG_HOME: process.env['FERRET_CONFIG_HOME'] ?? '.local/ferret-config',
};

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...options }).trim();
}

function running() {
  try {
    return docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { stdio: ['ignore', 'pipe', 'ignore'] }) === 'true';
  } catch {
    return false;
  }
}

function exists() {
  try {
    docker(['inspect', CONTAINER], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function start() {
  if (running()) {
    console.log(`${CONTAINER} is already running on port ${PORT}.`);
    return;
  }
  if (exists()) {
    docker(['start', CONTAINER]);
  } else {
    console.log(`Starting ${IMAGE} as ${CONTAINER} on port ${PORT}...`);
    try {
      docker([
        'run', '-d', '--name', CONTAINER,
        '-e', `POSTGRES_USER=${USER}`,
        '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
        '-e', `POSTGRES_DB=${DATABASE}`,
        // Explicitly loopback. `-p 55432:5432` binds **0.0.0.0** — the container
        // was reachable from the network, while this file and PR #76 both claimed
        // "the container publishes on loopback" and rested the security argument
        // on that binding. The claim was wrong; the binding is now what the claim
        // said. Caught by reading `docker ps` output while answering a question
        // about where the database runs.
        '-p', `127.0.0.1:${PORT}:5432`,
        IMAGE,
      ]);
    } catch (error) {
      // `docker run -d` creates the container *then* fails to bind the port, so
      // a name is taken by something that never started and the obvious retry —
      // running this script again — hits "name already in use" instead of the
      // real problem. Found by running it with the port already allocated.
      if (exists()) docker(['rm', '-f', CONTAINER]);
      // The cause is kept rather than summarised into the message: Docker's own
      // line names the real conflict, and a script that swallows it makes the
      // next person guess.
      throw new Error(
        `Could not start ${CONTAINER}. Port ${PORT} may already be in use — ` +
          `check with \`docker ps\`, or set FERRET_DATABASE_PORT to a free one.`,
        { cause: error },
      );
    }
  }

  // Polled rather than slept: the image takes a variable time to accept
  // connections, and a fixed sleep is either too short on a cold pull or wasted
  // on a warm start.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(['exec', CONTAINER, 'pg_isready', '-U', USER], { stdio: ['ignore', 'pipe', 'ignore'] });
      return;
    } catch {
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { stdio: 'ignore' });
    }
  }
  throw new Error(`${CONTAINER} did not accept connections`);
}

function ferret(args) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, stdio: 'inherit' });
}

if (process.argv.includes('--stop')) {
  if (exists()) docker(['rm', '-f', CONTAINER]);
  console.log(`${CONTAINER} removed.`);
  process.exit(0);
}

start();

if (!process.argv.includes('--index')) ferret(['init']);

// EPIC-108 content indexing **on** by default here, unlike the CLI.
//
// The CLI is right to make it opt-in: it reads every file. But this index exists
// to be *navigated*, and without content the full-text index holds paths and
// commit messages only — searching for a phrase that appears in the code finds
// the commit that mentioned it and not the code itself. Measured: "withheld
// count" matched one commit and no source file. An index you cannot search by
// what the code says is not a navigation tool.
const content = process.argv.includes('--no-content') ? [] : ['--content'];
ferret(['index', ROOT, ...content]);

console.log(`
Ferret is indexed and the MCP server in .mcp.json can reach it.
Export the one variable that is not committed, then restart your AI client:

  export FERRET_DATABASE_PASSWORD=${PASSWORD}        # bash
  $env:FERRET_DATABASE_PASSWORD = '${PASSWORD}'      # PowerShell

After each merge, re-index so Ferret answers about the code that is on main:

  node scripts/dogfood-db.mjs --index
`);
