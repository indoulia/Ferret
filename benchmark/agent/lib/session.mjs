/** One fresh Claude Code session per task per arm, driven headless, with its tool trace and exact token cost. */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

/** The Claude Code executable. Spawned directly rather than through a shell, which re-parses the arguments. */
const CLAUDE = process.env['FERRET_AGENT_CLAUDE'] ?? 'claude';

/** Built-in tools, identical in both arms. Read-only; the hook denies the rest. */
export const BUILT_IN_TOOLS = 'Read,Grep,Glob,Bash';

/** What is permitted without a prompt, identical in both arms. `mcp__ferret` matches nothing in the control. */
export const ALLOWED_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'Bash', 'mcp__ferret']);

/** Wall-clock ceiling for one session. */
const TIMEOUT_MS = 15 * 60 * 1000;

/** Spend ceiling for one session, so a runaway loop cannot cost unboundedly. */
const MAX_BUDGET_USD = 4;

/** The answer contract, appended to Claude Code's own system prompt — identical in both arms. */
export const CONTRACT = `You have been asked one engineering question about the repository in the working directory. Investigate with the tools you have, then answer.

Ground every claim in something you actually retrieved. Distinguish what is currently true from what used to be true: this repository contains decisions that were later reversed, and an answer resting on a superseded one is wrong however confidently it is stated.

Your final message must be exactly one JSON object matching the schema you were given, and nothing else — no prose before or after it. Keep the conclusion to a few sentences and cite only what you actually used.`;

