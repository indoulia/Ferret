#!/usr/bin/env node
/**
 * EPIC-137 — T1..T5. Does an anchored statement let a fresh agent skip
 * rediscovery, and does it refuse to when the code moved?
 *
 * Session A investigates and records. Five fresh sessions are then asked a
 * question that finding answers, under five states of the repository. Nothing
 * synthesises an anchor and nothing tells the treatment to trust a verdict: the
 * anchor is whatever Session A chose to pass to `ferret_context_record`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertBuildIsCurrent, describeTree } from '../lib/build.mjs';

import { grade } from './lib/grade.mjs';
import { run as runSession } from './lib/session.mjs';
import { CONNECTION, DATABASE, configFor, dropStore, indexRepository, resetStore } from './lib/store.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOVER = join(ROOT, 'HANDOVER.md');
const WORKDIR = join(ROOT, '.local', 'agent-benchmark-run', 'anchors');
const STATE = join(WORKDIR, 'state.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const phase = flag('phase', undefined);
const model = flag('model', process.env['FERRET_AGENT_MODEL'] ?? 'opus');
const effort = flag('effort', process.env['FERRET_AGENT_EFFORT'] ?? 'high');
const noContent = argv.includes('--no-content');

if (phase === undefined) {
  process.stderr.write(
    'usage: node benchmark/agent/anchors.mjs --phase setup|a|reindex|t1|t2|t3|t4|t5|report|drop\n' +
      '\n' +
      '  setup    drop, create, migrate and index the store this harness owns\n' +
      '  a        Session A: investigate and record, treatment only\n' +
      '  reindex  re-index the current tree into the same store, keeping what A recorded\n' +
      '  t1..t5   one fresh session per arm, on the carried question\n' +
      '  report   write results/anchors.json from whatever has run\n',
  );
  process.exit(2);
}

const suite = JSON.parse(readFileSync(join(HERE, 'anchors-tasks.json'), 'utf8'));
mkdirSync(WORKDIR, { recursive: true });

const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { phases: {} });
const saveState = (state) => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
const say = (text) => process.stderr.write(`${text}\n`);

const RECORDER = { principalId: 'benchmark.anchors.session-a', permissions: ['read', 'record'] };
const READER = { principalId: 'benchmark.anchors.reader', permissions: ['read'] };

async function connect(configHome) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: ROOT,
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
  });
  const client = new Client({ name: 'ferret-anchors', version: '1' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
  if (result.isError === true) throw new Error(`${name} refused: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Refuse to run against a store that can hand a session the answer key. */
async function assertAnswerKeyUnreachable(configHome) {
  const client = await connect(configHome);
  try {
    for (const path of [
      'benchmark/agent/anchors-tasks.json',
      'benchmark/agent/tasks.json',
      'benchmark/agent/continuity-tasks.json',
      'docs/EPICs/EPIC-137-Code-State-Anchored-Durable-Context.md',
      'docs/Architecture/EPIC-137-DECISIONS.md',
      'docs/evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md',
    ]) {
      const body = await call(client, 'ferret_find', { kind: 'file', attributes: { path }, limit: 1 });
      if ((body.results ?? []).length > 0) {
        throw new Error(`The store returns ${path}, which states this benchmark's answers.`);
      }
    }
  } finally {
    await client.close();
  }
}

async function durableContext(configHome) {
  const client = await connect(configHome);
  const body = await call(client, 'ferret_context_find', { limit: 100 });
  await client.close();
  return body.context ?? body.results ?? [];
}

const strip = (value) =>
  String(value ?? '')
    .replaceAll('␂ferret:content␂', '')
    .replaceAll('␃ferret:content␃', '')
    .trim();

/**
 * The notes file the control is handed: every statement A recorded, verbatim.
 *
 * The verdict is deliberately **not** written into it. A notes file has no
 * mechanism for saying whether the code still matches — that absence is the
 * capability under test, and supplying it would hand the control the thing only
 * the treatment has.
 */
