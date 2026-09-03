import { ErrorCode, FerretError, toFerretError } from '../errors/index.js';

import type { Provider } from './contract.js';
import { readProviderManifest, refusesImport, type ManifestVerdict } from './manifest.js';
import type { ProviderRegistry } from './registry.js';

/**
 * A provider package may export one provider as its default, or a named
 * `provider`/`providers` export. Discovery deliberately accepts only explicit
 * module specifiers supplied by the caller; repository content and repository
 * policy are never consulted to decide what code to import.
 */
export interface ProviderModuleExports {
  readonly default?: Provider | readonly Provider[];
  readonly provider?: Provider;
  readonly providers?: readonly Provider[];
}

export type ProviderModuleLoader = (specifier: string) => Promise<ProviderModuleExports>;

/**
 * Reads a package's `package.json` without importing the package — EPIC-074.
 *
 * Optional: absent means discovery behaves exactly as it did before EPIC-074,
 * which is what keeps every existing caller unchanged. Supplying one lets
 * discovery decline an incompatible package *before* running its top-level
 * code, because importing is executing and a refusal after the import is a
 * refusal after the fact.
 */
export type ProviderManifestReader = (specifier: string) => Promise<unknown>;

export interface DiscoveryOptions {
  readonly load?: ProviderModuleLoader;
  readonly readManifest?: ProviderManifestReader;
}

export interface ProviderDiscoveryResult {
  readonly modules: readonly string[];
  readonly providers: readonly string[];
  readonly skipped: readonly ProviderDiscoverySkip[];
}

export interface ProviderDiscoverySkip {
  readonly module: string;
  /**
   * Why the candidate was skipped, as a value rather than as prose.
   *
   * `lifecycle` is not a property of the provider: the module loaded and the
   * provider was well-formed, and the registry refused it because the caller
   * discovered it after `initializeAll` sealed the registry. That is a
   * composition-root mistake, and collapsing it into `invalid` left the only
   * distinguishing signal in `detail` — human text, which EPIC-013 AC-10
   * forbids a caller from having to parse.
   */
  readonly reason: 'unavailable' | 'invalid' | 'duplicate' | 'lifecycle' | 'incompatible';
  readonly detail: string;
}

const defaultLoader: ProviderModuleLoader = async (specifier) => {
  return (await import(specifier)) as ProviderModuleExports;
};

/**
 * The manifest, or `undefined` when it could not be read at all.
 *
 * A reader that throws is treated as silence rather than as a refusal: the
 * package may have no `package.json` reachable by that specifier — a relative
 * path, a workspace link — and failing to *find* metadata is not evidence that
 * the code is incompatible.
 */
async function manifestVerdict(
  readManifest: ProviderManifestReader,
  specifier: string,
): Promise<ManifestVerdict | undefined> {
  try {
    return readProviderManifest(await readManifest(specifier));
  } catch {
    return undefined;
  }
}

/**
 * Loads and registers providers from an explicit, ordered module list.
 *
 * Discovery is intentionally additive and best-effort: one unavailable or
 * malformed optional provider must not make already registered capabilities
 * disappear. Registration itself remains atomic per provider because
 * ProviderRegistry validates before mutating its indexes.
 *
 * The caller owns trust in the module specifiers. This function never scans a
 * repository, package tree, or configuration file for code to execute.
 */
