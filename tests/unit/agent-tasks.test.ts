import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EXCLUDED, isExcluded } from '../../benchmark/agent/lib/corpus.mjs';
import { grade, normalizeCitation, summarize } from '../../benchmark/agent/lib/grade.mjs';
import { classify } from '../../benchmark/agent/lib/session.mjs';
import { EXCLUDED_PREFIXES } from '../../benchmark/lib/identity.mjs';

/**
 * The real-agent benchmark's labels are still true, and its scoring still means
 * what it claims.
 *
 * Same two jobs as `benchmark-tasks.test.ts`, for the same reasons: a label that
 * names a deleted path produces numbers that read as "Ferret got worse", and a
 * headline figure whose definition is undefined behaviour is not evidence.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface Task {
  readonly id: string;
  readonly group: string;
  readonly question: string;
  readonly answerBasis: string;
  readonly verdict?: {
    readonly options: readonly string[];
    readonly expected: string;
    readonly stale?: string;
  };
  readonly facts?: readonly { readonly id: string; readonly patterns: readonly string[]; readonly why: string }[];
  readonly stale?: readonly { readonly id: string; readonly patterns: readonly string[]; readonly why: string }[];
  readonly evidence: readonly { readonly artefact: string; readonly relevance: number; readonly basis: string }[];
}

const suite = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../benchmark/agent/tasks.json', import.meta.url)), 'utf8'),
) as { readonly tasks: readonly Task[] };

function tracked(): Set<string> {
  return new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

describe('agent benchmark labels', () => {
  const files = tracked();

  it('has tasks, each with a question and the sentence its answer rests on', () => {
    expect(suite.tasks.length).toBeGreaterThanOrEqual(8);
    for (const task of suite.tasks) {
      expect(task.question.length, task.id).toBeGreaterThan(20);
      expect(task.answerBasis.length, task.id).toBeGreaterThan(40);
      expect(task.evidence.length, task.id).toBeGreaterThan(0);
    }
  });

  it('names only artefacts this repository still has', () => {
    for (const task of suite.tasks) {
      for (const { artefact } of task.evidence) {
        if (artefact.startsWith('file:')) {
          expect(files, `${task.id} → ${artefact}`).toContain(artefact.slice('file:'.length));
          continue;
        }
        // A commit label must still resolve, or the task cites nothing.
        const sha = artefact.slice(artefact.indexOf(':') + 1);
        const resolves = () =>
          execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
        expect(resolves, `${task.id} → ${artefact}`).not.toThrow();
      }
    }
  });

  it('grades every task on something, and never on the answer key', () => {
    for (const task of suite.tasks) {
      const gradeable = task.verdict !== undefined || (task.facts ?? []).length > 0;
      expect(gradeable, `${task.id} is not gradeable`).toBe(true);
      for (const { artefact } of task.evidence) {
        if (!artefact.startsWith('file:')) continue;
        expect(isExcluded(artefact.slice('file:'.length)), `${task.id} labels a withheld path`).toBe(
          false,
        );
      }
    }
  });

  it('offers a verdict set that contains the expected option and does not telegraph it', () => {
    for (const task of suite.tasks) {
      if (task.verdict === undefined) continue;
      expect(task.verdict.options, task.id).toContain(task.verdict.expected);
      expect(task.verdict.options.length, task.id).toBeGreaterThanOrEqual(3);
      if (task.verdict.stale !== undefined) {
        expect(task.verdict.options, task.id).toContain(task.verdict.stale);
        expect(task.verdict.stale, task.id).not.toBe(task.verdict.expected);
      }
      // The right answer must not be the longest option: an agent that picked by
      // length would score without reading the repository.
      const longest = [...task.verdict.options].sort((a, b) => b.length - a.length)[0];
      const ties = task.verdict.options.filter((one) => one.length === longest!.length);
      if (ties.length === 1) expect(longest, task.id).not.toBe(task.verdict.expected);
    }
  });

  it('compiles every fact and stale pattern', () => {
    for (const task of suite.tasks) {
      for (const fact of [...(task.facts ?? []), ...(task.stale ?? [])]) {
        expect(fact.patterns.length, `${task.id}/${fact.id}`).toBeGreaterThan(0);
        for (const pattern of fact.patterns) {
          expect(() => new RegExp(pattern, 'i'), `${task.id}/${fact.id}: ${pattern}`).not.toThrow();
        }
        expect(fact.why.length, `${task.id}/${fact.id}`).toBeGreaterThan(10);
      }
    }
  });

  it('withholds the whole task benchmark corpus rule, and two reports besides', () => {
    for (const prefix of EXCLUDED_PREFIXES) expect(EXCLUDED).toContain(prefix);
    expect(isExcluded('benchmark/agent/tasks.json')).toBe(true);
    expect(isExcluded('docs/evidence/FERRET-CAN-A-FRESH-AGENT-FIND-IT.md')).toBe(true);
    expect(isExcluded('docs/evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md')).toBe(true);
    expect(isExcluded('docs/EPICs/EPIC-115-macOS-Packaging-Validation.md')).toBe(false);
    expect(isExcluded('src/config/exclusions.ts')).toBe(false);
  });
});

describe('agent benchmark scoring', () => {
  it('reduces a citation an engineer would write to the artefact it names', () => {
    expect(normalizeCitation('docs/EPICs/EPIC-115-macOS-Packaging-Validation.md')).toBe(
      'file:docs/EPICs/EPIC-115-macOS-Packaging-Validation.md',
    );
    expect(normalizeCitation('src/config/schema.ts:130')).toBe('file:src/config/schema.ts');
    expect(normalizeCitation('file:.github/workflows/ci.yml (verify job, lines 73-98)')).toBe(
      'file:.github/workflows/ci.yml',
    );
    expect(normalizeCitation('6e26e97')).toBe('commit:6e26e97');
    expect(normalizeCitation('6e26e97ab12cd34')).toBe('commit:6e26e97');
    expect(normalizeCitation('#224')).toBe('pr:224');
    expect(normalizeCitation('https://github.com/indoulia/Ferret/pull/224')).toBe('pr:224');
    expect(normalizeCitation('   ')).toBeUndefined();
  });

  const task: Task = {
    id: 'worked-example',
    group: 'test',
    question: 'Should the matrix add a runner?',
    answerBasis: 'No — the owner dropped it, and the record says so in two places.',
    verdict: {
      options: ['add-it', 'do-not-add-it', 'cannot-determine'],
      expected: 'do-not-add-it',
      stale: 'add-it',
    },
    facts: [{ id: 'owner', patterns: ['owner decision'], why: 'the decision has an owner' }],
    evidence: [
      { artefact: 'file:a.md', relevance: 3, basis: 'says it' },
      { artefact: 'file:b.md', relevance: 2, basis: 'corroborates' },
    ],
  };

  /**
   * A trace produced by the driver's own classifier, so this pins the contract
   * between what the session records and what the scoring reads.
   */
  function trace(...entries: { tool: string; input: unknown; text: string }[]) {
    return entries.map((entry) =>
      classify({ tool: entry.tool, input: entry.input, at: performance.now() }, entry.text, false),
    );
  }

  it('scores a right answer that cited what it read', () => {
    const scored = grade({
      task,
      result: {
        answer: {
          verdict: 'do-not-add-it',
          conclusion: 'No. An owner decision dropped it.',
          key_facts: ['owner decision, 2026-09-05'],
          citations: ['a.md', 'b.md'],
          confidence: 'high',
        },
        stopped: 'completed',
        trace: trace(
          { tool: 'Read', input: { file_path: 'C:/repo/a.md' }, text: 'owner decision' },
          { tool: 'Read', input: { file_path: 'C:/repo/b.md' }, text: 'corroboration' },
        ),
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, turns: 3 },
        elapsedMs: 1000,
      },
    });

    expect(scored.verdictCorrect).toBe(true);
    expect(scored.factsComplete).toBe(true);
    expect(scored.evidenceSourced).toBe(true);
    expect(scored.staleAsserted).toBe(false);
    expect(scored.unsupportedCitations).toBe(0);
    expect(scored.contextTokens).toBe(115);
    expect(scored.filesRead).toBe(2);
  });

  it('counts a citation the session never retrieved as unsupported', () => {
    const scored = grade({
      task,
      result: {
        answer: {
          verdict: 'do-not-add-it',
          conclusion: 'No.',
          key_facts: [],
          citations: ['a.md', 'docs/never-opened.md'],
          confidence: 'high',
        },
        stopped: 'completed',
        trace: trace({ tool: 'Read', input: { file_path: 'a.md' }, text: 'content' }),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
        elapsedMs: 1,
      },
    });

    expect(scored.unsupportedCitations).toBe(1);
    expect(scored.unsupported).toStrictEqual(['file:docs/never-opened.md']);
    // Correct answer, incomplete facts: the two are reported apart.
    expect(scored.verdictCorrect).toBe(true);
    expect(scored.factsComplete).toBe(false);
  });

  it('separates an unanswered session from a wrong one', () => {
    const unanswered = grade({
      task,
      result: {
        answer: undefined,
        stopped: 'no-result',
        trace: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
        elapsedMs: 1,
      },
    });
    expect(unanswered.answered).toBe(false);
    expect(unanswered.verdictCorrect).toBe(false);
    expect(unanswered.evidenceSourced).toBe(false);

    const wrong = grade({
      task,
      result: {
        answer: {
          verdict: 'add-it',
          conclusion: 'Yes, add it.',
          key_facts: [],
          citations: [],
          confidence: 'high',
        },
        stopped: 'completed',
        trace: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1 },
        elapsedMs: 1,
      },
    });
    expect(wrong.answered).toBe(true);
    expect(wrong.verdictCorrect).toBe(false);
    // The wrong option here *is* the superseded belief, so staleness is exact.
    expect(wrong.staleAsserted).toBe(true);
  });

  it('summarizes without letting an inapplicable measure dilute a rate', () => {
    const answered = { verdictCorrect: true, staleAsserted: false };
    const unmeasured = { verdictCorrect: true, staleAsserted: undefined };
    const base = {
      factsCovered: 1,
      factsTotal: 1,
      factsComplete: true,
      primaryCited: 1,
      primaryTotal: 1,
      evidenceSourced: true,
      answered: true,
      unsupportedCitations: 0,
      toolCalls: 1,
      filesRead: 1,
      linesRead: 1,
      searches: 0,
      ferretCalls: 0,
      contextTokens: 100,
      inputTokens: 100,
      cacheReadTokens: 0,
      outputTokens: 0,
      elapsedMs: 1,
      turns: 1,
      ferretSurfaces: {},
    };
    const summary = summarize([
      { ...base, ...answered },
      { ...base, ...unmeasured },
    ]);
    expect(summary.verdictCorrect).toStrictEqual({ rate: 1, of: 2 });
    // One task labels no trap, so the rate is over one task rather than two.
    expect(summary.staleAsserted).toStrictEqual({ rate: 0, of: 1 });
  });
});
