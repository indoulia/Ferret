import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * The set of migrations this build ships.
 *
 * Migrations are `.sql` files rather than generated TypeScript so that the DDL
 * a reviewer reads is byte-for-byte the DDL PostgreSQL executes, and so that
 * `drizzle-kit` output (EPIC-006 onwards) can be dropped in unmodified.
 *
 * They are read from disk once, on first use, and cached. `scripts/copy-migrations.mjs`
 * places them beside the compiled output, and `tests/integration/packaging.test.ts`
 * asserts they are present in the published tarball — a migration that ships
 * missing would turn a working install into an unbootstrappable one.
 */

/** Filenames must be `NNNN_snake_case_name.sql` so ordering is lexical and total. */
const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  /** Monotonic, gap-free from 1. */
  readonly version: number;
  /** The descriptive part of the filename, e.g. `bootstrap`. */
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  /** SHA-256 of the normalized SQL. Detects edits to an applied migration. */
  readonly checksum: string;
}

/**
 * Hashes migration text with line endings normalized.
 *
 * Ferret is developed and run on both Windows and POSIX, and Git may rewrite
 * line endings on checkout. Hashing the raw bytes would make a database
 * migrated on Linux look tampered with when read from a Windows checkout.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL('./migrations/', import.meta.url));
}

function loadMigrations(): readonly Migration[] {
  const directory = migrationsDirectory();

  let filenames: string[];
  try {
    filenames = readdirSync(directory).filter((name) => name.endsWith('.sql'));
  } catch (error) {
    throw new FerretError(
      ErrorCode.MIGRATION_FAILED,
      'Ferret cannot read its own migration files; the installation is incomplete',
      {
        details: { directory },
        remediation: 'Reinstall Ferret. If this persists, the published package is missing dist/storage/migrations.',
        cause: error,
      },
    );
  }

  const migrations = filenames
    .sort()
    .map((filename): Migration => {
      const match = MIGRATION_FILE.exec(filename);
      if (match === null) {
        throw new FerretError(
          ErrorCode.MIGRATION_FAILED,
          `Migration filename "${filename}" does not match NNNN_name.sql`,
          { details: { filename } },
        );
      }
      const [, versionText, name] = match;
      const sql = readFileSync(join(directory, filename), 'utf8');
      return {
        version: Number(versionText),
        name: name ?? filename,
        filename,
        sql,
        checksum: checksumOf(sql),
      };
    });

  // A gap or a duplicate would make "current version" ambiguous, and would let
  // two branches ship the same number with different DDL. Refuse at load time,
  // where it is a build defect, rather than at apply time on a user's database.
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new FerretError(
        ErrorCode.MIGRATION_FAILED,
        `Migration versions must be gap-free from 1 — expected ${String(expected)}, found ${String(migration.version)} in "${migration.filename}"`,
        { details: { expected, found: migration.version, filename: migration.filename } },
      );
    }
  });

  return Object.freeze(migrations);
}

let cached: readonly Migration[] | undefined;

/** Every migration this build ships, ordered by version. */
export function allMigrations(): readonly Migration[] {
  cached ??= loadMigrations();
  return cached;
}

/** The schema version a fully migrated database reaches. `0` when none ship. */
export function targetSchemaVersion(): number {
  const migrations = allMigrations();
  return migrations.length === 0 ? 0 : (migrations[migrations.length - 1]?.version ?? 0);
}
