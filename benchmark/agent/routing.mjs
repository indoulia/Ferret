#!/usr/bin/env node
/**
 * Research harness — does *when* an agent asks Ferret change what the answer costs?
 *
 * EPIC-137 measured the anchor mechanism and found it correct, safe, and
 * unproductive, for one observed reason: the first Ferret call landed at tool
 * call 12–20 of 17–24, always after the investigation was finished. This is not
 * a Ferret change. It adds one arm whose only difference is an instruction about
 * *ordering* — check recorded context before opening source — and measures what
 * moves.
 *
 * Throwaway. It publishes nothing, changes no product behaviour, and the routing
 * text lives here rather than in any description Ferret ships.
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
const WORKDIR = join(ROOT, '.local', 'agent-benchmark-run', 'routing');
const STATE = join(WORKDIR, 'state.json');

/**
 * The whole experiment, in four sentences.
 *
 * Deliberately says nothing the plain treatment is not also free to discover:
 * no file, no answer, no mention of a verdict, of staleness, or of trust. It
 * asks "check whether any" rather than "read the one that exists", so the arm
 * is fair on a question nothing was recorded about. Trust guidance is absent on
 * purpose — whether an early-routed agent blindly believes what it is handed is
 * the safety measurement, and instructing it either way would destroy that.
 */
const ROUTING = `Before you open any source file, check whether durable engineering context about this question has already been recorded by an earlier session and is retrievable through the tools available to you. Do that check first. Then continue however you judge best.`;

/** control: no MCP. treatment: Ferret, contract unchanged. routed: Ferret, contract plus the ordering instruction. */
const CONDITIONS = {
  control: { mcp: false, suffix: '' },
  treatment: { mcp: true, suffix: '' },
  routed: { mcp: true, suffix: ROUTING },
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const phase = flag('phase', undefined);
const model = flag('model', process.env['FERRET_AGENT_MODEL'] ?? 'opus');
const effort = flag('effort', process.env['FERRET_AGENT_EFFORT'] ?? 'high');
const only = flag('arms', undefined);
const repeat = Number(flag('repeat', '1'));

if (phase === undefined) {
  process.stderr.write(
    'usage: node benchmark/agent/routing.mjs --phase setup|a|reindex|r1|r2|r5|r8|report|drop [--arms control,treatment,routed] [--repeat n]\n',
  );
  process.exit(2);
}

const anchors = JSON.parse(readFileSync(join(HERE, 'anchors-tasks.json'), 'utf8'));
const suite = JSON.parse(readFileSync(join(HERE, 'routing-tasks.json'), 'utf8'));
const benchmarkTasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks;
mkdirSync(WORKDIR, { recursive: true });

const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { phases: {} });
const saveState = (state) => writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
const say = (text) => process.stderr.write(`${text}\n`);

const RECORDER = { principalId: 'benchmark.routing.session-a', permissions: ['read', 'record'] };
const READER = { principalId: 'benchmark.routing.reader', permissions: ['read'] };

async function connect(configHome) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: ROOT,
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
  });
  const client = new Client({ name: 'ferret-routing', version: '1' });
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
      'benchmark/agent/routing-tasks.json',
      'benchmark/agent/tasks.json',
      'docs/EPICs/EPIC-137-Code-State-Anchored-Durable-Context.md',
      'docs/Architecture/EPIC-137-DECISIONS.md',
      'docs/EPICs/validation/EPIC-137-VALIDATION.md',
      'docs/evidence/FERRET-DOES-AN-ANCHOR-CARRY.md',
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

