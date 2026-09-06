#!/usr/bin/env node
/**
 * Does Ferret make an engineering question easier to answer than `git` does?
 *
 * The question this repository has never measured. Every Epic before this one
 * was validated against its own acceptance criteria, which proves the feature
 * works and says nothing about whether an agent holding it is better off. So
 * three conditions answer the same sixteen real questions about Ferret, drawn
 * from Ferret's own decisions, and each is measured on the same axes:
 *
 *   baseline        `git grep` and `git log --grep`, ranked — see lib/baseline.mjs
 *   ferret-pack     `ferret_context_pack`, the tool built for a task question
 *   ferret-search   `ferret_search`, the tool an agent reaches for by habit
 *
 * **What is being measured is evidence location, not prose.** Ferret assembles
 * and cites; it never writes an answer, and the brief's §1 keeps reasoning on
 * the agent's side of the boundary. Grading it on the wording of a reply would
 * be grading it against a design it does not have. What can be checked is
 * whether the artefacts an answer must rest on arrived, in what order, with
 * what else, and at what cost — and an answer given without them is unsourced
 * whatever it says.
 *
 * **Both conditions then read.** Neither returns the text of a document, so an
 * agent in either condition opens what it was pointed at. Both are charged for
 * the response *and* for opening their own top three, under the same two
 * reading habits, so the comparison is of total context spent to reach the same
 * evidence rather than of one tool's serialization against another's.
 *
 * Usage:
 *   node benchmark/run.mjs                    # every task, all three conditions
 *   node benchmark/run.mjs --task macos-runner
 *   node benchmark/run.mjs --out benchmark/results/run.json
 *
 * Requires `npm run build` and a Ferret index of this repository — the same
 * database `scripts/dogfood-db.mjs` builds.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { estimateTokens } from '../dist/context/budget.js';

import * as baseline from './lib/baseline.mjs';
import * as ferret from './lib/ferret.mjs';
import { withinCorpus } from './lib/identity.mjs';
import { K, READS, score, summarize } from './lib/score.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The pack's token budget, and the only number here that could be accused of
 * favouring one side.
 *
 * Four thousand estimated tokens: a realistic slice of a context window to
 * spend on one question, large enough that the budget is not what limits recall
 * — a run at this size reports two or three results omitted out of ten, so the
 * ranking rather than the ceiling is what decides the score. Raising it makes
 * Ferret cost more for the same artefacts; lowering it would cut the window the
 * benchmark scores at.
 */
const PACK_BUDGET = 4000;

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

const only = flag('task', undefined);
const outPath = flag('out', join(HERE, 'results', 'latest.json'));

const suite = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const tasks = suite.tasks.filter((task) => only === undefined || task.id === only);
if (tasks.length === 0) throw new Error(`no task matched --task ${only}`);

/** The read-cost entries for a ranked artefact list, for the shared cost model. */
function readEntries(artefacts, questionTerms) {
  return artefacts.flatMap((artefact) => {
    if (artefact.startsWith('file:')) {
      return [{ artefact, path: artefact.slice('file:'.length), matchedTerms: questionTerms }];
    }
    if (artefact.startsWith('commit:')) {
      return [{ artefact, sha: artefact.slice('commit:'.length), matchedTerms: questionTerms }];
    }
    // A durable statement is already in the response. There is nothing further
    // to open, and charging a second read for it would invent a cost.
    return [];
  });
}

/**
 * The corpus part of a ranked list, and how much of it was the harness.
 *
 * The baseline never greps `benchmark/` at all; Ferret indexes it like any other
 * directory and can return it, so the same exclusion is applied here to what it
 * returned. Ferret still paid to retrieve those results — the tokens are already
 * spent and are not refunded — and the count is reported rather than dropped, so
 * a run that was retrieving its own answer key says so.
 */
function corpusOnly(artefacts) {
  const kept = artefacts.filter((artefact) => withinCorpus(artefact));
  return { kept, harnessReturned: artefacts.length - kept.length };
}

function costFor(artefacts, questionTerms, responseText, ms) {
  const { full, frugal } = baseline.readCost(ROOT, readEntries(artefacts, questionTerms), {
    reads: READS,
    estimate: estimateTokens,
  });
  return {
    retrievalTokens: estimateTokens(responseText),
    readTokensFull: full,
    readTokensFrugal: frugal,
    ms,
  };
}

