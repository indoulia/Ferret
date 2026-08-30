import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, RUNTIME_CONTRACT_VERSION, VERSION, versionInfo } from '../../src/index.js';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('version reporting', () => {
  it('reports the package name and version from the manifest', () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
    expect(VERSION).toBe(manifest.version);
  });

  it('is deterministic across calls', () => {
    expect(versionInfo()).toStrictEqual(versionInfo());
  });

  it('reports the runtime contract version and host facts', () => {
    const info = versionInfo();
    expect(info.runtimeContractVersion).toBe(RUNTIME_CONTRACT_VERSION);
    expect(info.node).toBe(process.versions.node);
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
  });

  it('contains no host-identifying information', () => {
    expect(JSON.stringify(versionInfo())).not.toContain(process.cwd());
  });
});