/** The notes file the control is handed: every statement A recorded, verbatim, and no verdict. */
function writeHandover(records) {
  const lines = [
    '# Handover — how Ferret decides whether a statement still describes the code',
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

const work = (result) => result.trace.filter((entry) => entry.tool !== 'StructuredOutput');

/** Reads of the paths A anchored — the rediscovery measurement EPIC-137 defined. */
function anchoredReads(result, paths) {
  const wanted = paths.map((one) => one.replaceAll('\\', '/').toLowerCase());
  return work(result).filter((entry) => {
    const path = entry.read?.path;
    if (typeof path !== 'string') return false;
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    return wanted.some((one) => normalized.includes(one));
  }).length;
}

/**
 * Where in the session Ferret was asked, relative to where source was opened.
 *
 * This is the whole hypothesis reduced to two integers. `notes` treats the
 * control's handover file as its equivalent of a Ferret call, so the control is
 * measured on the same axis rather than scoring `n/a`.
 */
function ordering(result) {
  const entries = work(result);
  const isNotes = (entry) => JSON.stringify(entry.input ?? {}).includes('HANDOVER');
  const isSourceRead = (entry) =>
    entry.read !== undefined && !isNotes(entry) && /\.(ts|mjs|js|json|md)\b/i.test(String(entry.read.path));
  const firstFerret = entries.findIndex((entry) => entry.ferret !== undefined);
  const firstNotes = entries.findIndex(isNotes);
  const firstSource = entries.findIndex(isSourceRead);
  const consult = firstFerret === -1 ? firstNotes : firstFerret;
  return {
    calls: entries.length,
    firstFerretCall: firstFerret === -1 ? null : firstFerret + 1,
    firstNotesCall: firstNotes === -1 ? null : firstNotes + 1,
    firstSourceRead: firstSource === -1 ? null : firstSource + 1,
    consultedBeforeSource: consult === -1 ? false : firstSource === -1 || consult < firstSource,
    sourceReadsAfterConsult:
      consult === -1 ? entries.filter(isSourceRead).length : entries.slice(consult + 1).filter(isSourceRead).length,
    sequence: entries.map((entry) =>
      entry.ferret
        ? `ferret:${entry.ferret.name}`
        : isNotes(entry)
          ? 'notes'
          : entry.read
            ? `read:${String(entry.read.path).split('/').pop()}`
            : entry.log
              ? 'git'
              : entry.search
                ? 'search'
                : entry.tool,
    ),
  };
}

/**
 * Whether Ferret handed the session anything on point, and whether it handed it
 * a verdict. Substring over the tool result rather than a judgement: a statement
 * A recorded either came back in the text or it did not.
 */
function whatFerretSupplied(result, records) {
  const texts = work(result)
    .filter((entry) => entry.ferret !== undefined)
    .map((entry) => entry.text ?? '');
  const joined = texts.join('\n');
  const fingerprints = records.map((record) => strip(record.statement).slice(0, 60)).filter((one) => one.length > 20);
  return {
    ferretResultChars: joined.length,
    statementsReturned: fingerprints.filter((one) => joined.includes(one)).length,
    statementsHeld: fingerprints.length,
    verdictsReturned: (joined.match(/"verdict"\s*:\s*"(verified|stale|unknown|unanchored|superseded)"/g) ?? []).length,
    verdictKinds: [...new Set((joined.match(/"verdict"\s*:\s*"(\w+)"/g) ?? []).map((one) => one.split('"')[3]))],
    surfaces: work(result)
      .filter((entry) => entry.ferret !== undefined)
      .map((entry) => `${entry.ferret.name}${entry.ferret.ok ? '' : '!'}`),
  };
}

function line(label, one) {
  const s = one.scored;
  say(
    `  ${label.padEnd(20)} verdict=${s.verdictCorrect === undefined ? 'n/a' : s.verdictCorrect ? 'right' : 'WRONG'} ` +
      `facts=${s.factsCovered}/${s.factsTotal} anchorReads=${one.anchoredFileReads} files=${s.filesRead} ` +
      `lines=${s.linesRead} ferret=${s.ferretCalls} first=${one.ordering.firstFerretCall ?? one.ordering.firstNotesCall ?? '-'}/${one.ordering.firstSourceRead ?? '-'} ` +
      `early=${one.ordering.consultedBeforeSource} after=${one.ordering.sourceReadsAfterConsult} ` +
      `ctx=${s.contextTokens} ${(s.elapsedMs / 1000).toFixed(0)}s $${one.costUsd.toFixed(2)}` +
      `${s.staleAsserted === true ? ' STALE' : ''}`,
  );
}

assertBuildIsCurrent({ root: ROOT, cli: CLI });
const state = loadState();

if (phase === 'setup' || phase === 'reindex') {
  const indexer = configFor({
    root: ROOT,
    principalId: 'benchmark.routing.indexer',
    principalClass: 'automation',
    permissions: ['read', 'index'],
  });
  if (phase === 'setup') {
    say(`resetting ${DATABASE}`);
    resetStore({ root: ROOT, cli: CLI, configHome: indexer });
  }
  say('indexing');
  const { ms } = indexRepository({ root: ROOT, cli: CLI, configHome: indexer, content: true });
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
  const task = anchors.sessions.a;
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
  say(`  session-a facts=${scored.factsCovered}/${scored.factsTotal} files=${scored.filesRead} $${result.costUsd.toFixed(2)}`);

  const records = await durableContext(home);
  const anchored = [];
  for (const record of records) {
    const paths = (record.verification?.anchors ?? []).map((one) => one.path);
    anchored.push(...paths);
    say(
      `  · [${record.contextKind ?? '?'}] verdict=${record.verification?.verdict ?? 'none'} ` +
        `anchors=${paths.length === 0 ? 'NONE' : paths.join(', ')} :: ${strip(record.statement).slice(0, 80)}`,
    );
  }
  const anchoredPaths = [...new Set(anchored)];
  if (anchoredPaths.length === 0) throw new Error('Session A anchored nothing; the routing arms have nothing to inherit.');
  say(`anchored paths: ${anchoredPaths.join(', ')}`);

  state.phases.a = {
    tree: describeTree(ROOT),
    model,
    effort,
    scored,
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

if (/^r[0-9]$/.test(phase)) {
  const spec = suite.tasks[phase];
  if (spec === undefined) throw new Error(`no task ${phase}`);
  const task =
    spec.from === 'anchors'
      ? anchors.sessions[spec.session]
      : benchmarkTasks.find((one) => one.id === spec.taskId);
  if (task === undefined) throw new Error(`no question for ${phase}`);
  const home = configFor({ root: ROOT, ...READER });
  await assertAnswerKeyUnreachable(home);
  const anchoredPaths = state.phases.a?.anchoredPaths ?? [];
  const records = await durableContext(home);
  if (records.length === 0) throw new Error('The store holds no durable context. Run --phase a first.');
  const verdicts = records.map((one) => one.verification?.verdict ?? 'absent');
  say(`${phase.toUpperCase()} · ${spec.what} · ${records.length} statement(s) carried · verdicts ${verdicts.join(',')}`);

  const arms = (only ?? spec.arms.join(',')).split(',').filter((one) => one.length > 0);
  const runs = state.phases[phase]?.runs ?? {};

  for (let pass = 1; pass <= repeat; pass += 1) {
    for (const arm of arms) {
      const condition = CONDITIONS[arm];
      if (condition === undefined) throw new Error(`unknown arm ${arm}`);
      const label = repeat === 1 ? arm : `${arm}#${pass}`;
      // Only the control is handed the notes file, and only while it runs.
      if (condition.mcp === false) writeHandover(records);
      else if (existsSync(HANDOVER)) rmSync(HANDOVER);
      const result = await runSession({
        task,
        arm: condition.mcp ? 'treatment' : 'control',
        root: ROOT,
        cli: CLI,
        connection: CONNECTION,
        configHome: home,
        workdir: join(WORKDIR, `${phase}-${label}`),
        model,
        effort,
        promptSuffix: condition.suffix,
      });
      if (existsSync(HANDOVER)) rmSync(HANDOVER);
      const one = {
        arm,
        pass,
        routed: condition.suffix.length > 0,
        scored: grade({ task, result }),
        anchoredFileReads: anchoredReads(result, anchoredPaths),
        ordering: ordering(result),
        supplied: whatFerretSupplied(result, records),
        answer: result.answer,
        costUsd: result.costUsd,
      };
      line(label, one);
      runs[label] = one;
      writeFileSync(join(WORKDIR, `${phase}-${label}-transcript.json`), `${JSON.stringify(result, null, 2)}\n`);
      state.phases[phase] = {
        tree: describeTree(ROOT),
        model,
        effort,
        what: spec.what,
        carried: records.length,
        carriedVerdicts: verdicts,
        anchoredPaths,
        routingText: ROUTING,
        runs,
      };
      saveState(state);
    }
  }
  process.exit(0);
}

if (phase === 'report') {
  const out = join(HERE, 'results', 'routing.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`);
  say(`wrote ${out}`);
  for (const [name, run] of Object.entries(state.phases)) {
    if (run.runs === undefined) continue;
    say(`\n${name} — ${run.what} · carried ${run.carriedVerdicts?.join(',')}`);
    for (const [label, one] of Object.entries(run.runs)) line(label, one);
  }
  process.exit(0);
}

throw new Error(`unknown phase ${phase}`);
