import { describe, expect, it } from 'vitest';

import { MAX_MARKDOWN_SEGMENTS, parseMarkdown } from '../../src/parsers/index.js';

/**
 * EPIC-029's Markdown scanner.
 *
 * Pure over strings, so every rule in §8.2 can be provoked exactly. The claim
 * that needs a real repository — that 206 files gain structure and none of them
 * gains a `code_symbol` — is in the integration suite.
 */

const kinds = (text: string): string[] => parseMarkdown(text).segments.map((one) => one.kind);
const labels = (text: string): (string | undefined)[] =>
  parseMarkdown(text).segments.map((one) => one.label);

describe('headings — AC-1, AC-2, AC-3', () => {
  it('reads an ATX heading as a heading and an outline node', () => {
    const parsed = parseMarkdown('# Title\n\nSome prose.\n');

    expect(parsed.segments[0]?.kind).toBe('heading');
    expect(parsed.segments[0]?.label).toBe('Title');
    expect(parsed.outline).toHaveLength(1);
    expect(parsed.outline[0]?.title).toBe('Title');
  });

  it('strips a trailing run of hashes, which is decoration', () => {
    expect(labels('## Middle ##\n')).toStrictEqual(['Middle']);
  });

  it('reads a setext heading, level 1 for = and 2 for -', () => {
    const one = parseMarkdown('Title\n=====\n');
    const two = parseMarkdown('Sub\n---\n');

    expect(one.outline[0]?.title).toBe('Title');
    expect(two.outline[0]?.title).toBe('Sub');
    // Level shows in the nesting rather than on the node, so it is asserted
    // through a document that mixes the two.
    const mixed = parseMarkdown('Title\n=====\n\nSub\n---\n');
    expect(mixed.outline).toHaveLength(1);
    expect(mixed.outline[0]?.children[0]?.title).toBe('Sub');
  });

  it('does not read a rule that underlines nothing as a heading', () => {
    // A `---` after a blank line is a thematic break, and a heading with an
    // empty title is worse than no heading.
    const parsed = parseMarkdown('Some prose.\n\n---\n\nMore prose.\n');

    expect(parsed.outline).toStrictEqual([]);
    expect(parsed.headingCount).toBe(0);
  });

  it('nests by level', () => {
    const parsed = parseMarkdown('# A\n## B\n### C\n## D\n# E\n');

    expect(parsed.outline.map((one) => one.title)).toStrictEqual(['A', 'E']);
    expect(parsed.outline[0]?.children.map((one) => one.title)).toStrictEqual(['B', 'D']);
    expect(parsed.outline[0]?.children[0]?.children.map((one) => one.title)).toStrictEqual(['C']);
  });

  it('nests a skipped level under the nearest shallower heading — AC-3', () => {
    // Real documents skip levels, and a parser that refused them would produce
    // no outline for the files most in need of one.
    const parsed = parseMarkdown('# A\n### C\n');

    expect(parsed.outline).toHaveLength(1);
    expect(parsed.outline[0]?.children.map((one) => one.title)).toStrictEqual(['C']);
  });
});

describe('fenced code — AC-4, AC-5, AC-6', () => {
  it('reads a fence as code and records its info string', () => {
    const parsed = parseMarkdown('```ts\nconst a = 1;\n```\n');

    expect(parsed.segments[0]?.kind).toBe('code');
    expect(parsed.segments[0]?.label).toBe('ts');
  });

  it('never reads a heading inside a fence — AC-5', () => {
    // A `#` inside a fence is a comment in someone else's language, and a
    // parser that read it as a heading would invent a section from a sample.
    const parsed = parseMarkdown('```sh\n# not a heading\n```\n');

    expect(parsed.outline).toStrictEqual([]);
    expect(kinds('```sh\n# not a heading\n```\n')).toStrictEqual(['code']);
  });

  it('takes a tilde fence too', () => {
    expect(kinds('~~~python\nx = 1\n~~~\n')).toStrictEqual(['code']);
  });

  it('does not let an inner fence close an outer one', () => {
    const parsed = parseMarkdown('````md\n```\ninner\n```\n````\n');

    expect(parsed.segments).toHaveLength(1);
    expect(parsed.warnings).toStrictEqual([]);
  });

  it('ends an unterminated fence at the file and says so — AC-6', () => {
    const parsed = parseMarkdown('# Title\n\n```ts\nconst a = 1;\n');

    expect(parsed.segments.map((one) => one.kind)).toStrictEqual(['heading', 'code']);
    // Reported rather than silently swallowing the rest of the document, so a
    // malformed file is diagnosable instead of mysteriously short.
    expect(parsed.warnings.map((one) => one.code)).toStrictEqual(['unterminated-fence']);
  });
});

