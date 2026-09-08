import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTENT_NOTICE } from '../../src/index.js';

/**
 * The `initialize` guidance as text — EPIC-138 AC-2, AC-6, AC-7, AC-8.
 *
 * The lists below were committed red, before the wording existed: a
 * forbidden-phrase list written afterwards is one the sentence passes by
 * construction. AC-1 asserts the same string through a real client.
 */

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url));

/** The purpose sentence, unchanged by EPIC-138 and asserted to be so. */
const PURPOSE =
  'Ferret answers questions about indexed repositories: commits, files, ' +
  'branches, worktrees, developers and the evidence behind each fact. ';

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

/** Everything between the purpose sentence and the notice: the sentence EPIC-138 ships. */
function guidance(): string {
  const instructions = instructionsLiteral();
  if (!instructions.startsWith(PURPOSE)) {
    throw new Error('The purpose sentence changed; EPIC-138 §4 says it does not.');
  }
  if (!instructions.endsWith(CONTENT_NOTICE)) {
    throw new Error('CONTENT_NOTICE is no longer last; EPIC-138 AC-2 says it is.');
  }
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

describe('the routing guidance in the initialize instructions', () => {
  it('is one sentence, between the purpose sentence and the notice', () => {
    const text = guidance();
    expect(text.trim().length).toBeGreaterThan(0);
    // One terminator: a paragraph in a handshake is EPIC-136 §2.3's cost.
    expect(text.match(/[.!?](?=\s|$)/g)).toHaveLength(1);
  });

  it('costs a handshake roughly the sentence it is — EPIC-138 §20', () => {
    // Characters: no tokenizer ships here and `estimateTokens` misreads prose.
    // 320 chars is §20's ~60-76 tokens at 4-4.7 chars each; per-turn cost is nil.
    expect(guidance().length).toBeLessThanOrEqual(320);
  });

  it('prescribes no call count and no call on every question — AC-6', () => {
    const text = guidance();
    for (const forbidden of FORBIDDEN_UNCONDITIONAL) expect(text).not.toMatch(forbidden);
  });

  it('claims no authority for what Ferret returns — AC-7', () => {
    const text = guidance();
    for (const forbidden of FORBIDDEN_AUTHORITY) expect(text).not.toMatch(forbidden);
  });

  it('names every verdict that means verify against source — AC-8', () => {
    const text = guidance();
    for (const verdict of VERDICTS_REQUIRING_VERIFICATION) {
      expect(text).toContain(verdict);
      // After naming it, so the two cannot be read apart.
      expect(text.slice(text.indexOf(verdict))).toMatch(/\bverif/i);
    }
    expect(text).toMatch(/\bsource\b/i);
  });

  it('never presents a verdict as permission to stop — AC-8', () => {
    const text = guidance();
    for (const forbidden of FORBIDDEN_SKIPPING_VERIFICATION) expect(text).not.toMatch(forbidden);
  });

  it('carries no answer, no file path and no repository fact — §7', () => {
    const text = guidance();
    expect(text).not.toMatch(/\.(?:ts|js|mjs|cjs|md|json|sql)\b/i);
    expect(text).not.toMatch(/\b(?:src|docs|tests|benchmark)\//i);
    expect(text).not.toMatch(/\bEPIC-\d+/i);
    expect(text).not.toMatch(/\bferret_[a-z_]+\b/i);
  });

  it('leaves the notice present, unmodified and last — AC-2', () => {
    const instructions = instructionsLiteral();
    expect(instructions).toContain(CONTENT_NOTICE);
    expect(instructions.endsWith(CONTENT_NOTICE)).toBe(true);
    expect(instructions.indexOf(CONTENT_NOTICE)).toBeGreaterThan(instructions.indexOf(guidance()));
  });

  it('leaves the purpose sentence unchanged — §4', () => {
    expect(instructionsLiteral().startsWith(PURPOSE)).toBe(true);
  });
});
