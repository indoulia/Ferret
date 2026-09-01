import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalId, canonicalKey } from '../../src/domain/index.js';
import { ErrorCode } from '../../src/errors/index.js';
import {
  CORPUS_SCOPE,
  GOLDEN_DATASET_DIR,
  computeGoldenChecksum,
  loadGoldenDataset,
  resolveIdentity,
} from '../../src/evaluation/index.js';

/**
 * The golden dataset loads, and refuses when it should — EPIC-096.
 *
 * The refusals carry the weight. A dataset that quietly accepts a label naming a
 * deleted file makes a harness report "retrieval got worse" when what actually
 * happened is that the dataset broke, and the two are indistinguishable from a
 * precision figure alone.
 */

let workspace: string;

/** A copy of the real dataset, so a test can corrupt it without touching the tree. */
function corrupt(mutate: (root: string) => void): string {
  const root = mkdtempSync(join(workspace, 'dataset-'));
  cpSync(GOLDEN_DATASET_DIR, root, { recursive: true });
  mutate(root);
  return root;
}

/** Rewrites the manifest checksum, so a test isolates the failure it means to. */
function reseal(root: string): void {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    checksum: string;
  };
  manifest.checksum = computeGoldenChecksum(root);
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function editLabels(root: string, mutate: (labels: Record<string, unknown>) => void): void {
  const path = join(root, 'labels.json');
  const labels = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(labels);
  writeFileSync(path, `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
  reseal(root);
}

// File-scoped, not per-describe: the refusal tests below copy the dataset too,
// and a fixture that only exists inside one block is a fixture the others get
// `undefined` from.
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ferret-golden-'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('the committed dataset', () => {
  it('loads, and is not empty — AC-1, AC-3', () => {
    // A passing suite must not be an empty one: every assertion below is
    // meaningless if the dataset has no corpus and no labels.
    const dataset = loadGoldenDataset();

    expect(dataset.corpus.length).toBeGreaterThan(5);
    expect(dataset.queries.length).toBeGreaterThan(5);
    expect(dataset.evidence.length).toBeGreaterThan(0);
    expect(dataset.history.commits.length).toBeGreaterThan(0);
  });

  it('matches its manifest checksum, and reports both — AC-8', () => {
    const dataset = loadGoldenDataset();

    expect(dataset.computedChecksum).toBe(dataset.checksum);
    expect(dataset.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('hashes to the same value on a CRLF checkout — AC-1', () => {
    // CI caught this and the local run did not. The digest normalised newlines
    // for the two label files and hashed the corpus as raw bytes, so the same
    // commit produced one checksum on Linux and another on Windows, where git
    // checks text out with CRLF by default and this repository pins nothing in
    // `.gitattributes`.
    //
    // "Reproducible from a clean checkout" is AC-1, and a clean checkout on
    // Windows is a clean checkout.
    const crlf = corrupt((at) => {
      const rewrite = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          const full = join(directory, entry);
          if (statSync(full).isDirectory()) rewrite(full);
          // To LF first, then to CRLF. A bare `\n` → `\r\n` is not idempotent,
          // and on Windows the checkout is *already* CRLF — so the naive version
          // wrote `\r\r\n` and this test failed on the one platform it exists
          // for. CI caught that too.
          else {
            const text = readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
            writeFileSync(full, text.replace(/\n/g, '\r\n'), 'utf8');
          }
        }
      };
      rewrite(at);
    });

    expect(computeGoldenChecksum(crlf)).toBe(computeGoldenChecksum(GOLDEN_DATASET_DIR));
    // And it still loads: the manifest survived the same conversion.
    expect(() => loadGoldenDataset(crlf)).not.toThrow();
  });

  it('does not depend on the EPIC-005 spike corpus — AC-2', () => {
    // `spikes/corpus` is gitignored, generated, and its README says "This is not
    // Ferret. Nothing here ships." A dataset that is not in the repository
    // cannot be a golden dataset.
    const dataset = loadGoldenDataset();
    expect(dataset.root).not.toContain('spikes');
    for (const file of dataset.corpus) expect(file).not.toContain('spikes');
  });

  it('grades relevance rather than labelling it present or absent — AC-5', () => {
    const dataset = loadGoldenDataset();
    const grades = new Set(
      dataset.queries.flatMap((query) => query.expected.map((one) => one.relevance)),
    );

    // A binary label cannot tell a right answer in position one from the same
    // answer in position nine, and ranking is one of the five things
    // Governance §19 names.
    expect(grades.size).toBeGreaterThan(1);
  });

  it('asserts at least one absence — AC-6', () => {
    const dataset = loadGoldenDataset();
    const absences = dataset.queries.filter((query) => query.expected.length === 0);

    // Without one, a precision figure never sees a false positive and is not
    // measuring precision.
    expect(absences.length).toBeGreaterThan(0);
    for (const absence of absences) expect(absence.intent.length).toBeGreaterThan(0);
  });

  it('names an observation every evidence expectation should be traceable to — AC-7', () => {
    const dataset = loadGoldenDataset();
    for (const expectation of dataset.evidence) {
      expect(expectation.subject.scope).toBe(CORPUS_SCOPE);
      expect(expectation.atLeast).toBeGreaterThan(0);
    }
  });
});

describe('resolving a label to an entity id — AC-4', () => {
  it('derives the id through the same function the indexer uses', () => {
    const identity = {
      kind: 'file',
      sourceSystem: 'git',
      scope: CORPUS_SCOPE,
      sourceId: 'src/billing/invoice.ts',
    };
    const repository = canonicalId(
      canonicalKey({ kind: 'repository', sourceSystem: 'git', sourceId: '/somewhere/ledger' }),
    );

    // Asserted against `canonicalId` directly rather than a recorded UUID: a
    // fixture holding an id would be a snapshot of one indexing run, and this
    // test would then prove only that the snapshot was copied correctly.
    expect(resolveIdentity(identity, { [CORPUS_SCOPE]: repository })).toBe(
      canonicalId(
        canonicalKey({
          kind: 'file',
          sourceSystem: 'git',
          scope: repository,
          sourceId: 'src/billing/invoice.ts',
        }),
      ),
    );
  });

  it('gives a different id for the same file in a different repository', () => {
    // The reason scope is bound at resolution instead of written into the label.
    const identity = {
      kind: 'file',
      sourceSystem: 'git',
      scope: CORPUS_SCOPE,
      sourceId: 'README.md',
    };

    expect(resolveIdentity(identity, { [CORPUS_SCOPE]: 'repo-a' })).not.toBe(
      resolveIdentity(identity, { [CORPUS_SCOPE]: 'repo-b' }),
    );
  });

  it('refuses a scope nothing bound, rather than inventing one', () => {
    expect(() =>
      resolveIdentity(
        { kind: 'file', sourceSystem: 'git', scope: 'elsewhere', sourceId: 'README.md' },
        { [CORPUS_SCOPE]: 'repo-a' },
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.CONFIG_INVALID }));
  });
});

describe('refusing a dataset that would measure fiction — AC-9', () => {
  it('refuses a label naming a file the corpus does not contain', () => {
    const root = corrupt((at) => {
      editLabels(at, (labels) => {
        (labels['queries'] as { expected: { sourceId: string }[] }[])[0]!.expected.push({
          kind: 'file',
          sourceSystem: 'git',
          scope: CORPUS_SCOPE,
          sourceId: 'src/billing/does-not-exist.ts',
          relevance: 3,
        } as never);
      });
    });

    expect(() => loadGoldenDataset(root)).toThrowError(/does not contain/);
  });

  it('names the offending label, so the failure is actionable', () => {
    const root = corrupt((at) => {
      editLabels(at, (labels) => {
        (labels['queries'] as { id: string; expected: unknown[] }[])[0]!.expected.push({
          kind: 'file',
          sourceSystem: 'git',
          scope: CORPUS_SCOPE,
          sourceId: 'nope.ts',
          relevance: 1,
        });
      });
    });

    try {
      loadGoldenDataset(root);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(JSON.stringify(error)).toContain('exact-invoice-path');
    }
  });

  it('refuses a corpus file no commit introduces', () => {
    // It would never be indexed, so a label naming it would fail for a reason
    // that has nothing to do with retrieval.
    const root = corrupt((at) => {
      writeFileSync(join(at, 'corpus', 'orphan.md'), '# Never committed\n', 'utf8');
      reseal(at);
    });

    expect(() => loadGoldenDataset(root)).toThrowError(/never committed/i);
  });

  it('refuses a dataset with no absence expectation', () => {
    const root = corrupt((at) => {
      editLabels(at, (labels) => {
        labels['queries'] = (labels['queries'] as { expected: unknown[] }[]).filter(
          (query) => query.expected.length > 0,
        );
      });
    });

    expect(() => loadGoldenDataset(root)).toThrowError(/returns nothing/);
  });

  it('refuses two labels sharing an id', () => {
    const root = corrupt((at) => {
      editLabels(at, (labels) => {
        const queries = labels['queries'] as { id: string }[];
        queries[1]!.id = queries[0]!.id;
      });
    });

    expect(() => loadGoldenDataset(root)).toThrowError(/Duplicate label id/);
  });

  it('refuses content that has drifted from the manifest — AC-8', () => {
    // Deliberately *not* resealed: this is the case where someone edits the
    // corpus and forgets to recompute. A measurement cites a checksum, so the
    // dataset must not load while the two disagree.
    const root = corrupt((at) => {
      writeFileSync(join(at, 'corpus', 'README.md'), '# Changed\n', 'utf8');
    });

    expect(() => loadGoldenDataset(root)).toThrowError(/manifest checksum/);
  });
});

describe('the dataset measures nothing — AC-12', () => {
  it('exports data and a loader, and nothing that scores', async () => {
    // Asserted on the exported surface rather than by scanning the source for
    // the words "precision" and "recall" — the module quotes Governance §19 in
    // its own doc comment, so a text scan fails on the sentence explaining why
    // the rule exists. The surface is the contract; prose is not.
    const module = (await import('../../src/evaluation/index.js')) as Record<string, unknown>;
    const functions = Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(functions).toStrictEqual([
      'computeGoldenChecksum',
      'loadGoldenDataset',
      'resolveIdentity',
    ]);
  });

  it('reaches no retrieval or storage module, so it cannot run a query', () => {
    // The rule, not a list of today's imports — an exact list breaks whenever a
    // legitimate one is added, which trains people to update the assertion
    // rather than think about it. What must stay true is that this module cannot
    // reach anything that could execute a query: EPIC-097 through EPIC-100 own
    // measuring, and a dataset that could measure would make four harnesses four
    // copies of one scorer.
    const source = readFileSync('src/evaluation/dataset.ts', 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier, specifier).not.toMatch(/retrieval|storage|indexing|mcp|context/);
      if (specifier.startsWith('.')) {
        expect(specifier, specifier).toMatch(/^\.\.\/(domain|errors)\/index\.js$/);
      }
    }
  });
});
