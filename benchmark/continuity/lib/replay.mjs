/**
 * The history, replayed — one store, two agents, eight sessions.
 *
 * Everything goes through the **MCP surface**, over stdio against a built CLI,
 * exactly as `.mcp.json` wires it and for the reason `scripts/dogfood.mjs`
 * gives: *"a defect that only SQL can see is not a defect a client will ever
 * hit."* A harness that seeded the database directly would be measuring
 * something no agent can reach, and three of the six defects the task benchmark
 * found were invisible from SQL.
 *
 * **Two agents means two principals, and a principal comes from configuration.**
 * There is no authentication over stdio — the client is the process's parent —
 * so a second agent is a second server process with a second configuration file
 * naming a different `principalId`. That is not a trick of the harness; it is
 * how EPIC-132 says two agents share one Ferret, and `notYours` in
 * `src/mcp/session-tools.ts` is enforced against exactly this.
 *
 * **An isolated database, not the dogfood one.** The task benchmark measures a
 * repository index and this one measures what agents recorded; writing this
 * scenario into that index would change that benchmark's standing context and
 * silently move its numbers. It would also put invented sessions into the store
 * an agent working on this repository actually reads. So the store is created,
 * migrated and dropped by this harness, which additionally makes the corpus
 * exactly what the scenario says it is — the contamination the task benchmark
 * had to correct for twice is impossible here by construction rather than by an
 * exclusion list.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** The container the dogfood database already runs in. Nothing else is assumed. */
const CONTAINER = process.env['FERRET_CONTINUITY_CONTAINER'] ?? 'ferret-dogfood';

/** The database this harness owns outright, and drops. */
export const DATABASE = process.env['FERRET_CONTINUITY_DATABASE'] ?? 'ferret_continuity';

const CONNECTION = {
  FERRET_DATABASE_HOST: process.env['FERRET_DATABASE_HOST'] ?? '127.0.0.1',
  FERRET_DATABASE_PORT: process.env['FERRET_DATABASE_PORT'] ?? '55432',
  FERRET_DATABASE_NAME: DATABASE,
  FERRET_DATABASE_USER: process.env['FERRET_DATABASE_USER'] ?? 'ferret',
  FERRET_DATABASE_PASSWORD: process.env['FERRET_DATABASE_PASSWORD'] ?? 'ferret_dogfood',
};

function psql(statement) {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', CONNECTION.FERRET_DATABASE_USER, '-d', 'postgres', '-c', statement],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/**
 * A store holding nothing, migrated and ready.
 *
 * Dropped and recreated rather than emptied, so a run cannot inherit a row a
 * previous run left behind. The MCP server refuses to migrate — deliberately,
 * `src/cli/commands/mcp.ts` composes storage with the verify policy — so the
 * migration is `ferret init`, the same command `scripts/dogfood-db.mjs` uses.
 */
export function resetStore({ root, cli, configHome }) {
  psql(`DROP DATABASE IF EXISTS ${DATABASE}`);
  psql(`CREATE DATABASE ${DATABASE}`);
  execFileSync(process.execPath, [cli, 'init'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...CONNECTION, FERRET_DATABASE_MIGRATE: 'auto', FERRET_CONFIG_HOME: configHome },
  });
}

/** Removes the store. A benchmark that leaves a database behind is a mess. */
export function dropStore() {
  psql(`DROP DATABASE IF EXISTS ${DATABASE}`);
}

/**
 * A configuration directory naming one agent.
 *
 * The permissions are the scenario's, not this file's, so an agent that should
 * not be able to curate is one the scenario says cannot rather than one a
 * helper decided for it.
 */
