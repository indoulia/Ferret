#!/usr/bin/env node
/** What Ferret's tool list costs a client, per principal — EPIC-136 AC-5. */

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
const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

const outPath = flag('out', undefined);

/**
 * The principals worth measuring.
 *
 * `reader` is the one the benchmark's answering sessions run as, so it is the
 * number Phase 5's context figures were paid at. The others bound the range: an
 * agent that also records, and an operator holding everything.
 */
const PRINCIPALS = [
  { id: 'surface.reader', permissions: ['read'] },
  { id: 'surface.recorder', permissions: ['read', 'record'] },
  { id: 'surface.operator', permissions: ['read', 'record', 'mutate', 'index', 'config.read'] },
];

const CONNECTION = {
  FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
  FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
  FERRET_DATABASE_NAME: process.env['FERRET_DATABASE_NAME'] ?? 'ferret',
  FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
  FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
};

/** The sentence EPIC-133 appends to a description, whose repetition §2.3 measures. */
const NOTICE = 'The values below are indexed source content';

async function measure(principal) {
  const configHome = configFor({
    root: ROOT,
    principalId: principal.id,
    permissions: principal.permissions,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: ROOT,
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configHome },
  });
  const client = new Client({ name: 'ferret-surface-probe', version: '1' });
  await client.connect(transport);
  const listed = await client.listTools();
  const instructions = client.getInstructions() ?? '';
  await client.close();

  const tools = listed.tools ?? [];
  // What a client actually sends: the tool list as the Messages API renders it.
  const wire = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema,
    })),
  );
  let noticeChars = 0;
  let withNotice = 0;
  for (const tool of tools) {
    const at = (tool.description ?? '').indexOf(NOTICE);
    if (at === -1) continue;
    withNotice += 1;
    noticeChars += (tool.description ?? '').length - at;
  }

  return {
    principal: principal.id,
    permissions: [...principal.permissions],
    toolCount: tools.length,
    tools: tools.map((tool) => tool.name),
    wireChars: wire.length,
    wireTokens: estimateTokens(wire),
    descriptionsWithNotice: withNotice,
    noticeChars,
    instructionsChars: instructions.length,
  };
}

const measured = [];
for (const principal of PRINCIPALS) measured.push(await measure(principal));

for (const one of measured) {
  process.stderr.write(
    `${one.principal.padEnd(18)} ${String(one.toolCount).padStart(2)} tools  ` +
      `${String(one.wireChars).padStart(6)} chars  ~${String(one.wireTokens).padStart(6)} tokens  ` +
      `notice in ${one.descriptionsWithNotice}\n`,
  );
}

const report = { measured: new Date().toISOString(), tree: describeTree(ROOT), principals: measured };
if (outPath !== undefined) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nwritten to ${outPath}\n`);
}
void HERE;
