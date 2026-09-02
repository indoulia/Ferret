import { describe, expect, it } from 'vitest';

import {
  Capability,
  CapabilitySupport,
  ProviderRegistry,
  createRuntime,
  isContentParser,
  ParserFramework,
  ParserSupport,
  ReferenceKind,
  type Provider,
} from '../../../src/index.js';
// `discoverProviders` ships from `@indoulia/ferret/providers`, not the package
// root, and is imported from where it is published rather than added to the
// root barrel to suit a test.
import { discoverProviders, type ProviderDiscoverySkip } from '../../../src/providers/index.js';
import {
  FERRET_PARSERS_MODULE,
  loadFerretParsers,
} from '../../../src/cli/commands/parser-composition.js';
import { createTestOperationContext } from '../../../src/providers/sdk/testing.js';

/**
 * EPIC-108 AC-13 — the positive half of the boundary decision.
 *
 * `boundaries.test.ts` proves the CLI's static graph carries no parser and no
 * grammar runtime. On its own that is satisfied just as well by a composition
 * that silently does nothing, which is the failure mode this file exists to
 * rule out: an assertion that passes by *invisibility* is weaker than one that
 * passes by *absence*.
 *
 * So this proves the other direction. The parser really is loaded, through
 * EPIC-013 discovery, from the package's own published subpath, and it is then
 * reached **by capability** rather than by name — which is what makes it a
 * composed provider rather than an import with extra steps.
 */

describe('composing the code parser through discovery', () => {
  it('loads Ferret\'s parser subpath and registers a provider', async () => {
    const registry = new ProviderRegistry();

    const result = await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);

    expect(result.skipped).toStrictEqual([]);
    expect(result.modules).toStrictEqual([FERRET_PARSERS_MODULE]);
    // Three, since EPIC-026: the code parser, the PDF parser and the text
    // parser. One module, and the framework picks per file — only the text
    // parser offers a fallback, so none can displace another, which is what
    // `ParserSupport` is for.
    expect(result.providers).toHaveLength(3);
    for (const id of result.providers) expect(registry.has(id)).toBe(true);
  });

  it('makes the parser capability selectable, by capability and not by name', async () => {
    // The property that distinguishes composition from an import. Nothing after
    // this line names the code parser; the registry is asked for `parser` and
    // hands back whatever offers it.
    const registry = new ProviderRegistry();
    await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);

    const verdict = registry.supports(Capability.PARSER);
    expect(verdict.support).toBe(CapabilitySupport.SUPPORTED);
    expect(verdict.declaredVersion).toBe(1);

    const provider: Provider | undefined = registry.forCapability(Capability.PARSER);
    expect(provider).toBeDefined();
    expect(isContentParser(provider)).toBe(true);
  });

  it('produces a framework that actually claims a TypeScript file', async () => {
    // Registration is not the same as usefulness. Without this, a provider that
    // registered and claimed nothing would satisfy every assertion above and
    // still leave content indexing doing no work at all.
    const registry = new ProviderRegistry();
    await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);

    const framework = new ParserFramework({ registry });
    const parser = framework.select({
      path: 'src/app.ts',
      mediaType: 'text/x-typescript',
      binary: false,
      sizeBytes: 42,
    });

    expect(parser).toBeDefined();
    expect(parser?.supports({
      path: 'src/app.ts',
      mediaType: 'text/x-typescript',
      binary: false,
      sizeBytes: 42,
    })).toBe(ParserSupport.NATIVE);
  });

  it('hands out a fresh provider each time, so two runtimes do not share one', async () => {
    // `BaseProvider` refuses to initialize again once it has been shut down, so
    // a module-level singleton would work for the first runtime in a process
    // and fail for the second. Invisible in a CLI with one run; immediate in a
    // suite with many.
    const first = await loadFerretParsers(FERRET_PARSERS_MODULE);
    const second = await loadFerretParsers(FERRET_PARSERS_MODULE);

    // A fresh instance per load, which is the property under test: two runtimes
    // must not share one provider, because `BaseProvider` refuses to initialize
    // again once it has been shut down.
    expect(first.providers).toHaveLength(3);
    expect(second.providers).toHaveLength(3);
    for (const [index, provider] of (first.providers ?? []).entries()) {
      expect(provider).not.toBe(second.providers?.[index]);
      expect(provider.id).toBe(second.providers?.[index]?.id);
    }
  });

  it('refuses any specifier but its own, rather than importing it', async () => {
    // EPIC-108 §11: the parser module specifier is fixed and internal. The
    // refusal is what makes that a property rather than a convention — nothing
    // derived from repository content can ever become a module specifier here.
    for (const hostile of ['evil-package', './relative', '@indoulia/ferret/storage', '']) {
      await expect(loadFerretParsers(hostile)).rejects.toMatchObject({
        code: 'E_PROVIDER_INVALID',
      });
    }
  });

  it('leaves the registry usable when the module cannot be loaded', async () => {
    // Discovery is additive and best-effort by design (EPIC-013): one bad
    // optional provider must not make already-registered capabilities vanish.
    // This is what lets `composeContent` fall back to a metadata-only run
    // instead of failing the index.
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['@indoulia/ferret/nonexistent'], loadFerretParsers);

    expect(result.providers).toStrictEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('unavailable');
    expect(registry.supports(Capability.PARSER).support).toBe(CapabilitySupport.UNAVAILABLE);
  });
});

