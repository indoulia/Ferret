#!/usr/bin/env node
/**
 * Is knowledge learned in one session worth anything in the next one, or to
 * another agent?
 *
 * The task benchmark answered "is an agent holding Ferret better off than one
 * holding `git`" and closed with four gaps it could not reach. Two of them are
 * this benchmark's subject, in its own words:
 *
 * > **Durable context in its intended state.** Ferret's third tier holds what
 * > agents recorded. On the index this runs against it holds almost nothing…
 * >
 * > **Cross-session continuity between real sessions.** `resume-dogfood` asks
 * > the question; nothing here observes a second session actually resuming.
 *
 * So this one populates that tier from engineering knowledge this repository
 * actually produced, replays it as eight sessions run by two agents, and then
 * asks questions in sessions that hold no transcript of the work that learned
 * the answer. Half the questions are asked by the agent that recorded none of
 * it.
 *
 * **The baseline is an agent that writes things down**, not an agent that
 * forgets. Comparing a populated Ferret against an empty everything would be a
 * demonstration rather than a measurement. The notes file is given exactly the
 * same statements, in the same order, with the same reasoning — see
 * `lib/notes.mjs`, which holds the whole baseline and every constant in it.
 *
 * **And it is measured at more than one size.** A store holding twenty-five
 * statements is a week old, and at that size a notes file is a page that can
 * simply be read. The claim durable context makes is about a knowledge base
 * months old, so the same questions are asked again with the store padded by
 * real statements drawn from this repository's Epics — see `lib/padding.mjs`.
 *
 * Usage:
 *   node benchmark/continuity/run.mjs
 *   node benchmark/continuity/run.mjs --padding 0,120
 *   node benchmark/continuity/run.mjs --task macos-runner-now --padding 0
 *   node benchmark/continuity/run.mjs --keep      # leave the last store standing
 *
 * Requires `npm run build` and the Docker container `scripts/dogfood-db.mjs`
 * starts. The store itself is created, migrated and dropped by this harness:
 * it never touches the dogfood index, which the task benchmark measures and an
 * agent working on this repository actually reads.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { estimateTokens } from '../../dist/context/budget.js';
import { MAX_CONTEXT_PAGE } from '../../dist/context/index.js';

import { assertBuildIsCurrent, describeTree } from '../lib/build.mjs';
import { K, READS, score, summarize } from '../lib/score.mjs';

import { factsIn } from './lib/facts.mjs';
import * as notes from './lib/notes.mjs';
import * as padding from './lib/padding.mjs';
import { DATABASE, call, connectAgent, dropStore, replay, resetStore } from './lib/replay.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The pack's token budget — the task benchmark's, unchanged.
 *
 * Deliberately not re-tuned for this benchmark. That run measured the pack
 * needing roughly twice its budget to source what a search sources, and
 * choosing a larger number here because it flatters the pack would make the two
 * benchmarks incomparable and this one unfalsifiable.
 */
const PACK_BUDGET = 4000;

/**
 * What a whole-store read asks for: the largest page the tool will serve.
 *
 * Read from the build rather than written down here, because a number this
 * harness chose could quietly exceed the tool's bound — and it did. The first
 * sweep asked for 500, every call was refused, and the condition scored zero on
 * every task as though the store were empty. That is why {@link call} now
 * refuses to return an error as though it were an answer.
 */
const FIND_LIMIT = MAX_CONTEXT_PAGE;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const only = flag('task', undefined);
const keep = argv.includes('--keep');
const outPath = flag('out', join(HERE, 'results', 'latest.json'));

assertBuildIsCurrent({ root: ROOT, cli: CLI });

const scenario = JSON.parse(readFileSync(join(HERE, 'scenario.json'), 'utf8'));
const suite = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const tasks = suite.tasks.filter((task) => only === undefined || task.id === only);
if (tasks.length === 0) throw new Error(`no task matched --task ${only}`);

const available = padding.fromEpics(ROOT);
padding.assertNoOverlap(available, suite.tasks);
const levels = (flag('padding', `0,${String(available.length)}`))
  .split(',')
  .map((one) => Number.parseInt(one.trim(), 10))
  .filter((one) => Number.isFinite(one));

const configHome = join(ROOT, '.local', 'continuity-config');
const CONDITIONS = ['notes-append', 'notes-curated', 'notes-full', 'ferret-pack', 'ferret-search', 'ferret-find'];

/**
 * The order everything was recorded in, padding included.
 *
 * Padding is spread across the sessions rather than loaded in front of them.
 * Loading it first would make every graded statement the newest thing in the
 * store, which flatters any condition that reads newest-first and is not how a
 * knowledge base fills up. Within a session the older padding is recorded
 * before that session's own conclusions.
 */
