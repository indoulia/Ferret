#!/usr/bin/env node
/** Three sessions over one store: one records, a fresh one is asked a related question, and a third is asked again after the repository changed under the answer. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertBuildIsCurrent, describeTree } from '../lib/build.mjs';

import { grade } from './lib/grade.mjs';
import { BUILT_IN_TOOLS, run as runSession } from './lib/session.mjs';
import { CONNECTION, DATABASE, configFor, dropStore, indexRepository, resetStore } from './lib/store.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the notes baseline lives during a control session, and only then.
 *
 * An agent without a knowledge layer leaves a handover note in the repository —
 * `CLAUDE.md`, `NOTES.md`, the eleven markdown files this project's own agent
 * kept outside the product before EPIC-128. So that is the baseline, and it is
 * given exactly what Session A recorded, in the same order, with nothing
 * withheld. It is written immediately before the control session and deleted
 * immediately after, and its absence is asserted before the treatment session.
 */
const HANDOVER = join(ROOT, 'HANDOVER.md');

const WORKDIR = join(ROOT, '.local', 'agent-benchmark-run', 'continuity');
const STATE = join(WORKDIR, 'state.json');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

const phase = flag('phase', undefined);
const model = flag('model', process.env['FERRET_AGENT_MODEL'] ?? 'opus');
const effort = flag('effort', process.env['FERRET_AGENT_EFFORT'] ?? 'high');
const noContent = argv.includes('--no-content');

if (phase === undefined) {
  process.stderr.write(
    'usage: node benchmark/agent/continuity.mjs --phase setup|a|b|c|report [--model opus] [--effort high]\n' +
      '\n' +
      '  setup   drop, create, migrate and index the store this harness owns\n' +
      '  a       Session A: investigate and record. Writes what it recorded to state.\n' +
      '  b       Session B: a fresh agent, both arms, on a related question\n' +
      '  c       Session C: the same subject after the repository changed. Re-index first.\n' +
      '  report  write the evidence report input from whatever phases have run\n',
  );
  process.exit(2);
}

const suite = JSON.parse(readFileSync(join(HERE, 'continuity-tasks.json'), 'utf8'));
mkdirSync(WORKDIR, { recursive: true });

function loadState() {
  if (!existsSync(STATE)) return { phases: {} };
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
}

/** The principal Session A runs as: it may read and record, and nothing else. */
const RECORDER = { principalId: 'benchmark.agent.session-a', permissions: ['read', 'record'] };

/** The principal a later session runs as: read only, so it cannot rewrite what it found. */
const READER = { principalId: 'benchmark.agent.session-later', permissions: ['read'] };

async function connect(configHome) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: ROOT,
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
  });
  const client = new Client({ name: 'ferret-agent-continuity', version: '1' });
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

/**
 * Refuse to run a phase against a store that can hand a session the answer key.
 *
 * The same precondition `run.mjs` and both earlier harnesses apply, and needed
 * here more than anywhere: Session A runs against the tree *before* the
 * exclusion fix, and the harness's own corpus rule is written as string
 * prefixes. `ferretExclusions` strips the trailing slashes so the rule works on
 * either build; this checks that it did.
 */
async function assertAnswerKeyUnreachable(configHome) {
  const client = await connect(configHome);
  try {
    for (const path of [
      'benchmark/agent/tasks.json',
      'benchmark/agent/continuity-tasks.json',
      'benchmark/tasks.json',
      'docs/evidence/FERRET-DOES-A-REAL-AGENT-DO-BETTER.md',
      'docs/evidence/FERRET-DOES-IT-HELP.md',
    ]) {
      const body = await call(client, 'ferret_find', {
        kind: 'file',
        attributes: { path },
        limit: 1,
      });
      if ((body.results ?? []).length > 0) {
        throw new Error(
          `The store returns ${path}, which states this benchmark's answers.\n` +
            'Every session would be reading the answer key.',
        );
      }
    }
  } finally {
    await client.close();
  }
}

