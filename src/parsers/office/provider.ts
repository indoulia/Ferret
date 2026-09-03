import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  OutlineKind,
  ParserSupport,
  SegmentKind,
  SpanUnit,
  type ContentSegment,
  type ContentParser,
  type ContentSpan,
  type OutlineNode,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
} from '../../providers/contracts/parser.js';
import { ProviderKind, type Provider } from '../../providers/contract.js';
import { BaseProvider } from '../../providers/sdk/base.js';
import type { ProviderOperationContext } from '../../providers/sdk/operation.js';

import { docxLibraryIdentity, readDocx } from './document.js';
import { BlockKind, type HtmlBlock } from './html.js';

/**
 * Word documents — EPIC-027.
 *
 * The second parser whose unit is not a line, and the first whose unit is not a
 * page either: a `.docx` has no pages until something lays it out. §8.2.
 */

export const DOCX_PARSER_ID = 'ferret.parser.docx';
export const DOCX_PARSER_VERSION = '1.0.0';
export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocxParserOptions {
  /** Overridden only by a test that needs to reach the bound — §8.6. */
  readonly maxBlocks?: number;
  readonly maxCharacters?: number;
}

export class DocxParserProvider extends BaseProvider implements Provider, ContentParser {
  readonly id = DOCX_PARSER_ID;
  readonly kind = ProviderKind.PARSER;
  readonly description = 'Word document headings, paragraphs and tables';
  readonly capabilities = [
    { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
  ];

  readonly parserId = DOCX_PARSER_ID;
  readonly parserVersion = DOCX_PARSER_VERSION;

  readonly #maxBlocks: number | undefined;
  readonly #maxCharacters: number | undefined;

  constructor(options: DocxParserOptions = {}) {
    super();
    this.#maxBlocks = options.maxBlocks;
    this.#maxCharacters = options.maxCharacters;
  }

  /**
   * One media type, and no fallback.
   *
   * `application/zip` is deliberately not claimed: every OOXML file is a ZIP, so
   * claiming the container would put `.xlsx` and `.pptx` through a reader that
   * would refuse them one layer down, with a worse message than `no-parser`.
   */
  supports(target: ParseTarget): ParserSupport {
    return target.mediaType === DOCX_MEDIA_TYPE ? ParserSupport.NATIVE : ParserSupport.NONE;
  }

  producerIdentity(): Promise<string> {
    return Promise.resolve(`${this.parserVersion}+${docxLibraryIdentity()}`);
  }

  async parse(request: ParseRequest, context: ProviderOperationContext): Promise<ParseOutput> {
    context.signal.throwIfAborted();

    const extraction = await readDocx(request.bytes, {
      ...(this.#maxBlocks === undefined ? {} : { maxBlocks: this.#maxBlocks }),
      ...(this.#maxCharacters === undefined ? {} : { maxCharacters: this.#maxCharacters }),
      signal: context.signal,
    });

    const size = request.target.sizeBytes;
    const segments: ContentSegment[] = [];
    let headings = 0;
    let tables = 0;

    for (const [index, block] of extraction.blocks.entries()) {
      if (block.kind === BlockKind.HEADING) headings += 1;
      if (block.kind === BlockKind.TABLE) tables += 1;
      segments.push({
        kind: segmentKindOf(block),
        text: block.text,
        span: blockSpan(index + 1, size),
        ...(block.kind === BlockKind.HEADING ? { label: block.text } : {}),
      });
    }

    return {
      segments,
      outline: outlineOf(extraction.blocks, size),
      // A heading is a section — EPIC-029 §8.4. `buildCodeSymbols` must not run.
      outlineKind: OutlineKind.DOCUMENT,
      // §8.2. A page number here would be one Word disagreed with.
      spanUnit: SpanUnit.PARAGRAPH,
      attributes: {
        language: 'docx',
        blockCount: extraction.blocks.length,
        headingCount: headings,
        tableCount: tables,
      },
      warnings: extraction.warnings,
      truncated: extraction.truncated,
    };
  }
}

function segmentKindOf(block: HtmlBlock): SegmentKind {
  switch (block.kind) {
    case BlockKind.HEADING:
      return SegmentKind.HEADING;
    case BlockKind.TABLE:
      return SegmentKind.TABLE;
    default:
      return SegmentKind.TEXT;
  }
}

/** §8.2: the block index under the declared unit, the file as the byte range. */
function blockSpan(block: number, sizeBytes: number): ContentSpan {
  return { startByte: 0, endByte: Math.max(sizeBytes, 0), startLine: block, endLine: block };
}

/**
 * The outline, nested by heading level.
 *
 * A level that skips — `h1` then `h3` — attaches to the nearest shallower
 * heading rather than inventing the missing one. Word documents skip levels
 * constantly, and a synthetic `h2` would be a section the author never wrote.
 */
function outlineOf(blocks: readonly HtmlBlock[], sizeBytes: number): readonly OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { level: number; children: OutlineNode[] }[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block.kind !== BlockKind.HEADING) continue;
    const level = block.level ?? 1;
    const node: OutlineNode = {
      title: block.text,
      kind: 'section',
      span: blockSpan(index + 1, sizeBytes),
      children: [],
    };

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push({ level, children: node.children as OutlineNode[] });
  }

  return roots;
}

/** A fresh provider, for a runtime to register. */
export function createDocxParserProvider(options: DocxParserOptions = {}): DocxParserProvider {
  return new DocxParserProvider(options);
}
