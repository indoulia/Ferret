import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXCLUDED_PREFIXES, withinCorpus } from '../../benchmark/lib/identity.mjs';
import { score, summarize } from '../../benchmark/lib/score.mjs';

/**
 * The task benchmark's labels are still true, and its derived metrics still mean
 * what they claim.
 *
 * Two different jobs, both load-bearing.
 *
 * **The labels rot.** Every expectation in `tasks.json` names a path in this
 * repository, and a rename or a deletion turns it into a label nothing can
 * satisfy. The harness would keep running and keep producing numbers, and the
 * numbers would read as "retrieval got worse" rather than "the benchmark
 * broke" — the failure `tests/unit/golden-dataset.test.ts` was written to
 * prevent for the golden dataset, and the same one applies here.
 *
 * **The derived metrics are opinions.** `sourced` and `staleAboveCurrent` are
 * not standard measures; they are definitions this benchmark chose, and a
 * benchmark whose headline figure is undefined behaviour is not evidence. They
 * are pinned here against worked examples, so a change to what they mean has to
 * be a deliberate one.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Expectation {
  readonly artefact: string;
  readonly relevance: number;
  readonly basis: string;
}

interface Task {
  readonly id: string;
  readonly kind: string;
  readonly question: string;
  readonly answerBasis: string;
  readonly expected: readonly Expectation[];
  readonly superseded: readonly { readonly artefact: string; readonly basis: string }[];
}

const suite = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../benchmark/tasks.json', import.meta.url)), 'utf8'),
) as { readonly tasks: readonly Task[] };

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((path) => path.length > 0),
);

describe('benchmark task labels', () => {
  it('has tasks', () => {
    expect(suite.tasks.length).toBeGreaterThan(0);
  });

  it('gives every task a unique id', () => {
    const ids = suite.tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const task of suite.tasks) {
    describe(task.id, () => {
      it('names only files this repository tracks', () => {
        const missing = [...task.expected, ...task.superseded]
          .map((entry) => entry.artefact)
          .filter((artefact) => artefact.startsWith('file:'))
          .map((artefact) => artefact.slice('file:'.length))
          .filter((path) => !tracked.has(path));
        expect(missing).toEqual([]);
      });

      it('has at least one artefact the answer must rest on', () => {
        expect(task.expected.filter((entry) => entry.relevance === 3).length).toBeGreaterThan(0);
      });

      it('justifies every label', () => {
        // A label nobody can justify is a label nobody can fix — the argument
        // `src/evaluation/dataset.ts` makes for requiring `intent` on a query.
        for (const entry of [...task.expected, ...task.superseded]) {
          expect(entry.basis.length).toBeGreaterThan(0);
        }
        expect(task.answerBasis.length).toBeGreaterThan(0);
      });

      it('does not label one artefact both current and superseded', () => {
        const expected = new Set(task.expected.map((entry) => entry.artefact));
        const overlap = task.superseded.filter((entry) => expected.has(entry.artefact));
        expect(overlap).toEqual([]);
      });

      it('grades within the scale', () => {
        for (const entry of task.expected) expect([1, 2, 3]).toContain(entry.relevance);
      });
    });
  }
});

describe('the corpus the benchmark searches', () => {
  it('excludes the benchmark, which holds the questions and the answer key', () => {
    expect(withinCorpus('file:benchmark/tasks.json')).toBe(false);
    expect(withinCorpus('file:benchmark/results/latest.json')).toBe(false);
    expect(EXCLUDED_PREFIXES).toContain('benchmark/');
  });

  it('excludes the evidence report, which states every answer in prose', () => {
    // Not in `benchmark/`, and an ordinary document in every other respect —
    // which is why the rule is "what would not exist but for the benchmark, and
    // what states its answers" rather than "the benchmark directory". Committed,
    // it appeared twelve times across the three conditions and cost the pack
    // five points of `sourced` by displacing the documents it describes.
    expect(withinCorpus('file:docs/evidence/FERRET-DOES-IT-HELP.md')).toBe(false);
  });

  it('excludes nothing else', () => {
    expect(withinCorpus('file:docs/EPICs/ROADMAP.md')).toBe(true);
    expect(withinCorpus('file:src/context/pack.ts')).toBe(true);
    // Every other evidence document is corpus, including the ones that discuss
    // findings. Only the report *about these tasks* is not.
    expect(withinCorpus('file:docs/evidence/FERRET-REVIEW-PACKAGE.md')).toBe(true);
    expect(withinCorpus('commit:271be926b0')).toBe(true);
  });

  it('keeps every task question out of the tree the harness greps', () => {
    // The exclusion covers `benchmark/`. It does not cover a test or a source
    // comment that quotes a question, and one of each did — each ranking itself
    // for the task it mentioned. Closed at the source, and guarded here so it
    // cannot come back through a file no directory rule reaches.
    const corpus = [...tracked].filter((path) => withinCorpus(`file:${path}`));
    const leaked = corpus.filter((path) => {
      const content = readFileSync(join(ROOT, path), 'utf8');
      return suite.tasks.some((task) => content.includes(task.question));
    });
    expect(leaked).toEqual([]);
  });
});

describe('derived measurements', () => {
  const task = {
    id: 'worked-example',
    question: 'q',
    expected: [
      { artefact: 'file:a', relevance: 3, basis: 'the answer' },
      { artefact: 'file:b', relevance: 3, basis: 'the other half of it' },
      { artefact: 'file:c', relevance: 2, basis: 'support' },
    ],
    superseded: [{ artefact: 'file:old', basis: 'reversed' }],
  };
  const cost = { retrievalTokens: 10, readTokensFull: 100, readTokensFrugal: 50, ms: 1 };

  it('sources a task only when every artefact the answer needs came back', () => {
    expect(score(task, ['file:a', 'file:b'], cost).sourced).toBe(true);
    expect(score(task, ['file:a', 'file:c'], cost).sourced).toBe(false);
  });

  it('does not source a task on an artefact that fell outside the window', () => {
    const filler = Array.from({ length: 9 }, (_, at) => `file:filler-${at}`);
    expect(score(task, ['file:a', ...filler, 'file:b'], cost).sourced).toBe(false);
  });

  it('reports a superseded artefact ranked above the current one', () => {
    expect(score(task, ['file:old', 'file:a', 'file:b'], cost).staleAboveCurrent).toBe(true);
    expect(score(task, ['file:a', 'file:old', 'file:b'], cost).staleAboveCurrent).toBe(false);
  });

  it('reports a superseded artefact as stale-first when nothing current came back at all', () => {
    // Worse than ranking it second, and it would score identically to a clean
    // miss if this returned false.
    expect(score(task, ['file:old'], cost).staleAboveCurrent).toBe(true);
  });

  it('leaves the stale measurement undefined where the task labels no trap', () => {
    const untrapped = { ...task, superseded: [] };
    expect(score(untrapped, ['file:a'], cost).staleAboveCurrent).toBeUndefined();
    // And an undefined measurement contributes to no rate.
    expect(summarize([score(untrapped, ['file:a'], cost)]).staleAboveCurrent).toBeUndefined();
  });

  it('counts as irrelevant only what is neither expected nor a labelled trap', () => {
    expect(score(task, ['file:a', 'file:old', 'file:noise'], cost).irrelevant5).toBe(1);
  });

  it('reports no cost per sourced task when nothing was sourced', () => {
    // Not infinity, and not zero. A division by zero here is an absent
    // measurement, and reporting it as a very small cost would let a condition
    // that answered nothing look cheap.
    expect(summarize([score(task, ['file:noise'], cost)]).tokensPerSourcedTask).toBeUndefined();
  });
});