function writeHandover(records) {
  const lines = [
    '# Handover — how Ferret decides whether a statement still matches the code',
    '',
    'What the previous session established. Recorded so this work is not repeated.',
    '',
  ];
  for (const record of records) {
    lines.push(`## ${record.contextKind ?? 'note'}`, '', strip(record.statement), '');
    lines.push(`State: ${record.state ?? ''}, current: ${String(record.current)}`, '');
  }
  writeFileSync(HANDOVER, `${lines.join('\n')}\n`);
}

/** Reads of the paths A anchored — the primary measurement. */
function anchoredReads(result, paths) {
  const wanted = new Set(paths.map((one) => one.replaceAll('\\', '/').toLowerCase()));
  return result.trace.filter((entry) => {
    const path = entry.read?.path;
    if (typeof path !== 'string') return false;
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    return [...wanted].some((one) => normalized.endsWith(one));
  }).length;
}

function line(label, scored, extra = '') {
  say(
    `  ${label.padEnd(12)} verdict=${scored.verdictCorrect === undefined ? 'n/a' : scored.verdictCorrect ? 'right' : 'WRONG'} ` +
      `facts=${scored.factsCovered}/${scored.factsTotal} files=${scored.filesRead} lines=${scored.linesRead} ` +
      `tools=${scored.toolCalls} ferret=${scored.ferretCalls} ctx=${scored.contextTokens} ` +
      `${(scored.elapsedMs / 1000).toFixed(0)}s${scored.staleAsserted === true ? ' STALE' : ''}${extra}`,
  );
}

assertBuildIsCurrent({ root: ROOT, cli: CLI });
const state = loadState();

if (phase === 'setup' || phase === 'reindex') {
  const indexer = configFor({
    root: ROOT,
    principalId: 'benchmark.anchors.indexer',
    principalClass: 'automation',
    permissions: ['read', 'index'],
  });
  if (phase === 'setup') {
    say(`resetting ${DATABASE}`);
    resetStore({ root: ROOT, cli: CLI, configHome: indexer });
  }
  say(`indexing${noContent ? ' (paths and history only)' : ''}`);
  const { ms } = indexRepository({ root: ROOT, cli: CLI, configHome: indexer, content: !noContent });
  say(`indexed in ${(ms / 1000).toFixed(0)}s`);
  await assertAnswerKeyUnreachable(indexer);
  state[phase] = { database: DATABASE, tree: describeTree(ROOT), indexSeconds: Math.round(ms / 1000) };
  saveState(state);
  process.exit(0);
}

if (phase === 'drop') {
  dropStore();
  if (existsSync(HANDOVER)) rmSync(HANDOVER);
  say(`dropped ${DATABASE}`);
  process.exit(0);
}

