import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

/** Matches static `import`/`export ... from '<specifier>'` and `import('<specifier>')`. */
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g;

/**
 * A real module specifier: relative, bare, or scoped, with no spaces.
 *
 * The pattern above also fires on English prose that happens to end in the word
 * "from" immediately before a quote — a CLI help string reading
 * `'Print the files Ferret reads configuration from'` was picked up as a
 * dependency. Requiring the capture to look like a specifier removes that whole
 * class of false positive, and cannot hide a real import: every real specifier
 * satisfies this shape.
 */
const MODULE_SPECIFIER = /^(?:\.{1,2}(?:\/[\w.-]+)*\/?[\w.-]*|node:[\w/.-]+|@[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*|[\w.-]+(?:\/[\w.-]+)*)$/;

/**
 * Removes comments before the import graph is walked.
 *
 * Without this the scanner reads prose as code: a doc comment containing the
 * words `from "unreadable"` was picked up as a dependency on a package called
 * `unreadable`. An architectural control that a sentence can fool is not a
 * control, and the failure direction is the dangerous one — a comment could
 * just as easily *hide* nothing but could add noise that trains people to
 * loosen the allowlist.
 *
 * Block comments are stripped wholesale; line comments only when they start a
 * line, so a `'https://…'` literal inside real code is never truncated.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Graph {
  /** Repository-relative paths of every module reachable from the entry point. */
  readonly files: Set<string>;
  /** Bare package specifiers imported anywhere in that graph. */
  readonly packages: Set<string>;
}

/**
 * Walks the static import graph from an entry module.
 *
 * Reads the TypeScript sources directly rather than the build output, so the
 * boundary is enforced on the code under review.
 */
function importGraph(entry: string): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(SRC, entry)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    const key = relative(SRC, current).replaceAll('\\', '/');
    if (files.has(key)) continue;
    files.add(key);

    const source = stripComments(readFileSync(current, 'utf8'));
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined || !MODULE_SPECIFIER.test(specifier)) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(current), specifier.replace(/\.js$/, '.ts')));
      } else {
        packages.add(specifier);
      }
    }
  }

  return { files, packages };
}

/**
 * Runtime dependencies the core is permitted to reach.
 *
 * Adding an entry here is a deliberate architectural decision, not a fix for a
 * failing test: it widens what every consumer of `@indoulia/ferret` installs.
 */
const ALLOWED_CORE_PACKAGES: ReadonlySet<string> = new Set(['picomatch', 'pino', 'zod']);

/**
 * Packages the storage provider adds on top of the core set.
 *
 * EPIC-002 keeps these out of the core entry point deliberately: they are
 * reachable through `@indoulia/ferret/storage` and through the CLI, which
 * composes providers, but never from `@indoulia/ferret` itself.
 */
const STORAGE_PACKAGES: readonly string[] = [
  'drizzle-orm',
  'drizzle-orm/node-postgres',
  'drizzle-orm/pg-core',
  'pg',
];

/**
 * Substrings that identify a provider-, vendor- or parser-specific dependency.
 * EPIC-001 acceptance criterion: core imports must not depend on these.
 */
const FORBIDDEN_IN_CORE = [
  'github',
  'octokit',
  'jira',
  'atlassian',
  'pdfjs',
  'mammoth',
  'exceljs',
  'csv-parse',
  'tree-sitter',
  'drizzle',
  'postgres',
  'modelcontextprotocol',
  'openai',
  'anthropic',
];

