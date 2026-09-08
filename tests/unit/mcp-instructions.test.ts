import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTENT_NOTICE } from '../../src/index.js';

/**
 * The `initialize` instructions as text — EPIC-138.
 *
 * The lists below were committed red in `46dba26`, before any wording existed.
 * §14 then rejected the sentence on measurement, not on wording: it passes every
 * list here. Both halves are kept — what the string is today, and what any
 * future routing guidance would still have to satisfy.
 */

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url));

/** The purpose sentence. Unchanged by EPIC-138, which shipped no product change. */
const PURPOSE =
  'Ferret answers questions about indexed repositories: commits, files, ' +
  'branches, worktrees, developers and the evidence behind each fact. ';

/** The sentence §14 measured and rejected. Kept so the lists below are exercised against real wording. */
const REJECTED_GUIDANCE =
  'For a task-shaped engineering question, check the durable context an ' +
  'earlier session recorded before exploring source, and use its verdict: ' +
  '`verified` says what was observed still matches the indexed code, ' +
  'while `stale`, `unknown` and `unanchored` each mean verify against ' +
  'source before relying on it. ';

/** Block comments wholesale, line comments only when they start a line — as `mcp-destructive-tools.test.ts` does. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The instructions literal, concatenated. Throws rather than returning `''`, which would pass every list below. */
function instructionsLiteral(): string {
  // CRLF normalized for CI, and comments stripped — the first run of this
  // extractor scored the literal's own comment block, not the literal.
  const source = stripComments(readFileSync(SERVER, 'utf8').replaceAll('\r\n', '\n'));
  const field = /\n\s*instructions:\s*([\s\S]*?CONTENT_NOTICE,)\n/.exec(source);
  if (field === null) {
    throw new Error('src/mcp/server.ts no longer composes `instructions:` ending in CONTENT_NOTICE.');
  }
  const parts = [...(field[1] as string).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((found) =>
    (found[1] as string).replaceAll("\\'", "'").replaceAll('\\\\', '\\'),
  );
  if (parts.length === 0) throw new Error('The instructions literal holds no quoted text.');
  return parts.join('') + CONTENT_NOTICE;
}

/** Whatever sits between the purpose sentence and the notice. Empty today, by EPIC-138's rejection. */
function guidance(): string {
  const instructions = instructionsLiteral();
  if (!instructions.startsWith(PURPOSE)) throw new Error('The purpose sentence changed.');
  if (!instructions.endsWith(CONTENT_NOTICE)) throw new Error('CONTENT_NOTICE is no longer last.');
  return instructions.slice(PURPOSE.length, instructions.length - CONTENT_NOTICE.length);
}

/** AC-6. Check early, not call endlessly: R138 §8 measured a querying policy at 3x the calls for no correctness gain. */
const FORBIDDEN_UNCONDITIONAL: readonly RegExp[] = Object.freeze([
  /\balways\b/i,
  /\bmust\b/i,
  /\bevery\s+(?:question|task|session|turn|time|request|query|answer)\b/i,
  /\beach\s+(?:question|task|session|turn|time|request|query)\b/i,
  /\ball\s+(?:questions|tasks|requests|queries)\b/i,
  /\b(?:begin|start)\s+every\b/i,
  /\brepeatedly\b/i,
  /\bagain\b/i,
  /\bat least\b/i,
  /\bfirst call\b/i,
  /\b(?:once|twice|three times)\b/i,
  /\b\d+\s+(?:times?|calls?|tools?)\b/i,
]);

/** AC-7. `verified` is a claim about bytes (EPIC-137 §8); guidance that upgrades it to truth licenses the U2 failure. */
const FORBIDDEN_AUTHORITY: readonly RegExp[] = Object.freeze([
  /\bauthoritative\b/i,
  /\bauthority\b/i,
  /\bsource of truth\b/i,
  /\btrust(?:ed|s|worthy)?\b/i,
  /\bcorrect(?:ly)?\b/i,
  /\baccurate\b/i,
  /\bcomplete\b/i,
  /\bdefinitive\b/i,
  /\bcanonical\b/i,
  /\breliable\b/i,
  /\bguarantee[sd]?\b/i,
  /\bprefer(?:red|able|ably)?\b/i,
  /\bbetter than\b/i,
  /\bsafe to (?:rely|use|assume|skip)\b/i,
  /\b(?:instead of|rather than|in place of)\s+(?:reading\s+)?(?:the\s+)?source\b/i,
]);

/** AC-8. No verdict reads as permission to stop — `verified` included, which is the one that could. */
const FORBIDDEN_SKIPPING_VERIFICATION: readonly RegExp[] = Object.freeze([
  /\b(?:no need|need not|needs no|unnecessary|not necessary|do not need|skip)\b[^.]*\bverif/i,
  /\bverif[a-z]*\b[^.]*\b(?:unnecessary|not needed|optional|no longer needed)\b/i,
  /\bverified\b[^.]*\b(?:no|not|never|skip|stop)\b[^.]*\bverif/i,
  /\bwithout\s+(?:reading|checking|consulting|opening)\b/i,
  /\bdo(?:es)? not\s+(?:need to\s+)?(?:read|open|check)\b/i,
]);

/** The three verdicts that mean *verify against source* — EPIC-137 §8. */
const VERDICTS_REQUIRING_VERIFICATION: readonly string[] = Object.freeze(['stale', 'unknown', 'unanchored']);

describe('what the initialize instructions say today', () => {
  it('is the purpose sentence and the notice, and nothing between them — EPIC-138 rejected', () => {
    expect(instructionsLiteral()).toBe(PURPOSE + CONTENT_NOTICE);
    expect(guidance()).toBe('');
  });

  it('does not carry the sentence §14 measured and rejected', () => {
    expect(instructionsLiteral()).not.toContain(REJECTED_GUIDANCE.trim());
  });

  it('leaves the notice present, unmodified and last', () => {
    const instructions = instructionsLiteral();
    expect(instructions).toContain(CONTENT_NOTICE);
    expect(instructions.endsWith(CONTENT_NOTICE)).toBe(true);
  });
});

describe('what any routing guidance would still have to satisfy', () => {
  // Exercised against the rejected wording, which passes all of it. The sentence
  // was rejected on §14's measurement, and these lists are why nobody need
  // re-derive whether the wording was the problem.
  const text = REJECTED_GUIDANCE;

  it('is one sentence within a handshake budget — §20', () => {
    expect(text.match(/[.!?](?=\s|$)/g)).toHaveLength(1);
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it('prescribes no call count and no call on every question — AC-6', () => {
    for (const forbidden of FORBIDDEN_UNCONDITIONAL) expect(text).not.toMatch(forbidden);
  });

  it('claims no authority for what Ferret returns — AC-7', () => {
    for (const forbidden of FORBIDDEN_AUTHORITY) expect(text).not.toMatch(forbidden);
  });

  it('names every verdict that means verify against source — AC-8', () => {
    for (const verdict of VERDICTS_REQUIRING_VERIFICATION) {
      expect(text).toContain(verdict);
      expect(text.slice(text.indexOf(verdict))).toMatch(/\bverif/i);
    }
    expect(text).toMatch(/\bsource\b/i);
  });

  it('never presents a verdict as permission to stop — AC-8', () => {
    for (const forbidden of FORBIDDEN_SKIPPING_VERIFICATION) expect(text).not.toMatch(forbidden);
  });

  it('carries no answer, no file path and no repository fact — §7', () => {
    expect(text).not.toMatch(/\.(?:ts|js|mjs|cjs|md|json|sql)\b/i);
    expect(text).not.toMatch(/\b(?:src|docs|tests|benchmark)\//i);
    expect(text).not.toMatch(/\bEPIC-\d+/i);
    expect(text).not.toMatch(/\bferret_[a-z_]+\b/i);
  });
});
