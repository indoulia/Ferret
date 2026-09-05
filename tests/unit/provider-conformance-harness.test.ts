import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createGitSourceProvider } from '../../src/git/index.js';
import { createGithubProvider } from '../../src/github/index.js';
import { createJiraProvider } from '../../src/jira/index.js';
import { createConfluenceProvider } from '../../src/confluence/index.js';
import {
  createCodeParserProvider,
  createDocxParserProvider,
  createPdfParserProvider,
  createSheetParserProvider,
  createTextParserProvider,
} from '../../src/parsers/index.js';
import { runProviderConformance, summarizeConformance } from '../../src/providers/sdk/testing.js';
import { BaseProvider } from '../../src/providers/sdk/base.js';
import { PROVIDER_CONTRACT_VERSION, ProviderKind } from '../../src/providers/index.js';

/**
 * EPIC-099 — the suite runs over *every* provider, and a provider nothing runs
 * it against is a failing build.
 *
 * EPIC-016 built the suite and applied it to Ferret's own providers, correctly
 * — by hand, three times, in three files. Nothing enumerated the set, so a
 * fourth provider would be conformant only if somebody remembered to write a
 * fourth test. That is the shape of every defect EPIC-100 was written for.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

/**
 * Providers checked somewhere other than this file, named with where.
 *
 * The bounded escape hatch §8 describes. The storage provider needs a real
 * PostgreSQL and the harness must not require one to run at all — but "checked
 * in the integration suite" and "nobody checks this" have to look different,
 * so a declaration names the covering file and the gate below asserts that file
 * actually mentions the provider.
 */
const COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  'storage/provider.ts': 'tests/integration/providers/conformance.test.ts',
};

function sourceFiles(directory: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full.slice(SRC.length + 1).split(sep).join('/'));
  }
  return found;
}

/**
 * Every module in `src/` that implements the provider contract.
 *
 * A provider declares a `kind` from `ProviderKind`. The SDK base class and the
 * contract itself mention it without being providers, and both are excluded by
 * name — a short, visible list, unlike the set it is protecting.
 */
function providerModules(): string[] {
  const scaffolding = new Set(['providers/contract.ts', 'providers/sdk/base.ts']);
  return sourceFiles().filter((file) => {
    if (scaffolding.has(file)) return false;
    const source = readFileSync(resolve(SRC, file), 'utf8');
    return /readonly kind(?::\s*ProviderKind)?\s*=\s*ProviderKind\./.test(source);
  });
}

/**
 * Whether a module declares the provider that reported this id.
 *
 * Matched on the id the provider *returned* from a real run, against the
 * constant or literal the module declares. Comparing file names to ids would
 * pass on a coincidence of naming; this fails when a provider is renamed
 * without its coverage following.
 */
function declaresId(file: string, id: string): boolean {
  const source = readFileSync(resolve(SRC, file), 'utf8');
  if (source.includes(`'${id}'`)) return true;

  // Declared through a constant — resolve it in the same module.
  //
  // Whitespace is normalised rather than matched with a pattern: a `\s` inside
  // a template literal is the letter `s`, which silently turned this fallback
  // into a regex that could never match. It passed anyway, because the literal
  // branch above covers both providers that exist — a broken fallback in a gate
  // is exactly the quiet hole this file was written to close.
  const constant = /readonly id = ([A-Z][A-Z0-9_]*)/.exec(source)?.[1];
  if (constant === undefined) return false;
  return source.replace(/\s+/g, ' ').includes(`${constant} = '${id}'`);
}

/** Providers cheap enough to construct here. The rest are declared above. */
const RUNNABLE = [
  { name: 'ferret.source.git', create: () => createGitSourceProvider() },
  { name: 'ferret.parser.code', create: () => createCodeParserProvider() },
  // EPIC-029. The gate above is what made this line necessary rather than
  // optional: a new provider cannot reach `main` without facing the conformance
  // suite or declaring where it is covered.
  { name: 'ferret.parser.text', create: () => createTextParserProvider() },
  // EPIC-026, and the gate worked a second time.
  { name: 'ferret.parser.pdf', create: () => createPdfParserProvider() },
  { name: 'ferret.parser.docx', create: () => createDocxParserProvider() },
  { name: 'ferret.parser.sheet', create: () => createSheetParserProvider() },
  // EPIC-021. Constructed with a transport that answers nothing: the
  // conformance suite exercises the contract, not the network, and a provider
  // that reached out during it would make this gate depend on GitHub being up.
  {
    name: 'ferret.source.github',
    create: () =>
      createGithubProvider({
        fetch: () =>
          Promise.resolve({
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve('[]'),
          }),
      }),
  },
  // EPIC-071, on the same terms: the conformance suite exercises the contract,
  // not the network.
  {
    name: 'ferret.source.jira',
    create: () =>
      createJiraProvider({
        baseUrl: 'https://example.atlassian.net',
        fetch: () =>
          Promise.resolve({
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve('{}'),
          }),
      }),
  },
  // EPIC-123, and the gate worked again — this line exists because the suite
  // refused the Confluence provider before it had one. The first provider to
  // declare `source.connector`, held to the same provider contract as the rest.
  {
    name: 'ferret.source.confluence',
    create: () =>
      createConfluenceProvider({
        baseUrl: 'https://example.atlassian.net',
        fetch: () =>
          Promise.resolve({
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve('{}'),
          }),
      }),
  },
];

