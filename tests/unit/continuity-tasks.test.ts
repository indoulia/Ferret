import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { factsIn } from '../../benchmark/continuity/lib/facts.mjs';
import * as notes from '../../benchmark/continuity/lib/notes.mjs';

/**
 * The continuity benchmark's scenario is internally true, and its derived
 * metrics still mean what they claim.
 *
 * The same two jobs `benchmark-tasks.test.ts` does for the task benchmark, on a
 * suite whose labels rot differently. That one names paths in this repository
 * and breaks when a file is renamed. This one names **statements in its own
 * scenario**, so nothing outside can break it — and that is exactly why it
 * needs a test: a label naming a statement the scenario no longer holds is
 * unsatisfiable by any condition, the harness keeps running, and the number
 * reads as "durable context got worse" rather than as "the benchmark broke".
 *
 * The required facts are checked the same way and for a sharper reason. A fact
 * whose surface forms appear nowhere in the scenario can never be found by
 * anything, so `answered` would sit permanently below 100% for a reason no
 * product change could fix — a headline figure quietly measuring a typo.
 */

const scenario = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../benchmark/continuity/scenario.json', import.meta.url)), 'utf8'),
) as Scenario;

const suite = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../benchmark/continuity/tasks.json', import.meta.url)), 'utf8'),
) as Suite;

interface Statement {
  readonly key: string;
  readonly session: string;
  readonly kind: string;
  readonly statement: string;
  readonly rationale?: string;
  readonly basis: string;
  readonly supersedes?: string;
  readonly restatementOf?: string;
}

interface Scenario {
  readonly agents: Record<string, { readonly principalId: string; readonly permissions: readonly string[] }>;
  readonly sessions: readonly {
    readonly id: string;
    readonly agent: string;
    readonly parent: string | null;
    readonly private?: readonly { readonly kind: string; readonly statement: string }[];
    readonly checkpoint?: { readonly summary: string };
  }[];
  readonly statements: readonly Statement[];
}

interface Task {
  readonly id: string;
  readonly askedBy: string;
  readonly question: string;
  readonly expected: readonly { readonly artefact: string; readonly relevance: number; readonly basis: string }[];
  readonly superseded: readonly { readonly artefact: string; readonly basis: string }[];
  readonly requiredFacts: readonly { readonly id: string; readonly any: readonly string[]; readonly basis: string }[];
  readonly answerGroup?: readonly string[];
}

interface Suite {
  readonly tasks: readonly Task[];
  readonly continuity: readonly { readonly agent: string; readonly resumes: string; readonly expectedPhrases: readonly string[] }[];
  readonly isolation: readonly { readonly actor: string; readonly target: string; readonly expect: string }[];
}

const keys = new Set(scenario.statements.map((one) => one.key));
const sessionIds = new Set(scenario.sessions.map((one) => one.id));
const agentNames = new Set(Object.keys(scenario.agents));

/** Everything the scenario says, in one string, for the fact labels to be true of. */
const everythingSaid = [
  ...scenario.statements.flatMap((one) => [one.statement, one.rationale ?? '']),
  ...scenario.sessions.flatMap((session) => [
    session.checkpoint?.summary ?? '',
    ...(session.private ?? []).map((note) => note.statement),
  ]),
]
  .join('\n')
  .toLowerCase();

describe('the scenario is internally consistent', () => {
  it('has statements, sessions and two agents', () => {
    expect(scenario.statements.length).toBeGreaterThan(0);
    expect(scenario.sessions.length).toBeGreaterThan(0);
    expect(agentNames.size).toBeGreaterThanOrEqual(2);
  });

  it('gives every statement a distinct key', () => {
    expect(keys.size).toBe(scenario.statements.length);
  });

  it('records every statement in a session an agent ran', () => {
    for (const statement of scenario.statements) {
      expect(sessionIds, statement.key).toContain(statement.session);
    }
    for (const session of scenario.sessions) {
      expect(agentNames, session.id).toContain(session.agent);
      if (session.parent !== null) expect(sessionIds, session.id).toContain(session.parent);
    }
  });

  it('supersedes only statements recorded earlier', () => {
    const at = new Map(scenario.statements.map((one, index) => [one.key, index]));
    for (const statement of scenario.statements) {
      if (statement.supersedes === undefined) continue;
      expect(keys, statement.key).toContain(statement.supersedes);
      // A statement cannot replace one that has not been made yet, and the
      // replay records them in this order.
      expect(at.get(statement.supersedes)!).toBeLessThan(at.get(statement.key)!);
    }
  });

  it('cites a basis for every statement, because a scenario nobody can check is fiction', () => {
    for (const statement of scenario.statements) {
      expect(statement.basis.length, statement.key).toBeGreaterThan(10);
    }
  });

  it('marks a restatement as restating something the scenario holds', () => {
    for (const statement of scenario.statements) {
      if (statement.restatementOf === undefined) continue;
      expect(keys, statement.key).toContain(statement.restatementOf);
    }
  });
});

