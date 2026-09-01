import { describe, expect, it } from 'vitest';

import {
  Capability,
  CapabilitySupport,
  ProviderRegistry,
  createRuntime,
  isContentParser,
  ParserFramework,
  ParserSupport,
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
    expect(result.providers).toHaveLength(1);
    expect(registry.has(result.providers[0] ?? '')).toBe(true);
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

    expect(first.provider).toBeDefined();
    expect(first.provider).not.toBe(second.provider);
    expect(first.provider?.id).toBe(second.provider?.id);
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