describe('every provider is covered — AC-1, AC-2', () => {
  it('finds the provider implementations at all', () => {
    // Failing closed. A scanner that found nothing would turn the gate below
    // into a no-op that still reports green — the failure mode this whole
    // pattern exists to avoid.
    const modules = providerModules();

    expect(modules.length).toBeGreaterThanOrEqual(3);
    process.stderr.write(`[EPIC-099] provider implementations: ${modules.join(', ')}\n`);
  });

  it('runs or declares every one of them', async () => {
    const modules = providerModules();
    const aggregate = await runProviderConformance(RUNNABLE);
    // The ids the providers *reported*, not the names this file gave them: a
    // provider that renamed itself must show up under its real id or not at all.
    const ran = new Set(aggregate.reports.map((report) => report.providerId));

    for (const file of modules) {
      if (COVERED_ELSEWHERE[file] !== undefined) continue;

      expect(
        [...ran].some((id) => declaresId(file, id)),
        `${file} implements a provider that nothing runs the conformance suite against. ` +
          'Add it to RUNNABLE, or declare where it is covered in COVERED_ELSEWHERE.',
      ).toBe(true);
    }
  }, 60_000);

  it('proves each declaration actually covers what it claims', () => {
    // The escape hatch, bounded. A declaration that named a file which does not
    // mention the provider would be an opt-out wearing the appearance of
    // coverage.
    const root = resolve(SRC, '..');
    for (const [file, covering] of Object.entries(COVERED_ELSEWHERE)) {
      const source = readFileSync(resolve(root, covering), 'utf8');
      const providerName = file.split('/')[0] ?? '';

      expect(source.toLowerCase(), `${covering} does not appear to cover ${file}`).toContain(providerName);
      expect(source, `${covering} does not run the conformance suite`).toContain('runConformance');
    }
  });
});

describe('the aggregate — AC-3, AC-4, AC-5, AC-6', () => {
  it('returns one report per provider, in EPIC-016s shape', async () => {
    const aggregate = await runProviderConformance(RUNNABLE);

    expect(aggregate.providers).toBe(RUNNABLE.length);
    expect(aggregate.reports).toHaveLength(RUNNABLE.length);
    for (const report of aggregate.reports) {
      // Unchanged shape: a check id means the same thing here as in the suite
      // that produced it.
      expect(report).toHaveProperty('checks');
      expect(report).toHaveProperty('conformant');
      expect(report.passed + report.failed + report.skipped).toBe(report.checks.length);
    }
  }, 60_000);

  it('is conformant when every provider is, and says what it covered', async () => {
    const aggregate = await runProviderConformance(RUNNABLE);
    const summary = summarizeConformance(aggregate);
    process.stderr.write(`[EPIC-099]\n${summary}\n`);

    expect(aggregate.failures, summary).toStrictEqual([]);
    expect(aggregate.conformant).toBe(true);
    expect(summary).toContain('ferret.source.git');
  }, 60_000);

  it('names every failing check when a provider is not conformant — AC-5', async () => {
    class Broken extends BaseProvider {
      readonly id = 'not a valid id';
      readonly kind = ProviderKind.SOURCE;
      readonly capabilities = [];
      override readonly contractVersion = PROVIDER_CONTRACT_VERSION;
    }

    const aggregate = await runProviderConformance([{ name: 'broken', create: () => new Broken() }]);

    expect(aggregate.conformant).toBe(false);
    expect(aggregate.failures.length).toBeGreaterThan(0);
    expect(aggregate.failures.every((entry) => entry.includes(': '))).toBe(true);
  }, 60_000);

  it('treats a provider that cannot be constructed as a failure, not an exception', async () => {
    // "Cannot be constructed" is the most basic way to fail the contract, and a
    // harness that propagated it would report nothing about the providers after
    // it in the list.
    const aggregate = await runProviderConformance([
      {
        name: 'explodes',
        create: () => {
          throw new Error('no');
        },
      },
      ...RUNNABLE,
    ]);

    expect(aggregate.conformant).toBe(false);
    expect(aggregate.providers).toBe(RUNNABLE.length + 1);
    // The rest still ran, which is the property.
    expect(aggregate.reports.filter((report) => report.conformant)).toHaveLength(RUNNABLE.length);
  }, 60_000);
});
