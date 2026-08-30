// Starts a real migration that never finishes, so the parent test can kill this
// process mid-transaction and assert what the database is left holding.
//
// Uses the built `dist/` migrator rather than a hand-rolled imitation: the
// durability property under test belongs to the shipped code path, not to a
// re-implementation of it that could be atomic when the real one is not.
//
// Connection details arrive through FERRET_DATABASE_* so nothing is written to
// the command line, where it would be visible in a process listing.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const dist = (entry) => pathToFileURL(join(ROOT, 'dist', ...entry)).href;

const { allMigrations, createPool, migrate } = await import(dist(['storage', 'index.js']));
const { parseConfig } = await import(dist(['index.js']));

const sql = 'CREATE TABLE ferret.crash_marker (id integer PRIMARY KEY);\nSELECT pg_sleep(120);\n';
const hanging = {
  version: allMigrations().length + 1,
  name: 'hangs_forever',
  filename: '9999_hangs_forever.sql',
  sql,
  checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
};

const config = parseConfig({
  database: {
    host: process.env.FERRET_DATABASE_HOST,
    port: process.env.FERRET_DATABASE_PORT,
    database: process.env.FERRET_DATABASE_NAME,
    user: process.env.FERRET_DATABASE_USER,
    password: process.env.FERRET_DATABASE_PASSWORD,
  },
});

const nullLogger = {
  level: 'silent',
  child: () => nullLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

const pool = createPool(config, nullLogger);

process.stdout.write('STARTING\n');
await migrate(pool, { logger: nullLogger, migrations: [...allMigrations(), hanging] });

// Unreachable: the parent kills this process while `pg_sleep` is running.
process.stdout.write('UNEXPECTEDLY_FINISHED\n');
