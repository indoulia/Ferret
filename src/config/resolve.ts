import type { z } from 'zod';

import { ErrorCode, FerretError, REDACTED, isSecretKey, redact } from '../errors/index.js';

import { ferretConfigSchema, type FerretConfig } from './schema.js';
import { isSecretRef, resolveSecrets } from './secret-ref.js';

/**
 * A layer of configuration input.
 *
 * Every source is a fragment plus a precedence. Adding a layer — a file, a
 * repository policy, a session scope — is implementing this interface; the
 * runtime does not change when one is added.
 */
export interface ConfigSource {
  /** Stable identifier reported by configuration introspection. */
  readonly name: string;
  /** Lower numbers are overridden by higher numbers. */
  readonly precedence: number;
  /** Returns a partial, unvalidated configuration fragment. */
  read(): Record<string, unknown>;
}

/**
 * The precedence ladder from Governance §16:
 *
 * ```text
 * safe defaults → environment discovery → user configuration
 *   → repository policy → session scope → explicit operation
 * ```
 *
 * A stored setting therefore outranks an environment variable, which is
 * deliberate: the file is what the user chose, an inherited environment is not.
 * An explicit operation outranks everything, because the user is asking for it
 * right now.
 *
 * Security restrictions are *not* on this ladder. They cannot be overridden by
 * a lower-trust input at all — see `repository-source.ts`.
 */
export const ConfigPrecedence = {
  DEFAULTS: 0,
  ENVIRONMENT: 100,
  USER: 200,
  REPOSITORY: 300,
  SESSION: 400,
  EXPLICIT: 500,
} as const;

export const ENV_PREFIX = 'FERRET_';

/** Environment variables Ferret reads, and the config path each populates. */
export const ENV_BINDINGS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['FERRET_LOG_LEVEL', ['logLevel']],
  ['FERRET_DATABASE_HOST', ['database', 'host']],
  ['FERRET_DATABASE_PORT', ['database', 'port']],
  ['FERRET_DATABASE_NAME', ['database', 'database']],
  ['FERRET_DATABASE_USER', ['database', 'user']],
  ['FERRET_DATABASE_PASSWORD', ['database', 'password']],
  ['FERRET_DATABASE_MIGRATE', ['database', 'migrate']],
  ['FERRET_EXCLUDE', ['exclude']],
];

function assign(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (segment === undefined) return;
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined) cursor[leaf] = value;
}

/** Reads the environment surface. Unset variables contribute nothing. */
export function environmentSource(env: NodeJS.ProcessEnv = process.env): ConfigSource {
  return {
    name: 'environment',
    precedence: ConfigPrecedence.ENVIRONMENT,
    read(): Record<string, unknown> {
      const fragment: Record<string, unknown> = {};
      for (const [variable, path] of ENV_BINDINGS) {
        const raw = env[variable];
        if (raw === undefined || raw === '') continue;
        const value =
          path[0] === 'exclude'
            ? raw
                .split(/[,;]/)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
            : raw;
        assign(fragment, path, value);
      }
      return fragment;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeFragments(fragments: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment)) {
      const existing = merged[key];
      // A secret reference is a leaf, not a structure to merge into: merging it
      // with a literal would produce an object that is neither.
      const bothPlainObjects =
        isPlainObject(value) && isPlainObject(existing) && !isSecretRef(value) && !isSecretRef(existing);
      merged[key] = bothPlainObjects
        ? mergeFragments([existing, value])
        : value;
    }
  }
  return merged;
}

/**
 * Records which source supplied each leaf, for configuration introspection.
 *
 * Governance §18 requires Ferret to be able to explain itself, and "why is this
 * value what it is" is the first question anyone asks of a layered
 * configuration system.
 */
function collectOrigins(
  fragment: Record<string, unknown>,
  sourceName: string,
  into: Record<string, string>,
  prefix: readonly string[] = [],
): void {
  for (const [key, value] of Object.entries(fragment)) {
    const path = [...prefix, key];
    if (isPlainObject(value) && !isSecretRef(value)) {
      collectOrigins(value, sourceName, into, path);
    } else {
      into[path.join('.')] = sourceName;
    }
  }
}