describe('the task labels name statements that exist', () => {
  it('has tasks', () => {
    expect(suite.tasks.length).toBeGreaterThan(0);
  });

  it('expects and traps only statements the scenario records', () => {
    for (const task of suite.tasks) {
      for (const one of [...task.expected, ...task.superseded]) {
        expect(keys, `${task.id} → ${one.artefact}`).toContain(one.artefact);
      }
      for (const key of task.answerGroup ?? []) {
        expect(keys, `${task.id} answerGroup`).toContain(key);
      }
    }
  });

  it('is asked by an agent the scenario defines', () => {
    for (const task of suite.tasks) expect(agentNames, task.id).toContain(task.askedBy);
  });

  it('labels something a correct answer must rest on', () => {
    for (const task of suite.tasks) {
      expect(task.expected.filter((one) => one.relevance === 3).length, task.id).toBeGreaterThan(0);
    }
  });

  it('traps only statements something else supersedes', () => {
    const superseded = new Set(scenario.statements.flatMap((one) => (one.supersedes === undefined ? [] : [one.supersedes])));
    for (const task of suite.tasks) {
      for (const one of task.superseded) {
        // A label calling something stale that nothing replaced is a label
        // asserting a reversal the scenario never made.
        expect(superseded, `${task.id} → ${one.artefact}`).toContain(one.artefact);
      }
    }
  });

  it('asks each question in words the answer does not simply repeat', () => {
    // A question copied from the statement that answers it measures string
    // equality rather than retrieval. Not a similarity threshold — just a
    // refusal to let a question *be* its answer.
    for (const task of suite.tasks) {
      for (const statement of scenario.statements) {
        expect(task.question.toLowerCase(), task.id).not.toBe(statement.statement.toLowerCase());
      }
    }
  });
});

describe('the required facts are findable at all', () => {
  it('states, for every fact, something the scenario actually says', () => {
    for (const task of suite.tasks) {
      expect(task.requiredFacts.length, task.id).toBeGreaterThan(0);
      for (const fact of task.requiredFacts) {
        const reachable = fact.any.some((form) => everythingSaid.includes(form.toLowerCase()));
        expect(reachable, `${task.id} → ${fact.id}: no wording of this appears in the scenario`).toBe(true);
      }
    }
  });

  it('is satisfied in full by the scenario read whole, so 100% is reachable', () => {
    // The ceiling every condition is measured against. If a task cannot be
    // answered by *everything the scenario says*, no retrieval can answer it
    // and the label is wrong rather than the product.
    for (const task of suite.tasks) {
      expect(factsIn(task, everythingSaid).missingFacts, task.id).toStrictEqual([]);
    }
  });
});

describe('the continuity and isolation probes name real things', () => {
  it('resumes a session that recorded working state', () => {
    for (const probe of suite.continuity) {
      expect(agentNames).toContain(probe.agent);
      expect(sessionIds).toContain(probe.resumes);
      expect(probe.expectedPhrases.length).toBeGreaterThan(0);
    }
  });

  it('probes both directions, so a build that refused everyone could not pass', () => {
    expect(suite.isolation.some((one) => one.expect === 'refused')).toBe(true);
    expect(suite.isolation.some((one) => one.expect === 'allowed')).toBe(true);
    for (const probe of suite.isolation) {
      expect(agentNames).toContain(probe.actor);
      if (probe.target !== 'durable' && probe.target !== 'private') {
        expect(sessionIds).toContain(probe.target);
      }
    }
  });

  it('names a session that actually holds unpromoted working state', () => {
    // The isolation measurement is vacuous if no session has anything private.
    expect(scenario.sessions.some((one) => (one.private ?? []).length > 0)).toBe(true);
  });
});