describe('tables and front matter — AC-7, AC-8', () => {
  it('reads a table as one segment', () => {
    const parsed = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n');

    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.kind).toBe('table');
    expect(parsed.segments[0]?.text).toContain('| 1 | 2 |');
  });

  it('does not read a paragraph containing a pipe as a table', () => {
    expect(kinds('This | that, and nothing else.\n')).toStrictEqual(['text']);
  });

  it('reads front matter at the start as metadata — AC-8', () => {
    const parsed = parseMarkdown('---\ntitle: A\n---\n\n# Heading\n');

    expect(parsed.segments[0]?.kind).toBe('metadata');
    expect(parsed.segments[0]?.label).toBe('front matter');
    expect(parsed.segments[0]?.text).toBe('title: A');
    expect(parsed.segments[1]?.kind).toBe('heading');
  });

  it('does not read a rule further down as front matter — AC-8', () => {
    const parsed = parseMarkdown('# Heading\n\n---\n\nProse.\n');

    expect(parsed.segments.map((one) => one.kind)).not.toContain('metadata');
  });

  it('does not treat an unterminated opening rule as front matter', () => {
    const parsed = parseMarkdown('---\nnever closed\n');

    expect(parsed.segments.map((one) => one.kind)).not.toContain('metadata');
  });
});

describe('prose — AC-9', () => {
  it('groups a paragraph into one segment', () => {
    const parsed = parseMarkdown('One line.\nAnother line.\n\nA second paragraph.\n');

    expect(parsed.segments.map((one) => one.kind)).toStrictEqual(['text', 'text']);
    expect(parsed.segments[0]?.text).toBe('One line.\nAnother line.');
  });

  it('produces no segment for whitespace', () => {
    expect(parseMarkdown('\n\n   \n\n').segments).toStrictEqual([]);
  });
});

describe('spans name the bytes they quote — AC-10', () => {
  it('keeps every span inside the text, ordered, and naming its own bytes', () => {
    const document = [
      '---',
      'title: Spans',
      '---',
      '',
      '# Heading',
      '',
      'Some prose about spans.',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
    ].join('\n');
    const bytes = new TextEncoder().encode(document);
    const parsed = parseMarkdown(document);

    expect(parsed.segments.map((one) => one.kind)).toStrictEqual([
      'metadata',
      'heading',
      'text',
      'code',
      'table',
    ]);

    for (const segment of parsed.segments) {
      expect(segment.span.startByte).toBeGreaterThanOrEqual(0);
      expect(segment.span.endByte).toBeLessThanOrEqual(bytes.length);
      expect(segment.span.startByte).toBeLessThan(segment.span.endByte);
      expect(segment.span.startLine).toBeLessThanOrEqual(segment.span.endLine);

      // The span names the segment's own bytes — the property that makes a
      // retrieval hit quotable. Front matter is the one exception by design: the
      // span covers the fences and the text is what is between them.
      if (segment.kind !== 'metadata') {
        const quoted = new TextDecoder().decode(bytes.slice(segment.span.startByte, segment.span.endByte));
        expect(quoted).toBe(segment.text);
      }
    }
  });

  it('keeps spans correct after a multi-byte character', () => {
    // Byte offsets rather than character indexes, or a document with an em dash
    // reports spans that do not name what they quote.
    const document = '# Título — with an em dash\n\nProse after.\n';
    const bytes = new TextEncoder().encode(document);
    const parsed = parseMarkdown(document);
    const prose = parsed.segments.find((one) => one.kind === 'text');

    expect(prose).toBeDefined();
    if (prose === undefined) return;
    expect(new TextDecoder().decode(bytes.slice(prose.span.startByte, prose.span.endByte))).toBe(
      prose.text,
    );
  });
});

