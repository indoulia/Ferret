#!/usr/bin/env node
/** Does a real agent do better engineering work with Ferret than without it? */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { assertBuildIsCurrent, describeTree } from '../lib/build.mjs';

import { EXCLUDED, ferretExclusions } from './lib/corpus.mjs';
import { grade, summarize } from './lib/grade.mjs';
import { BUILT_IN_TOOLS, run as runSession } from './lib/session.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const HERE = dirname(fileURLToPath(import.meta.url));

/** The model both arms run, and the one number here that decides how strong the agent is rather than how much help it has. */
const MODEL = process.env['FERRET_AGENT_MODEL'] ?? 'opus';

/** Reasoning effort, held identical across arms. */
const EFFORT = process.env['FERRET_AGENT_EFFORT'] ?? 'high';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

const only = flag('task', undefined);
const onlyArm = flag('arm', undefined);
const repeats = Number(flag('repeats', '1'));
const model = flag('model', MODEL);
const effort = flag('effort', EFFORT);
const plan = argv.includes('--plan');
const outPath = flag('out', join(HERE, 'results', 'latest.json'));

const CONNECTION = {
  FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
  FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
  FERRET_DATABASE_NAME: process.env['FERRET_DATABASE_NAME'] ?? 'ferret',
  FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
  FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
};

/** The principal the answering agents run as. */
function configHome() {
  const directory = join(ROOT, '.local', 'agent-benchmark-config', 'reader');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          authorization: {
            principalId: 'benchmark.agent.reader',
            principalClass: 'agent',
            permissions: ['read'],
          },
          exclude: ferretExclusions(),
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

/** Records what Ferret publishes, and refuses to measure a store that can hand the treatment this benchmark's answers. */
async function probeFerret({ root, cli, env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp'],
    cwd: root,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: 'ferret-agent-benchmark-probe', version: '1' });
  await client.connect(transport);
  const listed = await client.listTools();
  const instructions = client.getInstructions() ?? null;
  await assertAnswerKeyUnreachable(client);
  await client.close();
  return { tools: (listed.tools ?? []).map((tool) => tool.name), instructions };
}

async function assertAnswerKeyUnreachable(client) {
  for (const path of [
    'benchmark/agent/tasks.json',
    'benchmark/tasks.json',
    'benchmark/continuity/tasks.json',
    'docs/evidence/FERRET-DOES-IT-HELP.md',
    'docs/evidence/FERRET-CAN-A-FRESH-AGENT-FIND-IT.md',
  ]) {
    const result = await client.callTool({
      name: 'ferret_find',
      arguments: { kind: 'file', attributes: { path }, limit: 1 },
    });
    const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`ferret_find did not answer while probing ${path}:\n${text}`);
    }
    if ((body.results ?? []).length > 0) {
      throw new Error(
        `Ferret returns ${path}, which states this benchmark's answers.\n` +
          'The treatment would be reading the answer key. Fix the exclusion and run again.',
      );
    }
  }
}

const suite = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const tasks = suite.tasks.filter((task) => only === undefined || task.id === only);
if (tasks.length === 0) throw new Error(`no task matched --task ${only}`);

assertBuildIsCurrent({ root: ROOT, cli: CLI });
const tree = describeTree(ROOT);

const arms = ['control', 'treatment'].filter((arm) => onlyArm === undefined || arm === onlyArm);

const home = configHome();
const probe = await probeFerret({ root: ROOT, cli: CLI, env: { ...CONNECTION, FERRET_CONFIG_HOME: home } });

const workdir = join(ROOT, '.local', 'agent-benchmark-run');
mkdirSync(workdir, { recursive: true });

process.stderr.write(
  `model ${model} · effort ${effort} · ${tasks.length} task(s) × ${arms.length} arm(s) × ${repeats} repeat(s)\n` +
    `built-in tools (both arms): ${BUILT_IN_TOOLS}\n` +
    `ferret publishes ${probe.tools.length} tool(s); server instructions ${
      probe.instructions === null ? 'absent' : 'present'
    }\n` +
    `corpus withholds ${EXCLUDED.length} path prefix(es)\n`,
);

if (plan) {
  process.stderr.write(`${probe.tools.join('\n')}\n`);
  process.exit(0);
}

const runs = [];
const started = performance.now();

