import { describe, expect, it } from 'vitest';

import { ParserFramework } from '../../src/index.js';
import { createTextParserProvider } from '../../src/parsers/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import type { ParsedContent } from '../../src/index.js';

/**
 * A span has to name the bytes it quotes — F-24.
 *
 * EPIC-024 §8 is explicit about what a span is: an offset "into the original
 * bytes, not into the extracted text, because evidence has to be able to point
 * at the file a human will open". Every citation Ferret emits rests on it, and
 * `validate` cannot check it — a span that is wrong but inside the file passes
 * every existing test.
 *
 * So this asserts the only thing that settles it: slice the **original file
 * bytes** by the span the parser reported and compare to the segment's own text.
 * Nothing here reads the parser's opinion of its own offsets.
 *
 * Where a parser genuinely cannot map its offsets onto the file — a UTF-16
 * document, whose decoded text has no byte-for-byte relationship with what is on
 * disk — the requirement is not a precise span. It is that Ferret does not claim
 * one.
 */

const framework = new ParserFramework({ parsers: [createTextParserProvider()] });
const decoder = new TextDecoder();

async function parse(path: string, bytes: Uint8Array): Promise<ParsedContent> {
  const outcome = await framework.parse({ path, bytes }, createTestOperationContext());
  if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

/** Which segments' spans do not slice their own text out of the file. */
function misquoted(bytes: Uint8Array, parsed: ParsedContent): readonly string[] {
  return parsed.segments
    .filter((segment) => decoder.decode(bytes.subarray(segment.span.startByte, segment.span.endByte)) !== segment.text)
    .map((segment) => `${String(segment.span.startByte)}-${String(segment.span.endByte)}`);
}

describe('a span names the bytes it quotes', () => {
  it('is exact for LF markdown — the control', async () => {
    const bytes = new TextEncoder().encode('# Title\n\nHello.\n');
    expect(misquoted(bytes, await parse('a.md', bytes))).toStrictEqual([]);
  });

  it('is exact for multi-byte characters — the control', async () => {
    const bytes = new TextEncoder().encode('# Café — built\n\nEmoji: \u{1F600}\n');
    expect(misquoted(bytes, await parse('b.md', bytes))).toStrictEqual([]);
  });

  it('is exact for a file with a UTF-8 BOM — F-24', async () => {
    // Detection strips the mark so the text a parser sees matches what an editor
    // shows. Nothing then added those three bytes back, so every span in every
    // BOM'd file in the index is three bytes low — pointing one character into
    // the previous token.
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('# Title\n\nHello.\n'),
    ]);
    expect(misquoted(bytes, await parse('bom.md', bytes))).toStrictEqual([]);
  });

  it('is exact for plain text separated by more than one blank line — F-24', async () => {
    // `#plain` splits on `/\n\s*\n/` and then advances the offset by a constant
    // two bytes, so every paragraph after a wider separator drifts.
    const bytes = new TextEncoder().encode('First para.\n\n\n\nSecond para.\n');
    expect(misquoted(bytes, await parse('c.txt', bytes))).toStrictEqual([]);
  });

  it('is exact for plain text with CRLF separators — F-24', async () => {
    const bytes = new TextEncoder().encode('First para.\r\n\r\nSecond para.\r\n');
    expect(misquoted(bytes, await parse('d.txt', bytes))).toStrictEqual([]);
  });

  it('claims no precise span for UTF-16, rather than a wrong one — F-24', async () => {
    // Two bytes per code unit and a BOM: a UTF-8 offset into the decoded string
    // has no relationship to the file at all. The previous spans pointed at
    // unrelated bytes and passed validation because they were inside the file.
    //
    // The requirement is not a correct byte span — this parser cannot produce
    // one — it is that Ferret does not assert one it cannot support.
    const text = '# Title\n\nHello.\n';
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (const [index, unit] of [...text].entries()) {
      const code = unit.codePointAt(0) ?? 0;
      utf16[2 + index * 2] = code & 0xff;
      utf16[3 + index * 2] = code >> 8;
    }

    const parsed = await parse('e.md', utf16);

    expect({
      // Every span covers the file rather than naming a region inside it.
      precise: parsed.segments.some(
        (segment) => segment.span.startByte !== 0 || segment.span.endByte !== utf16.byteLength,
      ),
      // And the reason is stated rather than left for a reader to notice.
      explained: parsed.warnings.some((warning) => /utf-16/iu.test(warning.detail)),
    }).toStrictEqual({ precise: false, explained: true });
  });
});
