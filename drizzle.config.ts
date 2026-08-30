import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit, used for one job: generating migration SQL by diffing the schema
 * in `src/storage/schema/` against the snapshot of what has already been
 * applied.
 *
 * TECHNOLOGY-DECISIONS §3 selected Drizzle over Kysely specifically for this —
 * Ferret's canonical model will change repeatedly under EPIC-010, and
 * hand-writing every diff is where schema bugs come from.
 *
 * Output lands in `src/storage/migrations/staging/`, and
 * `scripts/generate-migration.mjs` promotes it into the `NNNN_name.sql`
 * sequence EPIC-002's migrator reads. Two directories rather than one because
 * drizzle-kit numbers from 0000 and owns its `meta/` snapshot, while Ferret
 * requires a gap-free sequence from 0001 and refuses anything else.
 *
 * It is a devDependency and never runs in production: `dialect` and `schema` are
 * all it needs, and no database credentials appear here.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/storage/schema/*.ts',
  out: './src/storage/migrations/staging',
  strict: true,
  verbose: true,
});
