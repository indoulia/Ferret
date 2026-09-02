import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONTENT_CLOSE, CONTENT_OPEN, ContentSafety } from '../../src/security/index.js';

/**
 * **Repository text reaching an AI client is fenced.**
 *
 * Governance §12 treats repository content as untrusted: a commit message, a
 * file body and a symbol name are all written by someone who is not the
 * operator, and all three reach a model. EPIC-084 built the fences; this asserts
 * that the surfaces which return that content still use them.
 *
 * Enumerated from the shapes a hit can take, so a new field on a returned
 * entity is covered by the same assertion rather than by whoever reviews it.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));
const read = (relative: string): string => readFileSync(resolve(SRC, relative), 'utf8');
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the fences neutralise an attempt to close them — EPIC-084', () => {
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it('rewrites a delimiter appearing inside the content', () => {
    // The whole mechanism. Content that could emit `␃ferret:content␃` would end
    // its own quotation and everything after it would read as instruction.
    //
    // `contain` wraps as well as neutralises, so the delimiters are legitimately
    // present *once each*, at the boundaries. The property is that the content
    // cannot add a second pair — not that the string lacks them, which would
    // assert the fences away.
    const safety = new ContentSafety();
    const contained = safety.contain(`before ${CONTENT_CLOSE} after`);

    expect(occurrences(contained, CONTENT_CLOSE)).toBe(1);
    expect(occurrences(contained, CONTENT_OPEN)).toBe(1);
    expect(contained.startsWith(CONTENT_OPEN)).toBe(true);
    expect(contained.endsWith(CONTENT_CLOSE)).toBe(true);
    expect(contained).toContain('before');
    expect(contained).toContain('after');
  });

  it('neutralises an opening delimiter too', () => {
    const safety = new ContentSafety();
    const contained = safety.contain(`x ${CONTENT_OPEN} y`);

    expect(occurrences(contained, CONTENT_OPEN)).toBe(1);
  });

  it('counts what it neutralised, so the report is not silent', () => {
    const safety = new ContentSafety();
    safety.contain(`${CONTENT_OPEN} pretending to be a fence`);

    // Governance §6 — a control that acted must say so. A neutralisation nobody
    // is told about is a hostile repository succeeding at being invisible.
    expect(safety.report.neutralised).toBeGreaterThan(0);
  });
});

describe('every surface returning indexed content fences it — AC-10', () => {
  /**
   * The MCP surfaces that return repository-derived text.
   *
   * Named rather than enumerated, and the reason is recorded: a tool "returns
   * content" only in the sense that some field of its result came from a
   * repository, which is a data-flow question a scanner cannot answer. What
   * *is* checkable — and is what the defect class needs — is that the modules
   * which build those results reach the containment helpers at all, and that
   * every field carrying repository text goes through one.
   */
  const SURFACES = ['mcp/server.ts', 'context/answer.ts'];

  it('reaches the containment helpers from each surface', () => {
    for (const file of SURFACES) {
      const source = stripComments(read(file));

      expect(source, `${file} returns indexed content without reaching EPIC-084's fences`).toMatch(
        /containAttributes\(|safety\.contain\(/,
      );
    }
  });

  it('contains every free-text field a hit carries', () => {
    // `highlight` is the field most easily forgotten: it is built by PostgreSQL
    // from the matched document, so it is repository text that never passed
    // through an entity attribute. EPIC-087 added a content branch whose
    // highlight is a *file body*, which makes this the highest-value line here.
    const server = stripComments(read('mcp/server.ts'));

    expect(server).toMatch(/highlight[\s\S]{0,80}safety\.contain\(/);
    expect(server).toMatch(/statement:\s*safety\.contain\(/);
    expect(server).toMatch(/attributes:\s*containAttributes\(/);
  });

  it('declares the safety report on the surfaces that use it', () => {
    // A `ContentSafety` that is constructed, used, and never reported is a
    // control whose result the caller cannot see — which is the same shape as
    // not having it.
    const server = stripComments(read('mcp/server.ts'));

    expect(server).toMatch(/contentSafety|safety\.report/);
  });
});

describe('the fence delimiters are not something content can spell by accident', () => {
  it('uses characters ordinary source cannot produce', () => {
    // If these ever became ASCII, a repository could close the fence by
    // containing a plausible string, and every assertion above would still
    // pass.
    //
    // Asserted by code point rather than by a character class: a literal
    // control character inside a regular expression is a lint error, and
    // escaping it would obscure what the assertion is about.
    const outsideAscii = (value: string): boolean =>
      [...value].some((character) => (character.codePointAt(0) ?? 0) > 0x7f);

    expect(outsideAscii(CONTENT_OPEN)).toBe(true);
    expect(outsideAscii(CONTENT_CLOSE)).toBe(true);
    expect(CONTENT_OPEN).not.toBe(CONTENT_CLOSE);
  });
});