function configFor(configHome, agent) {
  const directory = join(configHome, agent.principalId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          authorization: {
            principalId: agent.principalId,
            principalClass: 'agent',
            permissions: agent.permissions,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

/** One connected agent: its own server process, its own principal. */
export async function connectAgent({ root, cli, configHome, agent }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp'],
    cwd: root,
    env: { ...process.env, ...CONNECTION, FERRET_CONFIG_HOME: configFor(configHome, agent) },
  });
  const client = new Client({ name: agent.principalId, version: '1' });
  await client.connect(transport);
  return client;
}

/** The text an MCP result puts in front of the model. */
export function textOf(result) {
  return (result.content ?? []).map((part) => part.text ?? JSON.stringify(part)).join('\n');
}

/**
 * One tool call, with the wall clock the caller waited.
 *
 * **A refused call is never returned as an answer.** Found by running this
 * harness: a whole-store read asked for a page larger than the tool serves,
 * every call was refused, and the condition scored zero on every task — which
 * reads as "durable context returned nothing" rather than as "the harness asked
 * wrongly". An empty result and a rejected request are different facts, and a
 * benchmark that cannot tell them apart reports the wrong one with a straight
 * face.
 *
 * A *refusal inside a successful call* — `found: false` on a session that is
 * not yours — is an answer, not an error, and passes through. That distinction
 * is the whole of the isolation measurement.
 */
export async function call(client, name, args) {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - started;
  const text = textOf(result);
  if (result.isError === true) {
    throw new Error(`${name} was refused, so this run would be measuring nothing:
${text}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { body, text, ms };
}

/**
 * Replays the scenario into the store, in the order it happened.
 *
 * Returns what the measurement needs to talk about statements by name: the
 * identifier Ferret minted for each key, and the reverse map. The reverse map is
 * **not** one-to-one, and that is the point — when a later session restates
 * something an earlier one recorded, the merger may fold the two onto one
 * record, and then one identifier answers to two keys. Which key it answers to
 * first is the one recorded, so a returned identifier resolves to the statement
 * that was made first.
 */
export async function replay({ scenario, clients }) {
  const sessionsById = new Map(scenario.sessions.map((session) => [session.id, session]));
  const statementsFor = (sessionId) => scenario.statements.filter((one) => one.session === sessionId);

  const idOfKey = new Map();
  const keyOfId = new Map();
  const sessionIdOf = new Map();
  const outcomes = [];
  const promotions = [];

  for (const session of scenario.sessions) {
    const client = clients[session.agent];

    const started = await call(client, 'ferret_session_start', {
      branch: session.branch,
      ...(session.parent === null || session.parent === undefined
        ? {}
        : { parentSessionId: sessionIdOf.get(session.parent) }),
    });
    const sessionId = started.body.sessionId;
    sessionIdOf.set(session.id, sessionId);

    for (const statement of statementsFor(session.id)) {
      // Durable first, because `ferret_context_record` is the only surface that
      // can express supersession — promotion has no field for it — and it is
      // the tool whose own description is "so a later session or a different
      // agent inherits it".
      const stored = await call(client, 'ferret_context_record', {
        statement: statement.statement,
        contextKind: statement.kind,
        ...(statement.supersedes === undefined
          ? {}
          : { supersedes: idOfKey.get(statement.supersedes) }),
      });
      const id = stored.body.context?.id;
      if (id === undefined) {
        throw new Error(`recording "${statement.key}" returned no identifier: ${stored.text}`);
      }
      idOfKey.set(statement.key, id);
      if (!keyOfId.has(id)) keyOfId.set(id, statement.key);
      outcomes.push({
        key: statement.key,
        id,
        outcome: stored.body.outcome,
        related: (stored.body.related ?? []).length,
      });

      // Then as a session memory, which is where the **rationale** goes. Both
      // sides of this benchmark are given the same rationale; only the notes
      // file has somewhere to put it that a later reader reaches, because
      // `ferret_context_record` has no rationale field. Recording it here is
      // not the harness being generous to Ferret — it is the surface Ferret
      // offers for exactly this sentence, and where it does and does not travel
      // is a thing to measure rather than to arrange.
      //
      // **A fact cannot be a session memory.** `MEMORY_KINDS` is EPIC-042's five
      // kinds and durable context added `fact` on top of them, so `fact` is
      // reachable only by recording durable context directly. The rationale for
      // a fact therefore has nowhere in Ferret to live, and this harness does
      // not invent somewhere: an earlier draft carried a fact into the session
      // tier as a `decision`, and because the merger keys on the statement *and
      // its kind*, promoting it produced a second record of the same sentence.
      // Three of twenty-five statements were duplicated that way. The
      // duplication was the harness's; the seam it exposed is not.
      if (statement.rationale !== undefined && statement.kind !== 'fact') {
        await call(client, 'ferret_session_remember', {
          sessionId,
          kind: statement.kind,
          statement: statement.statement,
          rationale: statement.rationale,
        });
      }
    }

    // Working state: recorded in the session and never promoted. This is what
    // must **not** reach the other agent, and the isolation probes check it.
    for (const note of session.private ?? []) {
      await call(client, 'ferret_session_remember', {
        sessionId,
        kind: note.kind,
        statement: note.statement,
        ...(note.rationale === undefined ? {} : { rationale: note.rationale }),
      });
    }

    if (session.checkpoint !== undefined) {
      await call(client, 'ferret_session_checkpoint', {
        sessionId,
        summary: session.checkpoint.summary,
        continuationState: session.checkpoint.continuationState,
      });
    }

    await call(client, 'ferret_session_end', { sessionId });

    // Promotion is the product's own answer to "what a session decided
    // outlives the session", so it is exercised rather than described — and it
    // is what folds a second observation onto each record, which is the state a
    // real store is in.
    //
    // **Not** on a session holding unpromoted working state. Promotion's
    // granularity is the whole session: an agent that wants two of its four
    // memories published cannot say so, so an agent with working state it does
    // not want published declines to promote the session. That is the choice
    // Ferret actually offers, and the isolation probes measure what it leaves
    // private.
    if ((session.private ?? []).length === 0) {
      const promoted = await call(client, 'ferret_context_promote', { sessionId });
      promotions.push({ session: session.id, ...promoted.body });
    }
  }

  return { idOfKey, keyOfId, sessionIdOf, sessionsById, outcomes, promotions };
}
