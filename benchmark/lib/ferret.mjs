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

import { EXCLUDED_PREFIXES, contextArtefact, dedupe, entityArtefact } from './identity.mjs';

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

/**
 * Refuse to measure an index that holds the answer key.
 *
 * The baseline cannot grep `benchmark/`; `EXCLUDED_PREFIXES` sees to that. An
 * *index* built without the matching exclusion can, and filtering those results
 * out afterwards does not undo the damage — measured on the first run after the
 * harness was committed and indexed: the benchmark's own files displaced real
 * answers out of `ferret_search`'s top ten, and the corpus filter then removed
 * them, leaving a shorter list that had quietly lost the results they pushed
 * out. Worse, the strict query now matched *something* for every question, which
 * masked the empty-pack defect the benchmark had just found.
 *
 * So this is a precondition rather than a warning. It asks a `read` question —
 * "is this file in the index" — rather than reading configuration, because
 * `config.read` is not granted by default and should not be: the property that
 * matters is whether the answer key is reachable, not which rule was written.
 */
export async function assertCorpusExcluded(client, probePath) {
  const { text } = await call(client, 'ferret_find', {
    kind: 'file',
    attributes: { path: probePath },
    limit: 1,
  });
  const found = (JSON.parse(text).results ?? []).length > 0;
  if (!found) return;
  // The remediation quotes the live list rather than a copy of it, so a run
  // refused because the list grew tells the reader the whole rule.
  const rule = JSON.stringify(
    EXCLUDED_PREFIXES.map((one) => (one.endsWith('/') ? one.slice(0, -1) : one)),
  );
  throw new Error(
    `The index holds ${probePath}, which is this benchmark's answer key.\n` +
      'Exclude the harness and re-index, then run again:\n' +
      `  node dist/cli/main.js config set exclude '${rule}'\n` +
      '  node scripts/dogfood-db.mjs --index',
  );
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
