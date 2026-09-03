import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config/index.js';
import {
  Capability,
  CAPABILITY_VERSIONS,
  ManifestRefusal,
  PROVIDER_CONTRACT_VERSION,
  ProviderKind,
  ProviderRegistry,
  discoverProviders,
  readProviderManifest,
  refusesImport,
} from '../../src/providers/index.js';
import { BaseProvider } from '../../src/providers/sdk/base.js';
import { registerEntityKind } from '../../src/domain/entity.js';
import { registerRelationshipType } from '../../src/domain/relationship.js';
import { EntityKind, createEntity, createRelationship } from '../../src/domain/index.js';
import { z } from 'zod';
import type { Provider } from '../../src/providers/index.js';

/**
 * EPIC-074. The framework a third party writes a provider against.
 *
 * The gap this Epic found is in the first suite: discovery imported a package
 * and validated it afterwards, so a package built for a future Ferret ran its
 * top-level code in this one before being refused.
 */

class Sample extends BaseProvider implements Provider {
  readonly id: string;
  readonly kind = ProviderKind.SOURCE;
  readonly capabilities = [
    { capability: Capability.SOURCE_PROJECT, version: CAPABILITY_VERSIONS[Capability.SOURCE_PROJECT] },
  ];

  constructor(id = 'acme.source.tracker') {
    super();
    this.id = id;
  }
}

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    name: '@acme/ferret-tracker',
    ferret: {
      provider: {
        id: 'acme.source.tracker',
        contractVersion: PROVIDER_CONTRACT_VERSION,
        capabilities: [Capability.SOURCE_PROJECT],
        ...overrides,
      },
    },
  };
}

describe('the manifest', () => {
  it('reads a well-formed one', () => {
    const verdict = readProviderManifest(manifest());
    expect(verdict.loadable).toBe(true);
    if (!verdict.loadable) return;
    expect(verdict.manifest.id).toBe('acme.source.tracker');
    expect(verdict.manifest.capabilities).toStrictEqual([Capability.SOURCE_PROJECT]);
  });

  it('treats an absent manifest as silence, not as a refusal', () => {
    // A package with no manifest predates this Epic or simply did not write
    // one, and EPIC-013's import-then-validate remains correct for it. Refusing
    // every unmanifested package would break every provider written before.
    const verdict = readProviderManifest({ name: '@acme/plain' });
    expect(verdict.loadable).toBe(false);
    if (verdict.loadable) return;
    expect(verdict.refusal).toBe(ManifestRefusal.ABSENT);
    expect(refusesImport(verdict)).toBe(false);
  });

  it('refuses a future contract version, and only that', () => {
    const future = readProviderManifest(manifest({ contractVersion: PROVIDER_CONTRACT_VERSION + 1 }));
    expect(future.loadable).toBe(false);
    if (future.loadable) return;
    expect(future.refusal).toBe(ManifestRefusal.UNSUPPORTED_CONTRACT);
    // The only verdict that stops an import: a malformed manifest is a package
    // that got its own metadata wrong, which is not evidence the code is
    // incompatible.
    expect(refusesImport(future)).toBe(true);
    expect(future.detail).toContain(String(PROVIDER_CONTRACT_VERSION));
  });

  it('reports a malformed manifest without echoing its contents', () => {
    // A manifest is a package's own file. Echoing its values into an error is
    // echoing untrusted text into a log.
    const verdict = readProviderManifest({ ferret: { provider: { id: 'x', contractVersion: 'one' } } });
    expect(verdict.loadable).toBe(false);
    if (verdict.loadable) return;
    expect(verdict.refusal).toBe(ManifestRefusal.MALFORMED);
    expect(verdict.detail).toContain('contractVersion');
    expect(verdict.detail).not.toContain('one');
    expect(refusesImport(verdict)).toBe(false);
  });

  it('refuses anything that is not an object', () => {
    for (const value of [undefined, null, 'a string', 42]) {
      expect(readProviderManifest(value).loadable).toBe(false);
    }
  });

  it('refuses an unknown capability rather than accepting it', () => {
    expect(readProviderManifest(manifest({ capabilities: ['source.telepathy'] })).loadable).toBe(
      false,
    );
  });
});

