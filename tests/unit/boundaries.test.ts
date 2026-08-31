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
/**
 * Packages the MCP surface adds on top of the core set.
 *
 * EPIC-064 serves the AI control plane, and TECHNOLOGY-DECISIONS §4 selected the
 * official SDK rather than hand-rolling the protocol. Reachable from the CLI,
 * which composes it, and from `@indoulia/ferret/mcp` — never from the core,
 * which the "mcp boundary" block below asserts separately.
 */
const MCP_PACKAGES: readonly string[] = [
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
];

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
    //
    // `capabilities.ts` joined the allowlist with EPIC-011: it is the capability
    // *contract*, which is core by definition — the core has to be able to ask
    // for a capability. `sdk/` joined it with EPIC-012 for the same reason: it
    // is machinery built *on* the contract, and depends on no implementation.
    // `contracts/` joined it with EPIC-017, which pinned the first capability's
    // method signatures; each is a contract, and each has its own boundary block
    // below. `discovery.ts` joined it with EPIC-013 on the same ground as
    // `sdk/`: it is machinery over the contract and the registry, it imports no
    // concrete provider, and the Epic requires the package to export it.
    //
    // What the core still may not reach is an implementation.
    const concreteProviders = [...graph.files].filter((file) =>
      /^providers\/(?!contract\.ts|contracts\/|registry|capabilities|index|sdk\/|discovery\.ts)/.test(file),
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

  it('adds no runtime dependency beyond commander, storage, MCP and the core set', () => {
    const external = [...graph.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual(
      ['commander', ...STORAGE_PACKAGES, ...MCP_PACKAGES, ...ALLOWED_CORE_PACKAGES].sort(),
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

describe('capability boundary', () => {
  const core = importGraph('index.ts');

  it('does not reach a concrete provider from the core entry point', () => {
    // EPIC-011's central rule: the core asks for a *capability* and is handed
    // whichever provider offers it. `PostgresStorageProvider` is a concrete
    // provider, and the moment the core names one, "replacing a provider does
    // not require unrelated core changes" stops being true.
    expect([...core.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
  });

  it('publishes the capability contract from the core, because it is core', () => {
    // The contract belongs to the core; the implementations do not.
    expect(core.files).toContain('providers/capabilities.ts');
    expect(core.files).toContain('providers/registry.ts');
  });

  it('keeps the capability contract free of any provider implementation', () => {
    const capabilities = importGraph('providers/capabilities.ts');
    expect([...capabilities.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    const external = [...capabilities.packages].filter((name) => !name.startsWith('node:'));
    expect(external).toStrictEqual([]);
  });

  it('lets a provider depend on the contract, never the contract on a provider', () => {
    const storage = importGraph('storage/index.ts');
    expect(storage.files).toContain('providers/capabilities.ts');

    const capabilities = importGraph('providers/capabilities.ts');
    expect(capabilities.files).not.toContain('storage/provider.ts');
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

describe('provider SDK boundary', () => {
  const core = importGraph('index.ts');
  const sdk = importGraph('providers/sdk/index.ts');

  it('builds on the contract and the canonical model, never on an implementation', () => {
    expect(sdk.files).toContain('providers/contract.ts');
    expect(sdk.files).toContain('domain/evidence.ts');
    // The SDK exists so that providers do not each reinvent lifecycle, retry and
    // emission. The moment it names one of them, it stops being shared
    // machinery and becomes that provider's private helper library.
    expect([...sdk.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
  });

  it('adds no runtime dependency beyond the core set', () => {
    // Governance §5 records the reuse decision (EPIC-012 §15): the SDK builds on
    // Node 22's abort and timer primitives rather than adopting a retry package.
    // A new package appearing here means that decision was reversed without
    // anyone saying so — which is the failure this assertion exists to catch,
    // since a retry library is exactly the thing someone reaches for later.
    const external = [...sdk.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('keeps its test doubles out of the core entry point', () => {
    // `testing.ts` ships under `@indoulia/ferret/testing` so an out-of-tree
    // provider author can use it. Reaching it from the package root would put a
    // stub provider and a capturing logger into every production bundle.
    expect(core.files.has('providers/sdk/testing.ts')).toBe(false);
    expect(sdk.files.has('providers/sdk/testing.ts')).toBe(false);
  });

  it('does not reach any CLI module', () => {
    expect([...sdk.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });
});

describe('git source provider boundary', () => {
  const core = importGraph('index.ts');
  const git = importGraph('git/index.ts');

  it('is not reachable from the core entry point', () => {
    // EPIC-017's central rule, and the first real test of EPIC-011's claim. The
    // core asks the registry for `source.repository` and is handed whichever
    // provider offers it. If this fails, the core knows Git exists, and
    // "replacing a provider does not require unrelated core changes" is false.
    expect([...core.files].filter((file) => file.startsWith('git/'))).toStrictEqual([]);
  });

  it('publishes the capability contract from the core, because it is a contract', () => {
    expect(core.files).toContain('providers/contracts/source-repository.ts');
    // The contract must not reach the implementation, or importing the contract
    // would drag Git in behind it.
    const contract = importGraph('providers/contracts/source-repository.ts');
    expect([...contract.files].filter((file) => file.startsWith('git/'))).toStrictEqual([]);
  });

  it('builds on the contract and the SDK', () => {
    expect(git.files).toContain('providers/contracts/source-repository.ts');
    expect(git.files).toContain('providers/sdk/base.ts');
    expect(git.files).toContain('providers/sdk/emit.ts');
  });

  it('adds no runtime dependency of its own', () => {
    // TECHNOLOGY-DECISIONS §5 selected the Git *executable* via subprocess. A
    // package appearing here means an in-process Git implementation was adopted
    // without that decision being revisited.
    const external = [...git.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('does not reach the storage provider or the CLI', () => {
    // Two providers must not know about each other, or replacing one would
    // require changing the other.
    expect([...git.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...git.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('can start a subprocess from exactly two modules, both named', () => {
    // Governance §12: no unsafe subprocess primitive that later Epics inherit.
    // Four Git Epics follow this one, and each of them will reach for whatever
    // is here. Keeping execution in one reviewed place is what makes the safety
    // overrides unavoidable rather than conventional.
    //
    // `environment/detect.ts` is named deliberately rather than excluded by a
    // pattern: it has run `git --version` since EPIC-001, with the same
    // argument-vector discipline, and it is reachable from here because the
    // provider contract carries an environment report. Listing it means adding
    // a third executor is a visible decision.
    expect(executorsIn(git.files)).toStrictEqual(['environment/detect.ts', 'git/runner.ts']);
  });

  it('never runs a subprocess through a shell', () => {
    const source = readFileSync(resolve(SRC, 'git/runner.ts'), 'utf8');
    // `exec` and `execSync` take a command *string* and run it through a shell.
    // A directory named `foo; rm -rf ~` is then a command.
    expect(/\bexecSync\s*\(/.test(source)).toBe(false);
    expect(/[^A-Za-z]exec\s*\(/.test(stripComments(source))).toBe(false);
    expect(source).toContain('shell: false');
  });
});

/**
 * Modules in a graph that can start a subprocess.
 *
 * Detected by the **import**, not by call syntax. The first version of this
 * matched `execFile(` and friends, and missed `environment/detect.ts` entirely
 * because it calls a promisified alias — a control that quietly finds nothing is
 * worse than no control, since it reports success either way. Nothing can launch
 * a process without reaching `node:child_process`, so that is what is counted.
 */
function executorsIn(files: ReadonlySet<string>): string[] {
  return [...files]
    .filter((file) => /['"]node:child_process['"]/.test(stripComments(readFileSync(resolve(SRC, file), 'utf8'))))
    .sort();
}

describe('mcp boundary', () => {
  const core = importGraph('index.ts');
  const mcp = importGraph('mcp/index.ts');

  it('is not reachable from the core entry point', () => {
    // The AI control plane is a *surface*, not the product. A consumer of
    // `@indoulia/ferret` that never speaks MCP must not install its SDK, and a
    // library that pulls a protocol server into every import is one nobody
    // embeds.
    expect([...core.files].filter((file) => file.startsWith('mcp/'))).toStrictEqual([]);
    expect([...core.packages].some((name) => name.includes('modelcontextprotocol'))).toBe(false);
  });

  it('builds on retrieval and context, not on storage', () => {
    // The tools answer through `RetrievalPort`, so the MCP surface has no idea
    // PostgreSQL exists — which is what makes it testable without one.
    expect(mcp.files).toContain('retrieval/query.ts');
    expect(mcp.files).toContain('context/pack.ts');
    expect([...mcp.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
  });

  it('adds nothing beyond the MCP SDK and the core set', () => {
    // A subset assertion, not an equality one: the MCP surface reaches only
    // part of the core (it has no need of the exclusion matcher, for one), and
    // demanding it reach all of it would make an unrelated refactor fail here.
    // What must not happen is a *new* package appearing.
    const allowed = new Set<string>([...MCP_PACKAGES, ...ALLOWED_CORE_PACKAGES]);
    const unexpected = [...mcp.packages].filter(
      (name) => !name.startsWith('node:') && !allowed.has(name),
    );
    expect(unexpected).toStrictEqual([]);
    // …and the SDK is genuinely there, so this cannot pass by reaching nothing.
    expect([...mcp.packages].some((name) => name.includes('modelcontextprotocol'))).toBe(true);
  });
});
