import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONTENT_NOTICE } from '../../src/index.js';

/**
 * The `initialize` instructions, as text — EPIC-138 AC-2, AC-6, AC-7, AC-8.
 *
 * The one string every MCP client shows before a session's first turn. EPIC-138
 * adds one sentence to it, and the whole Epic *is* that sentence: there is no
 * behaviour to assert, so what is asserted is what the words may and may not
 * say.
 *
 * **The lists below were written and committed before the wording was chosen.**
 * That ordering is the only thing that makes them a control rather than a
 * description — a forbidden-phrase list written after the sentence is a list the
 * sentence passes by construction, and proves nothing about the next person to
 * edit it. `git log` on this file against `src/mcp/server.ts` is the evidence.
 *
 * Source-level rather than through a client, on the precedent of
 * `mcp-destructive-tools.test.ts`: the property is *what the shipped literal
 * says*. AC-1 asserts the same string reaches a real client, and lives in
 * `tests/integration/mcp/tools.test.ts` where a client already exists.
 */

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url));

/** The purpose sentence, unchanged by EPIC-138 and asserted to be so. */
const PURPOSE =
  'Ferret answers questions about indexed repositories: commits, files, ' +
  'branches, worktrees, developers and the evidence behind each fact. ';

/**
 * The instructions literal, read out of the source and concatenated.
 *
 * Throws rather than returning something empty when the shape it expects is
 * gone: a text control that silently starts asserting against `''` passes every
 * list it holds, which is the failure mode this whole file exists to prevent.
 */
function instructionsLiteral(): string {
  // Line endings normalized: this repository is developed on Windows and
  // checked out on Linux in CI, and a control that matched only one of them
  // would pass on one platform by not running.
  const source = readFileSync(SERVER, 'utf8').replaceAll('\r\n', '\n');
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

/**
 * AC-6. No call count, and no instruction to call on every question.
 *
 * *Check early, not call endlessly.* R138 §8 measured what the other reading
 * costs: on a question nothing was recorded about, early routing produced three
 * times the Ferret calls and +36 s for no correctness change. A sentence that
 * reads as a policy of querying buys rediscovery savings with useless calls,
 * and §15 refuses that trade.
 */
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

/**
 * AC-7. No claim that Ferret is authoritative, correct, complete, or preferable
 * to reading source.
 *
 * EPIC-137 §8 makes `verified` a claim about bytes — that what was observed
 * still matches the indexed code — and nothing more. Guidance that upgrades it
 * into a claim about truth would license exactly the stale-context failure §14's
 * U2 gate exists to catch.
 */
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

/**
 * AC-8. No verdict may read as permission to skip source verification.
 *
 * Applies to `verified` as much as to the three that mean *verify*: the risk is
 * not that an agent distrusts a `stale` record, it is that it reads any verdict
 * as a reason to stop.
 */
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
    // One terminator, at the end. Two sentences is a paragraph, and a paragraph
    // in a handshake is the surface EPIC-136 §2.3 measured the cost of.
    expect(text.match(/[.!?](?=\s|$)/g)).toHaveLength(1);
  });

  it('costs a handshake roughly the sentence it is — EPIC-138 §20', () => {
    // Characters, not tokens: no tokenizer ships with this repository, and
    // `estimateTokens` is deliberately pessimistic about whitespace in a way
    // that misreads prose. English prose runs 4–4.7 characters per token, so
    // 320 characters is the ~60–76 tokens §20 budgets. The per-turn cost is
    // zero by construction — this string is sent at `initialize`, once.
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
      // And says so *after* naming it, so the two cannot be read apart.
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