if (phase === 'a') {
  const task = suite.sessions.a;
  const home = configFor({ root: ROOT, ...RECORDER });
  await assertAnswerKeyUnreachable(home);
  say(`session A — investigate and record · model ${model} · effort ${effort}`);
  const result = await runSession({
    task,
    arm: 'treatment',
    root: ROOT,
    cli: CLI,
    connection: CONNECTION,
    configHome: home,
    workdir: join(WORKDIR, 'a'),
    model,
    effort,
  });
  const scored = grade({ task, result });
  line('session-a', scored, ` $${result.costUsd.toFixed(2)}`);

  const records = await durableContext(home);
  say(`recorded ${records.length} durable statement(s)`);
  const anchored = [];
  for (const record of records) {
    const verification = record.verification;
    const paths = (verification?.anchors ?? []).map((one) => one.path);
    anchored.push(...paths);
    say(
      `  · [${record.contextKind ?? '?'}] verdict=${verification?.verdict ?? 'none'} ` +
        `anchors=${paths.length === 0 ? 'NONE' : paths.join(', ')} :: ${strip(record.statement).slice(0, 90)}`,
    );
  }
  const anchoredPaths = [...new Set(anchored)];
  say(anchoredPaths.length === 0 ? 'NO ANCHOR WAS RECORDED — T1..T5 cannot measure inheritance' : `anchored paths: ${anchoredPaths.join(', ')}`);

  state.phases.a = {
    tree: describeTree(ROOT),
    model,
    effort,
    scored: { ...scored, trace: result.trace.map(({ text, ...rest }) => ({ ...rest, chars: text.length })) },
    answer: result.answer,
    costUsd: result.costUsd,
    records,
    anchoredPaths,
  };
  saveState(state);
  writeFileSync(join(WORKDIR, 'a-transcript.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (existsSync(HANDOVER)) rmSync(HANDOVER);
  process.exit(0);
}

if (/^t[1-5]$/.test(phase)) {
  const task = suite.sessions.b;
  const home = configFor({ root: ROOT, ...READER });
  await assertAnswerKeyUnreachable(home);
  const anchoredPaths = state.phases.a?.anchoredPaths ?? [];
  const recorded = await durableContext(home);
  if (recorded.length === 0) throw new Error('The store holds no durable context. Run --phase a first.');

  const verdicts = recorded.map((one) => one.verification?.verdict ?? 'absent');
  say(`${phase.toUpperCase()} · ${recorded.length} statement(s) carried · verdicts ${verdicts.join(',')}`);

  const outcomes = {};
  writeHandover(recorded);
  const notesBytes = readFileSync(HANDOVER).length;
  const control = await runSession({
    task,
    arm: 'control',
    root: ROOT,
    cli: CLI,
    connection: CONNECTION,
    configHome: home,
    workdir: join(WORKDIR, `${phase}-control`),
    model,
    effort,
  });
  rmSync(HANDOVER);
  outcomes.control = { scored: grade({ task, result: control }), anchoredFileReads: anchoredReads(control, anchoredPaths), result: control };
  line('control', outcomes.control.scored, ` anchorReads=${outcomes.control.anchoredFileReads} $${control.costUsd.toFixed(2)}`);

  if (existsSync(HANDOVER)) throw new Error('HANDOVER.md is still present; the treatment would be reading the notes too.');
  const treatment = await runSession({
    task,
    arm: 'treatment',
    root: ROOT,
    cli: CLI,
    connection: CONNECTION,
    configHome: home,
    workdir: join(WORKDIR, `${phase}-treatment`),
    model,
    effort,
  });
  outcomes.treatment = { scored: grade({ task, result: treatment }), anchoredFileReads: anchoredReads(treatment, anchoredPaths), result: treatment };
  line('treatment', outcomes.treatment.scored, ` anchorReads=${outcomes.treatment.anchoredFileReads} $${treatment.costUsd.toFixed(2)}`);

  state.phases[phase] = {
    tree: describeTree(ROOT),
    model,
    effort,
    notesBytes,
    carried: recorded.length,
    carriedVerdicts: verdicts,
    anchoredPaths,
    arms: Object.fromEntries(
      Object.entries(outcomes).map(([arm, one]) => [
        arm,
        {
          scored: { ...one.scored, trace: one.result.trace.map(({ text, ...rest }) => ({ ...rest, chars: text.length })) },
          anchoredFileReads: one.anchoredFileReads,
          answer: one.result.answer,
          costUsd: one.result.costUsd,
        },
      ]),
    ),
  };
  saveState(state);
  for (const [arm, one] of Object.entries(outcomes)) {
    writeFileSync(join(WORKDIR, `${phase}-${arm}-transcript.json`), `${JSON.stringify(one.result, null, 2)}\n`);
  }
  process.exit(0);
}

if (phase === 'report') {
  const out = join(HERE, 'results', 'anchors.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`);
  say(`wrote ${out}`);
  for (const [name, run] of Object.entries(state.phases)) {
    if (run.arms === undefined) continue;
    for (const [arm, one] of Object.entries(run.arms)) {
      say(
        `${name} ${arm.padEnd(9)} verdict=${one.scored.verdictCorrect ? 'right' : 'WRONG'} ` +
          `facts=${one.scored.factsCovered}/${one.scored.factsTotal} anchorReads=${one.anchoredFileReads} ` +
          `files=${one.scored.filesRead} lines=${one.scored.linesRead} ctx=${one.scored.contextTokens} ` +
          `stale=${String(one.scored.staleAsserted)} $${one.costUsd.toFixed(2)}`,
      );
    }
  }
  process.exit(0);
}

throw new Error(`unknown phase ${phase}`);