describe('composing through a real runtime lifecycle', () => {
  it('registers the parser only when discovery runs before the runtime starts', async () => {
    // The regression. A registry refuses providers once the runtime has
    // initialized, so discovery inside `runtime.run` registers nothing, the
    // parser capability is never available, and content indexing reads no files
    // while reporting a successful run. Every assertion in this file above uses
    // a bare registry and would have passed with that defect in place; a
    // dogfooding run is what found it.
    const runtime = createRuntime({ providers: [] });

    await discoverProviders(runtime.providers, [FERRET_PARSERS_MODULE], loadFerretParsers);
    await runtime.run(() => {
      expect(runtime.providers.supports(Capability.PARSER).support).toBe(CapabilitySupport.SUPPORTED);
    });
  });

  it('refuses a parser discovered after the runtime has started', async () => {
    // Asserted rather than assumed, because it is the whole reason the order
    // above matters. Discovery is best-effort, so this surfaces as a skip
    // rather than a throw — which is precisely why the defect was silent.
    const runtime = createRuntime({ providers: [] });

    await runtime.run(async () => {
      const late = await discoverProviders(
        runtime.providers,
        [FERRET_PARSERS_MODULE],
        loadFerretParsers,
      );
      expect(late.providers).toStrictEqual([]);
      expect(late.skipped[0]?.detail).toContain('after the runtime has initialized');
      // Beside the prose assertion above, not instead of it. The prose is what a
      // person reads; the reason is what a caller branches on, and EPIC-013
      // AC-10 requires the second to exist so nobody has to do the first.
      expect(late.skipped[0]?.reason).toBe('lifecycle');
      expect(runtime.providers.supports(Capability.PARSER).support).toBe(
        CapabilitySupport.UNAVAILABLE,
      );
    });
  });

  it('reports a caller lifecycle error and a broken module as different reasons', async () => {
    // EPIC-013 AC-10, asserted as a *discrimination* rather than as a constant.
    // Both of these were `reason: 'invalid'` before this test existed, so the
    // only thing separating "you composed this at the wrong time" from "this
    // module is broken" was English text in `detail` — which is precisely what
    // AC-10 says a caller must never have to parse.
    //
    // It has to run through a real runtime, because a bare `ProviderRegistry`
    // cannot be sealed: `initializeAll` is the only thing that seals it. Every
    // fresh-registry test in this file passed throughout the defect's life.
    const runtime = createRuntime({ providers: [] });
    let lifecycle: ProviderDiscoverySkip | undefined;

    await runtime.run(async () => {
      const late = await discoverProviders(
        runtime.providers,
        [FERRET_PARSERS_MODULE],
        loadFerretParsers,
      );
      lifecycle = late.skipped[0];
    });

    // A well-formed module that exports something which is not a Provider. The
    // registry rejects it on its own merits, with a fresh registry, so nothing
    // about the lifecycle is involved.
    const broken = await discoverProviders(new ProviderRegistry(), ['broken-module'], () =>
      Promise.resolve({ provider: { id: 'broken.provider' } as unknown as Provider }),
    );
    const malformed = broken.skipped[0];

    expect(lifecycle?.reason).toBe('lifecycle');
    expect(malformed?.reason).toBe('invalid');
    expect(lifecycle?.reason).not.toBe(malformed?.reason);
  });
});

/**
 * EPIC-035 §8.1 — references, through the real grammars.
 *
 * The part that cannot be unit-tested: whether the node types and field names
 * `languages.ts` and `calleeOf` name are the ones tree-sitter actually produces.
 * A resolver with a perfect test suite over hand-built references proves nothing
 * if extraction finds none.
 */