for (let repeat = 1; repeat <= repeats; repeat += 1) {
  for (const task of tasks) {
    process.stderr.write(`\n${task.id}${repeats > 1 ? ` [${repeat}/${repeats}]` : ''}\n`);
    for (const arm of arms) {
      const result = await runSession({
        task,
        arm,
        root: ROOT,
        cli: CLI,
        connection: CONNECTION,
        configHome: home,
        workdir: join(workdir, arm),
        model,
        effort,
      });
      const scored = grade({ task, result });
      const transcript = saveTranscript({ task, arm, repeat, result });
      runs.push({
        arm,
        repeat,
        ...scored,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
        apiErrorStatus: result.apiErrorStatus,
        transcript: relative(ROOT, transcript).split('\\').join('/'),
        trace: result.trace.map(traceSummary),
        answer: result.answer,
        ...(result.answer === undefined ? { rawResultText: result.rawResultText, stderr: result.stderr } : {}),
      });
      process.stderr.write(
        `  ${arm.padEnd(9)} ` +
          `verdict=${scored.verdictCorrect === undefined ? 'n/a' : scored.verdictCorrect ? 'right' : 'WRONG'} ` +
          `facts=${scored.factsCovered}/${scored.factsTotal} ` +
          `evidence=${scored.primaryCited}/${scored.primaryTotal} ` +
          `tools=${scored.toolCalls} ferret=${scored.ferretCalls} ` +
          `ctx=${scored.contextTokens} ${(scored.elapsedMs / 1000).toFixed(0)}s $${result.costUsd.toFixed(2)} ` +
          `[${scored.stopped}]` +
          `${scored.staleAsserted === true ? ' STALE' : ''}` +
          `${scored.unsupportedCitations > 0 ? ` unsupported=${scored.unsupportedCitations}` : ''}\n`,
      );
    }
  }
}

/** The trace, minus the tool text: the report would otherwise be megabytes of file content. */
function traceSummary(entry) {
  const { text, ...rest } = entry;
  return { ...rest, chars: text.length };
}

/** The full trace, kept beside the report so a run can be re-graded without paying for it again. */
function saveTranscript({ task, arm, repeat, result }) {
  const directory = join(workdir, 'transcripts');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${task.id}.${arm}.${repeat}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        task: task.id,
        arm,
        repeat,
        sessionId: result.sessionId,
        stopped: result.stopped,
        answer: result.answer,
        rawResultText: result.rawResultText,
        usage: result.usage,
        costUsd: result.costUsd,
        elapsedMs: result.elapsedMs,
        trace: result.trace,
      },
      null,
      2,
    )}
`,
  );
  return path;
}

const byArm = {};
for (const arm of arms) {
  byArm[arm] = summarize(runs.filter((one) => one.arm === arm));
}

/** What one arm actually cost, as Claude Code reported it per session. */
function dollars(arm) {
  return runs.filter((one) => one.arm === arm).reduce((total, one) => total + one.costUsd, 0);
}

process.stderr.write('\n');
for (const arm of arms) {
  const s = byArm[arm];
  process.stderr.write(
    `${arm.padEnd(9)} ` +
      `verdict ${pct(s.verdictCorrect)}  ` +
      `facts ${pct(s.factsComplete)} (${(s.factsCovered * 100).toFixed(0)}% of facts)  ` +
      `evidence ${pct(s.evidenceSourced)} (${(s.primaryCited * 100).toFixed(0)}% cited)  ` +
      `stale ${pct(s.staleAsserted)}  ` +
      `unsupported ${s.unsupportedCitations}\n` +
      `${' '.repeat(10)}` +
      `tools ${s.toolCallsPerTask.toFixed(1)}/task  files ${s.filesReadPerTask.toFixed(1)}  ` +
      `lines ${s.linesReadPerTask}  searches ${s.searchesPerTask.toFixed(1)}  ` +
      `ferret ${s.ferretCallsPerTask.toFixed(1)}\n` +
      `${' '.repeat(10)}` +
      `context ${s.contextTokensPerTask}/task  per-correct ${s.contextTokensPerCorrect ?? 'n/a'}  ` +
      `p50 ${(s.medianElapsedMs / 1000).toFixed(0)}s  turns ${s.medianTurns}  ` +
      `$${dollars(arm).toFixed(2)}\n`,
  );
  const surfaces = Object.entries(s.ferretSurfaces).sort((a, b) => b[1] - a[1]);
  if (surfaces.length > 0) {
    process.stderr.write(`${' '.repeat(10)}surfaces ${surfaces.map(([n, c]) => `${n}×${c}`).join(' ')}\n`);
  }
}

function pct(measure) {
  if (measure === undefined) return 'n/a';
  return `${Math.round(measure.rate * 100)}%`;
}

const report = {
  measured: new Date().toISOString(),
  tree,
  model,
  effort,
  repeats,
  builtInTools: BUILT_IN_TOOLS,
  corpus: { excluded: [...EXCLUDED] },
  ferret: {
    tools: probe.tools,
    toolCount: probe.tools.length,
    instructionsPublished: probe.instructions !== null,
    instructions: probe.instructions,
  },
  suite: { version: suite.version, baseCommit: suite.baseCommit, tasks: tasks.map((task) => task.id) },
  summary: byArm,
  elapsedSeconds: Math.round((performance.now() - started) / 1000),
  costUsd: Object.fromEntries(arms.map((arm) => [arm, Math.round(dollars(arm) * 100) / 100])),
  runs,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`\nwritten to ${outPath}\n`);