describe('core public entry point', () => {
  const graph = importGraph('index.ts');

  it('reaches the runtime, provider and error modules it publishes', () => {
    expect(graph.files).toContain('runtime/runtime.ts');
    expect(graph.files).toContain('providers/registry.ts');
    expect(graph.files).toContain('errors/ferret-error.ts');
  });

  it('does not reach any CLI module', () => {
    const cliModules = [...graph.files].filter((file) => file.startsWith('cli/'));
    expect(cliModules).toStrictEqual([]);
  });

  it('depends only on Node built-ins and the approved runtime packages', () => {
    const external = [...graph.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('does not import commander, which is a CLI concern', () => {
    expect(graph.packages.has('commander')).toBe(false);
  });

  it.each(FORBIDDEN_IN_CORE)('does not import anything matching %s', (fragment) => {
    const offenders = [...graph.packages].filter((name) => name.toLowerCase().includes(fragment));
    expect(offenders).toStrictEqual([]);
  });

  it('lets providers depend on the core, never the reverse', () => {
    // A provider is registered through ProviderRegistry, so nothing in the core
    // graph may name a concrete provider module.
    const concreteProviders = [...graph.files].filter((file) =>
      /providers\/(?!contract|registry|index)/.test(file),
    );
    expect(concreteProviders).toStrictEqual([]);
  });
});

describe('cli entry point', () => {
  const graph = importGraph('cli/main.ts');

  it('builds on the core rather than duplicating it', () => {
    expect(graph.files).toContain('runtime/runtime.ts');
    expect(graph.files).toContain('errors/ferret-error.ts');
  });

  it('is the only layer that depends on commander', () => {
    expect(graph.packages.has('commander')).toBe(true);
  });

  it('adds no runtime dependency beyond commander, storage and the core set', () => {
    const external = [...graph.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual(
      ['commander', ...STORAGE_PACKAGES, ...ALLOWED_CORE_PACKAGES].sort(),
    );
  });
});

describe('storage provider boundary', () => {
  const core = importGraph('index.ts');
  const storage = importGraph('storage/index.ts');

  it('is not reachable from the core entry point', () => {
    // The whole point of the provider contract: the core gains a database by
    // being handed one, never by importing it. If this fails, `pg` and Drizzle
    // have leaked into every consumer of `@indoulia/ferret`.
    expect([...core.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
  });

  it('depends on the core rather than the reverse', () => {
    expect(storage.files).toContain('providers/contract.ts');
    expect(storage.files).toContain('errors/ferret-error.ts');
  });

  it('does not reach any CLI module', () => {
    expect([...storage.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('adds only its database packages on top of the core set', () => {
    const external = [...storage.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual([...STORAGE_PACKAGES, ...ALLOWED_CORE_PACKAGES].sort());
  });

  it('reaches PostgreSQL only through the selected driver and query layer', () => {
    // TECHNOLOGY-DECISIONS §3 selected `pg` + `drizzle-orm`. A second driver or
    // query builder appearing here is a technology decision, not a refactor.
    expect([...storage.packages].filter((name) => name.startsWith('drizzle')).sort()).toStrictEqual([
      'drizzle-orm',
      'drizzle-orm/node-postgres',
      'drizzle-orm/pg-core',
    ]);
  });

  it('does not ship drizzle-kit, which is a development tool', () => {
    // drizzle-kit generates migrations at development time. Reaching it from
    // runtime code would put a build tool into every installation.
    expect([...storage.packages].some((name) => name.startsWith('drizzle-kit'))).toBe(false);
  });
});

describe('canonical model boundary', () => {
  const domain = importGraph('domain/index.ts');

  it('is provider-neutral — it names no source system anywhere', () => {
    // EPIC-006's objective: the canonical model must not couple to GitHub, Jira,
    // files or any future source. A *pull request* is a canonical concept that
    // several systems map onto, and the mapping belongs to the provider. The
    // moment the model knows about a specific source, replacing that source
    // becomes a redesign rather than a provider swap.
    const sources = ['github', 'gitlab', 'bitbucket', 'jira', 'octokit', 'atlassian'];
    for (const file of domain.files) {
      const text = readFileSync(resolve(SRC, file), 'utf8').toLowerCase();
      for (const source of sources) {
        // Named in a comment as an example is fine; imported is not.
        expect([...domain.packages].some((name) => name.includes(source))).toBe(false);
        expect(text.includes(`from '${source}`)).toBe(false);
      }
    }
  });

  it('depends on nothing but the error model and zod', () => {
    const external = [...domain.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual(['zod']);
  });

  it('does not reach storage, the CLI, or any provider', () => {
    const forbidden = [...domain.files].filter(
      (file) => file.startsWith('storage/') || file.startsWith('cli/') || file.startsWith('providers/'),
    );
    expect(forbidden).toStrictEqual([]);
  });

  it('is reachable from the core entry point, because it is the core', () => {
    const core = importGraph('index.ts');
    expect(core.files).toContain('domain/entity.ts');
    expect(core.files).toContain('domain/identity.ts');
  });
});
