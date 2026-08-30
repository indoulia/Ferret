#!/usr/bin/env node
/**
 * Copies `src/storage/migrations/*.sql` beside the compiled output.
 *
 * `tsc` emits only what it compiles, so without this step `dist/` would ship a
 * migrator with no migrations — an installation that appears to work until the
 * first `ferret init`, which is the worst time to discover it.
 * `tests/integration/packaging.test.ts` asserts the files reach the tarball.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'src', 'storage', 'migrations');
const TARGET = join(ROOT, 'dist', 'storage', 'migrations');

// Removed first so a migration deleted from source cannot linger in a
// rebuilt dist/ and be applied on top of a database that never had it.
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });

const files = readdirSync(SOURCE).filter((name) => name.endsWith('.sql'));
for (const name of files) {
  copyFileSync(join(SOURCE, name), join(TARGET, name));
}

console.log(`copy-migrations: ${files.length} file(s) -> dist/storage/migrations`);