/** Everything the store currently holds as durable context, newest first. */
async function durableContext(configHome) {
  const client = await connect(configHome);
  const body = await call(client, 'ferret_context_find', { limit: 100 });
  await client.close();
  return body.results ?? body.context ?? body.records ?? [];
}

/**
 * The notes file the control is handed: what Session A recorded, verbatim.
 *
 * Nothing is withheld — every statement, its kind, its state and whether it is
 * current, in the order the store returns them. Containment markers are
 * stripped, because a notes file has no injection boundary to mark and leaving
 * them in would be handing the control a Ferret artefact rather than a note.
 *
 * There is no rationale to carry, and that is a finding rather than an
 * omission: a durable record has `id`, `statement`, `contextKind`, `state` and
 * `current`, and nowhere for why it is believed. The continuity benchmark
 * reported the same seam.
 */
function writeHandover(records) {
  const lines = [
    '# Handover — Ferret exclusions',
    '',
    'What the previous session established about how Ferret\'s `exclude`',
    'configuration behaves. Recorded so this work is not repeated.',
    '',
  ];
  for (const record of records) {
    const statement = String(record.statement ?? '')
      .replaceAll('␂ferret:content␂', '')
      .replaceAll('␃ferret:content␃', '')
      .trim();
    lines.push(`## ${record.contextKind ?? record.kind ?? 'note'}`, '', statement, '');
    const state = record.state ?? '';
    const current = record.current;
    if (state.length > 0 || current !== undefined) {
      lines.push(`State: ${state}${current === undefined ? '' : `, current: ${String(current)}`}`, '');
    }
  }
  writeFileSync(HANDOVER, `${lines.join('\n')}\n`);
}

function say(text) {
  process.stderr.write(`${text}\n`);
}

function line(label, scored, extra = '') {
  say(
    `  ${label.padEnd(20)} ` +
      `verdict=${scored.verdictCorrect === undefined ? 'n/a' : scored.verdictCorrect ? 'right' : 'WRONG'} ` +
      `facts=${scored.factsCovered}/${scored.factsTotal} ` +
      `evidence=${scored.primaryCited}/${scored.primaryTotal} ` +
      `tools=${scored.toolCalls} ferret=${scored.ferretCalls} ` +
      `ctx=${scored.contextTokens} ${(scored.elapsedMs / 1000).toFixed(0)}s` +
      `${scored.staleAsserted === true ? ' STALE' : ''}${extra}`,
  );
}

assertBuildIsCurrent({ root: ROOT, cli: CLI });
const state = loadState();

if (phase === 'setup') {
  const indexer = configFor({ root: ROOT, principalId: 'benchmark.agent.indexer', principalClass: 'automation', permissions: ['read', 'index'] });
  say(`resetting ${DATABASE}`);
  resetStore({ root: ROOT, cli: CLI, configHome: indexer });
  say(`indexing this repository${noContent ? ' (paths and history only — not a measurement)' : ''}`);
  const { ms } = indexRepository({ root: ROOT, cli: CLI, configHome: indexer, content: !noContent });
  say(`indexed in ${(ms / 1000).toFixed(0)}s`);
  await assertAnswerKeyUnreachable(indexer);
  state.setup = { database: DATABASE, tree: describeTree(ROOT), indexSeconds: Math.round(ms / 1000), content: !noContent };
  saveState(state);
  process.exit(0);
}

if (phase === 'reindex') {
  const indexer = configFor({ root: ROOT, principalId: 'benchmark.agent.indexer', principalClass: 'automation', permissions: ['read', 'index'] });
  say('re-indexing this repository into the existing store, keeping what Session A recorded');
  const { ms } = indexRepository({ root: ROOT, cli: CLI, configHome: indexer, content: !noContent });
  say(`re-indexed in ${(ms / 1000).toFixed(0)}s`);
  await assertAnswerKeyUnreachable(indexer);
  state.reindex = { tree: describeTree(ROOT), indexSeconds: Math.round(ms / 1000) };
  saveState(state);
  process.exit(0);
}

