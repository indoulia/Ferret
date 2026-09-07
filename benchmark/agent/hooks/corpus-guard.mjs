#!/usr/bin/env node
/** PreToolUse deny hook: confines both arms to the repository, withholds the answer key, and refuses anything that would write. */

import { isAbsolute, relative, resolve } from 'node:path';

import { isExcluded } from '../lib/corpus.mjs';

/**
 * The repository. Nothing outside it is readable.
 *
 * Found in the first smoke run: Claude Code's system prompt advertises the
 * session's memory directory, and the treatment agent read
 * `.claude/projects/…/memory/no-macos-ci.md` — a note whose one line is the
 * answer to the task. Outside the repository is where an answer key nobody
 * declared lives, so containment is the rule rather than a longer deny list.
 */
const ROOT = resolve(process.env['FERRET_AGENT_ROOT'] ?? process.cwd());

/** Verbs a question-answering run has no business using. Denied so a benchmark cannot change the repository. */
const FORBIDDEN_BASH = [
  /\bgit\s+(commit|push|checkout|switch|reset|clean|rebase|merge|stash|apply|am|revert|tag)\b/,
  /\b(rm|mv|cp|chmod|chown|truncate|dd|mkdir|touch|curl|wget)\b/,
  /\bnpm\s+(install|ci|run|test|publish)\b/,
  /\b(node|npx|python|pwsh|powershell)\b/,
  />{1,2}\s*\S/,
];

/** Path-ish tokens a shell command names, for the containment and corpus checks. */
const PATHISH = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])?[\w.@-]+(?:[\\/][\w.@ -]+)+/g;

function respond(decision, reason) {
  if (decision === 'deny') {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })}\n`,
    );
  }
  process.exit(0);
}

const deny = (reason) => respond('deny', reason);
const allow = () => respond('allow');

const outside = (what) =>
  `${what} is outside the repository under test. This session answers a question about ` +
  'the repository in the working directory and reads nothing else — not notes, not ' +
  'memory files, not another checkout.';

const withheld = (what) =>
  `${what} is excluded from this session's corpus: it is the benchmark harness or an ` +
  'evidence report that states benchmark answers. The path exists but is not readable ' +
  'here. Nothing you are asked about depends on it — answer from the rest of the repository.';

/** Whether a path names something inside the repository, and its repository-relative form. */
function contained(path) {
  const absolute = isAbsolute(path) || /^[A-Za-z]:/.test(path) ? resolve(path) : resolve(ROOT, path);
  const rel = relative(ROOT, absolute).replace(/\\/g, '/');
  return { inside: rel.length > 0 && !rel.startsWith('..'), rel };
}

function checkPath(value, what) {
  if (typeof value !== 'string' || value.length === 0) return;
  if (/^~[\\/]|\.claude|[\\/]memory[\\/]/.test(value)) deny(outside(value));
  const { inside, rel } = contained(value);
  if (!inside) deny(outside(value));
  if (isExcluded(rel)) deny(withheld(rel));
  void what;
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let event;
try {
  event = JSON.parse(raw);
} catch {
  // Fails closed: a guard that cannot read its input must not be the reason an
  // answer key was readable. A refusal is loud and appears in the trace.
  deny('The corpus guard could not read this tool call and refused it.');
}

const tool = event.tool_name ?? '';
const input = event.tool_input ?? {};

if (['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tool)) {
  deny(`${tool} is not available: this session answers a question and does not change the repository.`);
}

for (const key of ['file_path', 'path', 'notebook_path']) checkPath(input[key], key);

if (tool === 'Glob' || tool === 'Grep') {
  const glob = input.glob;
  if (typeof glob === 'string' && isExcluded(glob)) deny(withheld(glob));
  const pattern = input.pattern;
  if (typeof pattern === 'string' && tool === 'Glob' && isExcluded(pattern)) deny(withheld(pattern));
}

if (tool === 'Bash') {
  const command = String(input.command ?? '');
  for (const pattern of FORBIDDEN_BASH) {
    if (pattern.test(command)) {
      deny(
        'Only read-only inspection is available in this session (git log, git show, git grep, ' +
          'cat, ls, grep). Nothing that writes, installs, downloads or executes code.',
      );
    }
  }
  for (const token of command.match(PATHISH) ?? []) {
    if (/^-/.test(token)) continue;
    if (/^~[\\/]|\.claude|[\\/]memory[\\/]/.test(token)) deny(outside(token));
    const { inside, rel } = contained(token);
    // A relative token that is not a real path resolves inside and is harmless;
    // what matters is an absolute or traversing one that escapes.
    if (!inside && (/^[A-Za-z]:/.test(token) || token.startsWith('/') || token.includes('..'))) {
      deny(outside(token));
    }
    if (inside && isExcluded(rel)) deny(withheld(rel));
  }
}

allow();
