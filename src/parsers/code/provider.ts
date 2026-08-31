import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

import { ErrorCode, FerretError, toFerretError } from '../../errors/index.js';
import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  ParserSupport,
  SegmentKind,
  type ContentParser,
  type ContentSegment,
  type ContentSpan,
  type OutlineNode,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
  type ParseWarning,
} from '../../providers/contracts/parser.js';
import { ProviderKind, type Provider } from '../../providers/contract.js';
import { BaseProvider } from '../../providers/sdk/base.js';
import type { ProviderOperationContext } from '../../providers/sdk/operation.js';

import { loadGrammarBytes, grammarSearchPaths, type GrammarIdentity } from './grammars.js';
import { CODE_LANGUAGES, languageFor, type LanguageSpec } from './languages.js';
import { ByteOffsets } from './spans.js';

/**
 * Source files, through tree-sitter.
 *
 * TECHNOLOGY-DECISIONS §4 selected `web-tree-sitter` over a hand-written parser
 * per language and over the native binding: WASM needs no build toolchain, and
 * the measured 1.9× throughput cost is paid once per file. The decision also
 * made grammar pinning mandatory, which is why every result carries the hash of
 * the grammar binary that produced it.
 *
 * What makes tree-sitter the right choice here is not speed. It recovers from
 * syntax errors, and half the files worth indexing are mid-edit. A parser that
 * returns nothing for a file with one unbalanced brace is a parser that fails
 * exactly when someone needs help.
 */

export const CODE_PARSER_ID = 'ferret.parser.code';
export const CODE_PARSER_VERSION = '1.0.0';

/** Segments per file. A pathological file must not produce an unbounded result. */
export const MAX_SEGMENTS = 5000;

/** Nesting depth walked. Deeper declarations are reached; the outline stops. */
const MAX_OUTLINE_DEPTH = 12;

export interface CodeParserOptions {
  /** Where grammars are looked for. Defaults to the packaged directory. */
  readonly grammarPaths?: readonly string[];
  readonly maxSegments?: number;
}

interface LoadedLanguage {
  readonly language: Language;
  readonly identity: GrammarIdentity;
}

