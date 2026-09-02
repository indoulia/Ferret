import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { buildCodeSymbols, type CodeSymbol } from '../code/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { ParserFramework } from '../parsing/index.js';
import type { ProviderOperationContext } from '../providers/index.js';

/**
 * Measuring what a parser actually extracts — EPIC-097.
 *
 * Governance §19 names parsing in the same sentence as retrieval: *"'Perfect'
 * parsing or retrieval is not an acceptable quality claim without measurable
 * validation."* Retrieval got its number in EPIC-098. Parsing did not have one.
 *
 * The shape is EPIC-098's, deliberately: a labelled expectation, a run, and a
 * report that prints every figure and gates on only the ones the data supports.
 * A harness that asserted a precision floor over eleven files would be
 * enshrining whatever the first run produced.
 *
 * **The corpus is EPIC-096's and is not modified.** Only the expectations are
 * authored here, so a parser measurement and a retrieval measurement are made
 * against the same eleven files and can be compared.
 */

export interface ExpectedSymbol {
  readonly name: string;
  readonly kind: string;
  /** Checked only when the label supplies one. */
  readonly qualifiedName?: string;
}

export interface ParsingLabel {
  readonly path: string;
  /**
   * Which corpus the path is relative to.
   *
   * Two, because they answer different questions. EPIC-096's golden corpus is
   * shared with the retrieval harness so the two measurements are comparable,
   * and it is read-only here. This Epic's own fixtures exist because a corpus
   * of eleven small, well-formed files cannot fail: the first run over it
   * scored 1.00 on every metric, which measures the corpus rather than the
   * parser.
   */
  readonly corpus?: 'golden' | 'parsing';
  /** `null` when no parser is expected to claim the file. */
  readonly language: string | null;
  readonly unparsedReason?: string;
  readonly expected: readonly ExpectedSymbol[];
}

export interface ParsingDataset {
  readonly version: string;
  readonly description: string;
  readonly checksum: string;
  readonly files: readonly ParsingLabel[];
}

export interface FileParseMeasurement {
  readonly path: string;
  readonly parsed: boolean;
  readonly unparsedReason: string | undefined;
  readonly expected: number;
  readonly found: number;
  readonly matched: number;
  /** Symbols found that no label expects. Named, so a surprise is diagnosable. */
  readonly unexpected: readonly string[];
  /** Symbols a label expects that were not found. */
  readonly missing: readonly string[];
  /**
   * Found symbols whose recorded span, sliced from the file, contains the name.
   *
   * The measurement that needs no label at all: a span is either right about
   * where the declaration is or it is not, and the file says which. It is
   * therefore the one figure here that is a **correctness invariant** rather
   * than a quality target, and the only one this Epic gates on.
   */
  readonly spansValid: number;
  readonly spansChecked: number;
}

export interface ParsingQualityReport {
  readonly dataset: { readonly version: string; readonly checksum: string };
  readonly files: readonly FileParseMeasurement[];
  readonly aggregate: {
    readonly filesMeasured: number;
    readonly filesParsed: number;
    readonly filesUnparsed: number;
    /** Matched ÷ found, over every file a parser claimed. */
    readonly symbolPrecision: number | undefined;
    /** Matched ÷ expected. */
    readonly symbolRecall: number | undefined;
    /** Valid ÷ checked. A correctness invariant: anything below 1 is a defect. */
    readonly spanValidity: number | undefined;
    /**
     * Files a parser was expected to claim and did not, or claimed and was not
     * expected to. Gated on zero: the label says which files have a parser, and
     * disagreeing with it is a fact about the product, not a ranking opinion.
     */
    readonly parseDisagreements: number;
  };
}

/** Loads the parser expectations, and the digest that identifies them. */
export function loadParsingDataset(root: string): ParsingDataset {
  let raw: string;
  try {
    raw = readFileSync(join(root, 'labels.json'), 'utf8');
  } catch (error) {
    throw new FerretError(ErrorCode.CONFIG_INVALID, 'The parsing dataset could not be read', {
      details: { root },
      remediation: 'Check that datasets/parsing/labels.json is present.',
      cause: error,
    });
  }

  const parsed = JSON.parse(raw) as Omit<ParsingDataset, 'checksum'>;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new FerretError(ErrorCode.CONFIG_INVALID, 'The parsing dataset labels no files', {
      details: { root },
      remediation: 'A harness over an empty label set measures nothing and reports success.',
    });
  }

  // The digest identifies the expectations, so a figure can cite what produced
  // it. Line endings are normalised for the reason EPIC-002 normalises
  // migration checksums: this repository is developed on two platforms.
  const checksum = createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  return { ...parsed, checksum };
}