describe('discovery, with a manifest', () => {
  it('declines an incompatible package before importing it — the finding', async () => {
    // The defect: importing is executing, and EPIC-013 refused *after* the
    // import. A package built for a future Ferret ran its top-level code here.
    let imported = false;
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['@acme/future'], {
      load: () => {
        imported = true;
        return Promise.resolve({ provider: new Sample() });
      },
      readManifest: () =>
        Promise.resolve(manifest({ contractVersion: PROVIDER_CONTRACT_VERSION + 1 })),
    });

    expect(imported).toBe(false);
    expect(result.providers).toStrictEqual([]);
    expect(result.skipped[0]?.reason).toBe('incompatible');
    expect(result.skipped[0]?.detail).toContain('contract version');
  });

  it('imports a compatible package', async () => {
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['@acme/tracker'], {
      load: () => Promise.resolve({ provider: new Sample() }),
      readManifest: () => Promise.resolve(manifest()),
    });
    expect(result.providers).toStrictEqual(['acme.source.tracker']);
    expect(registry.has('acme.source.tracker')).toBe(true);
  });

  it('imports a package with no manifest at all', async () => {
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['@acme/plain'], {
      load: () => Promise.resolve({ provider: new Sample('acme.source.plain') }),
      readManifest: () => Promise.resolve({ name: '@acme/plain' }),
    });
    expect(result.providers).toStrictEqual(['acme.source.plain']);
  });

  it('treats an unreadable manifest as silence', async () => {
    // The package may have no `package.json` reachable by that specifier — a
    // relative path, a workspace link. Failing to *find* metadata is not
    // evidence that the code is incompatible.
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['./local/provider.js'], {
      load: () => Promise.resolve({ provider: new Sample('acme.source.local') }),
      readManifest: () => Promise.reject(new Error('ENOENT')),
    });
    expect(result.providers).toStrictEqual(['acme.source.local']);
  });

  it('still accepts a bare loader, as EPIC-013 callers pass one', async () => {
    // Positional compatibility: every existing caller passes a function.
    const registry = new ProviderRegistry();
    const result = await discoverProviders(registry, ['@acme/tracker'], () =>
      Promise.resolve({ provider: new Sample() }),
    );
    expect(result.providers).toStrictEqual(['acme.source.tracker']);
  });
});

describe('the configuration surface', () => {
  it('has somewhere to name an external provider module', () => {
    // Until EPIC-074, `providers` configured providers *by id* — which presumes
    // they are already registered — and nothing said where a third party's
    // provider comes from. The framework had a registry, a contract, a
    // conformance suite and no way in.
    const config = parseConfig({ providerModules: ['@acme/ferret-tracker'] });
    expect(config.providerModules).toStrictEqual(['@acme/ferret-tracker']);
  });

  it('defaults to empty, so `parseConfig({})` still succeeds — Governance §2', () => {
    expect(parseConfig({}).providerModules).toStrictEqual([]);
  });

  it('refuses an empty specifier', () => {
    expect(() => parseConfig({ providerModules: [''] })).toThrow();
  });
});

describe('the extension points a provider needs', () => {
  it('lets a provider register an entity kind and use it', () => {
    // EPIC-006 AC-4: an extension must not need a core change. Asserted here
    // because this is the Epic that claims a third party can write one.
    registerEntityKind(
      'acme_ticket',
      z.object({ name: z.string().optional(), severity: z.string().optional() }).strict(),
    );
    const entity = createEntity({
      kind: 'acme_ticket',
      source: { system: 'acme', id: 'T-1' },
      attributes: { severity: 'high' },
    });
    expect(entity.kind).toBe('acme_ticket');
    expect(entity.attributes['severity']).toBe('high');
  });

  it('validates a registered kind attributes, rather than waving them through', () => {
    expect(() =>
      createEntity({
        kind: 'acme_ticket',
        source: { system: 'acme', id: 'T-2' },
        attributes: { unexpected: true },
      }),
    ).toThrow();
  });

  it('lets a provider register a relationship type between existing kinds', () => {
    registerRelationshipType('acme_ticket_blocks_issue', {
      fromKinds: ['acme_ticket'],
      toKinds: [EntityKind.ISSUE],
      exclusiveFrom: false,
    });
    const edge = createRelationship({
      fromId: '11111111-1111-8111-8111-111111111111',
      type: 'acme_ticket_blocks_issue',
      toId: '22222222-2222-8222-8222-222222222222',
      sourceSystem: 'acme',
    });
    expect(edge.type).toBe('acme_ticket_blocks_issue');
  });

  it('still refuses an unregistered relationship type', () => {
    expect(() =>
      createRelationship({
        fromId: '11111111-1111-8111-8111-111111111111',
        type: 'acme_ticket_teleports_issue',
        toId: '22222222-2222-8222-8222-222222222222',
        sourceSystem: 'acme',
      }),
    ).toThrow();
  });
});
