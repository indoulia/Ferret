import type { z } from 'zod';

import { ErrorCode, FerretError, REDACTED, isSecretKey } from '../errors/index.js';

import { ferretConfigSchema, type FerretConfig } from './schema.js';

/**
 * A layer of configuration input.
 *
 * EPIC-001 ships only defaults and environment variables. EPIC-003 adds file,
 * repository-policy and session-scope sources by implementing this interface;
 * the runtime does not change when it does.
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
 * Precedence ladder from Governance §16. EPIC-001 populates the first two
 * rungs; the remainder are reserved so later Epics slot in without renumbering.
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

/** Environment variables read by EPIC-001, and the config path each populates. */
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

/** Reads the EPIC-001 environment surface. Unset variables contribute nothing. */
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

function mergeFragments(fragments: readonly Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment)) {
      const existing = merged[key];
      const bothPlainObjects =
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof existing === 'object' &&
        existing !== null &&
        !Array.isArray(existing);
      merged[key] = bothPlainObjects
        ? mergeFragments([existing as Record<string, unknown>, value as Record<string, unknown>])
        : value;
    }
  }
  return merged;
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
      'Correct the listed configuration values. Run `ferret env` to confirm which environment variables Ferret can see.',
  });
}

export interface ResolvedConfig {
  readonly config: FerretConfig;
  /** Source names that contributed, ordered by increasing precedence. */
  readonly sources: readonly string[];
}

/**
 * Resolves configuration from the supplied sources in precedence order.
 *
 * Resolution must succeed with no configuration at all: a user is never
 * required to author a configuration file merely to start Ferret.
 */
export function resolveConfig(sources: readonly ConfigSource[] = [environmentSource()]): ResolvedConfig {
  const ordered = [...sources].sort((a, b) => a.precedence - b.precedence);
  const fragments = ordered.map((source) => source.read());
  const result = ferretConfigSchema.safeParse(mergeFragments(fragments));
  if (!result.success) throw toConfigError(result.error);
  return {
    config: result.data,
    sources: ordered.map((source) => source.name),
  };
}

/** Validates an in-memory configuration object. */
export function parseConfig(input: unknown): FerretConfig {
  const result = ferretConfigSchema.safeParse(input);
  if (!result.success) throw toConfigError(result.error);
  return result.data;
}

/**
 * Renders configuration for display, replacing every secret-bearing field.
 *
 * This is the only supported way to show configuration to a human, a log or an
 * AI client.
 */
export function describeConfig(config: FerretConfig): Record<string, unknown> {
  const describe = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(describe);
    if (typeof value !== 'object' || value === null) return value;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      output[key] = isSecretKey(key) ? REDACTED : describe(entry);
    }
    return output;
  };
  return describe(config) as Record<string, unknown>;
}