function interleave(count) {
  const filler = padding.take(available, count).map((one) => ({ ...one }));
  const sessions = scenario.sessions;
  const perSession = Math.max(1, Math.ceil(filler.length / sessions.length));
  filler.forEach((one, at) => {
    one.session = sessions[Math.min(Math.floor(at / perSession), sessions.length - 1)].id;
  });

  const ordered = [];
  for (const session of sessions) {
    ordered.push(...filler.filter((one) => one.session === session.id));
    ordered.push(...scenario.statements.filter((one) => one.session === session.id));
  }
  return ordered;
}

/**
 * Rank-order metrics are not reported for a condition that ranked nothing.
 *
 * An agent that loads its whole notes file, or asks for everything the store
 * holds, has performed no retrieval. An nDCG over a file read in the order it
 * was written is a number with no meaning rather than a number that is low, and
 * `src/evaluation/metrics.ts` already refuses to return one where it would be a
 * fabrication. Recall and sourced stay, because holding the answer is a fact
 * about the condition however it came to hold it.
 */
function unranked(scored) {
  return { ...scored, precision5: undefined, precision10: undefined, ndcg10: undefined, reciprocalRankPrimary: undefined };
}

/** One complete measurement at one store size. */
async function measure(count) {
  const ordered = interleave(count);

  process.stderr.write(`\n=== store: ${String(scenario.statements.length)} graded + ${String(count)} padding ===\n`);
  resetStore({ root: ROOT, cli: CLI, configHome: join(configHome, 'setup') });

  const clients = {};
  for (const [name, agent] of Object.entries(scenario.agents)) {
    clients[name] = await connectAgent({ root: ROOT, cli: CLI, configHome, agent });
  }

  const history = await replay({ scenario: { ...scenario, statements: ordered }, clients });

  const appendNotes = notes.compose(ordered, history.sessionsById, { curated: false });
  const curatedNotes = notes.compose(ordered, history.sessionsById, { curated: true });
  if (count === levels.at(-1)) {
    mkdirSync(join(HERE, 'results'), { recursive: true });
    writeFileSync(join(HERE, 'results', 'notes-append.md'), `${appendNotes.text}\n`);
    writeFileSync(join(HERE, 'results', 'notes-curated.md'), `${curatedNotes.text}\n`);
  }

  const keyOfContext = (id) => history.keyOfId.get(id) ?? `unlabelled:${id}`;
  const leaderOf = new Map(ordered.map((one) => [one.key, one.restatementOf ?? one.key]));
  const canonicalise = (keys) => {
    const seen = new Set();
    const out = [];
    for (const key of keys) {
      const leader = leaderOf.get(key) ?? key;
      if (seen.has(leader)) continue;
      seen.add(leader);
      out.push(leader);
    }
    return out;
  };

  function notesCondition(file, task) {
    const started = performance.now();
    const found = notes.retrieve(file, task.question, { limit: K });
    const ms = performance.now() - started;
    const listing = found.results.map((entry) => file.lines[entry.from]).join('\n');
    const read = notes.readCost(file, found.results, { reads: READS, estimate: estimateTokens });
    const openedText = found.results
      .slice(0, READS)
      .map((entry) => file.lines.slice(entry.from, entry.to + 1).join('\n'))
      .join('\n');
    return {
      ranked: found.artefacts,
      delivered: `${listing}\n${openedText}`,
      cost: { retrievalTokens: estimateTokens(listing), readTokensFull: read.full, readTokensFrugal: read.frugal, ms },
    };
  }

  async function packCondition(client, task) {
    const json = await call(client, 'ferret_context_pack', { question: task.question, budget: PACK_BUDGET });
    const rendered = await call(client, 'ferret_context_pack', { question: task.question, budget: PACK_BUDGET, format: 'text' });
    const standing = json.body.standing ?? [];
    return {
      ranked: standing.map((entry) => keyOfContext(entry.id)),
      delivered: rendered.text,
      standingCount: standing.length,
      itemCount: (json.body.items ?? []).length,
      omitted: json.body.omitted ?? [],
      cost: { retrievalTokens: estimateTokens(rendered.text), readTokensFull: 0, readTokensFrugal: 0, ms: rendered.ms },
    };
  }

  async function searchCondition(client, task) {
    const found = await call(client, 'ferret_search', { query: task.question, limit: K });
    return {
      ranked: (found.body.results ?? []).map((hit) => keyOfContext(hit.id)),
      delivered: found.text,
      cost: { retrievalTokens: estimateTokens(found.text), readTokensFull: 0, readTokensFrugal: 0, ms: found.ms },
    };
  }

  async function findCondition(client) {
    const found = await call(client, 'ferret_context_find', { limit: FIND_LIMIT });
    return {
      ranked: (found.body.context ?? []).map((held) => keyOfContext(held.id)),
      delivered: found.text,
      cost: { retrievalTokens: estimateTokens(found.text), readTokensFull: 0, readTokensFrugal: 0, ms: found.ms },
    };
  }

  const rows = [];
  for (const task of tasks) {
    // The agent that asks is the one the task names, and half the tasks are
    // asked by the agent that recorded none of the answer.
    const client = clients[task.askedBy];
    const whole = notes.wholeFileCost(curatedNotes, { estimate: estimateTokens });

    const produced = {
      'notes-append': notesCondition(appendNotes, task),
      'notes-curated': notesCondition(curatedNotes, task),
      'notes-full': {
        ranked: curatedNotes.blocks.map((block) => block.key),
        delivered: curatedNotes.text,
        cost: { retrievalTokens: 0, readTokensFull: whole.full, readTokensFrugal: whole.frugal, ms: 0 },
      },
      'ferret-pack': await packCondition(client, task),
      'ferret-search': await searchCondition(client, task),
      'ferret-find': await findCondition(client),
    };

    const conditions = {};
    for (const name of CONDITIONS) {
      const result = produced[name];
      const wholeRead = name === 'notes-full' || name === 'ferret-find';
      const ranked = canonicalise(result.ranked);
      const scored = score(task, ranked, result.cost, wholeRead ? { window: ranked.length } : {});
      conditions[name] = {
        ranked: ranked.slice(0, 12),
        returned: ranked.length,
        // How many wordings of one answer arrived. EPIC-130's claim is that four
        // records saying one thing are one answer; a notes file has no
        // mechanism for that, so this is where the difference shows or does not.
        wordings: (task.answerGroup ?? []).filter((key) => result.ranked.includes(key)).length,
        ...(result.standingCount === undefined ? {} : { standingCount: result.standingCount }),
        ...(result.itemCount === undefined ? {} : { itemCount: result.itemCount }),
        ...(result.omitted === undefined ? {} : { omitted: result.omitted }),
        score: { ...(wholeRead ? unranked(scored) : scored), ...factsIn(task, result.delivered) },
      };
    }

    rows.push({ task: task.id, kind: task.kind, askedBy: task.askedBy, question: task.question, conditions });
  }

  // ─── Properties no ranked list can express ────────────────────────────────
  //
  // What must cross does cross, and what must not does not. Both halves,
  // because a build that refused everyone would pass a benchmark that only
  // checked the refusals, and one that leaked everything would pass a benchmark
  // that only checked the sharing.
  const isolation = [];
  for (const probe of suite.isolation) {
    const client = clients[probe.actor];
    const sessionId = history.sessionIdOf.get(probe.target);
    let observed;
    let detail;

    if (probe.target === 'durable') {
      const found = await call(client, 'ferret_context_find', { limit: FIND_LIMIT });
      const held = (found.body.context ?? []).length;
      observed = held > 0 ? 'allowed' : 'refused';
      detail = `${String(held)} durable statement(s) readable`;
    } else if (probe.target === 'private') {
      const found = await call(client, 'ferret_context_find', { limit: FIND_LIMIT });
      const statements = (found.body.context ?? []).map((one) => String(one.statement).toLowerCase());
      const privateNotes = scenario.sessions.flatMap((session) => session.private ?? []);
      const leaked = privateNotes.filter((note) =>
        statements.some((one) => one.includes(note.statement.slice(0, 40).toLowerCase())),
      );
      observed = leaked.length === 0 ? 'refused' : 'allowed';
      detail = `${String(leaked.length)} of ${String(privateNotes.length)} private note(s) reachable`;
    } else {
      const tool = probe.id.includes('promote')
        ? 'ferret_context_promote'
        : probe.id.includes('show')
          ? 'ferret_session_show'
          : 'ferret_session_recall';
      const result = await call(client, tool, { sessionId });
      observed = result.body.found === false ? 'refused' : 'allowed';
      detail =
        result.body.found === false
          ? String(result.body.detail)
          : `${String((result.body.memories ?? []).length)} memories`;
    }
    isolation.push({ ...probe, observed, detail, holds: observed === probe.expect });
  }

  // A second session actually resuming a first — the thing the task benchmark
  // could ask about and not observe.
  const continuity = [];
  for (const probe of suite.continuity) {
    const client = clients[probe.agent];
    const recalled = await call(client, 'ferret_session_recall', {
      sessionId: history.sessionIdOf.get(probe.resumes),
    });
    const viaNotes = notesCondition(curatedNotes, { question: probe.question });
    const haystack = recalled.text.toLowerCase();
    const phrasesFound = probe.expectedPhrases.filter((one) => haystack.includes(one.toLowerCase()));
    continuity.push({
      id: probe.id,
      resumed: probe.resumes,
      found: recalled.body.found === true,
      empty: recalled.body.empty,
      lineageDepth: (recalled.body.lineage ?? []).length,
      checkpointSequence: recalled.body.checkpoint?.sequence,
      memories: (recalled.body.memories ?? []).length,
      phrasesFound,
      phrasesTotal: probe.expectedPhrases.length,
      resumable: phrasesFound.length === probe.expectedPhrases.length,
      ferretTokens: estimateTokens(recalled.text),
      // What the same resumption costs an agent that has to re-read its notes.
      notesTokens: viaNotes.cost.retrievalTokens + viaNotes.cost.readTokensFull,
      wholeNotesTokens: estimateTokens(curatedNotes.text),
      ms: recalled.ms,
    });
  }

  const summary = Object.fromEntries(
    CONDITIONS.map((name) => {
      const scores = rows.map((row) => row.conditions[name].score);
      const rate = (key) => {
        const present = scores.map((one) => one[key]).filter((one) => one !== undefined);
        return present.length === 0
          ? undefined
          : { rate: present.filter(Boolean).length / present.length, of: present.length };
      };
      const grouped = rows.filter((row) => (row.conditions[name].wordings ?? 0) > 0);
      return [
        name,
        {
          ...summarize(scores),
          // The measurement artefact recall cannot make: whether what arrived
          // actually said what the answer needs.
          answered: rate('answered'),
          factsFound: scores.reduce((sum, one) => sum + one.factsFound, 0),
          factsTotal: scores.reduce((sum, one) => sum + one.factsTotal, 0),
          wordingsPerGroupedTask:
            grouped.length === 0
              ? undefined
              : grouped.reduce((sum, row) => sum + row.conditions[name].wordings, 0) / grouped.length,
        },
      ];
    }),
  );

  for (const client of Object.values(clients)) await client.close();

  return {
    padding: count,
    storeStatements: ordered.length,
    notes: {
      appendBlocks: appendNotes.blocks.length,
      curatedBlocks: curatedNotes.blocks.length,
      appendTokens: estimateTokens(appendNotes.text),
      curatedTokens: estimateTokens(curatedNotes.text),
    },
    recordOutcomes: history.outcomes.filter((one) => !one.key.startsWith('pad:')),
    promotions: history.promotions,
    summary,
    isolation,
    continuity,
    tasks: rows,
  };
}

