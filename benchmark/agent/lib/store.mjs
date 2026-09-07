/** A store this harness owns outright: created, migrated, indexed and dropped, never the dogfood one. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ferretExclusions } from './corpus.mjs';

/** The container the dogfood database already runs in. Nothing else is assumed. */
const CONTAINER = process.env['FERRET_AGENT_CONTAINER'] ?? 'ferret-dogfood';

/** The database this harness owns. Separate because Session A writes to it, and the dogfood store is what the task benchmark measures. */
export const DATABASE = process.env['FERRET_AGENT_DATABASE'] ?? 'ferret_agent_ab';

export const CONNECTION = Object.freeze({
  FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
  FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
  FERRET_DATABASE_NAME: DATABASE,
  FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
  FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
});

function psql(statement) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', CONNECTION.FERRET_DATABASE_USER, '-d', 'postgres', '-c', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Dropped and recreated rather than emptied, so a run cannot inherit a row a previous one left. */
export function resetStore({ root, cli, configHome }) {
  psql(`DROP DATABASE IF EXISTS ${DATABASE}`);
  psql(`CREATE DATABASE ${DATABASE}`);
  execFileSync(process.execPath, [cli, 'init'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...CONNECTION, FERRET_DATABASE_MIGRATE: 'auto', FERRET_CONFIG_HOME: configHome },
  });
}

/** Indexes this repository into the store. Content is on: without file bodies the index competes on paths alone. */
export function indexRepository({ root, cli, configHome, content = true }) {
  const started = performance.now();
  execFileSync(process.execPath, [cli, 'index', root, ...(content ? ['--content'] : [])], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
  });
  return { ms: performance.now() - started };
}

export function dropStore() {
  psql(`DROP DATABASE IF EXISTS ${DATABASE}`);
}

/** A configuration directory naming one principal, with the corpus rule in force. */
export function configFor({ root, principalId, principalClass = 'agent', permissions }) {
  const directory = join(root, '.local', 'agent-benchmark-config', principalId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          authorization: { principalId, principalClass, permissions: [...permissions] },
          exclude: ferretExclusions(),
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}
