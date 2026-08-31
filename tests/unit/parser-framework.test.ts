import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_PARSE_BYTES,
  ParserFramework,
  ParserSupport,
  SegmentKind,
  UnparsedReason,
  detectContent,
  mediaTypeForPath,
  type ContentParser,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
  type ParsedContent,
  type UnparsedContent,
} from '../../src/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/** A parser that turns each line into a segment, so spans are checkable. */
function lineParser(
  overrides: {
    readonly id?: string;
    readonly claims?: readonly string[];
    readonly fallbackFor?: readonly string[];
    readonly version?: string;
    readonly parse?: (request: ParseRequest) => ParseOutput | Promise<ParseOutput>;
  } = {},
): ContentParser {
  const claims = new Set(overrides.claims ?? ['text/plain']);
  const fallback = new Set(overrides.fallbackFor ?? []);
  return {
    parserId: overrides.id ?? 'test.parser.lines',
    parserVersion: overrides.version ?? '1.0.0',
    supports(target: ParseTarget) {
      if (claims.has(target.mediaType)) return ParserSupport.NATIVE;
      if (fallback.has(target.mediaType)) return ParserSupport.FALLBACK;
      return ParserSupport.NONE;
    },
    parse:
      overrides.parse ??
      ((request: ParseRequest): ParseOutput => {
        const text = request.text ?? '';
        const segments = [];
        let offset = 0;
        let line = 1;
        for (const piece of text.split('\n')) {
          segments.push({
            kind: SegmentKind.TEXT,
            text: piece,
            span: {
              startByte: offset,
              endByte: offset + encoder.encode(piece).length,
              startLine: line,
              endLine: line,
            },
          });
          offset += encoder.encode(piece).length + 1;
          line += 1;
        }
        return { segments };
      }),
  };
}

function context(signal?: AbortSignal): ReturnType<typeof createTestOperationContext> {
  return createTestOperationContext(signal === undefined ? {} : { signal });
}

