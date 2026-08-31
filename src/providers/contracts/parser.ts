import type { ProviderOperationContext } from '../sdk/operation.js';

/**
 * What a `parser` capability provider is asked, and what it returns.
 *
 * Everything after EPIC-023 needs the same thing from a file: retrieval needs
 * addressable text spans, context packs need an outline to cut on a token
 * budget, evidence needs a locator precise enough to quote, and incremental
 * indexing needs to know when a re-parse is required because the *parser*
 * changed rather than the file. Defining that once is the difference between
 * five parsers and five extraction models.
 *
 * The framework in `src/parsing/` owns selection, bounds, isolation and
 * redaction. A parser implements only this.
 */

/** What a segment is, coarsely. A parser may use whichever apply. */
export const SegmentKind = {
  /** Prose, or a run of source with no finer classification. */
  TEXT: 'text',
  /** A section title. Usually also an outline node. */
  HEADING: 'heading',
  /** Executable source. */
  CODE: 'code',
  /** A comment or docstring. */
  COMMENT: 'comment',
  /** Tabular data. */
  TABLE: 'table',
  /** Front matter, EXIF, document properties — facts about the file. */
  METADATA: 'metadata',
} as const;

export type SegmentKind = (typeof SegmentKind)[keyof typeof SegmentKind];

const SEGMENT_KINDS: ReadonlySet<string> = new Set(Object.values(SegmentKind));

export function isSegmentKind(value: unknown): value is SegmentKind {
  return typeof value === 'string' && SEGMENT_KINDS.has(value);
}

/**
 * Where a segment came from, in the *original* bytes.
 *
 * Into the original rather than into the extracted text, and this is the whole
 * point: evidence has to be able to point at the file a human will open. A span
 * into a PDF's extracted text names a position in a string nobody can see.
 */
export interface ContentSpan {
  /** Inclusive byte offset. */
  readonly startByte: number;
  /** Exclusive byte offset. */
  readonly endByte: number;
  /** 1-based, inclusive. */
  readonly startLine: number;
  /** 1-based, inclusive. Equal to `startLine` for a single-line segment. */
  readonly endLine: number;
}

export interface ContentSegment {
  readonly kind: SegmentKind;
  readonly text: string;
  readonly span: ContentSpan;
  /** A name for this segment — a function, a heading, a sheet. */
  readonly label?: string;
}

/** The file's structure, for cutting on meaning rather than character count. */
export interface OutlineNode {
  readonly title: string;
  /** Parser-chosen: `class`, `function`, `section`, `sheet`. */
  readonly kind: string;
  readonly span: ContentSpan;
  readonly children: readonly OutlineNode[];
}

/** Something the parser wants recorded but which is not a failure. */
export interface ParseWarning {
  readonly code: string;
  readonly detail: string;
}

/** What the framework knows about the file before a parser sees it. */
export interface ParseTarget {
  readonly path: string;
  readonly mediaType: string;
  readonly binary: boolean;
  readonly sizeBytes: number;
  /** EPIC-023's content hash, when the caller has one. */
  readonly contentHash?: string;
}

export interface ParseRequest {
  readonly target: ParseTarget;
  /**
   * The decoded content, when it decoded.
   *
   * Absent for binary content: a parser that claims a binary media type reads
   * `bytes` instead, and one that claims a text type can rely on this.
   */
  readonly text: string | undefined;
  readonly bytes: Uint8Array;
}

export interface ParseOutput {
  readonly segments: readonly ContentSegment[];
  readonly outline?: readonly OutlineNode[];
  /** Parser-declared facts about the file. Provider-specific by design. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly ParseWarning[];
  /** The parser stopped early — a bound of its own, not the framework's. */
  readonly truncated?: boolean;
}

/**
 * How strongly a parser claims a file.
 *
 * `fallback` exists so a generic text parser can be registered alongside
 * specific ones without displacing them: a Markdown parser claims
 * `text/markdown` natively, and the generic one offers to take it only if
 * nothing else will.
 */
export const ParserSupport = {
  NATIVE: 'native',
  FALLBACK: 'fallback',
  NONE: 'none',
} as const;

export type ParserSupport = (typeof ParserSupport)[keyof typeof ParserSupport];

/**
 * The `parser` capability.
 *
 * Implemented alongside `Provider` by a parser provider, the way
 * `GitSourceProvider` implements `RepositorySource`.
 */
export interface ContentParser {
  /** Stable, and reported in every result this parser produces. */
  readonly parserId: string;
  /**
   * The parser's own version, independent of Ferret's.
   *
   * EPIC-031 re-parses when this changes. Without it a parser fix would never
   * reach files already indexed, because the file's content hash did not move.
   */
  readonly parserVersion: string;
  /** Must not read content: it is called for every candidate. */
  supports(target: ParseTarget): ParserSupport;
  parse(
    request: ParseRequest,
    context: ProviderOperationContext,
  ): Promise<ParseOutput> | ParseOutput;
}

/** True when a provider also implements the parser capability. */
export function isContentParser(value: unknown): value is ContentParser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ContentParser>;
  return (
    typeof candidate.parserId === 'string' &&
    typeof candidate.parserVersion === 'string' &&
    typeof candidate.supports === 'function' &&
    typeof candidate.parse === 'function'
  );
}
