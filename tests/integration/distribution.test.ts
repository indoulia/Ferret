import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli/program.js';
import { PLANNED_COMMANDS } from '../../src/cli/commands/planned.js';

/**
 * Distribution: what someone who did not build Ferret actually receives.
 *
 * The README is the first thing anyone reads and the last thing anyone updates,
 * so it rots quietly. A README that says a command is planned when it ships, or
 * documents a flag that no longer exists, is worse than one that says nothing —
 * it costs the reader the time to find out.
 *
 * These assertions do not check prose. They check the handful of facts that are
 * *derivable* from the code and would otherwise drift.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
  engines: { node: string };
};

/** Every command the CLI actually offers, excluding Commander's own `help`. */
function shippedCommands(): string[] {
  return buildProgram()
    .commands.map((command) => command.name())
    .filter((name) => name !== 'help')
    .sort();
}

describe('the README describes the CLI that exists', () => {
  it('documents every command the binary offers', () => {
    // The failure this prevents is specific and has already happened once: the
    // command table said `ferret mcp` was planned for two Epics after it
    // shipped.
    for (const name of shippedCommands()) {
      expect(readme).toContain(`\`ferret ${name}\``);
    }
  });

  it('does not claim a command is planned when it ships', () => {
    const planned = new Set(PLANNED_COMMANDS.map((command) => command.name));
    for (const name of shippedCommands()) {
      if (planned.has(name)) continue;
      // A row for a shipped command must not say "Planned".
      const row = readme.split('\n').find((line) => line.includes(`\`ferret ${name}\` |`));
      if (row !== undefined) expect(row).not.toContain('Planned');
    }
  });

  it('tells a reader how to connect an AI client', () => {
    // The one thing that turns a working product into a usable one.
    expect(readme).toContain('mcpServers');
    expect(readme).toContain('"args": ["mcp"]');
    expect(readme).toContain('Model Context Protocol');
  });

  it('states that indexed content is data rather than instructions', () => {
    // A reader wiring Ferret into a model deserves to know what Ferret does and
    // does not promise about the content it returns.
    expect(readme).toContain('data, not instructions');
  });

  it('names every tool the MCP surface offers', () => {
    for (const tool of [
      'ferret_search',
      'ferret_find',
      'ferret_get_entity',
      'ferret_neighbours',
      'ferret_context_pack',
    ]) {
      expect(readme).toContain(tool);
    }
  });
});

describe('the package a consumer installs', () => {
  it('rebuilds before it is packed, so the tarball matches the source', () => {
    // `npm pack` and `npm publish` ship whatever is in `dist/`. Without this,
    // publishing from a checkout whose last build predates its last edit ships
    // code that exists nowhere in the repository, and the artefact and the tag
    // disagree with no way to tell.
    expect(pkg.scripts['prepack']).toBe('npm run build');
  });

  it('installs a `ferret` binary from the built output', () => {
    expect(pkg.bin['ferret']).toBe('dist/cli/main.js');
  });

  it('ships the built output, the licence and the readme, and nothing else', () => {
    // Not a style preference: `files` is what stops a `.env`, a fixture or a
    // developer's scratch directory reaching a public registry.
    expect(pkg.files.sort()).toStrictEqual(['LICENSE', 'README.md', 'dist']);
  });

  it('publishes the subpaths the architecture depends on', () => {
    // Each subpath exists because the core must *not* carry what it holds:
    // `pg` and Drizzle, the Git executable path, the MCP SDK, the test doubles.
    // `./providers` is EPIC-013's: a host composing Ferret needs the registry
    // and discovery without importing anything that loads a provider for it.
    expect(Object.keys(pkg.exports).sort()).toStrictEqual([
      '.',
      './git',
      './mcp',
      './package.json',
      './providers',
      './storage',
      './testing',
    ]);
  });

  it('declares the Node it needs', () => {
    expect(pkg.engines.node).toContain('22');
  });

  it('starts with a shebang, so a global install is executable', () => {
    const main = readFileSync(new URL('file://' + ROOT + 'src/cli/main.ts'), 'utf8');
    expect(main.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