/**
 * Runs the parser over the labelled corpus and scores it.
 *
 * `roots` names both corpora. Nothing is written; the harness reads files and a
 * parser, and returns numbers.
 */
export async function measureParsingQuality(
  dataset: ParsingDataset,
  parser: ParserFramework,
  roots: { readonly golden: string; readonly parsing: string },
  context: ProviderOperationContext,
): Promise<ParsingQualityReport> {
  const files: FileParseMeasurement[] = [];

  for (const label of dataset.files) {
    const root = label.corpus === 'parsing' ? roots.parsing : roots.golden;
    const bytes = readFileSync(join(root, ...label.path.split(posix.sep)));
    const outcome = await parser.parse({ path: label.path, bytes }, context);

    if (!outcome.parsed) {
      files.push({
        path: label.path,
        parsed: false,
        unparsedReason: outcome.reason,
        expected: label.expected.length,
        found: 0,
        matched: 0,
        unexpected: [],
        missing: label.expected.map((symbol) => symbol.name),
        spansValid: 0,
        spansChecked: 0,
      });
      continue;
    }

    const symbols = buildCodeSymbols(outcome, { scope: 'evaluation', path: label.path });
    files.push(measureFile(label, symbols, bytes));
  }

  return { dataset: { version: dataset.version, checksum: dataset.checksum }, files, aggregate: aggregate(dataset, files) };
}

function measureFile(label: ParsingLabel, symbols: readonly CodeSymbol[], bytes: Uint8Array): FileParseMeasurement {
  const expectedNames = new Set(label.expected.map((symbol) => symbol.name));
  const foundNames = symbols.map((symbol) => symbol.name);

  const matched = label.expected.filter((expected) =>
    symbols.some(
      (symbol) =>
        symbol.name === expected.name &&
        (expected.qualifiedName === undefined || symbol.qualifiedName === expected.qualifiedName),
    ),
  );

  let spansValid = 0;
  let spansChecked = 0;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  for (const symbol of symbols) {
    // A span with no extent says nothing about where the declaration is, and
    // counting it either way would move the number without measuring anything.
    if (symbol.span.endByte <= symbol.span.startByte) continue;
    spansChecked += 1;
    // Sliced from the file itself. The label does not say where the symbol is
    // and does not need to: the file is the authority, which is what makes this
    // the one figure here that cannot be wrong about its own expectation.
    if (text.slice(symbol.span.startByte, symbol.span.endByte).includes(symbol.name)) spansValid += 1;
  }

  return {
    path: label.path,
    parsed: true,
    unparsedReason: undefined,
    expected: label.expected.length,
    found: symbols.length,
    matched: matched.length,
    unexpected: foundNames.filter((name) => !expectedNames.has(name)),
    missing: label.expected.filter((symbol) => !matched.includes(symbol)).map((symbol) => symbol.name),
    spansValid,
    spansChecked,
  };
}

function ratio(numerator: number, denominator: number): number | undefined {
  // `undefined`, not zero: nothing measured is not the same as nothing correct,
  // and EPIC-098 made the same distinction for the same reason.
  return denominator === 0 ? undefined : numerator / denominator;
}

function aggregate(dataset: ParsingDataset, files: readonly FileParseMeasurement[]): ParsingQualityReport['aggregate'] {
  const sum = (pick: (file: FileParseMeasurement) => number): number => files.reduce((total, file) => total + pick(file), 0);

  const disagreements = files.filter((file) => {
    const label = dataset.files.find((entry) => entry.path === file.path);
    if (label === undefined) return true;
    // The label says whether a parser should claim this file. Disagreeing is a
    // fact about the product — a language silently lost, or one claimed by the
    // wrong parser — rather than a ranking opinion.
    return file.parsed !== (label.language !== null);
  }).length;

  return {
    filesMeasured: files.length,
    filesParsed: files.filter((file) => file.parsed).length,
    filesUnparsed: files.filter((file) => !file.parsed).length,
    symbolPrecision: ratio(sum((file) => file.matched), sum((file) => file.found)),
    symbolRecall: ratio(sum((file) => file.matched), sum((file) => file.expected)),
    spanValidity: ratio(sum((file) => file.spansValid), sum((file) => file.spansChecked)),
    parseDisagreements: disagreements,
  };
}