export async function discoverProviders(
  registry: ProviderRegistry,
  specifiers: readonly string[],
  loadOrOptions: ProviderModuleLoader | DiscoveryOptions = defaultLoader,
): Promise<ProviderDiscoveryResult> {
  // A function or an options object: EPIC-013's callers pass a loader
  // positionally and must keep working, and EPIC-074 needs a second seam.
  const load =
    typeof loadOrOptions === 'function' ? loadOrOptions : (loadOrOptions.load ?? defaultLoader);
  const readManifest = typeof loadOrOptions === 'function' ? undefined : loadOrOptions.readManifest;

  const modules: string[] = [];
  const providers: string[] = [];
  const skipped: ProviderDiscoverySkip[] = [];
  const seenModules = new Set<string>();
  const seenProviders = new Set<string>();

  for (const rawSpecifier of specifiers) {
    const specifier = rawSpecifier.trim();
    if (specifier.length === 0) {
      skipped.push({ module: rawSpecifier, reason: 'invalid', detail: 'Provider module specifier cannot be empty.' });
      continue;
    }
    if (seenModules.has(specifier)) {
      skipped.push({ module: specifier, reason: 'duplicate', detail: 'Provider module was already discovered.' });
      continue;
    }
    seenModules.add(specifier);
    modules.push(specifier);

    // §8.2. Before the import, because importing is executing.
    if (readManifest !== undefined) {
      const verdict = await manifestVerdict(readManifest, specifier);
      if (verdict !== undefined && refusesImport(verdict) && !verdict.loadable) {
        skipped.push({ module: specifier, reason: 'incompatible', detail: verdict.detail });
        continue;
      }
    }

    let exports: ProviderModuleExports;
    try {
      exports = await load(specifier);
    } catch (error) {
      skipped.push({
        module: specifier,
        reason: 'unavailable',
        detail: toFerretError(error).message,
      });
      continue;
    }

    const candidates = extractProviders(exports);
    if (candidates.length === 0) {
      skipped.push({
        module: specifier,
        reason: 'invalid',
        detail: 'Provider module must export a Provider as default, provider, or providers.',
      });
      continue;
    }

    for (const provider of candidates) {
      if (typeof provider !== 'object' || provider === null || typeof provider.id !== 'string') {
        skipped.push({
          module: specifier,
          reason: 'invalid',
          detail: 'Provider module exported a value that is not a Provider object.',
        });
        continue;
      }
      if (seenProviders.has(provider.id) || registry.has(provider.id)) {
        skipped.push({
          module: specifier,
          reason: 'duplicate',
          detail: `Provider "${provider.id}" is already registered.`,
        });
        continue;
      }
      try {
        registry.register(provider);
        seenProviders.add(provider.id);
        providers.push(provider.id);
      } catch (error) {
        const failure = toFerretError(error);
        if (failure.code === ErrorCode.PROVIDER_DUPLICATE) {
          skipped.push({ module: specifier, reason: 'duplicate', detail: failure.message });
          continue;
        }
        // A sealed registry is the caller's error, not the provider's, and it is
        // the one skip here that skipping cannot recover from.
        if (failure.code === ErrorCode.LIFECYCLE_INVALID_STATE) {
          skipped.push({ module: specifier, reason: 'lifecycle', detail: failure.message });
          continue;
        }
        skipped.push({ module: specifier, reason: 'invalid', detail: failure.message });
      }
    }
  }

  return { modules, providers, skipped };
}

// Array.isArray widens a `readonly Provider[]` union member to `any[]`, so the
// spread that follows it needs a guard that keeps the element type.
function isProviderList(value: Provider | readonly Provider[]): value is readonly Provider[] {
  return Array.isArray(value);
}

function extractProviders(exports: ProviderModuleExports): readonly Provider[] {
  const candidates: Provider[] = [];
  const add = (value: Provider | readonly Provider[] | undefined): void => {
    if (value === undefined) return;
    if (isProviderList(value)) candidates.push(...value);
    else candidates.push(value);
  };
  add(exports.default);
  add(exports.provider);
  add(exports.providers);
  return candidates;
}

/** Converts discovery failures into a stable error without executing a module. */
export function providerDiscoveryError(module: string, error: unknown): FerretError {
  return new FerretError(
    ErrorCode.PROVIDER_INVALID,
    `Provider module "${module}" could not be loaded: ${toFerretError(error).message}`,
    { details: { module }, cause: error },
  );
}
