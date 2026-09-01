import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  Capability,
  DependencyStatus,
  ErrorCode,
  PROVIDER_CONTRACT_VERSION,
  ProviderKind,
  type FerretError,
  type Provider,
  type ProviderContext,
  type ProviderOptionsSchema,
} from '../../src/index.js';
import {
  CONFORMANCE_CHECK_IDS,
  assertConformant,
  runConformance,
  type ConformanceReport,
} from '../../src/providers/sdk/testing.js';
import { GitSourceProvider } from '../../src/git/index.js';

/** A provider that honours every invariant the suite checks. */
class GoodProvider implements Provider {
  readonly id: string = 'test.conformant';
  readonly kind = ProviderKind.SOURCE;
  readonly contractVersion = PROVIDER_CONTRACT_VERSION;
  readonly capabilities = [{ capability: Capability.SOURCE_REPOSITORY, version: 1 }];
  readonly configSchema: ProviderOptionsSchema = z.object({
    endpoint: z.string().default('local'),
    pat: z.string().optional(),
  });
  readonly secretOptions: readonly string[] = ['pat'];

  initialize(context: ProviderContext): Promise<void> | void {
    // Logs the option that is not a secret, which is the honest thing to do.
    context.logger.info({ endpoint: context.settings.options['endpoint'] }, 'ready');
  }

  checkDependencies(): readonly { name: string; status: DependencyStatus; required: boolean }[] {
    return [{ name: 'test.system', status: DependencyStatus.OK, required: false }];
  }

  shutdown(): void {
    // Nothing to release; the point is that calling it twice is safe.
  }
}

function failed(report: ConformanceReport): readonly string[] {
  return report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
}

