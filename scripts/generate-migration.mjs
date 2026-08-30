#!/usr/bin/env node
/**
 * Generates the next migration by diffing `src/storage/schema/` against what
 * drizzle-kit has already recorded, then promoting the result into the
 * `NNNN_name.sql` sequence EPIC-002's migrator reads.
 *
 * The adapter exists because the two numbering schemes disagree and neither is
 * negotiable: drizzle-kit numbers from `0000` and owns a `meta/` snapshot it
 * needs in order to diff, while Ferret's migrator requires a gap-free sequence
 * from `0001` and refuses anything it cannot order totally (EPIC-002). So
 * drizzle-kit keeps its own directory, and exactly one file is copied out of it.
 *
 * Usage: npm run migration:generate -- <snake_case_name>
 *
 * Review the generated SQL before committing it. A diff tool proposes DDL; it
 * does not know that dropping a column loses evidence.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'src', 'storage', 'migrations');
const STAGING = join(MIGRATIONS, 'staging');

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: npm run migration:generate -- <snake_case_name>');
  process.exit(2);
}

const before = new Set(existsSync(STAGING) ? readdirSync(STAGING).filter((f) => f.endsWith('.sql')) : []);

mkdirSync(STAGING, { recursive: true });
execFileSync(
  process.execPath,
  [join(ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'generate', `--name=${name}`],
  { cwd: ROOT, stdio: 'inherit' },
);

const produced = readdirSync(STAGING)
  .filter((file) => file.endsWith('.sql') && !before.has(file))
  .sort();

if (produced.length === 0) {
  console.log('generate-migration: schema is unchanged; nothing to do.');
  process.exit(0);
}
if (produced.length > 1) {
  console.error(`generate-migration: expected one new file, got ${produced.length}: ${produced.join(', ')}`);
  process.exit(1);
}

// Ferret's sequence continues from the highest existing migration, which is
// independent of drizzle-kit's own numbering.
const existing = readdirSync(MIGRATIONS)
  .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
  .map((file) => Number(file.slice(0, 4)));
const next = String((existing.length === 0 ? 0 : Math.max(...existing)) + 1).padStart(4, '0');

const target = join(MIGRATIONS, `${next}_${name}.sql`);
copyFileSync(join(STAGING, produced[0]), target);

// drizzle-kit separates statements with its own marker, which is meaningful to
// its runner and noise to PostgreSQL. Ferret sends the file as one script.
const sql = readFileSync(target, 'utf8').replaceAll('--> statement-breakpoint', '').replace(/\n{3,}/g, '\n\n');
writeFileSync(target, sql, 'utf8');

console.log(`generate-migration: wrote src/storage/migrations/${next}_${name}.sql`);
console.log('Review it before committing. A schema diff does not know that dropping a column loses evidence.');
