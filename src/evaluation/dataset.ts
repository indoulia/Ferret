import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { canonicalId, canonicalKey } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * The golden evaluation dataset — EPIC-096.
 *
 * Governance §19: "Golden datasets must be used to measure retrieval precision,
 * recall, ranking, evidence correctness, and completeness. 'Perfect' parsing or
 * retrieval is not an acceptable quality claim without measurable validation."
 * Ferret had none, and every retrieval Epic was validated by example — a
 * correctness demonstration, which is worth having and is not a rate.
 *
 * **This module measures nothing.** It supplies labelled data and the identity
 * contract a harness resolves against; EPIC-097 through EPIC-100 own the
 * measuring. A dataset that also scored itself would make four harnesses four
 * copies of one scorer.
 */

/** How relevant an expected result is, so ranking is measurable and not binary. */
export const Relevance = {
  /** Marginally related. Returning it is not wrong; ranking it first is. */
  MARGINAL: 1,
  /** Relevant. */
  RELEVANT: 2,
  /** The answer. A query with one of these has an unambiguous best result. */
  EXACT: 3,
} as const;

export type Relevance = (typeof Relevance)[keyof typeof Relevance];

/**
 * Which retrieval path a query is a label for.
 *
 * Kept to what Ferret can answer today. Semantic is deliberately absent: Ferret
 * ships no embedding provider, so a semantic label would be unmeasurable rather
 * than aspirational.
 */
export const QueryShape = { EXACT: 'exact', TEXT: 'text' } as const;
export type QueryShape = (typeof QueryShape)[keyof typeof QueryShape];

/**
 * What an expectation points at, in source terms.
 *
 * Never a generated id. Ferret derives an entity's id from
 * `canonicalKey(kind, sourceSystem, scope, sourceId)`, so a label can name the
 * source identity and be resolved by the same function the indexer uses — which
 * is what makes a label survive a re-index.
 *
 * `scope` is **symbolic**. A file is keyed within its repository and a
 * repository's id derives from where it was found, so a corpus indexed from a
 * temporary directory produces different ids on every run. The label says
 * `"corpus"` and {@link resolveIdentity} binds that to the repository actually
 * indexed. Writing a UUID here would make the dataset a snapshot of one run.
 */
const identitySchema = z.strictObject({
  kind: z.string().min(1),
  sourceSystem: z.string().min(1),
  scope: z.string().min(1),
  sourceId: z.string().min(1),
});