export class CodeParserProvider extends BaseProvider implements Provider, ContentParser {
  readonly id = CODE_PARSER_ID;
  readonly kind = ProviderKind.PARSER;
  readonly description = 'Source code structure, via tree-sitter';
  readonly capabilities = [
    { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
  ];

  readonly parserId = CODE_PARSER_ID;
  /**
   * Ferret's parser version and the runtime it is built on, together.
   *
   * Both change what a result looks like, and EPIC-031 re-parses when this
   * string moves. The *grammar* is per-language and travels in the attributes,
   * because one parser version spans four of them.
   */
  readonly parserVersion = `${CODE_PARSER_VERSION}+wts0.25.10`;

  readonly #options: CodeParserOptions;
  readonly #grammarPaths: readonly string[];
  readonly #loaded = new Map<string, LoadedLanguage>();
  /**
   * Languages whose grammar could not be loaded, and why.
   *
   * Remembered so a missing grammar costs one attempt rather than one per file,
   * and so the failure can be reported as a warning on every affected parse
   * instead of vanishing after the first.
   */
  readonly #failed = new Map<string, string>();
  #initialized: Promise<void> | undefined;

  constructor(options: CodeParserOptions = {}) {
    super();
    this.#options = options;
    this.#grammarPaths = options.grammarPaths ?? grammarSearchPaths();
  }

  /**
   * Whether this parser handles a file.
   *
   * Native for the media types its grammars cover, and nothing else. Declining
   * is the honest answer: EPIC-024 then reports `no-parser`, which is a fact,
   * rather than this parser guessing at a language it has no grammar for.
   */
  supports(target: ParseTarget): ParserSupport {
    if (target.binary) return ParserSupport.NONE;
    return languageFor(target.path, target.mediaType) === undefined
      ? ParserSupport.NONE
      : ParserSupport.NATIVE;
  }

  async parse(request: ParseRequest, context: ProviderOperationContext): Promise<ParseOutput> {
    const spec = languageFor(request.target.path, request.target.mediaType);
    if (spec === undefined) {
      throw new FerretError(
        ErrorCode.NOT_IMPLEMENTED,
        `No grammar for ${request.target.mediaType}`,
        { details: { path: request.target.path, mediaType: request.target.mediaType } },
      );
    }
    const text = request.text;
    if (text === undefined) {
      throw new FerretError(ErrorCode.USAGE, 'The code parser needs decoded text', {
        details: { path: request.target.path },
      });
    }

    const loaded = await this.#language(spec);
    context.signal.throwIfAborted();

    const parser = new Parser();
    let tree: Tree | undefined;
    try {
      parser.setLanguage(loaded.language);
      const parsed = parser.parse(text);
      if (parsed === null) {
        throw new FerretError(ErrorCode.UNKNOWN, 'tree-sitter returned no tree', {
          details: { path: request.target.path, language: spec.language },
        });
      }
      tree = parsed;
      return this.#extract(tree, spec, loaded.identity, text);
    } finally {
      // tree-sitter allocates in WASM memory, which the JavaScript collector
      // knows nothing about. Freeing on the same path that allocated — failure
      // included — is the only thing standing between an index run and a heap
      // that grows by one tree per file.
      tree?.delete();
      parser.delete();
    }
  }

  #extract(
    tree: Tree,
    spec: LanguageSpec,
    identity: GrammarIdentity,
    text: string,
  ): ParseOutput {
    const offsets = new ByteOffsets(text);
    const maxSegments = this.#options.maxSegments ?? MAX_SEGMENTS;
    const segments: ContentSegment[] = [];
    const warnings: ParseWarning[] = [];
    let truncated = false;

    const spanOf = (node: Node): ContentSpan => ({
      startByte: offsets.byteAt(node.startPosition, node.startIndex),
      endByte: offsets.byteAt(node.endPosition, node.endIndex),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });

    const push = (segment: ContentSegment): boolean => {
      if (segments.length >= maxSegments) {
        truncated = true;
        return false;
      }
      segments.push(segment);
      return true;
    };

    const imports: Node[] = [];

    /**
     * Walks the tree, emitting a segment per declaration and an outline node
     * per declaration nested the way the code is.
     *
     * `wrapper` is the enclosing `export_statement` or decorator, when there is
     * one: the declaration is what has a name, but the wrapper is what a reader
     * recognises and what a retrieval hit should quote, so the segment spans
     * the wrapper and is labelled from the declaration inside it.
     */
    const visit = (node: Node, depth: number, wrapper?: Node): readonly OutlineNode[] => {
      const children: OutlineNode[] = [];
      for (let index = 0; index < node.namedChildCount; index += 1) {
        const child = node.namedChild(index);
        if (child === null) continue;

        if (spec.comments.includes(child.type)) {
          push({ kind: SegmentKind.COMMENT, text: child.text, span: spanOf(child) });
          continue;
        }
        if (spec.imports.includes(child.type) && isImport(child)) {
          imports.push(child);
          continue;
        }

        const declaration = spec.declarations[child.type];
        if (declaration === undefined) {
          // Not a declaration itself, but a declaration may be inside it — an
          // exported class, a decorated function, a namespace body. Walking
          // through is what makes the outline a tree rather than a flat list of
          // whatever happens to sit at the top level.
          children.push(...visit(child, depth, spec.wrappers.includes(child.type) ? child : undefined));
          continue;
        }

        const label = nameOf(child);
        // The wrapper only applies to the declaration directly inside it, so it
        // is not passed down: a method in an exported class is its own segment,
        // not another copy of the class.
        const quoted = wrapper ?? child;
        const span = spanOf(quoted);
        push({
          kind: SegmentKind.CODE,
          text: quoted.text,
          span,
          ...(label === undefined ? {} : { label }),
        });
        const nested = depth < MAX_OUTLINE_DEPTH ? visit(child, depth + 1) : [];
        children.push({
          title: label ?? child.type,
          kind: declaration,
          span,
          children: nested,
        });
      }
      return children;
    };

    const outline = visit(tree.rootNode, 0);

    if (imports.length > 0) {
      // One segment for the whole import block rather than one per statement:
      // what a reader or a retrieval hit wants is "what does this file depend
      // on", and twenty one-line segments answer it worse than one.
      const first = imports[0];
      const last = imports[imports.length - 1];
      if (first !== undefined && last !== undefined) {
        push({
          kind: SegmentKind.METADATA,
          label: 'imports',
          text: imports.map((node) => node.text).join('\n'),
          span: {
            startByte: offsets.byteAt(first.startPosition, first.startIndex),
            endByte: offsets.byteAt(last.endPosition, last.endIndex),
            startLine: first.startPosition.row + 1,
            endLine: last.endPosition.row + 1,
          },
        });
      }
    }

    if (segments.length === 0) {
      // A script with no declarations is still content. Returning nothing would
      // make it indistinguishable from a file the parser could not read.
      push({
        kind: SegmentKind.CODE,
        text,
        span: { startByte: 0, endByte: offsets.totalBytes, startLine: 1, endLine: countLines(text) },
      });
    }

    if (tree.rootNode.hasError) {
      warnings.push({
        code: 'syntax-error',
        detail: 'The file did not parse cleanly; the segments are what tree-sitter recovered.',
      });
    }
    if (truncated) {
      warnings.push({
        code: 'segment-limit',
        detail: `Stopped at ${String(maxSegments)} segments.`,
      });
    }
    const failure = this.#failed.get(spec.grammar);
    if (failure !== undefined) warnings.push({ code: 'grammar-unavailable', detail: failure });

    return {
      segments,
      outline,
      attributes: {
        language: spec.language,
        grammar: identity.grammar,
        grammarAbiVersion: identity.abiVersion,
        grammarBinaryHash: identity.binaryHash,
        declarationCount: outline.length,
        hasSyntaxErrors: tree.rootNode.hasError,
      },
      warnings,
      truncated,
    };
  }

