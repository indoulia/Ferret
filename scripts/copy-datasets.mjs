#!/usr/bin/env node
/**
 * Copies the golden evaluation dataset beside the compiled loader — EPIC-096.
 *
 * The same reason the migrations and grammars are copied: without this step
 * `dist/` ships a loader with nothing to load, and EPIC-099's provider
 * conformance harness — which runs in a provider author's own repository, not in
 * this one — would have no corpus to measure against.
 *
 * `tests/integration/packaging.test.ts` asserts the files reach the tarball.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'datasets', 'golden');
const target = join(root, 'dist', 'datasets', 'golden');

if (!existsSync(source)) {
  console.error('copy-datasets: datasets/golden is missing');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log('copy-datasets: datasets/golden -> dist/datasets/golden');
