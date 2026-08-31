import type { FerretConfig } from '../config/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import type { Provider } from './contract.js';

/**
 * Per-provider configuration.
 *
 * `FerretConfig.providers` has carried a `{ enabled, options }` record since
 * EPIC-003, and nothing has ever read it: `options` was validated only for
 * being an object, `enabled` was inert, and every provider was handed the whole
 * `FerretConfig` — the database password and every other provider's options
 * included.
 *
 * This module closes that gap. The core validates the *shape* of a provider's
 * options against a schema the provider itself declares, hands the provider its
 * own slice and nothing else, and knows which of those values are secrets so
 * they can be redacted at the render boundary rather than by asking each
 * provider to be careful (Governance §4, §12).
 */

/** One reason a schema rejected an option. Carries the path, never the value. */
export interface OptionsSchemaIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

export type OptionsSchemaResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: { readonly issues: readonly OptionsSchemaIssue[] } };

/**
 * What a provider must expose to have its options validated.
 *
 * Structural rather than `z.ZodType` on purpose: a provider shipped as its own
 * package brings its own Zod, and a nominal type would make the two copies
 * incompatible for no benefit. Any Zod schema satisfies this as written, and so
 * does a hand-rolled validator, which keeps a provider free of a Ferret-imposed
 * validation dependency.
 */
export interface ProviderOptionsSchema {
  safeParse(value: unknown): OptionsSchemaResult;
}

/** A provider's own configuration, and nothing else's. */
export interface ProviderSettings {
  readonly enabled: boolean;
  readonly options: Readonly<Record<string, unknown>>;
}

/** What an unconfigured provider gets: on, with no options. */
export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = Object.freeze({
  enabled: true,
  options: Object.freeze({}),
});

function issuePath(issue: OptionsSchemaIssue): string {
  return issue.path.map(String).join('.') || '(root)';
}

/**
 * Resolves and validates one provider's configuration slice.
 *
 * Called immediately before `initialize`, so a mistyped option fails at startup
 * naming the provider rather than at first use three layers away.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` when the declared schema rejects the
 * options. The error names the provider and the failing paths; a rejected value
 * is never echoed, because a rejected value may itself be a credential.
 */
export function providerSettings(provider: Provider, config: FerretConfig): ProviderSettings {
  const entry = config.providers[provider.id];
  if (entry === undefined && provider.configSchema === undefined) return DEFAULT_PROVIDER_SETTINGS;

  const enabled = entry?.enabled ?? true;
  const options = entry?.options ?? {};
  if (provider.configSchema === undefined) return { enabled, options };

  const result = provider.configSchema.safeParse(options);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issuePath(issue),
      message: issue.message,
    }));
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Provider "${provider.id}" rejected its configuration — ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
      {
        details: { providerId: provider.id, issues },
        remediation: `Correct the listed options under providers."${provider.id}".options. Run \`ferret config list --explain\` to see which layer supplied each one.`,
      },
    );
  }

  // A schema may replace the record entirely — defaults, coercions, stripped
  // unknown keys. Anything that is not a record after validation would break the
  // `options` contract for every consumer, so it is refused here rather than
  // handed on.
  const data = result.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Provider "${provider.id}" declared a configuration schema that does not produce an options object`,
      {
        details: { providerId: provider.id, produced: Array.isArray(data) ? 'array' : typeof data },
        remediation: 'A provider configSchema must validate to an object of options.',
      },
    );
  }
  return { enabled, options: data as Record<string, unknown> };
}

export interface ProviderConfigurationWarning {
  readonly providerId: string;
  readonly reason: 'unregistered';
}

/**
 * Configured provider ids that no registered provider claims.
 *
 * A typo in a provider id is otherwise completely silent: the options are valid
 * against the core schema, nothing reads them, and the provider the user meant
 * to configure runs on its defaults. Reporting is deliberately not fatal — a
 * configuration file shared across machines may name a provider that is only
 * installed on some of them (Governance §13).
 */
export function providerConfigurationWarnings(
  config: FerretConfig,
  registeredIds: Iterable<string>,
): readonly ProviderConfigurationWarning[] {
  const known = new Set(registeredIds);
  return Object.keys(config.providers)
    .filter((providerId) => !known.has(providerId))
    .map((providerId) => ({ providerId, reason: 'unregistered' as const }));
}

/**
 * Builds the predicate `describeConfig` uses to redact declared provider
 * secrets.
 *
 * EPIC-003 redacts by key name, which covers `password` and `token` and misses
 * the same secret stored as `pat`. A provider knows which of its options are
 * credentials, so it says so, and Ferret enforces it at the point configuration
 * is rendered.
 *
 * Paths arrive as segments — `['providers', 'ferret.source.github', 'options',
 * 'auth', 'token']` — rather than a dotted string, because provider ids contain
 * dots and a dotted path could not be split back apart unambiguously.
 *
 * A declared path also covers everything beneath it: declaring `auth` redacts
 * `auth.token` and `auth.user` both, which is the safe direction to be wrong in.
 */
export function secretOptionPredicate(
  providers: Iterable<Provider>,
): (path: readonly string[]) => boolean {
  const declared = new Map<string, readonly string[][]>();
  for (const provider of providers) {
    const paths = provider.secretOptions ?? [];
    if (paths.length === 0) continue;
    const existing = declared.get(provider.id) ?? [];
    declared.set(provider.id, [...existing, ...paths.map((path) => path.split('.'))]);
  }
  if (declared.size === 0) return () => false;

  return (path: readonly string[]): boolean => {
    if (path.length < 4 || path[0] !== 'providers' || path[2] !== 'options') return false;
    const providerId = path[1];
    if (providerId === undefined) return false;
    const optionPath = path.slice(3);
    return (declared.get(providerId) ?? []).some(
      (secret) =>
        secret.length <= optionPath.length &&
        secret.every((segment, index) => segment === optionPath[index]),
    );
  };
}
