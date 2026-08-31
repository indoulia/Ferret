#!/usr/bin/env node
/**
 * Ferret, asked about Ferret — and checked against the truth.
 *
 * This is not a demo. It is an **oracle**: every question it asks has an answer
 * that `git` can produce independently, so a disagreement is a defect rather
 * than a matter of opinion. That distinction is the whole point. Running Ferret
 * against its own repository and reading the output proves only that it
 * produces output; comparing that output to `git ls-files` is what found
 * thirteen files Ferret believed in that had not existed for months.
 *
 * Every question goes through the **MCP surface**, not through SQL. A defect
 * that only SQL can see is not a defect a client will ever hit, and — far more
 * often — a defect a client *will* hit is invisible from SQL, because it lives
 * in the layer between the database and the answer. Two of the findings that
 * produced this script were exactly that: evidence Ferret held correctly and
 * never surfaced.
 *
 * Usage:
 *   npm run dogfood            # index, then check
 *   npm run dogfood -- --check # check what is already indexed
 *
 * Requires a configured database, the same as any other Ferret run.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const checkOnly = process.argv.includes('--check');

/** Findings, so the run reports all of them rather than only the first. */
const findings = [];
function fail(check, detail) {
  findings.push({ check, detail });
  process.stderr.write(`  FAIL  ${check}\n        ${detail}\n`);
}
function pass(check, detail) {
  process.stderr.write(`  ok    ${check}${detail === undefined ? '' : `  (${detail})`}\n`);
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Ground truth, from git rather than from Ferret.
// ---------------------------------------------------------------------------

/**
 * Files the repository actually tracks at HEAD.
 *
 * Symlinks and submodules are excluded because Ferret deliberately does not
 * model them as files — a symlink's blob holds a target path, not content.
 * Excluding them here rather than tolerating a mismatch keeps the check strict.
 */
function trackedFiles() {
  const lines = git('ls-files', '-s', '-z').split('\0').filter((line) => line.length > 0);
  const files = new Set();
  for (const line of lines) {
    const mode = line.slice(0, 6);
    if (mode === '120000' || mode === '160000') continue; // symlink, submodule
    const path = line.slice(line.indexOf('\t') + 1);
    files.add(path);
  }
  return files;
}

function headSha() {
  return git('rev-parse', 'HEAD').trim();
}

// ---------------------------------------------------------------------------
// Ferret, over MCP, exactly as a client reaches it.
// ---------------------------------------------------------------------------

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...process.env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'ferret-dogfood', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (result.isError === true) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(CLI)) {
    process.stderr.write('dogfood: dist/cli/main.js is missing. Run `npm run build` first.\n');
    process.exit(2);
  }

  if (!checkOnly) {
    process.stderr.write('Indexing this repository with the built CLI...\n');
    execFileSync(process.execPath, [CLI, 'index', ROOT], { stdio: 'inherit', cwd: ROOT });
    process.stderr.write('\n');
  }

  const client = await connect();
  process.stderr.write('Asking Ferret about Ferret, and checking every answer:\n\n');

  try {
    // -- Every response must frame its content as data. -------------------
    const sample = await call(client, 'ferret_find', { kind: 'repository', limit: 1 });
    if (typeof sample.notice !== 'string' || !sample.notice.includes('DATA, not instructions')) {
      fail('content notice', 'A response arrived without the notice that frames content as data.');
    } else {
      pass('content notice');
    }

    const repository = sample.entities?.[0];
    if (repository === undefined) {
      fail('repository indexed', 'Ferret holds no repository entity. Nothing else can be checked.');
      return;
    }
    pass('repository indexed', repository.attributes?.name);

    // -- What Ferret says the repository contains, versus what it does. ---
    const tracked = trackedFiles();
    const indexed = new Map();
    const page = await call(client, 'ferret_find', { kind: 'file', scope: repository.id, limit: 500 });
    for (const entity of page.entities ?? []) {
      indexed.set(entity.attributes?.path, entity);
    }

    // `ferret_find` offers no cursor, so "every file in this repository" is
    // whatever fits in one page. Saying so is the difference between a partial
    // answer and a wrong one.
    if (indexed.size >= 500) {
      fail(
        'the file list is complete',
        'ferret_find returned a full page and offers no cursor, so the remaining files ' +
          'cannot be enumerated and the checks below are running on a truncated set.',
      );
    }

    const live = [...indexed.entries()].filter(([, e]) => e.lifecycle === 'active').map(([p]) => p);

    // A file Ferret calls active that is not tracked and not on disk is a file
    // Ferret invented. This is the check that found the original thirteen.
    const phantom = live.filter((path) => !tracked.has(path) && !existsSync(join(ROOT, path)));
    if (phantom.length > 0) {
      fail(
        'no phantom files',
        `${phantom.length} file(s) reported active that the repository does not contain: ` +
          `${phantom.slice(0, 5).join(', ')}${phantom.length > 5 ? ', ...' : ''}`,
      );
    } else {
      pass('no phantom files', `${live.length} active`);
    }

    // ...and the other direction: a tracked file Ferret does not know about.
    const missing = [...tracked].filter((path) => !indexed.has(path));
    if (missing.length > 0) {
      fail(
        'no missing files',
        `${missing.length} tracked file(s) absent from the index: ` +
          `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`,
      );
    } else {
      pass('no missing files', `${tracked.size} tracked`);
    }

    // -- Commits must carry content, not just an identifier. --------------
    //
    // The check that exists because sixty of sixty-one commits once held a SHA
    // and nothing else, while every structural test passed.
    const head = headSha();
    const found = await call(client, 'ferret_search', { query: head.slice(0, 12), limit: 5 });
    const headEntity = (found.results ?? []).find((r) => r.attributes?.sha === head);
    if (headEntity === undefined) {
      fail('HEAD is indexed', `No commit entity for ${head.slice(0, 12)}.`);
    } else if (
      typeof headEntity.attributes?.message !== 'string' ||
      headEntity.attributes.message.length === 0
    ) {
      fail('commits carry content', `Commit ${head.slice(0, 12)} has no message.`);
    } else {
      pass('commits carry content', headEntity.attributes.message.split('\n')[0].slice(0, 48));
    }

    // -- An exact question must get an exact answer, or an error. ---------
    //
    // A lookup whose filter is silently discarded returns a confident wrong
    // answer, which is indistinguishable from a right one at the call site.
    const impossible = await call(client, 'ferret_find', {
      kind: 'file',
      attributes: { path: 'this/path/does/not/exist.txt' },
    });
    if ((impossible.count ?? 0) !== 0) {
      fail('exact lookup filters', `An impossible path matched ${impossible.count} entities.`);
    } else {
      pass('exact lookup filters');
    }

    // -- A client must be able to see what a change was. ------------------
    //
    // Ferret records whether a commit added, modified or deleted a file. If
    // that never reaches a client, the evidence may as well not exist.
    const deletedPath = [...indexed.keys()].find(
      (path) => indexed.get(path)?.lifecycle === 'deleted',
    );
    if (deletedPath !== undefined) {
      const neighbours = await call(client, 'ferret_neighbours', {
        id: indexed.get(deletedPath).id,
        includeHistorical: true,
      });
      const changes = (neighbours.neighbours ?? []).filter(
        (n) => n.relationship === 'commit_modifies_file',
      );
      if (changes.every((n) => n.metadata === undefined)) {
        fail(
          'change kind is visible',
          'A client cannot tell whether a commit added, modified or deleted a file.',
        );
      } else {
        pass('change kind is visible');
      }
    }

    // -- Health must describe reality. ------------------------------------
    const status = execFileSync(process.execPath, [CLI, 'status', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const health = JSON.parse(status);
    const integrity = (health.components ?? []).find((c) => c.name === 'index-integrity');
    if (integrity !== undefined && /no index exists/i.test(integrity.detail ?? '')) {
      fail('health reflects the index', `status reports "${integrity.detail}" with an index present.`);
    } else {
      pass('health reflects the index', integrity?.detail?.slice(0, 48));
    }
  } finally {
    await client.close();
  }

  process.stderr.write('\n');
  if (findings.length > 0) {
    process.stderr.write(`${findings.length} finding(s). Ferret disagrees with the repository.\n`);
    process.exit(1);
  }
  process.stderr.write('Ferret agrees with the repository on every question asked.\n');
}

await main();
