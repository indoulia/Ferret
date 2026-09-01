import { z } from 'zod';

import { scopeSelectorSchema } from '../domain/scope.js';
import { LOG_LEVELS } from '../logging/index.js';

import {
  DEFAULT_EXCLUSIONS,
  exclusionInputSchema,
  mergeExclusions,
  type ExclusionRule,
} from './exclusions.js';

export const DEFAULT_DATABASE_PORT = 5432;

/**
 * PostgreSQL connection details.
 *
 * Governance §2 fixes this as the entire mandatory configuration surface:
 * host, port, database, user, password. Every field is optional here because
 * starting Ferret does not require a database — completeness is enforced by the
 * subsystem that needs it (EPIC-002), not by merely starting the runtime.
 *
 * `password` accepts a secret reference as well as a literal; references are
 * resolved before validation, so by the time a value reaches this schema it is
 * always a plain string. See `secret-ref.ts`.
 */
export const databaseConfigSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DATABASE_PORT),
  database: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  password: z.string().optional(),
  /**
   * What EPIC-002 does when the database is behind the code.
   *
   * `auto` is the default because Governance §15 requires Ferret to provision
   * itself; the other values exist for operators who need a change window and
   * are never required for ordinary use.
   */
  migrate: z.enum(['auto', 'verify', 'off']).default('auto'),
});

/**
 * Per-provider configuration.
 *
 * The core does not know which providers exist — EPIC-013 discovers them — so
 * the *shape* is validated here and the meaning of `options` is left to the
 * provider. Governance §4 keeps provider-specific validation behind the
 * provider contract rather than in the core schema.
 */
export const providerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.unknown()).default({}),
});

/** Provider ids are the dotted identifiers the provider contract defines. */
const PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const providersConfigSchema = z
  .record(
    z.string().regex(PROVIDER_ID, 'Provider ids are lowercase dotted segments, e.g. ferret.storage.postgres'),
    providerConfigSchema,
  )
  .default({});

/**
 * The version of the persisted configuration *file format*.
 *
 * Separate from the Ferret version and from the database schema version: a
 * config file written by an older Ferret must keep working, and one written by
 * a newer Ferret must be refused rather than misread. `store.ts` owns the
 * upgrade path.
 */
export const CONFIG_FILE_VERSION = 1;

/**
 * The complete Ferret configuration surface.
 *
 * Nothing here may become mandatory for starting Ferret: `parseConfig({})` must
 * always succeed, or Governance §2 is broken.
 */
/**
 * The grant a principal is given — EPIC-068.
 *
 * Optional, and its absence means `ANONYMOUS_PRINCIPAL`: read-only, no scopes.
 * A Ferret nobody configured should be the restricted one, and everything it
 * indexes by default is unscoped local source the caller could read with `cat`.
 *
 * Deliberately **one** principal. There is no authentication over stdio — the
 * client is the process's parent — so a role system with several principals would
 * be a configuration file with extra steps (EPIC-068 §4). The permission strings
 * are validated by `principalFrom` rather than by an enum here, so a misspelling
 * produces a message naming the known permissions instead of a schema dump.
 */
const authorizationConfigSchema = z
  .object({
    /** Stable identifier for a log line and a denial. Never a credential. */
    principalId: z.string().min(1).default('ferret.configured'),
    principalClass: z.enum(['operator', 'agent', 'automation']).default('agent'),
    /** Anything absent is denied. Validated against the known vocabulary. */
    permissions: z.array(z.string().min(1)).default([]),
    /** EPIC-058 permission scopes this principal holds. Opaque tokens. */
    permittedScopes: z.array(z.string().min(1)).default([]),
    /** Which repositories, worktrees and sessions it may see — EPIC-009. */
    scope: scopeSelectorSchema.optional(),
  })
  .strict();

export const ferretConfigSchema = z.object({
  logLevel: z.enum(LOG_LEVELS).default('warn'),
  database: databaseConfigSchema.default({ port: DEFAULT_DATABASE_PORT, migrate: 'auto' }),
  /**
   * Paths excluded from indexing. Accepts a bare glob or a full rule.
   *
   * These are the user's *intent*. The rules actually applied are these plus
   * {@link DEFAULT_EXCLUSIONS} — see {@link effectiveExclusions}. Keeping them
   * apart is what lets `ferret config` show what the user chose separately from
   * what Ferret does by default.
   */
  exclude: z.array(exclusionInputSchema).default([]),
  /**
   * Who this Ferret answers for, and what they may do — EPIC-068.
   *
   * Absent means read-only with no scopes. Never widened by anything a client
   * sends or anything Ferret indexed (Governance §12).
   */
  authorization: authorizationConfigSchema.optional(),
  providers: providersConfigSchema,
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type FerretConfig = z.infer<typeof ferretConfigSchema>;

/** The fields EPIC-002 requires before it can open a connection. */
export const REQUIRED_DATABASE_FIELDS = ['host', 'database', 'user', 'password'] as const;

/** True when every field required to connect to PostgreSQL has been supplied. */
export function isDatabaseConfigured(config: FerretConfig): boolean {
  return REQUIRED_DATABASE_FIELDS.every((field) => {
    const value = config.database[field];
    return typeof value === 'string' && value.length > 0;
  });
}

/** Names of the database fields that are still missing, in declaration order. */
export function missingDatabaseFields(config: FerretConfig): string[] {
  return REQUIRED_DATABASE_FIELDS.filter((field) => {
    const value = config.database[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

/**
 * Every exclusion rule that actually applies: Ferret's defaults, then the
 * user's.
 *
 * Defaults come first so they cannot be displaced, and because exclusion is
 * additive a later rule can only ever exclude more.
 */
export function effectiveExclusions(config: FerretConfig): ExclusionRule[] {
  return mergeExclusions(DEFAULT_EXCLUSIONS, config.exclude);
}