function parsed(outcome: ParsedContent | UnparsedContent): ParsedContent {
  if (!outcome.parsed) throw new Error(`expected a parsed result, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

function unparsed(outcome: ParsedContent | UnparsedContent): UnparsedContent {
  if (outcome.parsed) throw new Error('expected an unparsed result');
  return outcome;
}

describe('content detection', () => {
  it('maps common extensions to media types — AC-11', () => {
    expect(mediaTypeForPath('src/a.ts')).toBe('text/x-typescript');
    expect(mediaTypeForPath('README.md')).toBe('text/markdown');
    expect(mediaTypeForPath('package.json')).toBe('application/json');
    expect(mediaTypeForPath('a/b/notes.txt')).toBe('text/plain');
    expect(mediaTypeForPath('doc.pdf')).toBe('application/pdf');
  });

  it('knows extensionless files that are conventionally text', () => {
    expect(mediaTypeForPath('Dockerfile')).toBe('text/plain');
    expect(mediaTypeForPath('deep/path/Makefile')).toBe('text/plain');
    expect(mediaTypeForPath('LICENSE')).toBe('text/plain');
  });

  it('has no answer for an unknown extension, rather than guessing', () => {
    expect(mediaTypeForPath('thing.wibble')).toBeUndefined();
  });

  it('detects a mislabelled binary by its bytes — AC-11', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const detection = detectContent('screenshot.txt', png);

    expect(detection.binary).toBe(true);
    expect(detection.mediaType).toBe('image/png');
  });

  it('treats a NUL byte as binary whatever the name says — AC-11', () => {
    const detection = detectContent('notes.txt', new Uint8Array([0x68, 0x69, 0x00, 0x21]));
    expect(detection.binary).toBe(true);
    expect(detection.mediaType).toBe('application/octet-stream');
  });

  it('reads UTF-8 with a byte-order mark as text', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('hello')]);
    const detection = detectContent('a.txt', withBom);

    expect(detection.binary).toBe(false);
    expect(detection.encoding).toBe('utf-8-bom');
    expect(detection.mediaType).toBe('text/plain');
  });

  it('reports an empty file as empty text, not as binary', () => {
    const detection = detectContent('a.txt', new Uint8Array(0));
    expect(detection).toMatchObject({ binary: false, sizeBytes: 0 });
  });

  it('falls back to plain text for an unknown extension that reads as text', () => {
    expect(detectContent('thing.wibble', bytesOf('plain words')).mediaType).toBe('text/plain');
  });
});

describe('parser selection', () => {
  it('selects a parser that claims the media type natively — AC-1', async () => {
    const framework = new ParserFramework({ parsers: [lineParser()] });

    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('one\ntwo') }, context()));

    expect(outcome.parserId).toBe('test.parser.lines');
    expect(outcome.parserVersion).toBe('1.0.0');
    expect(outcome.segments.map((segment) => segment.text)).toStrictEqual(['one', 'two']);
  });

  it('lets registration order decide between two native claims — AC-1', async () => {
    const framework = new ParserFramework({
      parsers: [lineParser({ id: 'first' }), lineParser({ id: 'second' })],
    });

    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context()));
    expect(outcome.parserId).toBe('first');
  });

  it('prefers a native claim over a fallback registered earlier — AC-2', async () => {
    const framework = new ParserFramework({
      parsers: [
        lineParser({ id: 'generic', claims: [], fallbackFor: ['text/markdown'] }),
        lineParser({ id: 'markdown', claims: ['text/markdown'] }),
      ],
    });

    const outcome = parsed(await framework.parse({ path: 'a.md', bytes: bytesOf('# hi') }, context()));
    expect(outcome.parserId).toBe('markdown');
  });

  it('uses a fallback when nothing claims the type natively — AC-2', async () => {
    const framework = new ParserFramework({
      parsers: [lineParser({ id: 'generic', claims: [], fallbackFor: ['text/markdown'] })],
    });

    const outcome = parsed(await framework.parse({ path: 'a.md', bytes: bytesOf('# hi') }, context()));
    expect(outcome.parserId).toBe('generic');
  });

  it('reports no-parser rather than failing — AC-3', async () => {
    const framework = new ParserFramework({ parsers: [lineParser({ claims: ['text/markdown'] })] });

    const outcome = unparsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context()));

    expect(outcome.reason).toBe(UnparsedReason.NO_PARSER);
    expect(outcome.mediaType).toBe('text/plain');
    expect(outcome.parserId).toBeUndefined();
  });
});

describe('bounds and content shape', () => {
  it('does not hand a parser content over the size bound — AC-4', async () => {
    const parse = vi.fn();
    const framework = new ParserFramework({ parsers: [lineParser({ parse })], maxBytes: 8 });

    const outcome = unparsed(
      await framework.parse({ path: 'a.txt', bytes: bytesOf('far too many bytes') }, context()),
    );

    expect(outcome.reason).toBe(UnparsedReason.TOO_LARGE);
    expect(outcome.detail).toContain('8');
    expect(parse).not.toHaveBeenCalled();
  });

  it('defaults the bound to something a source file never reaches', () => {
    expect(DEFAULT_MAX_PARSE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('reports binary content no parser claims — AC-5', async () => {
    const framework = new ParserFramework({ parsers: [lineParser()] });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

    const outcome = unparsed(await framework.parse({ path: 'a.png', bytes: png }, context()));
    expect(outcome.reason).toBe(UnparsedReason.BINARY);
  });

  it('lets a parser claim binary input explicitly — AC-5', async () => {
    const binaryParser = lineParser({
      id: 'test.parser.png',
      claims: ['image/png'],
      parse: () => ({
        segments: [
          {
            kind: SegmentKind.METADATA,
            text: 'a picture',
            span: { startByte: 0, endByte: 10, startLine: 1, endLine: 1 },
          },
        ],
      }),
    });
    const framework = new ParserFramework({ parsers: [binaryParser] });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

    const outcome = parsed(await framework.parse({ path: 'a.png', bytes: png }, context()));
    expect(outcome.parserId).toBe('test.parser.png');
  });

  it('reports an empty file as empty', async () => {
    const framework = new ParserFramework({ parsers: [lineParser()] });
    const outcome = unparsed(await framework.parse({ path: 'a.txt', bytes: new Uint8Array(0) }, context()));
    expect(outcome.reason).toBe(UnparsedReason.EMPTY);
  });
});

describe('parser isolation', () => {
  it('reports a throwing parser without failing the call — AC-6', async () => {
    const framework = new ParserFramework({
      parsers: [
        lineParser({
          parse: () => {
            throw new Error('unbalanced brackets');
          },
        }),
      ],
    });

    const outcome = unparsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context()));

    expect(outcome.reason).toBe(UnparsedReason.PARSER_FAILED);
    expect(outcome.detail).toContain('unbalanced brackets');
    expect(outcome.parserId).toBe('test.parser.lines');
  });

  it('leaves the next file unaffected — AC-6', async () => {
    let calls = 0;
    const framework = new ParserFramework({
      parsers: [
        lineParser({
          parse: (request) => {
            calls += 1;
            if (calls === 1) throw new Error('first file is broken');
            return { segments: [{ kind: SegmentKind.TEXT, text: request.text ?? '', span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 } }] };
          },
        }),
      ],
    });

    expect(unparsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('a') }, context())).reason).toBe(
      UnparsedReason.PARSER_FAILED,
    );
    expect(parsed(await framework.parse({ path: 'b.txt', bytes: bytesOf('b') }, context())).segments).toHaveLength(1);
  });

  it.each([
    ['a segment with no text', { segments: [{ kind: SegmentKind.TEXT, span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 } }] }],
    ['a span past the end of the content', { segments: [{ kind: SegmentKind.TEXT, text: 'x', span: { startByte: 0, endByte: 9999, startLine: 1, endLine: 1 } }] }],
    ['a span that runs backwards', { segments: [{ kind: SegmentKind.TEXT, text: 'x', span: { startByte: 3, endByte: 1, startLine: 1, endLine: 1 } }] }],
    ['a line number below one', { segments: [{ kind: SegmentKind.TEXT, text: 'x', span: { startByte: 0, endByte: 1, startLine: 0, endLine: 1 } }] }],
    ['no segments array at all', {}],
  ])('rejects %s — AC-7', async (_label, output) => {
    const framework = new ParserFramework({
      parsers: [lineParser({ parse: () => output as ParseOutput })],
    });

    const outcome = unparsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('hello') }, context()));
    expect(outcome.reason).toBe(UnparsedReason.INVALID_RESULT);
  });

  it('accepts a result whose spans are consistent with the content — AC-12', async () => {
    const framework = new ParserFramework({ parsers: [lineParser()] });
    const content = 'alpha\nbeta\ngamma';

    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf(content) }, context()));

    for (const segment of outcome.segments) {
      expect(segment.span.startByte).toBeGreaterThanOrEqual(0);
      expect(segment.span.endByte).toBeLessThanOrEqual(content.length);
      expect(segment.span.startLine).toBeGreaterThanOrEqual(1);
      expect(segment.span.endLine).toBeGreaterThanOrEqual(segment.span.startLine);
    }
    expect(outcome.segments.at(-1)?.span.endLine).toBe(3);
  });
});

describe('cancellation', () => {
  it('stops before calling a parser when already aborted — AC-10', async () => {
    const parse = vi.fn();
    const framework = new ParserFramework({ parsers: [lineParser({ parse })] });
    const controller = new AbortController();
    controller.abort();

    const outcome = unparsed(
      await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context(controller.signal)),
    );

    expect(outcome.reason).toBe(UnparsedReason.CANCELLED);
    expect(parse).not.toHaveBeenCalled();
  });

  it('hands the signal to a parser that has started — AC-10', async () => {
    let seen: AbortSignal | undefined;
    const framework = new ParserFramework({
      parsers: [
        lineParser({
          parse: () => ({ segments: [] }),
        }),
      ],
    });
    const spy = new ParserFramework({
      parsers: [
        {
          parserId: 'test.parser.signal',
          parserVersion: '1.0.0',
          supports: () => ParserSupport.NATIVE,
          parse: (_request, operation) => {
            seen = operation.signal;
            return { segments: [] };
          },
        },
      ],
    });
    void framework;

    const controller = new AbortController();
    await spy.parse({ path: 'a.txt', bytes: bytesOf('x') }, context(controller.signal));

    expect(seen).toBe(controller.signal);
  });
});

describe('credential redaction', () => {
  it('keeps a credential out of every segment, and counts it — AC-8', async () => {
    const secret = 'ghp_0123456789012345678901234567890123456789';
    const framework = new ParserFramework({ parsers: [lineParser()] });

    const outcome = parsed(
      await framework.parse({ path: 'a.txt', bytes: bytesOf(`token = ${secret}\nsafe line`) }, context()),
    );

    expect(JSON.stringify(outcome.segments)).not.toContain(secret);
    expect(outcome.redactedSecrets).toBeGreaterThan(0);
    expect(outcome.segments.some((segment) => segment.text.includes('safe line'))).toBe(true);
  });

  it('reports nothing redacted for clean content', async () => {
    const framework = new ParserFramework({ parsers: [lineParser()] });
    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('nothing here') }, context()));
    expect(outcome.redactedSecrets).toBe(0);
  });

  it('redacts even when the parser did not — the framework is where it is enforced — AC-8', async () => {
    const secret = 'ghp_0123456789012345678901234567890123456789';
    const framework = new ParserFramework({
      parsers: [
        lineParser({
          parse: (request) => ({
            segments: [
              {
                kind: SegmentKind.TEXT,
                text: request.text ?? '',
                span: { startByte: 0, endByte: request.bytes.length, startLine: 1, endLine: 1 },
              },
            ],
          }),
        }),
      ],
    });

    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf(secret) }, context()));
    expect(outcome.segments[0]?.text).not.toContain(secret);
  });
});

describe('provenance', () => {
  it('names the parser and its version — AC-9', async () => {
    const framework = new ParserFramework({ parsers: [lineParser({ version: '2.3.4' })] });
    const outcome = parsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context()));

    expect(outcome).toMatchObject({ parserId: 'test.parser.lines', parserVersion: '2.3.4' });
  });

  it('gives an unparsed result a reason instead of a parser — AC-9', async () => {
    const framework = new ParserFramework({ parsers: [] });
    const outcome = unparsed(await framework.parse({ path: 'a.txt', bytes: bytesOf('x') }, context()));

    expect(outcome.reason).toBe(UnparsedReason.NO_PARSER);
    expect(outcome.detail.length).toBeGreaterThan(0);
  });
});
