import { describe, expect, it } from 'vitest';

import {
  CORE_DEPENDENCY_CHECKS,
  DependencyStatus,
  MINIMUM_NODE_MAJOR,
  createNullLogger,
  detectEnvironment,
  detectGit,
  gitAvailableCheck,
  isHealthy,
  nodeVersionCheck,
  parseConfig,
  type DependencyCheckContext,
  type EnvironmentReport,
} from '../../src/index.js';

function environment(overrides: Partial<EnvironmentReport> = {}): EnvironmentReport {
  return {
    ferretVersion: '0.0.0-test',
    node: { version: '22.0.0', major: 22, supportedRange: '>=22.0.0', supported: true },
    platform: 'linux',
    arch: 'x64',
    cwd: '/workspace',
    interactive: false,
    git: { available: true, version: '2.55.0' },
    ...overrides,
  };
}

function checkContext(report: EnvironmentReport): DependencyCheckContext {
  return {
    logger: createNullLogger(),
    config: parseConfig({}),
    environment: report,
    signal: new AbortController().signal,
  };
}

describe('detectEnvironment', () => {
  it('reports the running host accurately', async () => {
    const report = await detectEnvironment();

    expect(report.node.version).toBe(process.versions.node);
    expect(report.node.major).toBe(Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10));
    expect(report.node.supported).toBe(true);
    expect(report.platform).toBe(process.platform);
    expect(report.arch).toBe(process.arch);
    expect(report.cwd).toBe(process.cwd());
    expect(typeof report.interactive).toBe('boolean');
  });

  it('renders a health verdict nowhere — that belongs to EPIC-004', async () => {
    const report = await detectEnvironment();
    expect(report).not.toHaveProperty('status');
    expect(report).not.toHaveProperty('healthy');
  });

  it('is repeatable', async () => {
    const [first, second] = await Promise.all([detectEnvironment(), detectEnvironment()]);
    expect(first.node).toStrictEqual(second.node);
    expect(first.git.available).toBe(second.git.available);
  });

  it('derives the minimum Node major from the declared engines range', () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
  });
});

describe('detectGit', () => {
  it('reports Git as a fact and never throws', async () => {
    const info = await detectGit();
    expect(typeof info.available).toBe('boolean');
    if (info.available && info.version !== undefined) {
      expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('returns unavailable rather than throwing when the probe cannot complete', async () => {
    // A 1 ms budget cannot complete a process spawn; absence must be reported,
    // not raised.
    await expect(detectGit(1)).resolves.toMatchObject({ available: false });
  });
});

describe('nodeVersionCheck', () => {
  it('passes on a supported runtime', async () => {
    const result = await nodeVersionCheck.run(checkContext(environment()));
    expect(result).toMatchObject({ name: 'node-version', status: DependencyStatus.OK, required: true });
    expect(isHealthy(result)).toBe(true);
  });

  it('is unavailable and actionable on an unsupported runtime', async () => {
    const report = environment({
      node: { version: '18.0.0', major: 18, supportedRange: '>=22.0.0', supported: false },
    });
    const result = await nodeVersionCheck.run(checkContext(report));

    expect(result.status).toBe(DependencyStatus.UNAVAILABLE);
    expect(result.required).toBe(true);
    expect(result.remediation).toContain('22');
    expect(isHealthy(result)).toBe(false);
  });
});

describe('gitAvailableCheck', () => {
  it('passes when Git is present', async () => {
    const result = await gitAvailableCheck.run(checkContext(environment()));
    expect(result).toMatchObject({ status: DependencyStatus.OK, required: false });
    expect(result.detail).toContain('2.55.0');
  });

  it('degrades rather than blocks when Git is absent, because EPIC-017 owns that need', async () => {
    const result = await gitAvailableCheck.run(checkContext(environment({ git: { available: false } })));

    expect(result.status).toBe(DependencyStatus.DEGRADED);
    expect(result.required).toBe(false);
    expect(isHealthy(result)).toBe(true);
    expect(result.remediation).toContain('PATH');
  });
});

describe('core dependency checks', () => {
  it('cover the Node runtime and Git, and declare stable names', () => {
    expect(CORE_DEPENDENCY_CHECKS.map((check) => check.name)).toStrictEqual(['node-version', 'git']);
  });

  it('mark only the Node runtime as required for startup', () => {
    expect(CORE_DEPENDENCY_CHECKS.filter((check) => check.required).map((c) => c.name)).toStrictEqual([
      'node-version',
    ]);
  });
});