const client = await ferret.connect({
  root: ROOT,
  cli: CLI,
  env: {
    FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
    FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
    FERRET_DATABASE_NAME: process.env['FERRET_DATABASE_NAME'] ?? 'ferret',
    FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
    FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
    FERRET_CONFIG_HOME: process.env['FERRET_CONFIG_HOME'] ?? join(ROOT, '.local', 'ferret-config'),
  },
});

const rows = [];
for (const task of tasks) {
  const questionTerms = baseline.terms(task.question);

  const startedBaseline = performance.now();
  const found = baseline.retrieve(ROOT, task.question, { limit: K });
  const baselineMs = performance.now() - startedBaseline;
  // What the baseline "returns" is a list of paths in a terminal. Charging it
  // for that list rather than for nothing keeps the two sides symmetric; it is
  // a few dozen tokens either way.
  const baselineCost = costFor(found.artefacts, questionTerms, found.artefacts.join('\n'), baselineMs);

  const packed = await ferret.pack(client, task.question, { budget: PACK_BUDGET });
  const packRanked = corpusOnly(packed.artefacts);
  const packCost = costFor(packRanked.kept, questionTerms, packed.renderedText, packed.ms);

  const searched = await ferret.search(client, task.question, { limit: K });
  const searchRanked = corpusOnly(searched.artefacts);
  const searchCost = costFor(searchRanked.kept, questionTerms, searched.renderedText, searched.ms);

  rows.push({
    task: task.id,
    kind: task.kind,
    question: task.question,
    conditions: {
      baseline: { ranked: found.artefacts, score: score(task, found.artefacts, baselineCost) },
      'ferret-pack': {
        ranked: packRanked.kept,
        harnessReturned: packRanked.harnessReturned,
        standingCount: packed.standingCount,
        omitted: packed.omitted,
        packJsonTokens: estimateTokens(packed.jsonText),
        score: score(task, packRanked.kept, packCost),
      },
      'ferret-search': {
        ranked: searchRanked.kept,
        harnessReturned: searchRanked.harnessReturned,
        score: score(task, searchRanked.kept, searchCost),
      },
    },
  });

  const line = (name) => {
    const s = rows.at(-1).conditions[name].score;
    return `${name.padEnd(14)} sourced=${s.sourced ? 'yes' : `${s.primaryFound}/${s.primaryTotal}`} ndcg=${(s.ndcg10 ?? 0).toFixed(2)} tokens=${s.retrievalTokens + s.readTokensFull}`;
  };
  process.stderr.write(`\n${task.id}  ${task.question}\n  ${line('baseline')}\n  ${line('ferret-pack')}\n  ${line('ferret-search')}\n`);
}

await client.close();

const conditions = ['baseline', 'ferret-pack', 'ferret-search'];
const summary = Object.fromEntries(
  conditions.map((name) => [name, summarize(rows.map((row) => row.conditions[name].score))]),
);

const report = {
  version: suite.version,
  ranAt: new Date().toISOString(),
  baseCommit: suite.baseCommit,
  parameters: { k: K, reads: READS, packBudget: PACK_BUDGET },
  summary,
  tasks: rows,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

process.stderr.write('\n');
for (const name of conditions) {
  const s = summary[name];
  process.stderr.write(
    `${name.padEnd(14)} sourced ${(s.sourced.rate * 100).toFixed(0)}%  recall ${(s.recall ?? 0).toFixed(2)}  ndcg ${(s.ndcg10 ?? 0).toFixed(2)}  ` +
      `stale-first ${s.staleAboveCurrent === undefined ? 'n/a' : `${(s.staleAboveCurrent.rate * 100).toFixed(0)}%`}  ` +
      `tokens ${s.totalTokensFull} full / ${s.totalTokensFrugal} frugal  ` +
      `per-sourced ${s.tokensPerSourcedTask ?? 'n/a'}  p50 ${(s.medianMs ?? 0).toFixed(0)}ms\n`,
  );
}
process.stderr.write(`\nwritten to ${outPath}\n`);
