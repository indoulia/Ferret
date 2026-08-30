import { z } from 'zod';

import { LOG_LEVELS } from '../logging/index.js';

export const DEFAULT_DATABASE_PORT = 5432;

/**
 * PostgreSQL connection details.
 *
 * Governance §2 fixes this as the entire mandatory configuration surface:
 * host, port, database, user, password. Every field is optional here because
 * EPIC-001 does not open a connection — completeness is enforced by the
 * subsystem that needs it (EPIC-002), not by merely starting the runtime.
 */
export const databaseConfigSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_DATABASE_PORT),
  database: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  password: z.string().optional(),
});

/**
 * The complete Ferret configuration surface as of EPIC-001.
 *
 * EPIC-003 extends this schema with precedence layers, repository policy and
 * session scope. Nothing here may become mandatory for starting Ferret.
 */
export const ferretConfigSchema = z.object({
  logLevel: z.enum(LOG_LEVELS).default('warn'),
  database: databaseConfigSchema.default({ port: DEFAULT_DATABASE_PORT }),
  /** Repository paths or globs excluded from indexing. Applied by EPIC-022. */
  exclude: z.array(z.string().min(1)).default([]),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
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
