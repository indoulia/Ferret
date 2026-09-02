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

/**
 * What kind of use a reference is — EPIC-035 §8.1.
 *
 * Deliberately coarse. A parser reports what its grammar can see without a type
 * checker, and a vocabulary finer than this would be claiming knowledge no
 * grammar has.
 */
export const ReferenceKind = {
  /** A call: `applyTax(total)`, `self.save()`. */
  CALL: 'call',
  /** A construction: `new Invoice()`. */
  CONSTRUCTION: 'construction',
} as const;

export type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

/**
 * One use of a name, as the grammar found it — EPIC-035.
 *
 * `name` is the last identifier of the callee, so `a.save()` reports `save`.
 * That is name-based by construction and EPIC-035 §8.3 records what it costs;
 * resolving it needs a type checker Ferret does not have.
 *
 * `enclosing` is the outline title path the reference sits inside, which is how
 * an edge becomes answerable: "`refundInvoice` calls `applyTax`" is a fact, and
 * "line 42 calls `applyTax`" is not a graph. Empty means top-level, which
 * EPIC-035 §8.2 attributes to the file.
 */
export interface CodeReference {
  readonly kind: ReferenceKind;
  readonly name: string;
  /**
   * The callee was a member access — `a.save()` rather than `save()`.
   *
   * Load-bearing, and found by dogfooding rather than reasoning. A bare
   * identifier is resolved by the language's own scoping to something in scope;
   * a member name is scoped by the *receiver's type*, which Ferret does not
   * know. Resolving `map.has(x)` to the one declared `has` in the repository
   * gave `ProviderRegistry.has` 84 references on Ferret's own code, nearly all
   * of them `Map.has` — a call graph that reads as knowledge and is wrong.
   * EPIC-035 §8.3 uses this to refuse that inference.
   */
  readonly qualified: boolean;
  readonly enclosing: readonly string[];
  readonly span: ContentSpan;
}

/**
 * What an outline *is* — EPIC-029 §8.4.
 *
 * The defect this prevents: `runContentStage` builds code symbols from every
 * outline it is given, and `codeSymbolKindOf` maps an unrecognised kind to
 * `UNKNOWN` — so a Markdown outline became `code_symbol` entities, a heading
 * indexed as a declaration, and on Ferret's own repository that is 206 files of
 * prose filling EPIC-034's symbol index.
 *
 * **Absent means no code symbols.** A parser that has not said its outline is a
 * symbol table has not said it, and assuming otherwise is the inference
 * Governance §6 forbids. Every Ferret parser sets this explicitly.
 */
export const OutlineKind = {
  /** Declarations. `buildCodeSymbols` applies. */
  CODE: 'code',
  /** Sections of a document. It does not. */
  DOCUMENT: 'document',
} as const;

export type OutlineKind = (typeof OutlineKind)[keyof typeof OutlineKind];

export interface ParseOutput {
  readonly segments: readonly ContentSegment[];
  readonly outline?: readonly OutlineNode[];
  /** What the outline is — EPIC-029 §8.4. Absent means no code symbols. */
  readonly outlineKind?: OutlineKind;
  /**
   * Names this file uses — EPIC-035.
   *
   * Optional, so a parser that reports none is a parser that did not look
   * rather than a file with no references. Four Epics deferred this and
   * `findSymbols` could answer "where is this defined" while nothing could
   * answer "where is it used".
   */
  readonly references?: readonly CodeReference[];
  /**
   * Names this file brings into scope from elsewhere — EPIC-035 §8.3.
   *
   * An imported name is declared somewhere Ferret may not have indexed, so it
   * must not be resolved to a repository-unique homonym. Found by dogfooding:
   * without this, `describe(...)` in every test file resolved to
   * `ProviderRegistry.describe` (111 references) because that is the only
   * `describe` Ferret *declares*, and `resolve(...)` resolved to
   * `IdentityStore.resolve` rather than `node:path`.
   */
  readonly imports?: readonly string[];
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
  /**
   * What *else* determines this parser's output, as an opaque identity string.
   *
   * For the code parser this is the grammar: its name, its ABI version and the
   * hash of the `.wasm` actually loaded. TECHNOLOGY-DECISIONS §4 made grammar
   * pinning mandatory because two ecosystems' grammars disagreed by 1.2% of
   * named nodes over the same corpus, so a result is only attributable if the
   * grammar that produced it is recorded.
   *
   * **Optional, read-only, and it must not parse.** EPIC-108's re-parse gate has
   * to know this *before* deciding whether to read a file at all; an identity
   * only learned from a parse result is learned too late to decide anything. A
   * parser with nothing beyond its own version to declare omits this, and the
   * gate keys on `parserId` and `parserVersion` alone.
   *
   * A string rather than a structured type because the contract cannot name a
   * grammar: a future PDF or spreadsheet parser has no grammar and may have a
   * model version or a library build instead. What every one of them can say is
   * "this is what I am, beyond my version", which is all a gate needs to
   * compare.
   */
  producerIdentity?(target: ParseTarget): Promise<string | undefined>;
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