/** The JSON schema the final message must match, per task. */
export function schemaFor(task) {
  const properties = {
    conclusion: { type: 'string', description: 'The answer, in at most a few sentences.' },
    key_facts: {
      type: 'array',
      items: { type: 'string' },
      description: 'The specific facts the conclusion rests on, one per entry.',
    },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What each fact came from: repository-relative file paths, commit shas, pull request numbers, or identifiers a tool returned.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  };
  const required = ['conclusion', 'key_facts', 'citations', 'confidence'];
  if (Array.isArray(task.verdict?.options)) {
    properties.verdict = {
      type: 'string',
      enum: [...task.verdict.options],
      description: task.verdict.description ?? 'The option that answers the question.',
    };
    required.unshift('verdict');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** MCP configuration per arm: the only intended difference between them. */
function mcpConfig({ arm, root, cli, connection, configHome, directory }) {
  const servers =
    arm === 'treatment'
      ? {
          ferret: {
            command: process.execPath,
            args: [cli, 'mcp'],
            cwd: root,
            env: { ...connection, FERRET_CONFIG_HOME: configHome },
          },
        }
      : {};
  const path = join(directory, `mcp-${arm}.json`);
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return path;
}

/** Settings holding only the corpus guard: no user, project or local settings are loaded. */
function settingsFile({ root, directory }) {
  const path = join(directory, 'settings.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: `"${process.execPath}" "${join(root, 'benchmark', 'agent', 'hooks', 'corpus-guard.mjs')}"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

/** Everything the harness needs from one stream-json line. */
function ingest(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === 'assistant') {
    state.assistantMessages += 1;
    for (const block of event.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      state.pending.set(block.id, { tool: block.name, input: block.input ?? {}, at: performance.now() });
    }
    return;
  }
  if (event.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const call = state.pending.get(block.tool_use_id);
      if (call === undefined) continue;
      state.pending.delete(block.tool_use_id);
      const text = Array.isArray(block.content)
        ? block.content.map((part) => part.text ?? '').join('\n')
        : String(block.content ?? '');
      state.trace.push(classify(call, text, block.is_error === true));
    }
    return;
  }
  if (event.type === 'result') state.result = event;
}

/** A trace entry in the shape `grade.mjs` scores, from a Claude Code tool call. */
export function classify(call, text, isError) {
  const entry = {
    tool: call.tool,
    input: call.input,
    ms: Math.round(performance.now() - call.at),
    isError,
    refused: /excluded from this session's corpus|Only read-only inspection/.test(text),
    text,
  };
  const command = String(call.input.command ?? '');
  if (call.tool === 'Read') {
    entry.read = { path: normalize(call.input.file_path), lines: text.split('\n').length };
  } else if (call.tool === 'Grep' || call.tool === 'Glob') {
    entry.search = { pattern: call.input.pattern ?? call.input.glob, matches: text.split('\n').length };
  } else if (call.tool === 'Bash' && /^\s*git\s+(log|show|blame|diff)/.test(command)) {
    entry.log = { command };
  } else if (call.tool === 'Bash' && /\b(grep|rg|findstr)\b/.test(command)) {
    entry.search = { pattern: command, matches: text.split('\n').length };
  } else if (call.tool === 'Bash' && /^\s*(cat|head|tail|sed|type)\b/.test(command)) {
    entry.read = { path: command, lines: text.split('\n').length };
  } else if (call.tool.startsWith('mcp__ferret__')) {
    entry.ferret = { name: call.tool.replace('mcp__ferret__', ''), ok: !isError, chars: text.length };
  }
  return entry;
}

function normalize(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^.*\/Ferret\//, '');
}

/** The final JSON object, or undefined when the session never produced one. */
function parseAnswer(result) {
  const text = String(result?.result ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const candidate of [fenced?.[1], text]) {
    if (candidate === undefined) continue;
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

/** Runs one session to an answer, and returns what the metrics are computed from. */
export async function run({ task, arm, root, cli, connection, configHome, workdir, model, effort, promptSuffix = '' }) {
  mkdirSync(workdir, { recursive: true });
  const settings = settingsFile({ root, directory: workdir });
  const mcp = mcpConfig({ arm, root, cli, connection, configHome, directory: workdir });

  // The prompt goes on stdin, not argv: a question containing shell metacharacters
  // arrived at the model truncated to its first word when it was an argument.
  const argv = [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    promptSuffix.length === 0 ? CONTRACT : `${CONTRACT}

${promptSuffix}`,
    '--json-schema',
    JSON.stringify(schemaFor(task)),
    '--tools',
    BUILT_IN_TOOLS,
    // Permission has to be granted as well as the tool made available, and
    // `dontAsk` denies anything not named here. The first run of this harness
    // found that out the expensive way: every Ferret call in every treatment
    // session came back "denied because Claude Code is running in don't ask
    // mode", so the treatment was a control with a broken MCP server, and some
    // `Bash` calls were denied on both sides for the same reason. The list is
    // identical in both arms — `mcp__ferret` matches nothing in the control —
    // so the arms differ by which servers exist, not by what is permitted.
    '--allowedTools',
    ...ALLOWED_TOOLS,
    '--setting-sources',
    '',
    '--settings',
    settings,
    '--strict-mcp-config',
    '--mcp-config',
    mcp,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--max-budget-usd',
    String(MAX_BUDGET_USD),
  ];

  const state = { trace: [], pending: new Map(), assistantMessages: 0, result: undefined };
  const started = performance.now();

  await new Promise((resolve, reject) => {
    // The parent's ANTHROPIC_API_KEY would take precedence over the subscription
    // login and is not the credential this runs on.
    const env = { ...process.env, FERRET_AGENT_ROOT: root };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(CLAUDE, argv, { cwd: root, env });
    child.stdin.end(task.question);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        ingest(buffer.slice(0, at), state);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      if (buffer.trim().length > 0) ingest(buffer, state);
      state.stderr = stderr.slice(-4000);
      resolve();
    });
  });

  const result = state.result;
  const usageOf = result?.usage ?? {};
  return {
    answer: parseAnswer(result),
    stopped: result === undefined ? 'no-result' : (result.terminal_reason ?? result.subtype ?? 'unknown'),
    isError: result?.is_error === true,
    apiErrorStatus: result?.api_error_status ?? null,
    sessionId: result?.session_id ?? null,
    costUsd: result?.total_cost_usd ?? 0,
    trace: state.trace,
    usage: {
      inputTokens: usageOf.input_tokens ?? 0,
      outputTokens: usageOf.output_tokens ?? 0,
      cacheReadTokens: usageOf.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usageOf.cache_creation_input_tokens ?? 0,
      turns: result?.num_turns ?? state.assistantMessages,
      nudges: 0,
    },
    elapsedMs: Math.round(performance.now() - started),
    stderr: state.stderr,
    rawResultText: String(result?.result ?? '').slice(0, 4000),
  };
}