const runs = [];
for (const level of levels) {
  const result = await measure(level);
  runs.push(result);

  for (const name of CONDITIONS) {
    const s = result.summary[name];
    process.stderr.write(
      `${name.padEnd(14)} sourced ${(s.sourced.rate * 100).toFixed(0)}%  answered ${(s.answered.rate * 100).toFixed(0)}%  ` +
        `recall ${(s.recall ?? 0).toFixed(2)}  ` +
        `stale-first ${s.staleAboveCurrent === undefined ? 'n/a' : `${(s.staleAboveCurrent.rate * 100).toFixed(0)}%`}  ` +
        `tokens ${s.totalTokensFull}  per-sourced ${s.tokensPerSourcedTask ?? 'n/a'}  p50 ${(s.medianMs ?? 0).toFixed(0)}ms\n`,
    );
  }
  process.stderr.write(
    `isolation ${String(result.isolation.filter((one) => one.holds).length)}/${String(result.isolation.length)} hold\n`,
  );
  for (const one of result.isolation.filter((probe) => !probe.holds)) {
    process.stderr.write(`  FAIL ${one.id}: expected ${one.expect}, observed ${one.observed} — ${one.detail}\n`);
  }
  for (const one of result.continuity) {
    process.stderr.write(
      `continuity ${one.id}: resumable=${one.resumable ? 'yes' : `${one.phrasesFound.length}/${one.phrasesTotal}`} ` +
        `lineage=${String(one.lineageDepth)} recall=${String(one.ferretTokens)} notes-grep=${String(one.notesTokens)} ` +
        `notes-whole=${String(one.wholeNotesTokens)}\n`,
    );
  }
}

const report = {
  version: suite.version,
  ranAt: new Date().toISOString(),
  scenarioVersion: scenario.version,
  measured: describeTree(ROOT),
  parameters: { k: K, reads: READS, packBudget: PACK_BUDGET, findLimit: FIND_LIMIT, database: DATABASE },
  scenario: {
    sessions: scenario.sessions.length,
    statements: scenario.statements.length,
    agents: Object.keys(scenario.agents),
    paddingAvailable: available.length,
  },
  levels,
  runs,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

if (!keep) dropStore();
process.stderr.write(`\nwritten to ${outPath}\n`);
