#!/usr/bin/env node
/** Re-scores stored transcripts against the current rubric, so a scoring correction costs nothing and can be checked against the run it changes. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeTree } from '../lib/build.mjs';

import { EXCLUDED } from './lib/corpus.mjs';
import { grade, summarize } from './lib/grade.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

const from = flag('from', join(ROOT, '.local', 'agent-benchmark-run', 'transcripts'));
const outPath = flag('out', undefined);
const against = flag('against', undefined);

if (!existsSync(from)) throw new Error(`no transcripts at ${from}`);

const suite = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const byId = new Map(suite.tasks.map((task) => [task.id, task]));

const runs = [];
for (const name of readdirSync(from).filter((one) => one.endsWith('.json')).sort()) {
  const transcript = JSON.parse(readFileSync(join(from, name), 'utf8'));
  const task = byId.get(transcript.task);
  if (task === undefined) {
    process.stderr.write(`skipping ${name}: no task named ${transcript.task}\n`);
    continue;
  }
  const scored = grade({ task, result: transcript });
  runs.push({
    arm: transcript.arm,
    repeat: transcript.repeat ?? 1,
    ...scored,
    costUsd: transcript.costUsd ?? 0,
    answer: transcript.answer,
  });
}

const arms = [...new Set(runs.map((one) => one.arm))].sort();
const summary = Object.fromEntries(arms.map((arm) => [arm, summarize(runs.filter((one) => one.arm === arm))]));

function pct(measure) {
  return measure === undefined ? 'n/a' : `${Math.round(measure.rate * 100)}%`;
}

for (const arm of arms) {
  const s = summary[arm];
  process.stderr.write(
    `${arm.padEnd(9)} verdict ${pct(s.verdictCorrect)}  facts ${pct(s.factsComplete)}  ` +
      `evidence ${pct(s.evidenceSourced)}  stale ${pct(s.staleAsserted)}  ` +
      `unsupported ${s.unsupportedCitations}  ctx ${s.contextTokensPerTask}/task  ` +
      `ferret ${s.ferretCallsPerTask?.toFixed(1)}\n`,
  );
}

// A correction is only checkable against the numbers it changes, so the diff is
// printed rather than left for a reader to reconstruct.
if (against !== undefined) {
  const before = JSON.parse(readFileSync(against, 'utf8'));
  process.stderr.write(`\nagainst ${against}:\n`);
  for (const arm of arms) {
    for (const run of runs.filter((one) => one.arm === arm)) {
      const was = (before.runs ?? []).find(
        (one) => one.arm === arm && one.task === run.task && (one.repeat ?? 1) === run.repeat,
      );
      if (was === undefined) continue;
      const changes = [];
      for (const key of ['verdictCorrect', 'factsCovered', 'primaryCited', 'staleAsserted', 'unsupportedCitations']) {
        if (JSON.stringify(was[key]) !== JSON.stringify(run[key])) {
          changes.push(`${key} ${JSON.stringify(was[key])} → ${JSON.stringify(run[key])}`);
        }
      }
      if (changes.length > 0) process.stderr.write(`  ${run.task} ${arm}: ${changes.join('; ')}\n`);
    }
  }
}

if (outPath !== undefined) {
  const report = {
    measured: new Date().toISOString(),
    regradedFrom: from,
    tree: describeTree(ROOT),
    corpus: { excluded: [...EXCLUDED] },
    suite: { version: suite.version, tasks: [...new Set(runs.map((one) => one.task))] },
    summary,
    runs,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nwritten to ${outPath}\n`);
}
