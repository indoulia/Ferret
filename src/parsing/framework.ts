import { redactSecrets } from '../security/index.js';
import { Capability } from '../providers/capabilities.js';
import {
  ParserSupport,
  isContentParser,
  isSegmentKind,
  isSpanUnit,
  type ContentParser,
  type ContentSegment,
  type CodeReference,
  type OutlineKind,
  type OutlineNode,
  type ParseOutput,
  type SpanUnit,
  type ParseTarget,
  type ParseWarning,
} from '../providers/contracts/parser.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

import { detectContent, type ContentDetection } from './detect.js';

/** `Array.isArray` widens a typed value to `any[]`; this keeps the element unknown. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Choosing a parser, bounding it, and surviving it.
 *
 * A parser is the most dangerous thing Ferret runs: it is handed
 * attacker-controlled bytes out of a repository. Everything here exists because
 * of that. The size bound is enforced *before* a parser sees the content, so an
 * allocation attack cannot start. A parser that throws costs one file. Extracted
 * text is redacted at this boundary rather than in each parser, so a parser
 * added in two years cannot forget.
 *
 * What it does not do is contain a parser. There is no separate process and no
 * sandbox; a parser runs in-process with full privileges, and is trusted,
 * registered code. The framework bounds it, which is a different claim.
 */

/**
 * The largest content handed to a parser.
 *
 * 4 MiB: two orders of magnitude above any source file, and small enough that a
 * repository full of them cannot exhaust a heap. A file over it is reported
 * `too-large`, which is a fact worth having rather than a silent skip.
 */
export const DEFAULT_MAX_PARSE_BYTES = 4 * 1024 * 1024;

/** Why a file produced no extraction. Stable, so it can be aggregated. */
export const UnparsedReason = {
  /** No registered parser claims this media type. */
  NO_PARSER: 'no-parser',
  /** Over the size bound. The parser was never called. */
  TOO_LARGE: 'too-large',
  /** Binary content, and no parser claims binary of this type. */
  BINARY: 'binary',
  EMPTY: 'empty',
  /** The parser threw or rejected. */
  PARSER_FAILED: 'parser-failed',
  /** The parser returned something that is not a valid extraction. */
  INVALID_RESULT: 'invalid-result',
  CANCELLED: 'cancelled',
} as const;

export type UnparsedReason = (typeof UnparsedReason)[keyof typeof UnparsedReason];

export const UNPARSED_REASONS: readonly UnparsedReason[] = Object.freeze(
  Object.values(UnparsedReason),
);

export interface ParsedContent {
  readonly parsed: true;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly mediaType: string;
  readonly segments: readonly ContentSegment[];
  readonly outline: readonly OutlineNode[];
  /** What the outline is — EPIC-029 §8.4. Absent means no code symbols. */
  readonly outlineKind: OutlineKind | undefined;
  /** What every span here counts — EPIC-026 §8.1. Absent means lines. */
  readonly spanUnit: SpanUnit | undefined;
  /**
   * Names the file uses — EPIC-035.
   *
   * Carried through rather than re-derived: the parse already walked the tree,
   * and a second walk here would be a second place for language support to
   * drift. Empty for a parser that reports none.
   */
  readonly references: readonly CodeReference[];
  /** Names the file brings into scope from elsewhere — EPIC-035 §8.3. */
  readonly imports: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly warnings: readonly ParseWarning[];
  /** The parser stopped early. */
  readonly truncated: boolean;
  /** How many credentials were removed from the extracted text. */
  readonly redactedSecrets: number;
}

export interface UnparsedContent {
  readonly parsed: false;
  readonly reason: UnparsedReason;
  readonly detail: string;
  readonly mediaType: string;
  /** The parser that failed, when one was chosen. */
  readonly parserId: string | undefined;
}

export type ParseOutcome = ParsedContent | UnparsedContent;

export interface ParseInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** EPIC-023's content hash, passed through to the parser. */
  readonly contentHash?: string;
}

export interface ParserFrameworkOptions {
  /** Parsers, in precedence order. */
  readonly parsers?: readonly ContentParser[];
  /** Or take them from the registry's `parser` capability, in the same order. */
  readonly registry?: ProviderRegistry;
  readonly maxBytes?: number;
  /** Off only for a test that needs to see raw extraction. Never in a runtime. */
  readonly redact?: boolean;
}

/** The parser-capability providers a registry holds, in registration order. */
export function parsersFrom(registry: ProviderRegistry): readonly ContentParser[] {
  return registry
    .allForCapability(Capability.PARSER)
    .filter((provider): provider is typeof provider & ContentParser => isContentParser(provider));
}

export class ParserFramework {
  readonly #parsers: readonly ContentParser[];
  readonly #maxBytes: number;
  readonly #redact: boolean;