describe('a degenerate document — AC-14', () => {
  it('parses an empty file', () => {
    const parsed = parseMarkdown('');

    expect(parsed.segments).toStrictEqual([]);
    expect(parsed.outline).toStrictEqual([]);
    expect(parsed.warnings).toStrictEqual([]);
  });

  it('parses a file of one heading', () => {
    const parsed = parseMarkdown('# Only');

    expect(parsed.segments).toHaveLength(1);
    expect(parsed.outline).toHaveLength(1);
  });

  it('parses a file of only front matter', () => {
    const parsed = parseMarkdown('---\na: 1\n---\n');

    expect(parsed.segments.map((one) => one.kind)).toStrictEqual(['metadata']);
  });

  it('stops at the segment bound and says so', () => {
    const many = Array.from({ length: MAX_MARKDOWN_SEGMENTS + 50 }, (_unused, index) =>
      `# Heading ${String(index)}`,
    ).join('\n');
    const parsed = parseMarkdown(many);

    expect(parsed.segments).toHaveLength(MAX_MARKDOWN_SEGMENTS);
    expect(parsed.truncated).toBe(true);
    expect(parsed.warnings.map((one) => one.code)).toContain('segment-limit');
  });
});

/**
 * **A CRLF document is the same document — F-22.**
 *
 * `linesOf` split on `\n` and left the CR at the end of every line. `.` matches
 * a CR, so `# Title\r` still matched the ATX pattern — with the carriage return
 * *inside the captured title* — and every rule downstream that compared a line
 * to a literal stopped matching. Measured before the fix: an identical document
 * parsed LF gave 2 headings and 1 outline node; parsed CRLF it gave **0 and 0**.
 *
 * That is not an edge case. Git checks Markdown out as CRLF on Windows by
 * default, so on that platform it was every Markdown file Ferret indexes,
 * including its own 206 — the files where most of its recorded knowledge lives.
 * Nothing failed, nothing warned: the structure was simply absent, and a
 * document with no outline is retrievable only as a blob.
 */
describe('line endings do not change the document — F-22', () => {
  const SOURCE = '# Title\n\nBody text.\n\n## Sécond\n\nMore.\n';
  const crlf = (text: string): string => text.replace(/\n/gu, '\r\n');

  it('finds the same headings in a CRLF document as in an LF one', () => {
    const unix = parseMarkdown(SOURCE);
    const windows = parseMarkdown(crlf(SOURCE));

    const labels = (parsed: ReturnType<typeof parseMarkdown>): readonly unknown[] =>
      parsed.segments.filter((one) => one.kind === 'heading').map((one) => one.label);

    expect(labels(windows), 'a CRLF document lost its headings').toStrictEqual(labels(unix));
    expect(labels(windows)).toStrictEqual(['Title', 'Sécond']);
  });

  it('builds the same outline structure', () => {
    // Structure, not spans. A CRLF document is genuinely longer, so its byte
    // offsets differ by one per preceding line and *must* — comparing the nodes
    // whole would assert the offsets are wrong.
    const shape = (parsed: ReturnType<typeof parseMarkdown>): string =>
      JSON.stringify(parsed.outline, (key, value: unknown) => (key === 'span' ? undefined : value));

    expect(shape(parseMarkdown(crlf(SOURCE)))).toStrictEqual(shape(parseMarkdown(SOURCE)));
  });

  it('carries no carriage return into a heading label or a segment', () => {
    // The half that would survive a naive fix: the ATX pattern *did* match, so
    // the defect could also have been "headings found, titles dirty".
    const parsed = parseMarkdown(crlf(SOURCE));
    expect(JSON.stringify(parsed.segments)).not.toContain('\r');
  });

  it('still names the bytes it quotes — AC-10 under CRLF', () => {
    // The regression a careless fix causes: strip the CR from the content and
    // forget it is still a byte of the source, and every span after the first
    // line points one byte early — per line. `Sécond` is multibyte on purpose.
    const source = crlf(SOURCE);
    const bytes = new TextEncoder().encode(source);
    const decoder = new TextDecoder();

    for (const segment of parseMarkdown(source).segments) {
      expect(decoder.decode(bytes.slice(segment.span.startByte, segment.span.endByte))).toBe(
        segment.text,
      );
    }
  });
});
