#!/usr/bin/env node
/**
 * Recomputes the golden dataset's manifest checksum — EPIC-096 AC-8.
 *
 * The dataset refuses to load when its content and its manifest disagree, which
 * is deliberate: a measurement cites a checksum. Run this after changing the
 * corpus, the history or the labels, and commit the manifest with the change.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const { computeGoldenChecksum } = await import('../dist/evaluation/index.js');

const root = 'datasets/golden';
const manifestPath = `${root}/manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const checksum = computeGoldenChecksum(root);

if (manifest.checksum === checksum) {
  console.log(`golden dataset checksum unchanged: ${checksum}`);
} else {
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, checksum }, null, 2)}\n`, 'utf8');
  console.log(`golden dataset checksum updated: ${checksum}`);
}
