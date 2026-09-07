#!/usr/bin/env node
/** What a pack and a search actually cost a client, against what they claim — EPIC-136 AC-1, AC-2, AC-3. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { estimateTokens } from '../../dist/context/budget.js';
import { describeTree } from '../lib/build.mjs';

import { configFor } from './lib/store.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}
const outPath = flag('out', undefined);

/**
 * The questions, fixed.
 *
 * Three rather than one because AC-1 asks for at least three, and a single
 * question could be the one whose envelope happens to line up.
 */
const QUESTIONS = Object.freeze([
  'Should a macOS runner be added?',
  'Where does a session decision become readable by another agent?',
  'What does the exclude configuration key actually do?',
]);

const CONNECTION = {
  FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
  FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
  FERRET_DATABASE_NAME: process.env['FERRET_DATABASE_NAME'] ?? 'ferret',
  FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
  FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
};

const configHome = configFor({
  root: ROOT,
  principalId: 'delivery.reader',
  permissions: ['read'],
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, 'mcp'],
  cwd: ROOT,
  env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
});
const client = new Client({ name: 'ferret-delivery-probe', version: '1' });
await client.connect(transport);

/** The text a tool result puts in front of the model — what the client actually pays for. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((part) => part.text ?? '').join('');
  return { text, tokens: estimateTokens(text), isError: result.isError === true };
}

const packs = [];
for (const question of QUESTIONS) {
  for (const format of [undefined, 'text']) {
    const { text, tokens } = await call('ferret_context_pack', {
      question,
      budget: 4000,
      ...(format === undefined ? {} : { format }),
    });
    // Only the JSON form carries the claim; the rendered form is prose.
    const reported = format === undefined ? JSON.parse(text).estimatedTokens : undefined;
    const budget = format === undefined ? JSON.parse(text).budget : undefined;
    packs.push({
      question,
      format: format ?? 'json',
      budget,
      reportedTokens: reported,
      deliveredTokens: tokens,
      driftPercent:
        reported === undefined ? undefined : Math.round((Math.abs(tokens - reported) / tokens) * 1000) / 10,
      withinBudget: budget === undefined ? undefined : tokens <= budget,
    });
  }
}

/** A budget below the floor is raised and says so, rather than being exceeded in silence. */
const clamped = await call('ferret_context_pack', { question: QUESTIONS[0], budget: 100 });
const clampedBody = JSON.parse(clamped.text);

const searches = [];
for (const maxTokens of [undefined, 4000, 8000]) {
  const { text, tokens } = await call('ferret_search', {
    query: 'macOS runner verify matrix packaging suite',
    limit: 20,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  });
  const body = JSON.parse(text);
  searches.push({
    maxTokens: maxTokens ?? null,
    deliveredTokens: tokens,
    results: (body.results ?? []).length,
    droppedResults: body.truncated?.droppedResults ?? 0,
    withinBound: maxTokens === undefined ? undefined : tokens <= maxTokens,
  });
}

await client.close();

for (const one of packs) {
  process.stderr.write(
    `pack ${one.format.padEnd(4)} ${one.question.slice(0, 34).padEnd(36)} ` +
      `reports ${String(one.reportedTokens ?? '-').padStart(5)} of ${String(one.budget ?? '-').padStart(4)} ` +
      `delivered ${String(one.deliveredTokens).padStart(5)} ` +
      `${one.driftPercent === undefined ? '' : `drift ${String(one.driftPercent)}%`} ` +
      `${one.withinBudget === false ? 'OVER BUDGET' : ''}\n`,
  );
}
process.stderr.write(
  `pack clamp   budget 100 -> reported budget ${String(clampedBody.budget)}, ` +
    `delivered ${String(clamped.tokens)}, says so: ` +
    `${String((clampedBody.omitted ?? []).some((one) => /was raised to/.test(one.detail ?? '')))}\n`,
);
for (const one of searches) {
  process.stderr.write(
    `search maxTokens ${String(one.maxTokens ?? 'none').padEnd(5)} -> ` +
      `${String(one.deliveredTokens).padStart(6)} tokens, ${String(one.results).padStart(2)} results, ` +
      `dropped ${String(one.droppedResults)}${one.withinBound === false ? ' OVER BOUND' : ''}\n`,
  );
}

if (outPath !== undefined) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        measured: new Date().toISOString(),
        tree: describeTree(ROOT),
        packs,
        clamp: {
          asked: 100,
          appliedBudget: clampedBody.budget,
          deliveredTokens: clamped.tokens,
          saysItWasRaised: (clampedBody.omitted ?? []).some((one) => /was raised to/.test(one.detail ?? '')),
        },
        searches,
      },
      null,
      2,
    )}\n`,
  );
  process.stderr.write(`\nwritten to ${outPath}\n`);
}
