import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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
 * The package a specifier installs, rather than the specifier.
 *
 * `pdfjs-dist/legacy/build/pdf.mjs` is one dependency, not a fourth one — the
 * graph records what is written so a subpath policy stays visible, and this is
 * for the assertions that ask what would be *installed*. EPIC-026.
 */
function packageNames(graph: Graph): Set<string> {
  const names = new Set<string>();
  for (const specifier of graph.packages) {
    if (specifier.startsWith('node:')) continue;
    const parts = specifier.split('/');
    names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
  }
  return names;
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

/**
 * Packages the CLI loads **dynamically**, only for a run that asked for them.
 *
 * EPIC-108 §8.5, and this entry is the whole of that Epic's permitted amendment
 * to this file. It is a stated decision, not an allowlist widened to get a suite
 * green, so the reason is recorded here where the next reader will be standing.
 *
 * **What it permits:** `ferret index --content` composes Ferret's own code
 * parser through EPIC-013's `discoverProviders`, naming the package's own
 * published subpath. The specifier is written as a literal `import(...)` in
 * `cli/commands/parser-composition.ts` so that the package's `exports` map, a
 * bundler and this scanner all see the same edge — an edge only the runtime
 * knows about is one no review can check.
 *
 * **What it does not permit, and what still holds unchanged:**
 *
 * - `core.packages.has('web-tree-sitter')` is still false. EPIC-025 AC-12 is
 *   untouched, and the package root still installs no grammar runtime.
 * - `cli.packages.has('web-tree-sitter')` is still false. The 5.6 MB WASM
 *   runtime is loaded on demand, for the one flag that needs it, and never by
 *   `ferret status` or `ferret config`.
 * - `cli.files` still contains no `parsers/` module. The CLI's *static* graph
 *   names no parser, which is the assertion that would have caught a relative
 *   `import('../../parsers/index.js')` — the scanner treats a literal relative
 *   dynamic import exactly as it treats a static one, so that route was never
 *   an escape and is not one now.
 *
 * The rejected larger amendment, recorded so it is not re-proposed: letting the
 * CLI import `parsers/` statically. It works, and it puts a WebAssembly runtime
 * into the static graph of every `ferret` invocation to serve one optional flag.
 *
 * An entry here is meaningful on its face — the CLI may load Ferret's own parser
 * subpath at runtime — and adding a second one is a new architectural decision,
 * not a fix.
 */
const CLI_DYNAMIC_PACKAGES: readonly string[] = ['@indoulia/ferret/parsers'];

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
    // `configuration.ts` joined it with EPIC-015 on that same ground: it is how
    // the core resolves a provider's own settings, and it knows nothing about
    // what any provider's options mean. `lifecycle.ts` joined it with EPIC-014
    // on exactly that ground too: it is the state vocabulary and the recovery
    // budget the registry keeps *about* a provider, and it imports nothing but
    // `errors/`. `manifest.ts` joined it with EPIC-074 on the narrowest ground
    // of all: it reads a package's `package.json` and never imports a package,
    // so it is the one module here that exists precisely *not* to reach an
    // implementation.
    //
    // What the core still may not reach is an implementation.
    const concreteProviders = [...graph.files].filter((file) =>
      /^providers\/(?!contract\.ts|contracts\/|configuration\.ts|lifecycle\.ts|manifest\.ts|registry|capabilities|index|sdk\/|discovery\.ts)/.test(
        file,
      ),
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
    // `CLI_DYNAMIC_PACKAGES` is EPIC-108 §8.5's single approved amendment; see
    // the reason recorded at its declaration. Everything else in this set is
    // statically imported.
    const external = [...graph.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual(
      [
        'commander',
        ...STORAGE_PACKAGES,
        ...MCP_PACKAGES,
        ...ALLOWED_CORE_PACKAGES,
        ...CLI_DYNAMIC_PACKAGES,
      ].sort(),
    );
  });

  it('loads the parser subpath dynamically and names no parser module statically — AC-13', () => {
    // The amendment above is only safe while both halves hold. Asserted here
    // together, rather than trusting the two blocks that assert them apart,
    // because it is *this pair* that makes "the CLI may load the parser"
    // different from "the CLI ships the parser".
    expect(graph.packages.has('@indoulia/ferret/parsers')).toBe(true);
    expect(graph.packages.has('web-tree-sitter')).toBe(false);
    expect([...graph.files].filter((file) => file.startsWith('parsers/'))).toStrictEqual([]);
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

/**
 * EPIC-068's module boundary, and why it is a module of its own.
 *
 * Found by the test below on its first run: authorization was written into
 * `security/`, and `domain/memory-extraction.ts` imports that barrel — so
 * reading configuration and producing a retrieval context dragged `picomatch`
 * and `pino` into the graph EPIC-006 requires to depend on nothing but the error
 * model and zod.
 *
 * The split the failure forced is also the honest one. `security/` holds
 * *content* controls, which the model itself needs. This holds a *caller*
 * control, which only the surfaces a caller reaches need.
 */
describe('authorization boundary', () => {
  const authorization = importGraph('authorization/index.ts');

  it('is not reachable from the canonical model', () => {
    const model = importGraph('domain/index.ts');
    expect([...model.files].filter((file) => file.startsWith('authorization/'))).toStrictEqual([]);
  });

  it('reads configuration and produces a retrieval context, which is why it is separate', () => {
    expect(authorization.files).toContain('config/schema.ts');
    expect(authorization.files).toContain('retrieval/access.ts');
  });

  it('does not reach storage, the CLI, a provider or the MCP surface', () => {
    // A decision must be makeable without any of them. The MCP server depends on
    // authorization; the reverse would make the model untestable without a
    // transport and would invite a decision that varied by surface.
    const forbidden = [...authorization.files].filter(
      (file) =>
        file.startsWith('storage/') ||
        file.startsWith('cli/') ||
        file.startsWith('providers/') ||
        file.startsWith('mcp/'),
    );
    expect(forbidden).toStrictEqual([]);
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

describe('code parser boundary', () => {
  const core = importGraph('index.ts');
  const cli = importGraph('cli/main.ts');
  const parsers = importGraph('parsers/index.ts');

  it('is the only graph that carries a grammar runtime — AC-12', () => {
    // 5.6 MB of WASM and a WebAssembly runtime. `@indoulia/ferret` must be
    // importable without any of it, which is why EPIC-025 ships on its own
    // subpath rather than from the package root.
    expect(parsers.packages.has('web-tree-sitter')).toBe(true);
    expect(core.packages.has('web-tree-sitter')).toBe(false);
    expect(cli.packages.has('web-tree-sitter')).toBe(false);
  });

  it('is not reachable from the core or the CLI', () => {
    expect([...core.files].filter((file) => file.startsWith('parsers/'))).toStrictEqual([]);
    expect([...cli.files].filter((file) => file.startsWith('parsers/'))).toStrictEqual([]);
  });

  it('builds on the contract and the SDK, not on storage', () => {
    expect(parsers.files).toContain('providers/contracts/parser.ts');
    expect(parsers.files).toContain('providers/sdk/base.ts');
    expect([...parsers.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...parsers.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('adds only the parser runtimes to the core dependency set', () => {
    // EPIC-026 widened this by one. `pdfjs-dist` is 33 MB installed and carries
    // a font engine and a decompressor; the point of the subpath is that
    // `@indoulia/ferret` needs none of it.
    expect([...packageNames(parsers)].sort()).toStrictEqual(
      [...ALLOWED_CORE_PACKAGES, 'csv-parse', 'mammoth', 'pdfjs-dist', 'web-tree-sitter'].sort(),
    );
  });

  it('is the only graph that carries a PDF engine — EPIC-026 AC-14', () => {
    expect(packageNames(parsers).has('pdfjs-dist')).toBe(true);
    expect(packageNames(core).has('pdfjs-dist')).toBe(false);
    expect(packageNames(cli).has('pdfjs-dist')).toBe(false);
  });

  it('never carries a spreadsheet library — EPIC-028 AC-15', () => {
    // TECHNOLOGY-DECISIONS §4 selected `exceljs` conditionally and made the
    // condition blocking on EPIC-028. The condition was settled by replacement:
    // the `.xlsx` reader is Ferret's own, over `node:zlib`. A future `npm
    // install exceljs` would fail here, which is where it should fail.
    for (const graph of [parsers, core, cli]) {
      expect(packageNames(graph).has('exceljs')).toBe(false);
      expect(packageNames(graph).has('xlsx')).toBe(false);
    }
    expect(packageNames(parsers).has('csv-parse')).toBe(true);
    expect(packageNames(core).has('csv-parse')).toBe(false);
  });

  it('is the only graph that carries an OOXML reader — EPIC-027 AC-13', () => {
    // `mammoth` brings a ZIP reader and an XML parser with it. The core is a
    // knowledge layer and needs neither.
    expect(packageNames(parsers).has('mammoth')).toBe(true);
    expect(packageNames(core).has('mammoth')).toBe(false);
    expect(packageNames(cli).has('mammoth')).toBe(false);
  });
});

describe('GitHub provider boundary — EPIC-021 AC-20', () => {
  const github = importGraph('github/index.ts');

  it('reaches neither storage nor the CLI', () => {
    // A source provider that could read the database would be a second write
    // path into it, and one that could reach the CLI would be composing itself.
    expect([...github.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...github.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('adds nothing to the core dependency set', () => {
    // The transport is the platform's `fetch`. A vendor SDK is the one thing
    // that would make this provider heavy, and EPIC-021 §4 declined it — so the
    // graph carries the core's three packages and not a fourth.
    expect([...packageNames(github)].sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('speaks the capability contract rather than a concrete provider', () => {
    expect(github.files).toContain('providers/contracts/source-project.ts');
    expect([...github.files].filter((file) => file.startsWith('git/'))).toStrictEqual([]);
  });
});

describe('Jira provider boundary — EPIC-071', () => {
  const jira = importGraph('jira/index.ts');
  const github = importGraph('github/index.ts');

  it('reaches neither storage, the CLI, nor the other provider', () => {
    // The last of those is the point of this Epic: a second implementation that
    // imported the first would be a subclass wearing a provider's clothes, and
    // would prove nothing about whether the contract generalises.
    expect([...jira.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...jira.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
    expect([...jira.files].filter((file) => file.startsWith('github/'))).toStrictEqual([]);
    expect([...github.files].filter((file) => file.startsWith('jira/'))).toStrictEqual([]);
  });

  it('adds nothing to the core dependency set', () => {
    expect([...packageNames(jira)].sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('speaks the same contract the GitHub provider does', () => {
    expect(jira.files).toContain('providers/contracts/source-project.ts');
    expect(github.files).toContain('providers/contracts/source-project.ts');
  });
});

describe('Confluence provider boundary — EPIC-123', () => {
  const confluence = importGraph('confluence/index.ts');
  const jira = importGraph('jira/index.ts');
  const core = importGraph('index.ts');

  it('reaches neither storage, the CLI, nor another provider', () => {
    expect([...confluence.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...confluence.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
    // The pointed one: Confluence and Jira share a *transport*, and sharing a
    // transport must not become one provider importing the other. If this
    // fails, `src/atlassian` stopped being a shared layer and became a
    // back door between two providers.
    expect([...confluence.files].filter((file) => file.startsWith('jira/'))).toStrictEqual([]);
    expect([...jira.files].filter((file) => file.startsWith('confluence/'))).toStrictEqual([]);
    expect([...confluence.files].filter((file) => file.startsWith('github/'))).toStrictEqual([]);
  });

  it('shares the Atlassian transport with Jira rather than copying it', () => {
    // Both reach it, which is the whole reason it exists: one place to fix a
    // backoff, one place a credential is assembled.
    expect(confluence.files).toContain('atlassian/client.ts');
    expect(jira.files).toContain('atlassian/client.ts');
  });

  it('is not reachable from the core entry point', () => {
    // EPIC-017's rule, which is not about Git: the core asks the registry for a
    // capability and is handed whichever provider offers it. A core that knows
    // Confluence exists cannot have that provider replaced.
    expect([...core.files].filter((file) => file.startsWith('confluence/'))).toStrictEqual([]);
    expect([...core.files].filter((file) => file.startsWith('atlassian/'))).toStrictEqual([]);
  });

  it('adds nothing to the core dependency set', () => {
    expect([...packageNames(confluence)].sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it('implements the universal connector contract, not a source-shaped one', () => {
    // The claim EPIC-119 made and could not test: a source that is neither a
    // checkout nor a tracker reaches storage through the connector contract.
    expect(confluence.files).toContain('providers/contracts/source-connector.ts');
    expect(confluence.files).not.toContain('providers/contracts/source-project.ts');
    expect(confluence.files).not.toContain('providers/contracts/source-repository.ts');
  });
});

describe('event ingestion boundary — EPIC-077', () => {
  const events = importGraph('events/index.ts');
  const core = importGraph('index.ts');

  it('hosts no server and reaches no provider', () => {
    // Ferret verifies and normalizes; terminating an HTTP request is the
    // host's. A framework here would be the largest dependency in the tree, for
    // the part of the problem Ferret is least suited to own.
    expect([...events.files].filter((file) => file.startsWith('github/'))).toStrictEqual([]);
    expect([...events.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...events.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('adds no package at all', () => {
    // `node:crypto` and `node:fs`. Everything a webhook needs is in the
    // platform, and a signature verifier is the last place to take a
    // dependency.
    expect([...packageNames(events)]).toStrictEqual([]);
  });

  it('is reachable from the core, because a host needs it', () => {
    expect([...core.files].filter((file) => file.startsWith('events/')).length).toBeGreaterThan(0);
  });
});

describe('resolution boundary — EPIC-051', () => {
  const resolution = importGraph('resolution/index.ts');

  it('carries identity logic and reaches no provider', () => {
    // This gate is why `normalizeRemote` moved out of `src/git/`. Importing it
    // from there put a subprocess runner's module into the core graph, and the
    // objection is real rather than technical: `src/project/` depends on this
    // module, and the core barrel depends on that.
    expect(resolution.files).toContain('identity/remote.ts');
    expect([...resolution.files].filter((file) => file.startsWith('git/'))).toStrictEqual([]);
    expect([...resolution.files].filter((file) => file.startsWith('github/'))).toStrictEqual([]);
    expect([...resolution.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...resolution.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('adds no package beyond the core set', () => {
    for (const name of packageNames(resolution)) {
      expect(ALLOWED_CORE_PACKAGES.has(name), name).toBe(true);
    }
  });
});

describe('project modelling boundary — EPIC-072 AC-17', () => {
  const project = importGraph('project/index.ts');

  it('imports no provider, no storage and no CLI', () => {
    // The whole argument for this module is that it is a pure function from
    // records to canonical records. An import of a provider would make it the
    // GitHub modeller rather than the project modeller, and EPIC-071 would have
    // to write a second one.
    expect([...project.files].filter((file) => file.startsWith('github/'))).toStrictEqual([]);
    expect([...project.files].filter((file) => file.startsWith('git/'))).toStrictEqual([]);
    expect([...project.files].filter((file) => file.startsWith('storage/'))).toStrictEqual([]);
    expect([...project.files].filter((file) => file.startsWith('cli/'))).toStrictEqual([]);
  });

  it('builds on the contract, the domain and the emitter', () => {
    expect(project.files).toContain('providers/contracts/source-project.ts');
    expect(project.files).toContain('providers/sdk/emit.ts');
    expect(project.files).toContain('identity/index.ts');
  });
});

describe('developer identity boundary', () => {
  const identity = importGraph('identity/index.ts');

  it('opens nothing and stores nothing', () => {
    // EPIC-036 is handed names, addresses and a `.mailmap` as *text*. A
    // filesystem or process import here would make classification depend on a
    // checkout, and a storage one on a database; it depends on neither.
    // `node:crypto` is reachable and fine — the canonical model hashes ids
    // with it — so the assertion names what must be absent rather than
    // demanding a graph with no built-ins at all.
    const reaching = [...identity.packages].filter((name) =>
      ['node:fs', 'node:fs/promises', 'node:path', 'node:child_process', 'node:net'].includes(name),
    );
    expect(reaching).toStrictEqual([]);
    const forbidden = [...identity.files].filter(
      (file) => file.startsWith('storage/') || file.startsWith('git/') || file.startsWith('cli/'),
    );
    expect(forbidden).toStrictEqual([]);
  });

  it('builds on the actor model, which is where the two identity classes live', () => {
    expect(identity.files).toContain('domain/actor.ts');
  });

  it('exports nothing that merges', () => {
    // The one thing that merges is EPIC-009's IdentityStore, which requires
    // evidence. This module produces that evidence and must not grow a
    // shortcut around it.
    const source = readFileSync(resolve(SRC, 'identity/index.ts'), 'utf8');
    const exported = [...source.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*),$/gm)].map((m) => m[1]);
    expect(exported.filter((name) => name?.toLowerCase().includes('merge'))).toStrictEqual([]);
    expect(exported.length).toBeGreaterThan(5);
  });
});

describe('code intelligence boundary', () => {
  const code = importGraph('code/index.ts');

  it('speaks the parser contract, never a parser', () => {
    // EPIC-033 exists so a grammar upgrade cannot change what a consumer
    // switches on. An import of a parser here would defeat that entirely.
    expect([...code.files].filter((file) => file.startsWith('parsers/'))).toStrictEqual([]);
    expect(code.packages.has('web-tree-sitter')).toBe(false);
  });

  it('derives identity the way the canonical model does', () => {
    // A second identity scheme is how two halves of one graph stop agreeing
    // about what a thing is.
    expect(code.files).toContain('domain/identity.ts');
  });

  it('does not reach storage, the CLI or a provider implementation', () => {
    const forbidden = [...code.files].filter(
      (file) => file.startsWith('storage/') || file.startsWith('cli/') || file.startsWith('git/'),
    );
    expect(forbidden).toStrictEqual([]);
  });

  it('adds no runtime dependency beyond the core set', () => {
    // A subset rather than an exact match: this graph reaches less of the core
    // than the entry point does, and asserting the full set would make the test
    // fail when the module got *smaller*.
    const external = [...code.packages].filter((name) => !name.startsWith('node:'));
    expect(external.filter((name) => !ALLOWED_CORE_PACKAGES.has(name))).toStrictEqual([]);
  });
});

describe('file intelligence boundary', () => {
  const files = importGraph('files/index.ts');

  it('derives from bytes it is given, and opens nothing', () => {
    // EPIC-030 describes a file; it never reads one. A filesystem import here
    // would make classification depend on a checkout existing, which is exactly
    // what EPIC-022 avoided by reading trees rather than walking directories.
    expect([...files.packages].filter((name) => name.startsWith('node:'))).toStrictEqual([]);
  });

  it('reuses EPIC-024 detection rather than repeating it', () => {
    // A file that is text to one module and binary to the other is the bug this
    // import prevents.
    expect(files.files).toContain('parsing/detect.ts');
  });

  it('does not reach a provider, storage or the CLI', () => {
    const forbidden = [...files.files].filter(
      (file) => file.startsWith('git/') || file.startsWith('storage/') || file.startsWith('cli/'),
    );
    expect(forbidden).toStrictEqual([]);
  });
});

describe('parser framework boundary', () => {
  const parsing = importGraph('parsing/index.ts');

  it('builds on the parser contract, never on a parser', () => {
    // EPIC-024 is selection, bounds, isolation and redaction. The moment it
    // names a format it stops being a framework and becomes that format's
    // loader — and the next four Epics each add a format.
    expect(parsing.files).toContain('providers/contracts/parser.ts');
    expect([...parsing.files].filter((file) => /^parsing\/parsers\//.test(file))).toStrictEqual([]);
  });

  it('reaches the secret detector, because redaction is enforced here', () => {
    // §8 of the Epic: a parser is not trusted to redact, and a parser added
    // later cannot forget. Losing this import would silently move the
    // responsibility back to every parser author.
    expect(parsing.files).toContain('security/secrets.ts');
  });

  it('adds no runtime dependency beyond the core set', () => {
    // Detection is a byte sniff and a table; parsing is dispatch. Neither needs
    // a library. A package appearing here beyond what the core already carries
    // means someone reached for a format parser inside the framework, which is
    // exactly the boundary this Epic draws.
    const external = [...parsing.packages].filter((name) => !name.startsWith('node:'));
    expect(external.sort()).toStrictEqual([...ALLOWED_CORE_PACKAGES].sort());
  });

  it.each(FORBIDDEN_IN_CORE)('does not import anything matching %s', (fragment) => {
    expect([...parsing.packages].filter((name) => name.toLowerCase().includes(fragment))).toStrictEqual([]);
  });

  it('does not reach storage or the CLI', () => {
    const forbidden = [...parsing.files].filter(
      (file) => file.startsWith('storage/') || file.startsWith('cli/'),
    );
    expect(forbidden).toStrictEqual([]);
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

  it('keeps the conformance suite out of the core entry point', () => {
    // EPIC-016 ships beside the doubles, on the same subpath and for the same
    // reason: it exists to *run* provider code, which is a development act.
    expect(core.files.has('providers/sdk/conformance.ts')).toBe(false);
    expect(sdk.files.has('providers/sdk/conformance.ts')).toBe(false);
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

describe('content never reaches a control path — EPIC-084 AC-6', () => {
  /**
   * Modules that read repository content and could, in principle, act on it.
   *
   * EPIC-108 §11 asserts that "content never selects code": a media type chooses
   * among registered parsers, a grammar is loaded by language name, and nothing
   * derived from repository content becomes a module specifier or a path. That
   * was a claim in a document. This makes it a test.
   */
  const CONTENT_HANDLING = [
    'indexing/content.ts',
    'parsing/framework.ts',
    'parsing/detect.ts',
    'files/structure.ts',
    'code/symbols.ts',
    'context/pack.ts',
    'security/containment.ts',
  ];

  /** Modules that can reach outside the process. */
  const CONTROL_MODULES = [
    'node:fs',
    'node:fs/promises',
    'node:path',
    'node:child_process',
    'node:net',
    'node:http',
    'node:https',
    'node:worker_threads',
  ];

  it.each(CONTENT_HANDLING)('%s imports nothing that reaches outside the process', (file) => {
    // The module's **own** import list, not its transitive graph. A direct
    // import is what this file could actually call; anything further away is
    // reachable only through code that is not this file's to run.
    const source = stripComments(readFileSync(resolve(SRC, file), 'utf8'));
    const specifiers = [...source.matchAll(SPECIFIER)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined);

    expect(specifiers.filter((specifier) => CONTROL_MODULES.includes(specifier))).toStrictEqual([]);
  });

  it.each(CONTENT_HANDLING)('%s loads no module chosen at runtime', (file) => {
    // EPIC-108 §11: nothing derived from repository content becomes a module
    // specifier. A dynamic import in a module that handles content is the one
    // construct that could make that false, so its absence is asserted rather
    // than argued. `import(` with a literal is caught here too — the point is
    // that content-handling code loads nothing at all.
    const source = stripComments(readFileSync(resolve(SRC, file), 'utf8'));
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  /**
   * Deliberately *not* asserted: that these modules cannot transitively reach
   * `node:fs` or `node:child_process`.
   *
   * They can, and the reachability is meaningless. `indexing/content.ts` imports
   * the providers barrel for four types; the barrel reaches `providers/contract.ts`,
   * which reaches `environment/detect.ts`, which runs a subprocess to describe
   * the machine. Nothing about that lets repository content reach a subprocess —
   * the chain is type-level and composition-level, and the scanner cannot see
   * that `import type` is erased.
   *
   * An assertion that fails for a reason unrelated to the property it names
   * teaches people to widen it. So the property is asserted where it is real:
   * above, on what these modules actually *call*, and below, on the layers they
   * may not reach at all.
   */
  it('keeps the content-handling graph free of raw SQL', () => {
    // Symbol names, signatures and documentation are untrusted text. EPIC-034
    // binds every value as a parameter and escapes LIKE metacharacters; nothing
    // that handles content may assemble a query at all.
    for (const file of CONTENT_HANDLING) {
      const graph = importGraph(file);
      expect([...graph.files].filter((f) => f.startsWith('storage/'))).toStrictEqual([]);
      expect([...graph.packages].filter((name) => name.startsWith('drizzle'))).toStrictEqual([]);
    }
  });
});

/**
 * Every child process starts with a scrubbed environment — EPIC-081 AC-9.
 *
 * Structural rather than by review, because the failure it catches is an
 * omission and an omission is invisible in a diff. `detectGit` passed no `env`
 * at all and inherited `FERRET_DATABASE_PASSWORD` into `git --version`; it had
 * been that way since EPIC-001, through every review of every Epic that touched
 * the file, because nothing was looking.
 *
 * Two assertions, and both are needed. The first bounds *who* may start a child
 * at all, so a third spawner has to be added here deliberately. The second
 * requires each of them to import the scrub, which the import graph can see.
 * Neither proves the scrub is applied at the call site — `tests/unit/credential-
 * isolation.test.ts` does that behaviourally — and the division is deliberate:
 * a structural test that tried to read call sites would be a parser, and a
 * fragile one.
 */
describe('subprocess environment boundary', () => {
  /**
   * The only modules permitted to start a child process.
   *
   * `git/runner.ts` is Ferret's single point for executing `git`;
   * `environment/detect.ts` asks the machine what `git` it has. Adding a third
   * means adding it here, which is the point.
   */
  const SPAWNERS = ['environment/detect.ts', 'git/runner.ts'];

  /** Every `.ts` under `src/`, walked directly — reachability is not the question. */
  function sourceFiles(directory: string = SRC): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts')) found.push(relative(SRC, full).split(sep).join('/'));
    }
    return found;
  }

  function imports(file: string): string[] {
    const source = stripComments(readFileSync(resolve(SRC, file), 'utf8'));
    return [...source.matchAll(SPECIFIER)]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined && MODULE_SPECIFIER.test(specifier));
  }

  it('starts a child process from two modules and no others', () => {
    const spawners = sourceFiles().filter((file) => imports(file).includes('node:child_process'));

    expect(spawners.sort()).toStrictEqual(SPAWNERS);
  });

  it('gives every spawner the credential scrub — AC-9', () => {
    for (const file of SPAWNERS) {
      const graph = importGraph(file);

      expect([...graph.files], file).toContain('security/credentials.ts');
    }
  });
});