function statusOf(report: ConformanceReport, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

describe('a conformant provider', () => {
  it('produces a report with no failures — AC-1', async () => {
    const report = await runConformance({ create: () => new GoodProvider() });

    expect(failed(report)).toStrictEqual([]);
    expect(report.conformant).toBe(true);
    expect(report.providerId).toBe('test.conformant');
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
  });

  it('passes assertConformant quietly — AC-9', async () => {
    const report = await runConformance({ create: () => new GoodProvider() });
    expect(() => {
      assertConformant(report);
    }).not.toThrow();
  });

  it('emits only published check ids — AC-10', async () => {
    const report = await runConformance({ create: () => new GoodProvider() });
    const published = new Set(CONFORMANCE_CHECK_IDS);
    for (const check of report.checks) expect(published.has(check.id)).toBe(true);
    // And the published list is not aspirational: every id in it was emitted.
    expect(new Set(report.checks.map((check) => check.id))).toStrictEqual(published);
  });
});

describe('contract declaration', () => {
  function broken(overrides: Partial<Provider>): () => Provider {
    return () =>
      ({
        id: 'test.conformant',
        kind: ProviderKind.SOURCE,
        contractVersion: PROVIDER_CONTRACT_VERSION,
        capabilities: [{ capability: Capability.SOURCE_REPOSITORY, version: 1 }],
        ...overrides,
      });
  }

  it('fails a malformed id — AC-2', async () => {
    const report = await runConformance({ create: broken({ id: 'Not An Id' }) });
    expect(statusOf(report, 'contract.id')).toBe('fail');
    expect(report.conformant).toBe(false);
  });

  it('fails an unknown kind — AC-2', async () => {
    const report = await runConformance({ create: broken({ kind: 'wormhole' as ProviderKind }) });
    expect(statusOf(report, 'contract.kind')).toBe('fail');
  });

  it('fails an unsupported contract version — AC-2', async () => {
    const report = await runConformance({ create: broken({ contractVersion: 99 }) });
    expect(statusOf(report, 'contract.version')).toBe('fail');
  });

  it('fails an invalid capability declaration — AC-2', async () => {
    const report = await runConformance({
      create: broken({ capabilities: [{ capability: 'teleport' as Capability, version: 1 }] }),
    });
    expect(statusOf(report, 'contract.capabilities')).toBe('fail');
  });

  it('fails a capability declared twice — AC-2', async () => {
    const report = await runConformance({
      create: broken({
        capabilities: [
          { capability: Capability.SOURCE_REPOSITORY, version: 1 },
          { capability: Capability.SOURCE_REPOSITORY, version: 1 },
        ],
      }),
    });
    expect(statusOf(report, 'contract.capabilities')).toBe('fail');
  });

  it('checks the provider is selectable for what it declares', async () => {
    const report = await runConformance({ create: () => new GoodProvider() });
    expect(statusOf(report, 'contract.registers')).toBe('pass');
    expect(statusOf(report, 'contract.selectable')).toBe('pass');
  });
});

describe('lifecycle', () => {
  it('fails a provider that throws from a second initialize — AC-3', async () => {
    class Once extends GoodProvider {
      #count = 0;
      override initialize(context: ProviderContext): Promise<void> | void {
        this.#count += 1;
        if (this.#count > 1) throw new Error('already initialized');
        return super.initialize(context);
      }
    }

    const report = await runConformance({ create: () => new Once() });
    expect(statusOf(report, 'lifecycle.initialize.idempotent')).toBe('fail');
  });

  it('fails a provider that throws from shutdown before initialize — AC-3', async () => {
    class Fragile extends GoodProvider {
      #started = false;
      override async initialize(context: ProviderContext): Promise<void> {
        await super.initialize(context);
        this.#started = true;
      }
      override shutdown(): void {
        if (!this.#started) throw new Error('never started');
      }
    }

    const report = await runConformance({ create: () => new Fragile() });
    expect(statusOf(report, 'lifecycle.shutdown.bare')).toBe('fail');
  });

  it('fails a provider that throws from a second shutdown — AC-3', async () => {
    class OnceDown extends GoodProvider {
      #stops = 0;
      override shutdown(): void {
        this.#stops += 1;
        if (this.#stops > 1) throw new Error('already stopped');
      }
    }

    const report = await runConformance({ create: () => new OnceDown() });
    expect(statusOf(report, 'lifecycle.shutdown.idempotent')).toBe('fail');
  });

  it('checks concurrent initialization — AC-4', async () => {
    class Racy extends GoodProvider {
      #entered = false;
      override async initialize(context: ProviderContext): Promise<void> {
        if (this.#entered) throw new Error('re-entered');
        this.#entered = true;
        await Promise.resolve();
        await super.initialize(context);
        this.#entered = false;
      }
    }

    const report = await runConformance({ create: () => new Racy() });
    expect(statusOf(report, 'lifecycle.initialize.concurrent')).toBe('fail');
  });

  it('checks shutdown after the context is aborted', async () => {
    const report = await runConformance({ create: () => new GoodProvider() });
    expect(statusOf(report, 'lifecycle.shutdown.afterAbort')).toBe('pass');
  });
});

describe('dependency reporting', () => {
  it('fails a malformed dependency result — AC-5', async () => {
    class Sloppy extends GoodProvider {
      override checkDependencies(): readonly { name: string; status: DependencyStatus; required: boolean }[] {
        return [{ name: '', status: 'fine' as DependencyStatus, required: true }];
      }
    }

    const report = await runConformance({ create: () => new Sloppy() });
    expect(statusOf(report, 'dependencies.shape')).toBe('fail');
  });

  it('skips a provider that does not implement it — AC-5, AC-8', async () => {
    const report = await runConformance({
      create: () =>
        ({
          id: 'test.minimal',
          kind: ProviderKind.SOURCE,
          contractVersion: PROVIDER_CONTRACT_VERSION,
        }),
    });

    expect(statusOf(report, 'dependencies.shape')).toBe('skipped');
    expect(report.conformant).toBe(true);
  });
});

describe('secret handling', () => {
  it('fails a provider that logs a declared secret — AC-6', async () => {
    class Leaky extends GoodProvider {
      override initialize(context: ProviderContext): void {
        context.logger.info({ options: context.settings.options }, 'ready with options');
      }
    }

    const report = await runConformance({ create: () => new Leaky() });
    const check = report.checks.find((entry) => entry.id === 'security.secrets.notLogged');

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('pat');
    // The canary is what the suite planted; naming it would defeat the point.
    expect(check?.detail).not.toMatch(/canary-[0-9a-f]/i);
  });

  it('fails a provider that puts a secret into a thrown error — AC-7', async () => {
    class Shouty extends GoodProvider {
      override initialize(context: ProviderContext): void {
        throw new Error(`could not authenticate with ${String(context.settings.options['pat'])}`);
      }
    }

    const report = await runConformance({ create: () => new Shouty() });
    expect(statusOf(report, 'security.secrets.notThrown')).toBe('fail');
  });

  it('fails a provider that logs the database password', async () => {
    // Reached through the declared grant, because since EPIC-081 there is no
    // other way to reach it: `context.config.database.password` does not
    // compile. The check still has something to catch, and now it catches it on
    // the only provider that could ever have it.
    class Nosy extends GoodProvider {
      readonly credentials = ['database.password'];
      override initialize(context: ProviderContext): void {
        context.logger.debug({ dsn: context.credentials?.['database.password'] }, 'connecting');
      }
    }

    const report = await runConformance({ create: () => new Nosy() });
    expect(statusOf(report, 'security.config.notLogged')).toBe('fail');
  });

  it('skips the secret checks when nothing is declared — AC-8', async () => {
    class Quiet extends GoodProvider {
      override readonly secretOptions = [];
    }

    const report = await runConformance({ create: () => new Quiet() });
    expect(statusOf(report, 'security.secrets.notLogged')).toBe('skipped');
    expect(statusOf(report, 'security.secrets.notThrown')).toBe('skipped');
    expect(report.conformant).toBe(true);
  });
});

describe('configuration declaration', () => {
  it('skips the schema check when none is declared — AC-8', async () => {
    const report = await runConformance({
      create: () =>
        ({
          id: 'test.minimal',
          kind: ProviderKind.SOURCE,
          contractVersion: PROVIDER_CONTRACT_VERSION,
        }),
    });
    expect(statusOf(report, 'config.schema.total')).toBe('skipped');
  });

  it('fails a schema that throws instead of returning a verdict', async () => {
    class Explosive extends GoodProvider {
      override readonly configSchema = {
        safeParse(): never {
          throw new Error('boom');
        },
      };
    }

    const report = await runConformance({ create: () => new Explosive() });
    expect(statusOf(report, 'config.schema.total')).toBe('fail');
  });

  it('fails a secretOptions entry that is not a usable path', async () => {
    class Vague extends GoodProvider {
      override readonly secretOptions = ['', 'a..b'];
    }

    const report = await runConformance({ create: () => new Vague() });
    expect(statusOf(report, 'config.secretOptions.paths')).toBe('fail');
  });
});

describe('assertConformant', () => {
  it('names every failed check — AC-9', async () => {
    class Bad extends GoodProvider {
      override readonly id = 'Not An Id';
      override readonly secretOptions = [''];
    }

    const report = await runConformance({ create: () => new Bad() });
    let thrown: FerretError | undefined;
    try {
      assertConformant(report);
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe(ErrorCode.PROVIDER_INVALID);
    expect(thrown?.message).toContain('contract.id');
    expect(thrown?.message).toContain('config.secretOptions.paths');
    expect(thrown?.details).toMatchObject({ providerId: 'Not An Id' });
  });
});

describe("Ferret's own providers", () => {
  it('the Git source provider is conformant — AC-11', async () => {
    const report = await runConformance({ create: () => new GitSourceProvider() });

    // Printed rather than summarised: a failure here should say which invariant
    // broke without anyone re-running the suite by hand.
    expect(
      report.checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`),
    ).toStrictEqual([]);
    expect(report.conformant).toBe(true);
  });

  it('declares no secrets yet, and the report says so rather than passing quietly', async () => {
    const report = await runConformance({ create: () => new GitSourceProvider() });
    expect(statusOf(report, 'security.secrets.notLogged')).toBe('skipped');
    // What it does prove is that the database password never reached the log.
    expect(statusOf(report, 'security.config.notLogged')).toBe('pass');
  });
});
