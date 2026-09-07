/**
 * A knowledge base that never grows is not the thing being measured.
 *
 * Twenty-five statements is a store one week old. Every condition sources
 * almost everything at that size, because a notes file of twenty-five notes is
 * a page and a page can simply be read — which is exactly the finding, and
 * exactly why it cannot be the only size measured. The claim durable context
 * makes is about a knowledge base a team has been writing into for months, and
 * the honest way to test a claim about growth is to grow it.
 *
 * So the graded statements stay fixed and the store around them is padded with
 * **real** engineering knowledge from this repository: one statement per Epic,
 * drawn from its title and its status line. Real, mechanically derived, and
 * verifiable — `docs/EPICs/` is right there.
 *
 * Three properties keep this from being a way of getting a result:
 *
 * - **Both sides get the same padding.** The notes file and the durable store
 *   hold the identical statements in the identical order. Padding cannot help
 *   one condition without helping the other.
 * - **Padding is never labelled.** No task expects a padding statement, so a
 *   condition that returns one is scored as having returned something
 *   irrelevant. If a padding statement happens to bear on a question it
 *   *understates* precision on whichever side returns it — a bias against the
 *   conditions that retrieve well, which is the safe direction.
 * - **It is drawn from a shape that cannot answer the questions.** The tasks
 *   ask about behaviours, reversals and working practice; an Epic's title and
 *   status say which Epic delivered what. The overlap check below fails the run
 *   rather than reporting numbers if any padding statement contains a phrase a
 *   task requires.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** `# EPIC-034 — Symbol Index` → `EPIC-034`, `Symbol Index`. */
const TITLE = /^#\s*(EPIC-\d+)\s*[—-]\s*(.+?)\s*$/;
/** `**Status: VALIDATED | …` and `**Status:** IMPLEMENTED` both appear. */
const STATUS = /\*\*Status:?\*?\*?\s*([A-Z][A-Z ]+)/;

/**
 * One durable statement per Epic, oldest first.
 *
 * Oldest first because that is the order they were learned in, and a store
 * where the newest thing is also the most deeply buried would be a store nobody
 * has.
 */
export function fromEpics(root) {
  const directory = join(root, 'docs', 'EPICs');
  const statements = [];

  for (const name of readdirSync(directory).filter((one) => one.endsWith('.md')).sort()) {
    const text = readFileSync(join(directory, name), 'utf8');
    const title = TITLE.exec(text.split('\n')[0] ?? '');
    if (title === null) continue;
    const status = STATUS.exec(text)?.[1]?.trim() ?? 'SPECIFIED';
    const [, epic, subject] = title;

    statements.push({
      key: `pad:${epic}`,
      session: undefined,
      kind: 'fact',
      statement: `${epic} covers ${subject.toLowerCase()} and its status is ${status.toLowerCase()}.`,
      basis: `docs/EPICs/${name}, its title and status line.`,
      padding: true,
    });
  }

  return statements;
}

/**
 * Refuse to measure a store whose padding states an answer.
 *
 * The task benchmark had to correct for its own answer key twice, both times
 * after the numbers had been published. This is the same failure arriving by a
 * different route — filler that happens to say the thing being asked about —
 * and it is checked before anything is measured rather than explained
 * afterwards.
 */
export function assertNoOverlap(padding, tasks) {
  const offences = [];
  for (const statement of padding) {
    const haystack = statement.statement.toLowerCase();
    for (const task of tasks) {
      for (const fact of task.requiredFacts ?? []) {
        for (const form of fact.any) {
          if (haystack.includes(form.toLowerCase())) {
            offences.push(`${statement.key} states "${form}", required by ${task.id}`);
          }
        }
      }
    }
  }
  if (offences.length > 0) {
    throw new Error(`padding states a task's answer:\n  ${offences.join('\n  ')}`);
  }
}

/** The first `count` padding statements, or all of them. */
export function take(padding, count) {
  return count >= padding.length ? padding : padding.slice(0, count);
}