describe('the derived metrics mean what the report says they mean', () => {
  const task = {
    id: 'worked-example',
    requiredFacts: [
      { id: 'a', any: ['first thing', 'the first'], basis: 'worked example' },
      { id: 'b', any: ['second thing'], basis: 'worked example' },
    ],
  };

  it('answers only when every fact is present', () => {
    expect(factsIn(task, 'the FIRST thing and the second thing').answered).toBe(true);
    expect(factsIn(task, 'first thing only').answered).toBe(false);
  });

  it('accepts any listed surface form', () => {
    expect(factsIn(task, 'the first, and second thing').factsFound).toBe(2);
  });

  it('reports which fact was missing rather than only how many', () => {
    expect(factsIn(task, 'second thing').missingFacts).toStrictEqual(['a']);
  });

  it('is not vacuously answered by a task that requires nothing', () => {
    expect(factsIn({ id: 'unlabelled', requiredFacts: [] }, 'anything at all').answered).toBe(false);
  });
});

describe('the notes baseline is given exactly what Ferret is given', () => {
  const sessionsById = new Map(scenario.sessions.map((one) => [one.id, one]));

  it('writes every statement into the append file, in scenario order', () => {
    const composed = notes.compose(scenario.statements, sessionsById, { curated: false });
    expect(composed.blocks.map((one: { key: string }) => one.key)).toStrictEqual(
      scenario.statements.map((one) => one.key),
    );
  });

  it('drops exactly the superseded statements from the curated file, and nothing else', () => {
    const composed = notes.compose(scenario.statements, sessionsById, { curated: true });
    const replaced = new Set(
      scenario.statements.flatMap((one) => (one.supersedes === undefined ? [] : [one.supersedes])),
    );
    const kept = new Set(composed.blocks.map((one: { key: string }) => one.key));

    for (const statement of scenario.statements) {
      expect(kept.has(statement.key), statement.key).toBe(!replaced.has(statement.key));
    }
  });

  it('carries the rationale, so the baseline is not weakened by being given less', () => {
    const composed = notes.compose(scenario.statements, sessionsById, { curated: false });
    const withReasons = scenario.statements.filter((one) => one.rationale !== undefined);
    for (const statement of withReasons) {
      expect(composed.text, statement.key).toContain(statement.rationale!);
    }
  });

  it('weights a term in a note heading above one in its body', () => {
    // A worked example on a constructed pair, so a change to the baseline's
    // ranking has to be a deliberate one. `lib/baseline.mjs` supplies the
    // formula and weights a filename hit at three content hits; a note's
    // heading is its name, and this pins that the note unit is wired to the
    // same constant rather than to a second one.
    const sessions = new Map([['s1', { id: 's1', agent: 'alpha' }]]);
    const composed = notes.compose(
      [
        { key: 'in-the-body', session: 's1', kind: 'fact', statement: 'Something unrelated entirely.', rationale: 'A digression that mentions kestrels once.' },
        { key: 'in-the-heading', session: 's1', kind: 'fact', statement: 'Kestrels hover before they stoop.' },
      ],
      sessions,
      { curated: false },
    );

    expect(notes.retrieve(composed, 'kestrels', { limit: 5 }).artefacts).toStrictEqual([
      'in-the-heading',
      'in-the-body',
    ]);
  });

  it('still finds the labelled answer to a real question in the real scenario', () => {
    // Not a worked example — a guard that the baseline keeps working on the
    // data it is actually run against. A baseline that quietly stopped
    // retrieving would make every Ferret condition look good.
    const composed = notes.compose(scenario.statements, sessionsById, { curated: true });
    for (const task of suite.tasks) {
      const found = notes.retrieve(composed, task.question, { limit: 10 });
      for (const one of task.expected.filter((entry) => entry.relevance === 3)) {
        expect(found.artefacts, `${task.id} → ${one.artefact}`).toContain(one.artefact);
      }
    }
  });
});
