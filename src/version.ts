import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly engines?: { readonly node?: string };
}

const manifest = require('../package.json') as PackageManifest;

/** Published package name. */
export const PACKAGE_NAME: string = manifest.name;

/** Package version. The single source of truth is package.json. */
export const VERSION: string = manifest.version;

/** Supported Node.js range, as declared to npm. */
export const SUPPORTED_NODE_RANGE: string = manifest.engines?.node ?? '>=22.0.0';

/**
 * Version of the runtime's public contract.
 *
 * Bumped when a published interface changes incompatibly; independent of the
 * package version so consumers can gate on behaviour, not release cadence.
 */
export const RUNTIME_CONTRACT_VERSION = 1;

export interface VersionInfo {
  readonly name: string;
  readonly version: string;
  readonly runtimeContractVersion: number;
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/** Deterministic version report. Contains no host-identifying information. */
export function versionInfo(): VersionInfo {
  return {
    name: PACKAGE_NAME,
    version: VERSION,
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
}