const expectedSchema = identitySchema.extend({
  relevance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

const querySchema = z.strictObject({
  id: z.string().min(1),
  shape: z.enum([QueryShape.EXACT, QueryShape.TEXT]),
  query: z.string().min(1),
  /** Why this label exists. A label nobody can justify is a label nobody can fix. */
  intent: z.string().min(1),
  expected: z.array(expectedSchema),
});

const evidenceSchema = z.strictObject({
  id: z.string().min(1),
  subject: identitySchema,
  intent: z.string().min(1),
  /** Fewest observations Ferret must hold about the subject. */
  atLeast: z.number().int().min(1),
});

const labelsSchema = z.strictObject({
  queries: z.array(querySchema).min(1),
  evidence: z.array(evidenceSchema).min(1),
});

const historySchema = z.strictObject({
  author: z.strictObject({ name: z.string().min(1), email: z.string().min(1) }),
  startedAt: z.string().min(1),
  commits: z
    .array(
      z.strictObject({
        subject: z.string().min(1),
        files: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

const manifestSchema = z.strictObject({
  version: z.string().min(1),
  description: z.string().min(1),
  /** SHA-256 over the corpus, the history and the labels. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

export type GoldenIdentity = z.infer<typeof identitySchema>;
export type GoldenExpected = z.infer<typeof expectedSchema>;
export type GoldenQuery = z.infer<typeof querySchema>;
export type GoldenEvidenceExpectation = z.infer<typeof evidenceSchema>;
export type GoldenHistory = z.infer<typeof historySchema>;

export interface GoldenDataset {
  readonly version: string;
  readonly description: string;
  /** What the manifest records. Every measurement cites it. */
  readonly checksum: string;
  /** What the files on disk actually hash to. Equal to `checksum` after loading. */
  readonly computedChecksum: string;
  readonly root: string;
  readonly corpus: readonly string[];
  readonly history: GoldenHistory;
  readonly queries: readonly GoldenQuery[];
  readonly evidence: readonly GoldenEvidenceExpectation[];
}

/**
 * Where the dataset lives.
 *
 * Two locations, tried in order, because there are two legitimate callers. In
 * this repository the dataset is a source artefact at `datasets/golden`; in an
 * installed package it sits beside the compiled loader, copied there by
 * `scripts/copy-datasets.mjs` — which is what lets EPIC-099's conformance
 * harness run inside a provider author's repository rather than only inside
 * this one.
 *
 * Resolved once, at load, rather than guessed per call.
 */
export const GOLDEN_DATASET_DIR = ((): string => {
  const beside = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'datasets', 'golden');
  return existsSync(join(beside, 'manifest.json')) ? beside : 'datasets/golden';
})();

/** The symbolic scope a corpus label is written against. */
export const CORPUS_SCOPE = 'corpus';

/** Repository-relative corpus paths, sorted, with POSIX separators. */
function corpusFiles(corpusRoot: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(relative(corpusRoot, full).split(sep).join(posix.sep));
    }
  };
  walk(corpusRoot);
  return found.sort();
}

/**
 * SHA-256 over the corpus, the history and the labels.
 *
 * Paths are hashed alongside content, so moving a file changes the checksum —
 * a label names a path, and a dataset whose paths moved is a different dataset.
 * Content is hashed as raw bytes with the path normalised to POSIX separators,
 * so the same checkout on Windows and Linux produces the same digest.
 */
function computeChecksum(root: string, files: readonly string[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8');
    hash.update(readFileSync(join(root, 'corpus', ...file.split(posix.sep))));
  }
  for (const name of ['history.json', 'labels.json']) {
    hash.update(name, 'utf8');
    // Newlines normalised: git may check these out with CRLF, and a checksum
    // that depended on the line ending would fail on one platform and pass on
    // the other, which is worse than no checksum.
    hash.update(readFileSync(join(root, name), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  }
  return hash.digest('hex');
}

/**
 * The checksum the manifest should carry for the dataset on disk.
 *
 * Exported so `scripts/golden-checksum.mjs` recomputes it with the same code the
 * loader verifies against — two implementations of one digest is two digests.
 */
export function computeGoldenChecksum(root: string = GOLDEN_DATASET_DIR): string {
  return computeChecksum(root, corpusFiles(join(root, 'corpus')));
}

function invalid(message: string, details: Record<string, unknown>): FerretError {
  return new FerretError(ErrorCode.CONFIG_INVALID, message, {
    details,
    remediation:
      'Fix the label or the corpus so they agree, then recompute the manifest checksum ' +
      'with `node scripts/golden-checksum.mjs`.',
  });
}

/**
 * Loads and validates the dataset.
 *
 * Refuses rather than warns. A label that resolves to nothing measures fiction,
 * and a harness reading a broken dataset would report a precision figure about
 * a corpus that does not contain what it was asked for.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` when the dataset is malformed, its
 * checksum does not match, or a label names something the corpus lacks.
 */
export function loadGoldenDataset(root: string = GOLDEN_DATASET_DIR): GoldenDataset {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')),
  );
  const history = historySchema.parse(JSON.parse(readFileSync(join(root, 'history.json'), 'utf8')));
  const labels = labelsSchema.parse(JSON.parse(readFileSync(join(root, 'labels.json'), 'utf8')));

  const corpus = corpusFiles(join(root, 'corpus'));
  if (corpus.length === 0) {
    throw invalid('The golden corpus is empty', { root });
  }

  const computedChecksum = computeChecksum(root, corpus);
  if (computedChecksum !== manifest.checksum) {
    // Not a warning. A measurement cites a checksum, so a dataset whose content
    // has moved away from its manifest cannot be cited honestly.
    throw invalid('The golden dataset does not match its manifest checksum', {
      expected: manifest.checksum,
      actual: computedChecksum,
    });
  }

  assertSelfConsistent({ corpus, history, labels });

  return Object.freeze({
    version: manifest.version,
    description: manifest.description,
    checksum: manifest.checksum,
    computedChecksum,
    root,
    corpus: Object.freeze(corpus),
    history,
    queries: Object.freeze(labels.queries),
    evidence: Object.freeze(labels.evidence),
  });
}

/**
 * Every label points at something the corpus contains — EPIC-096 AC-9.
 *
 * The one property this Epic can prove without a harness, and the reason it runs
 * in `verify`: a label naming a deleted file scores zero in a harness, which
 * reads as "retrieval got worse" rather than "the dataset is broken".
 */
function assertSelfConsistent(dataset: {
  corpus: readonly string[];
  history: GoldenHistory;
  labels: { queries: readonly GoldenQuery[]; evidence: readonly GoldenEvidenceExpectation[] };
}): void {
  const present = new Set(dataset.corpus);

  const checkIdentity = (identity: GoldenIdentity, label: string): void => {
    if (identity.scope !== CORPUS_SCOPE) {
      throw invalid(`Label ${label} names an unknown scope`, {
        label,
        scope: identity.scope,
        known: [CORPUS_SCOPE],
      });
    }
    if (identity.kind === 'file' && !present.has(identity.sourceId)) {
      throw invalid(`Label ${label} names a file the corpus does not contain`, {
        label,
        sourceId: identity.sourceId,
      });
    }
  };

  const ids = new Set<string>();
  for (const query of dataset.labels.queries) {
    if (ids.has(query.id)) throw invalid(`Duplicate label id ${query.id}`, { id: query.id });
    ids.add(query.id);
    for (const expected of query.expected) checkIdentity(expected, query.id);
  }
  for (const expectation of dataset.labels.evidence) {
    if (ids.has(expectation.id)) {
      throw invalid(`Duplicate label id ${expectation.id}`, { id: expectation.id });
    }
    ids.add(expectation.id);
    checkIdentity(expectation.subject, expectation.id);
  }

  for (const [index, commit] of dataset.history.commits.entries()) {
    for (const file of commit.files) {
      if (!present.has(file)) {
        throw invalid(`Commit ${String(index)} touches a file the corpus does not contain`, {
          subject: commit.subject,
          file,
        });
      }
    }
  }

  // A corpus file no commit introduces is never indexed, so a label naming it
  // would fail for a reason that has nothing to do with retrieval.
  const committed = new Set(dataset.history.commits.flatMap((commit) => commit.files));
  const orphans = dataset.corpus.filter((file) => !committed.has(file));
  if (orphans.length > 0) {
    throw invalid('Corpus files are never committed by the history', { orphans });
  }

  // A dataset with no absence expectation cannot measure a false positive, and a
  // precision figure that never sees one is not measuring precision.
  if (!dataset.labels.queries.some((query) => query.expected.length === 0)) {
    throw invalid('No label asserts that a query returns nothing', {
      remediationHint: 'Add a query whose expected set is empty — EPIC-096 AC-6.',
    });
  }
}

/**
 * The entity id a label refers to, once the corpus has been indexed somewhere.
 *
 * `bindings` supplies the real id for each symbolic scope. Resolution goes
 * through `canonicalKey` and `canonicalId` — the same functions the indexer uses
 * — rather than a second copy of the rule, so a label and the index cannot
 * disagree about what an answer *is*.
 */
export function resolveIdentity(
  identity: GoldenIdentity,
  bindings: Readonly<Record<string, string>>,
): string {
  const scope = bindings[identity.scope];
  if (scope === undefined) {
    throw invalid(`No binding for scope ${identity.scope}`, {
      scope: identity.scope,
      bound: Object.keys(bindings),
    });
  }
  return canonicalId(
    canonicalKey({
      kind: identity.kind,
      sourceSystem: identity.sourceSystem,
      scope,
      sourceId: identity.sourceId,
    }),
  );
}