/**
 * Converts validation failures into a structured error.
 *
 * Only the path and the rule that failed are reported. Rejected values are
 * never echoed, because a rejected value may itself be a credential.
 */
function toConfigError(error: z.ZodError): FerretError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    rule: issue.code,
    message: issue.message,
  }));
  const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  return new FerretError(ErrorCode.CONFIG_INVALID, `Configuration is invalid — ${summary}`, {
    details: { issues },
    remediation:
      'Correct the listed configuration values. Run `ferret config list --explain` to see which layer supplied each one.',
  });
}

export interface ResolvedConfig {
  readonly config: FerretConfig;
  /** Source names that contributed, ordered by increasing precedence. */
  readonly sources: readonly string[];
  /** Dotted path to the name of the source that supplied it. */
  readonly origins: Readonly<Record<string, string>>;
}

export interface ResolveOptions {
  /** Environment used to resolve secret references. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolves configuration from the supplied sources in precedence order.
 *
 * Resolution must succeed with no configuration at all: a user is never required
 * to author a configuration file merely to start Ferret. Secret references are
 * resolved before validation, so the schema — and every consumer after it — sees
 * only plain values.
 */
export function resolveConfig(
  sources: readonly ConfigSource[] = [environmentSource()],
  options: ResolveOptions = {},
): ResolvedConfig {
  const ordered = [...sources].sort((a, b) => a.precedence - b.precedence);

  const origins: Record<string, string> = {};
  const fragments: Record<string, unknown>[] = [];
  for (const source of ordered) {
    const fragment = source.read();
    fragments.push(fragment);
    collectOrigins(fragment, source.name, origins);
  }

  const merged = resolveSecrets(mergeFragments(fragments), {
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const result = ferretConfigSchema.safeParse(merged);
  if (!result.success) throw toConfigError(result.error);

  return {
    config: result.data,
    sources: ordered.map((source) => source.name),
    origins,
  };
}

/** Validates an in-memory configuration object. */
export function parseConfig(input: unknown): FerretConfig {
  const result = ferretConfigSchema.safeParse(input);
  if (!result.success) throw toConfigError(result.error);
  return result.data;
}

export interface DescribeConfigOptions {
  /**
   * Additional paths to redact, decided by the caller.
   *
   * Redaction by key name cannot know that a provider stores its token under
   * `pat`. EPIC-015 lets a provider declare which of its option paths are
   * secrets and passes the resulting predicate here, so the core still enforces
   * redaction and still does not need to know what any provider's options mean.
   *
   * The path arrives as segments rather than a dotted string because a provider
   * id contains dots, and a joined path could not be split back apart.
   */
  readonly secret?: (path: readonly string[]) => boolean;
}

/**
 * Renders configuration for display, replacing every secret-bearing field.
 *
 * This is the only supported way to show configuration to a human, a log or an
 * AI client.
 */
export function describeConfig(
  config: FerretConfig,
  options: DescribeConfigOptions = {},
): Record<string, unknown> {
  const isSecretPath = options.secret;
  const describe = (value: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(value)) return value.map((entry, index) => describe(entry, [...path, String(index)]));
    // A leaf goes through the shared redactor — EPIC-100.
    //
    // This function redacted by key name and by declared path, and not by value
    // shape, so a credential in a field whose *name* is innocuous rendered
    // verbatim. The case is concrete rather than theoretical: a provider option
    // holding a connection URL with userinfo in it, under a field called
    // `baseUrl`, and this is the boundary `ferret config` and
    // `ferret doctor --show-config` print through. (No worked example here —
    // the packaging scan reads the shipped bytes and a realistic one in a
    // comment trips it, correctly. It tripped on the first draft of this one.)
    //
    // `redact` already handles exactly this — by value shape and by URI
    // userinfo — and the log path has used it since EPIC-001. Over-redacting a
    // rendered value costs nothing here, which is the same trade `redact.ts`
    // documents for every other surface it guards.
    if (typeof value !== 'object' || value === null) return redact(value);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      const child = [...path, key];
      output[key] = isSecretKey(key) || isSecretPath?.(child) === true ? REDACTED : describe(entry, child);
    }
    return output;
  };
  return describe(config, []) as Record<string, unknown>;
}