  /**
   * The grammar for a language, loaded once per process.
   *
   * A failure is recorded against that grammar alone: an unloadable Python
   * grammar must cost Python and nothing else (Governance §13).
   */
  async #language(spec: LanguageSpec): Promise<LoadedLanguage> {
    const cached = this.#loaded.get(spec.grammar);
    if (cached !== undefined) return cached;

    // `Parser.init` boots the tree-sitter runtime. Concurrent parses would
    // otherwise each start it; sharing the promise makes it exactly once.
    this.#initialized ??= Parser.init();
    await this.#initialized;

    let loaded: LoadedLanguage;
    try {
      const { bytes, binaryHash } = await loadGrammarBytes(spec.grammar, this.#grammarPaths);
      const language = await Language.load(bytes);
      loaded = {
        language,
        identity: { grammar: spec.grammar, abiVersion: language.abiVersion, binaryHash },
      };
    } catch (error) {
      const detail = toFerretError(error).message;
      this.#failed.set(spec.grammar, detail);
      throw new FerretError(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        `Grammar "${spec.grammar}" could not be loaded: ${detail}`,
        {
          details: { grammar: spec.grammar, language: spec.language },
          remediation: 'Run `npm run build` to copy grammars beside the parser, or reinstall.',
          cause: error,
        },
      );
    }
    this.#loaded.set(spec.grammar, loaded);
    return loaded;
  }

  protected override onShutdown(): void {
    // A `Language` has no `delete` in web-tree-sitter 0.25: a loaded grammar is
    // a process-lifetime resource, not a per-parser one. Dropping the cache is
    // all this provider owns; the trees and parsers it created were freed on
    // the paths that created them.
    this.#loaded.clear();
    this.#failed.clear();
  }
}

/** A `Provider` and a `ContentParser`, ready to register. */
export function createCodeParserProvider(options: CodeParserOptions = {}): CodeParserProvider {
  return new CodeParserProvider(options);
}

/** The languages this provider handles, for diagnostics. */
export const CODE_PARSER_LANGUAGES: readonly string[] = Object.freeze(
  CODE_LANGUAGES.map((spec) => spec.language),
);

/**
 * A declaration's name.
 *
 * `name` is the field tree-sitter uses for it in every grammar here. Python's
 * decorated definitions wrap the real declaration, so the name is one level in.
 */
function nameOf(node: Node): string | undefined {
  const direct = node.childForFieldName('name');
  if (direct !== null) return direct.text;
  for (let index = 0; index < node.namedChildCount; index += 1) {
    const child = node.namedChild(index);
    const nested = child?.childForFieldName('name');
    if (nested !== null && nested !== undefined) return nested.text;
  }
  return undefined;
}

/**
 * Whether an `export_statement` is actually an import.
 *
 * `export ... from './x'` brings something into scope and re-exports it; plain
 * `export class Foo {}` is a declaration and must keep being walked into, or
 * every exported class in a TypeScript file disappears from the outline.
 */
function isImport(node: Node): boolean {
  if (node.type !== 'export_statement') return true;
  return node.childForFieldName('source') !== null;
}

function countLines(text: string): number {
  let lines = 1;
  for (const character of text) if (character === '\n') lines += 1;
  return lines;
}
