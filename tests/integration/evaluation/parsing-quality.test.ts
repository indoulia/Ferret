import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { ParserFramework, loadParsingDataset, measureParsingQuality, type ParsingDataset } from '../../../src/index.js';
import { createCodeParserProvider } from '../../../src/parsers/index.js';
import { createTestOperationContext } from '../../../src/providers/sdk/testing.js';

/**
 * EPIC-097 — the first measured figures for what Ferret's parser extracts.
 *
 * Governance §19 names parsing beside retrieval: *"'Perfect' parsing or
 * retrieval is not an acceptable quality claim without measurable validation."*
 * EPIC-098 produced retrieval's number. This produces parsing's, over the same
 * eleven files, so the two are comparable.
 *
 * **The figures are printed; only two things are asserted.** A precision floor
 * over eleven files would enshrine whatever the first run happened to produce,
 * which is the mistake EPIC-098 explicitly refused to make. What *is* gated is
 * the pair the data actually supports:
 *
 * - **span validity** — a reported span either contains the symbol it names or
 *   it does not, and the file is the authority. A correctness invariant, not a
 *   quality target.
 * - **parse disagreements** — the label says which files a parser should claim.
 *   A language silently lost is a fact about the product.
 */

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const parser = new ParserFramework({ parsers: [createCodeParserProvider()] });

let dataset: ParsingDataset;

beforeAll(() => {
  dataset = loadParsingDataset(resolve(ROOT, 'datasets/parsing'));
});

describe('the parsing dataset', () => {
  it('labels every corpus file, so the measurement is not over a subset', () => {
    // A harness over half the corpus reports a number about half the corpus and
    // reads like a number about the corpus.
    expect(dataset.files.length).toBeGreaterThanOrEqual(16);
    expect(dataset.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expects at least one symbol from every file it says has a parser', () => {
    for (const label of dataset.files) {
      if (label.language === null) continue;
      expect(label.expected.length, label.path).toBeGreaterThan(0);
    }
  });
});

describe('measuring the parser over the golden corpus', () => {
  it('produces a well-formed report, and prints every figure', async () => {
    const report = await measureParsingQuality(
      dataset,
      parser,
      { golden: resolve(ROOT, 'datasets/golden/corpus'), parsing: resolve(ROOT, 'datasets/parsing/corpus') },
      createTestOperationContext(),
    );

    process.stderr.write(`\n[EPIC-097] ${JSON.stringify(report.aggregate)}\n`);
    for (const file of report.files) {
      process.stderr.write(
        `[EPIC-097] ${file.path.padEnd(44)} parsed=${String(file.parsed)} ` +
          `expected=${String(file.expected)} found=${String(file.found)} matched=${String(file.matched)} ` +
          `spans=${String(file.spansValid)}/${String(file.spansChecked)}` +
          `${file.missing.length === 0 ? '' : ` missing=[${file.missing.join(',')}]`}` +
          `${file.unexpected.length === 0 ? '' : ` unexpected=[${file.unexpected.join(',')}]`}\n`,
      );
    }

    expect(report.files).toHaveLength(dataset.files.length);
    expect(report.dataset.checksum).toBe(dataset.checksum);
    expect(report.aggregate.filesMeasured).toBe(dataset.files.length);
  }, 120_000);

  it('claims exactly the files the labels say have a parser — AC-4', async () => {
    // A markdown file must come back unparsed with a reason, and a TypeScript
    // file must not. Both directions matter: a parser that silently claimed
    // everything would score well on recall and be badly wrong.
    const report = await measureParsingQuality(
      dataset,
      parser,
      { golden: resolve(ROOT, 'datasets/golden/corpus'), parsing: resolve(ROOT, 'datasets/parsing/corpus') },
      createTestOperationContext(),
    );

    expect(report.aggregate.parseDisagreements, JSON.stringify(report.files.map((file) => [file.path, file.parsed]))).toBe(0);
  }, 120_000);

  it('records a span that actually contains its symbol — AC-5', async () => {
    // The one figure that needs no label: the file says where the declaration
    // is. Anything below 1 is a defect in span computation, not a ranking
    // opinion, which is why it is the threshold this Epic gates on.
    const report = await measureParsingQuality(
      dataset,
      parser,
      { golden: resolve(ROOT, 'datasets/golden/corpus'), parsing: resolve(ROOT, 'datasets/parsing/corpus') },
      createTestOperationContext(),
    );

    expect(report.aggregate.spanValidity).toBe(1);
  }, 120_000);

  it('never reports a ratio outside 0..1, or NaN', async () => {
    const report = await measureParsingQuality(
      dataset,
      parser,
      { golden: resolve(ROOT, 'datasets/golden/corpus'), parsing: resolve(ROOT, 'datasets/parsing/corpus') },
      createTestOperationContext(),
    );

    for (const [name, value] of Object.entries(report.aggregate)) {
      if (typeof value !== 'number') continue;
      expect(Number.isNaN(value), name).toBe(false);
      if (name.startsWith('symbol') || name === 'spanValidity') {
        expect(value, name).toBeGreaterThanOrEqual(0);
        expect(value, name).toBeLessThanOrEqual(1);
      }
    }
  }, 120_000);
});
