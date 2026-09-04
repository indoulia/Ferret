import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  OutlineKind,
  ParserSupport,
  SegmentKind,
  type ContentParser,
  type ContentSegment,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
} from '../../providers/contracts/parser.js';
import { ProviderKind, type Provider } from '../../providers/contract.js';
import { BaseProvider } from '../../providers/sdk/base.js';
import type { ProviderOperationContext } from '../../providers/sdk/operation.js';

import { MAX_MARKDOWN_SEGMENTS, parseMarkdown } from './markdown.js';

/**
 * Documents — EPIC-029.
 *
 * Two parsers in one provider because they are one decision: Markdown natively,
 * and anything else textual as a **fallback** so it claims what nothing else
 * will without displacing a specific parser. `ParserSupport.FALLBACK` exists for
 * exactly this, and its own contract comment says so.
 *
 * No grammar and no dependency — see `markdown.ts`. This provider is therefore
 * cheap to start, which matters because it claims the long tail.
 */

export const TEXT_PARSER_ID = 'ferret.parser.text';
export const TEXT_PARSER_VERSION = '1.0.0';

/** The media types this parser claims outright. */
export const TEXT_NATIVE_MEDIA_TYPES: readonly string[] = Object.freeze(['text/markdown']);

/** What it will take when nothing else offers. */
export const TEXT_FALLBACK_MEDIA_TYPES: readonly string[] = Object.freeze([
  'text/plain',
  'text/x-rst',
  'text/troff',
]);

export class TextParserProvider extends BaseProvider implements Provider, ContentParser {
  readonly id = TEXT_PARSER_ID;
  readonly kind = ProviderKind.PARSER;
  readonly description = 'Markdown and plain-text structure, without a grammar';
  readonly capabilities = [
    { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
  ];

  readonly parserId = TEXT_PARSER_ID;
  /**
   * No runtime suffix, unlike the code parser's `+wts0.25.10`.
   *
   * There is no grammar runtime to name. What changes a result is this version
   * alone, which is what EPIC-031 re-parses on.
   */
  readonly parserVersion = TEXT_PARSER_VERSION;

  /**
   * Native for Markdown, fallback for other text.
   *
   * Declining a binary rather than guessing: EPIC-024 then reports the honest
   * reason, and a fallback that claimed everything would displace `no-parser`
   * with a segment nobody can use.
   */
  supports(target: ParseTarget): ParserSupport {
    if (target.binary) return ParserSupport.NONE;
    if (TEXT_NATIVE_MEDIA_TYPES.includes(target.mediaType)) return ParserSupport.NATIVE;
    if (TEXT_FALLBACK_MEDIA_TYPES.includes(target.mediaType)) return ParserSupport.FALLBACK;
    return ParserSupport.NONE;
  }

  producerIdentity(): Promise<string> {
    return Promise.resolve(this.parserVersion);
  }

  parse(request: ParseRequest, context: ProviderOperationContext): Promise<ParseOutput> {
    context.signal.throwIfAborted();
    const markdown = TEXT_NATIVE_MEDIA_TYPES.includes(request.target.mediaType);
    return Promise.resolve(markdown ? this.#markdown(request) : this.#plain(request));
  }

  #markdown(request: ParseRequest): ParseOutput {
    const parsed = parseMarkdown(request.text ?? '');
    return {
      segments: parsed.segments,
      outline: parsed.outline,
      // EPIC-029 §8.4. A heading is a section, not a declaration: said here so
      // `buildCodeSymbols` is never applied to it.
      outlineKind: OutlineKind.DOCUMENT,
      attributes: {
        language: 'markdown',
        headingCount: parsed.headingCount,
      },
      warnings: parsed.warnings,
      truncated: parsed.truncated,
    };
  }

  /**
   * Plain text: one segment per paragraph, and no outline.
   *
   * A `.txt` file has no structure to claim, and inventing one would be a claim
   * about content this Epic does not make — EPIC-029 §8.3. Paragraphs rather
   * than one segment for the file, because a paragraph is the smallest unit a
   * retrieval hit can usefully quote.
   */
  #plain(request: ParseRequest): ParseOutput {
    const text = request.text ?? '';
    const segments: ContentSegment[] = [];
    const encoder = new TextEncoder();
    let byte = 0;
    let line = 1;
    let truncated = false;

    // A *capturing* split, so the separator's real width is known rather than
    // assumed. Advancing by a constant two bytes drifted on every gap wider
    // than one blank line and on every CRLF file — and a drifting span still
    // passes every check, because it is inside the file. It just does not
    // quote what it says it quotes.
    for (const [index, part] of text.split(/(\n\s*\n)/).entries()) {
      if (index % 2 === 1) {
        // The separator itself: measured, not estimated.
        byte += encoder.encode(part).length;
        line += part.split('\n').length - 1;
        continue;
      }
      const bytes = encoder.encode(part).length;
      const lineCount = part.split('\n').length;
      if (part.trim().length > 0) {
        if (segments.length >= MAX_MARKDOWN_SEGMENTS) {
          truncated = true;
          break;
        }
        segments.push({
          kind: SegmentKind.TEXT,
          text: part,
          span: {
            startByte: byte,
            endByte: byte + bytes,
            startLine: line,
            endLine: line + lineCount - 1,
          },
        });
      }
      byte += bytes;
      line += lineCount - 1;
    }

    return {
      segments,
      outline: [],
      outlineKind: OutlineKind.DOCUMENT,
      attributes: { language: 'text' },
      warnings: truncated
        ? [{ code: 'segment-limit', detail: `Stopped at ${String(MAX_MARKDOWN_SEGMENTS)} segments.` }]
        : [],
      truncated,
    };
  }
}

/** A fresh provider, for a runtime to register. */
export function createTextParserProvider(): TextParserProvider {
  return new TextParserProvider();
}