describe('extracting references from real code', () => {
  const parse = async (path: string, mediaType: string, text: string) => {
    const registry = new ProviderRegistry();
    await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);
    const framework = new ParserFramework({ registry });
    const target = { path, mediaType, binary: false, sizeBytes: text.length };
    const parser = framework.select(target);
    expect(parser).toBeDefined();
    if (parser === undefined) throw new Error('no parser');
    return parser.parse(
      { target, text, bytes: new TextEncoder().encode(text) },
      createTestOperationContext(),
    );
  };

  it('finds a call and attributes it to the function it sits inside — AC-1, AC-7', async () => {
    const output = await parse(
      'src/billing/refund.ts',
      'text/x-typescript',
      [
        'export function applyTax(total: number): number {',
        '  return total * 1.2;',
        '}',
        '',
        'export function refundInvoice(total: number): number {',
        '  return applyTax(total);',
        '}',
        '',
      ].join('\n'),
    );

    const references = output.references ?? [];
    const call = references.find((one) => one.name === 'applyTax');

    expect(call).toBeDefined();
    expect(call?.kind).toBe(ReferenceKind.CALL);
    expect(call?.enclosing).toStrictEqual(['refundInvoice']);
    expect(call?.span.startLine).toBe(6);
  });

  it('finds a construction — AC-2', async () => {
    const output = await parse(
      'src/billing/invoice.ts',
      'text/x-typescript',
      ['class Invoice {}', '', 'function make(): Invoice {', '  return new Invoice();', '}', ''].join('\n'),
    );

    const construction = (output.references ?? []).find((one) => one.name === 'Invoice');
    expect(construction?.kind).toBe(ReferenceKind.CONSTRUCTION);
    expect(construction?.enclosing).toStrictEqual(['make']);
  });

  it('reports the last identifier of a member call, and says so by name — AC-1', async () => {
    // `a.save()` reports `save`. Name-based by construction: resolving it to the
    // right `save` needs the type of `a`, which no grammar carries.
    const output = await parse(
      'src/app.ts',
      'text/x-typescript',
      ['function run(store: Store): void {', '  store.save();', '}', ''].join('\n'),
    );

    expect((output.references ?? []).map((one) => one.name)).toContain('save');
  });

  it('attributes a top-level call to no declaration — AC-7', async () => {
    const output = await parse(
      'src/main.ts',
      'text/x-typescript',
      ['function boot(): void {}', '', 'boot();', ''].join('\n'),
    );

    const call = (output.references ?? []).find((one) => one.name === 'boot');
    expect(call?.enclosing).toStrictEqual([]);
  });

  it('finds a call nested inside a method — AC-7', async () => {
    const output = await parse(
      'src/billing/invoice.ts',
      'text/x-typescript',
      [
        'function applyTax(n: number): number { return n; }',
        '',
        'class Invoice {',
        '  total(): number {',
        '    return applyTax(1);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const call = (output.references ?? []).find((one) => one.name === 'applyTax');
    expect(call?.enclosing).toStrictEqual(['Invoice', 'total']);
  });

  it('finds the arguments of a call as references too', async () => {
    // `save(build(x))` — a call may contain another call, and falling through
    // after recording one is what finds the inner.
    const output = await parse(
      'src/app.ts',
      'text/x-typescript',
      ['function run(): void {', '  save(build(1));', '}', ''].join('\n'),
    );

    const names = (output.references ?? []).map((one) => one.name);
    expect(names).toContain('save');
    expect(names).toContain('build');
  });

  it('finds a Python call, where the grammar cannot tell a class from a function', async () => {
    const output = await parse(
      'module.py',
      'text/x-python',
      ['def apply_tax(total):', '    return total', '', 'def refund(total):', '    return apply_tax(total)', ''].join('\n'),
    );

    const call = (output.references ?? []).find((one) => one.name === 'apply_tax');
    expect(call?.kind).toBe(ReferenceKind.CALL);
    expect(call?.enclosing).toStrictEqual(['refund']);
  });

  it('finds a JavaScript call', async () => {
    const output = await parse(
      'helpers.js',
      'text/javascript',
      ['function helper() {}', '', 'function main() {', '  helper();', '}', ''].join('\n'),
    );

    expect((output.references ?? []).map((one) => one.name)).toContain('helper');
  });

  it('reports the reference count as a parser attribute', async () => {
    const output = await parse(
      'src/app.ts',
      'text/x-typescript',
      ['function a() {}', 'function b() { a(); }', ''].join('\n'),
    );

    expect(output.attributes?.['referenceCount']).toBe((output.references ?? []).length);
  });

  it('yields no references and no error for a file with none — AC-16', async () => {
    const output = await parse(
      'src/types.ts',
      'text/x-typescript',
      ['export interface Empty {', '  name: string;', '}', ''].join('\n'),
    );

    expect(output.references ?? []).toStrictEqual([]);
  });
});