  constructor(options: ParserFrameworkOptions = {}) {
    this.#parsers =
      options.parsers ?? (options.registry === undefined ? [] : parsersFrom(options.registry));
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_PARSE_BYTES;
    this.#redact = options.redact ?? true;
  }

  /** The parser that would be chosen, without parsing. */
  select(target: ParseTarget): ContentParser | undefined {
    let fallback: ContentParser | undefined;
    for (const parser of this.#parsers) {
      let verdict: ParserSupport;
      try {
        verdict = parser.supports(target);
      } catch {
        // A parser that cannot answer "is this mine" is not asked to parse.
        continue;
      }
      if (verdict === ParserSupport.NATIVE) return parser;
      // First fallback wins, for the same reason the first native claim does:
      // order is composition, and composition is visible at the call site.
      if (verdict === ParserSupport.FALLBACK) fallback ??= parser;
    }
    return fallback;
  }

  /**
   * What would produce a result for this target, without producing one.
   *
   * The identity EPIC-108's re-parse gate keys on: the parser that would be
   * chosen, its version, and whatever else determines its output — for the code
   * parser, the grammar binary. All three change the result, so all three must
   * invalidate a cached one.
   *
   * **It never parses.** The gate has to decide whether to *read* a file, and an
   * identity learned from a parse result is learned after the cost it exists to
   * avoid. `select` is the same selection `parse` performs, so this is the
   * same parser the run would use — and `producerIdentity` is the parser's own
   * read-only accessor, not a second way in.
   *
   * `undefined` when nothing claims the target. That is itself a stable answer
   * — "no parser handles this" — and it changes the moment a parser is added,
   * so a file is reconsidered rather than skipped for ever.
   */
  async producerVersion(target: ParseTarget): Promise<string | undefined> {
    const parser = this.select(target);
    if (parser === undefined) return undefined;

    let identity: string | undefined;
    try {
      identity = await parser.producerIdentity?.(target);
    } catch {
      // A parser that cannot say what it is does not get to stop the run. The
      // version alone still invalidates on a parser upgrade; what is lost is
      // invalidation on a grammar change, and the parse that follows will
      // report the same failure with its own reason attached.
      identity = undefined;
    }
    return identity === undefined
      ? `${parser.parserId}@${parser.parserVersion}`
      : `${parser.parserId}@${parser.parserVersion}+${identity}`;
  }

