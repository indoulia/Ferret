#!/usr/bin/env node
/**
 * Copies the tree-sitter grammars EPIC-025 uses beside the compiled parser.
 *
 * `tree-sitter-wasms` carries about forty grammars and 50 MB; Ferret uses four.
 * It is therefore a *dev* dependency, and this step puts only what is used into
 * `dist/`, so an installing user gets four grammars rather than forty.
 *
 * Without this step `dist/` would ship a code parser with no grammars — an
 * installation that appears to work until the first file is parsed.
 * `tests/integration/packaging.test.ts` asserts the files reach the tarball.
 */
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The grammars to copy.
 *
 * Duplicated from `REQUIRED_GRAMMARS` in `src/parsers/code/languages.ts`,
 * because this script runs under plain Node and cannot import TypeScript. The
 * duplication is guarded: `tests/unit/code-parser.test.ts` imports this array
 * and asserts it equals the one the parser derives from its language table, so
 * adding a language without a grammar — or shipping a grammar nothing uses —
 * fails a test rather than a user's first parse.
 */
export const GRAMMARS = ['javascript', 'python', 'tsx', 'typescript'];

function copyGrammars() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = join(root, 'dist', 'parsers', 'code', 'grammars');
  const require = createRequire(import.meta.url);
  const source = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  let bytes = 0;
  for (const grammar of GRAMMARS) {
    const file = `tree-sitter-${grammar}.wasm`;
    const from = join(source, file);
    copyFileSync(from, join(target, file));
    bytes += statSync(from).size;
  }

  // stderr, for the same reason as `clean.mjs`: this runs inside `prepack`, and
  // `npm pack --json` parses stdout.
  process.stderr.write(
    `copy-grammars: ${GRAMMARS.length} grammar(s), ${(bytes / 1024 / 1024).toFixed(1)} MB -> dist/parsers/code/grammars\n`,
  );
}

// Only when run, so a test can import GRAMMARS without copying anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  copyGrammars();
}
