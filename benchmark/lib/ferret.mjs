/**
 * The other condition: the same question, asked through Ferret's MCP surface.
 *
 * Over stdio against a built CLI, exactly as `.mcp.json` wires it and exactly as
 * `scripts/dogfood.mjs` connects, for the reason that script gives — *"a defect
 * that only SQL can see is not a defect a client will ever hit"*. A benchmark
 * that read the database directly would be measuring something no agent can
 * reach.
 *
 * Two tools are exercised because two are plausible, and choosing one silently
 * would decide the result:
 *
 * - `ferret_context_pack` is the tool built for this question shape — "assemble
 *   what bears on this task, inside a budget". It is the **primary** Ferret
 *   condition.
 * - `ferret_search` is what an agent reaches for when it half-remembers
 *   something. Reported alongside, because if the general-purpose tool beats
 *   the purpose-built one that is a finding rather than a detail to leave out.
 *
 * Cost is charged on the **rendered** form. `format: 'text'` is what
 * `renderPack` exists for — the pack pasted into a prompt — so charging the raw
 * JSON would bill Ferret for a serialization no careful client would send. Both
 * are measured anyway and both are reported.
 */

import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { contextArtefact, dedupe, entityArtefact } from './identity.mjs';

/** The text an MCP result puts in front of the model. */
function textOf(result) {
  return (result.content ?? [])
    .map((part) => part.text ?? JSON.stringify(part))
    .join('\n');
}

/** One connected client, reused across every task in a run. */
export async function connect({ root, cli, env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp'],
    cwd: root,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: 'ferret-benchmark', version: '1' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - started;
  return { result, ms, text: textOf(result) };
}

/**
 * A context pack for the question.
 *
 * The JSON form is what supplies the ranked artefacts, because the rendered
 * form is prose and parsing entity kinds back out of it would be a second,
 * fallible reading of the same answer. The rendered form is fetched only to
 * charge the condition what a client would actually pay.
 */
export async function pack(client, question, { budget }) {
  const json = await call(client, 'ferret_context_pack', { question, budget });
  const rendered = await call(client, 'ferret_context_pack', { question, budget, format: 'text' });

  const parsed = JSON.parse(json.text);
  const items = parsed.items ?? [];
  const standing = parsed.standing ?? [];

  return {
    // Standing context is what the pack says constrains the task, and it comes
    // first in the rendered form for that reason. Ranking it first here is not
    // a thumb on the scale: it is the order the agent reads.
    artefacts: dedupe([
      // A standing entry is a flattened `StandingContext`, not an entity: it
      // carries the durable record's id and its statement, and no `kind`.
      ...standing.map((entry) => contextArtefact(entry.id)),
      ...items.map((item) => entityArtefact(item.entity)),
    ]),
    standingCount: standing.length,
    itemCount: items.length,
    omitted: parsed.omitted ?? [],
    renderedText: rendered.text,
    jsonText: json.text,
    ms: rendered.ms,
  };
}

/** A ranked search for the question. */
export async function search(client, question, { limit }) {
  const { result, ms, text } = await call(client, 'ferret_search', { query: question, limit });
  void result;
  const parsed = JSON.parse(text);
  return {
    artefacts: dedupe((parsed.results ?? []).map((hit) => entityArtefact(hit))),
    renderedText: text,
    ms,
  };
}