if (phase === 'drop') {
  dropStore();
  say(`dropped ${DATABASE}`);
  if (existsSync(HANDOVER)) rmSync(HANDOVER);
  process.exit(0);
}

if (phase === 'a' || phase === 'maintain') {
  const task = suite.sessions[phase];
  const home = configFor({ root: ROOT, ...RECORDER });
  await assertAnswerKeyUnreachable(home);
  say(`session ${phase === 'a' ? 'A — investigate and record' : 'MAINTAIN — bring the record up to date'} · model ${model} · effort ${effort}`);
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
  line(task.id, scored, ` $${result.costUsd.toFixed(2)}`);

  const records = await durableContext(home);
  say(`recorded ${records.length} durable statement(s)`);
  for (const record of records) {
    say(`  · [${record.kind ?? '?'}] ${String(record.statement ?? '').slice(0, 110)}`);
  }

  state.phases[phase] = {
    tree: describeTree(ROOT),
    model,
    effort,
    scored: { ...scored, trace: result.trace.map(({ text, ...rest }) => ({ ...rest, chars: text.length })) },
    answer: result.answer,
    costUsd: result.costUsd,
    records,
    surfaces: scored.ferretSurfaces,
  };
  saveState(state);
  writeFileSync(join(WORKDIR, 'a-transcript.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (existsSync(HANDOVER)) rmSync(HANDOVER);
  process.exit(0);
}

if (phase === 'b' || phase === 'c' || phase === 'd') {
  const task = suite.sessions[phase];
  const home = configFor({ root: ROOT, ...READER });
  await assertAnswerKeyUnreachable(home);
  // Read live rather than from Session A's snapshot: by Session D a maintenance
  // session may have changed what the store holds, and the notes baseline has to
  // mirror the store as it is now or the two arms are carrying different
  // knowledge.
  const recorded = await durableContext(home);
  if (recorded.length === 0) {
    throw new Error('The store holds no durable context, so there is nothing for this phase to carry. Run --phase a first.');
  }
  say(`session ${phase.toUpperCase()} · model ${model} · effort ${effort} · ${recorded.length} statement(s) carried`);

  const outcomes = {};

  // Control first: the notes file exists only while this arm runs.
  writeHandover(recorded);
  const notesBytes = readFileSync(HANDOVER).length;
  say(`  control holds HANDOVER.md (${notesBytes} bytes) and no MCP server`);
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
  outcomes.control = { scored: grade({ task, result: control }), result: control };
  line('control', outcomes.control.scored, ` $${control.costUsd.toFixed(2)}`);

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
  outcomes.treatment = { scored: grade({ task, result: treatment }), result: treatment };
  line('treatment', outcomes.treatment.scored, ` $${treatment.costUsd.toFixed(2)}`);

  state.phases[phase] = {
    tree: describeTree(ROOT),
    model,
    effort,
    notesBytes,
    carried: recorded.length,
    arms: Object.fromEntries(
      Object.entries(outcomes).map(([arm, one]) => [
        arm,
        {
          ...one.scored,
          answer: one.result.answer,
          costUsd: one.result.costUsd,
          trace: one.result.trace.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
          ...(one.result.answer === undefined ? { rawResultText: one.result.rawResultText } : {}),
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
  const out = join(HERE, 'results', 'continuity.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        measured: new Date().toISOString(),
        database: DATABASE,
        builtInTools: BUILT_IN_TOOLS,
        suite: { version: suite.version, description: suite.description },
        gitLog: execFileSync('git', ['log', '--oneline', '-3'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'),
        ...state,
      },
      null,
      2,
    )}\n`,
  );
  say(`written to ${out}`);
  process.exit(0);
}

throw new Error(`unknown phase ${phase}`);