  async parse(input: ParseInput, context: ProviderOperationContext): Promise<ParseOutcome> {
    const detection = detectContent(input.path, input.bytes);
    const unparsed = (
      reason: UnparsedReason,
      detail: string,
      parserId?: string,
    ): UnparsedContent => ({
      parsed: false,
      reason,
      detail,
      mediaType: detection.mediaType,
      parserId,
    });

    if (context.signal.aborted) {
      return unparsed(UnparsedReason.CANCELLED, 'Cancelled before parsing began');
    }
    if (detection.sizeBytes === 0) {
      return unparsed(UnparsedReason.EMPTY, 'The file has no content');
    }
    // Before selection *and* before decoding anything further: the point of the
    // bound is that nothing large is processed at all.
    if (detection.sizeBytes > this.#maxBytes) {
      return unparsed(
        UnparsedReason.TOO_LARGE,
        `${String(detection.sizeBytes)} bytes exceeds the ${String(this.#maxBytes)}-byte parse limit`,
      );
    }

    const target: ParseTarget = {
      path: input.path,
      mediaType: detection.mediaType,
      binary: detection.binary,
      sizeBytes: detection.sizeBytes,
      ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
    };

    const parser = this.select(target);
    if (parser === undefined) {
      // Binary is the more useful of the two answers when both are true: "no
      // parser handles PNG" and "this is a PNG" send a reader to different
      // places.
      return detection.binary
        ? unparsed(UnparsedReason.BINARY, `No parser claims binary content of type ${detection.mediaType}`)
        : unparsed(UnparsedReason.NO_PARSER, `No parser claims ${detection.mediaType}`);
    }

    let output: ParseOutput;
    try {
      output = await parser.parse(
        { target, text: detection.text, bytes: input.bytes },
        context,
      );
    } catch (error) {
      return unparsed(
        UnparsedReason.PARSER_FAILED,
        error instanceof Error ? error.message : String(error),
        parser.parserId,
      );
    }

    const invalid = validate(output, detection.sizeBytes);
    if (invalid !== undefined) {
      return unparsed(UnparsedReason.INVALID_RESULT, invalid, parser.parserId);
    }

    let redactedSecrets = 0;
    const segments = output.segments.map((segment) => {
      const placed = place(segment, detection);
      if (!this.#redact) return placed;
      const result = redactSecrets(placed.text);
      redactedSecrets += result.redacted;
      return result.redacted === 0 ? placed : { ...placed, text: result.text };
    });

    const warnings = [...(output.warnings ?? [])];
    // Stated rather than left to be noticed. A span covering the whole file is a
    // truthful "somewhere in here", and a reader deserves to know why it is not
    // narrower.
    if (!detection.byteAddressable && detection.text !== undefined && output.segments.length > 0) {
      warnings.push({
        code: 'span-not-byte-addressable',
        detail: `Content is ${detection.encoding}, so a byte span cannot be derived; spans cover the whole file.`,
      });
    }

    return {
      parsed: true,
      parserId: parser.parserId,
      parserVersion: parser.parserVersion,
      mediaType: detection.mediaType,
      segments,
      outline: output.outline ?? [],
      outlineKind: output.outlineKind,
      spanUnit: output.spanUnit,
      references: output.references ?? [],
      imports: output.imports ?? [],
      attributes: output.attributes ?? {},
      warnings,
      truncated: output.truncated ?? false,
      redactedSecrets,
    };
  }
}

/**
 * Puts a segment's span where it belongs in the *file*.
 *
 * A parser measures its offsets against the text it was handed, and that text
 * is not always the file: a byte-order mark is stripped when decoding, so every
 * offset was short by the mark's length — three bytes for UTF-8, pointing one
 * character into the token before the one the span meant to quote. `validate`
 * cannot catch it, because a span that is wrong but inside the file is still
 * inside the file.
 *
 * When the offsets cannot be converted at all — UTF-16, where the decoded string
 * is two bytes per code unit and the parser measured with a UTF-8 encoder — the
 * span is widened to the whole file rather than left pointing at unrelated
 * bytes. That is EPIC-024 §8's contract kept honestly: a span must name the
 * bytes it quotes, and a parser that cannot say which bytes those are must not
 * pretend to. Line numbers are untouched; they come from the decoded text and
 * are correct either way.
 */
function place(segment: ContentSegment, detection: ContentDetection): ContentSegment {
  if (!detection.byteAddressable) {
    if (segment.span.startByte === 0 && segment.span.endByte === detection.sizeBytes) return segment;
    return {
      ...segment,
      span: { ...segment.span, startByte: 0, endByte: detection.sizeBytes },
    };
  }
  if (detection.textByteOffset === 0) return segment;
  const shift = detection.textByteOffset;
  return {
    ...segment,
    span: {
      ...segment.span,
      startByte: Math.min(segment.span.startByte + shift, detection.sizeBytes),
      endByte: Math.min(segment.span.endByte + shift, detection.sizeBytes),
    },
  };
}

/**
 * Rejects an extraction that cannot be true of this content.
 *
 * A span past the end of the file is the dangerous one: it survives as far as
 * evidence, where it becomes a quote of bytes that do not exist. Checking it
 * here costs one comparison per segment and makes every downstream consumer
 * able to trust a span without re-deriving it.
 */
function validate(output: ParseOutput, sizeBytes: number): string | undefined {
  if (typeof output !== 'object' || output === null) return 'The parser returned no result';
  // `Array.isArray` widens the field to `any[]`, which would make every check
  // below unchecked. A guard that keeps the element `unknown` forces each one
  // to narrow, which is the point: this function exists precisely because the
  // parser's output is not trustworthy.
  const segments: unknown = output.segments;
  if (!isUnknownArray(segments)) return 'The parser returned no segments array';

  // EPIC-026 §8.1. An unrecognised unit is worse than an absent one: a consumer
  // would read the default meaning off a field that was trying to say otherwise.
  const spanUnit: unknown = output.spanUnit;
  if (spanUnit !== undefined && !isSpanUnit(spanUnit)) {
    return `The parser declared unknown span unit ${JSON.stringify(spanUnit)}`;
  }

  for (const [index, entry] of segments.entries()) {
    const where = `segment ${String(index)}`;
    if (!isRecord(entry)) return `${where} is not an object`;
    if (typeof entry['text'] !== 'string') return `${where} has no text`;
    if (!isSegmentKind(entry['kind'])) return `${where} declares unknown kind "${String(entry['kind'])}"`;

    const span = entry['span'];
    if (!isRecord(span)) return `${where} has no span`;
    const startByte = span['startByte'];
    const endByte = span['endByte'];
    const startLine = span['startLine'];
    const endLine = span['endLine'];

    if (!Number.isInteger(startByte) || (startByte as number) < 0) {
      return `${where} has a negative start byte`;
    }
    if (!Number.isInteger(endByte) || (endByte as number) < (startByte as number)) {
      return `${where} has a span that runs backwards`;
    }
    if ((endByte as number) > sizeBytes) {
      return `${where} ends at byte ${String(endByte)}, past the ${String(sizeBytes)}-byte content`;
    }
    if (!Number.isInteger(startLine) || (startLine as number) < 1) {
      return `${where} has a line number below one`;
    }
    if (!Number.isInteger(endLine) || (endLine as number) < (startLine as number)) {
      return `${where} has line numbers that run backwards`;
    }
  }
  return undefined;
}
