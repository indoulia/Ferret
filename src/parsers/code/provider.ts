import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

import { ErrorCode, FerretError, toFerretError } from '../../errors/index.js';
import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  OutlineKind,
  ParserSupport,
  SegmentKind,
  type ContentParser,
  type CodeReference,
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
import { CODE_LANGUAGES, DeclarationKind, languageFor, type LanguageSpec } from './languages.js';
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

  /**
   * The grammar that would parse this file, identified without parsing it.
   *
   * EPIC-108 AC-17. The gate needs grammar identity *before* it decides whether
   * to read a file, and `grammarBinaryHash` travels in a parse result — which
   * is after the read and the parse it was supposed to avoid.
   *
   * Goes through `#language`, the same accessor `parse` uses, rather than
   * reading and hashing the binary a second time. That is the whole of "the
   * parser is entered through exactly one path": grammars are cached per
   * language per process, so this costs one load per language per run and the
   * load is not wasted — the files that provoked it are about to be parsed with
   * it.
   */
  async producerIdentity(target: ParseTarget): Promise<string | undefined> {
    const spec = languageFor(target.path, target.mediaType);
    if (spec === undefined) return undefined;
    const loaded = await this.#language(spec);
    const { grammar, abiVersion, binaryHash } = loaded.identity;
    return `${grammar}@${String(abiVersion)}/${binaryHash}`;
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
    // EPIC-035. Collected during the walk that already happens; no second parse.
    const references: CodeReference[] = [];
    const importedNames = new Set<string>();

    /**
     * Walks the tree, emitting a segment per declaration and an outline node
     * per declaration nested the way the code is.
     *
     * `wrapper` is the enclosing `export_statement` or decorator, when there is
     * one: the declaration is what has a name, but the wrapper is what a reader
     * recognises and what a retrieval hit should quote, so the segment spans
     * the wrapper and is labelled from the declaration inside it.
     */
    const visit = (
      node: Node,
      depth: number,
      wrapper?: Node,
      enclosing: readonly string[] = [],
    ): readonly OutlineNode[] => {
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
          for (const name of identifiersIn(child)) importedNames.add(name);
          continue;
        }

        // EPIC-035 §8.1. A use of a name, attributed to the declaration it sits
        // inside — `enclosing` is the same outline title path `buildCodeSymbols`
        // joins into a qualified name, so the two match by construction rather
        // than by a second convention.
        const reference = spec.references[child.type];
        if (reference !== undefined) {
          const callee = calleeOf(child);
          if (callee !== undefined) {
            references.push({
              kind: reference,
              name: callee.name,
              qualified: callee.qualified,
              ...(callee.receiver === undefined ? {} : { receiver: callee.receiver }),
              enclosing,
              span: spanOf(child),
            });
          }
          // Fall through: a call may contain another call, and the arguments of
          // `save(build(x))` are references too.
        }

        // Issue #106 — a node whose *value* is a function. `const x = () => {}`
        // and `const x = 1` are both `variable_declarator`, so the node type
        // alone cannot tell them apart and the value's type decides. Without
        // this, arrow functions produced no symbol at all — which is the
        // dominant way functions are written in modern TypeScript and
        // JavaScript.
        const declaration = spec.declarations[child.type] ?? functionValuedKind(spec, child);
        if (declaration === undefined) {
          // Not a declaration itself, but a declaration may be inside it — an
          // exported class, a decorated function, a namespace body. Walking
          // through is what makes the outline a tree rather than a flat list of
          // whatever happens to sit at the top level.
          //
          // `wrapper ?? child` keeps the *outermost* wrapper, so
          // `export const x = () => {}` quotes the `export` too. For a single
          // wrapper this is what it always did: `wrapper` is undefined there,
          // and `undefined ?? child` is `child`.
          children.push(
            ...visit(child, depth, spec.wrappers.includes(child.type) ? (wrapper ?? child) : undefined, enclosing),
          );
          continue;
        }

        // The wrapper only applies to the declaration directly inside it, so it
        // is not passed down: a method in an exported class is its own segment,
        // not another copy of the class.
        const label = nameOf(child);
        const quoted = wrapper ?? child;
        const span = spanOf(quoted);
        push({
          kind: SegmentKind.CODE,
          text: quoted.text,
          span,
          ...(label === undefined ? {} : { label }),
        });
        const nested =
          depth < MAX_OUTLINE_DEPTH
            ? visit(child, depth + 1, undefined, [...enclosing, label ?? child.type])
            : [];
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
      // EPIC-029 §8.4. Said explicitly: this outline *is* a symbol table, and
      // a parser that does not say so does not get symbols built from it.
      outlineKind: OutlineKind.CODE,
      references,
      imports: [...importedNames].sort(),
      attributes: {
        language: spec.language,
        grammar: identity.grammar,
        grammarAbiVersion: identity.abiVersion,
        grammarBinaryHash: identity.binaryHash,
        declarationCount: outline.length,
        referenceCount: references.length,
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
/**
 * Every identifier inside an import statement — EPIC-035 §8.3.
 *
 * The whole subtree rather than a per-grammar field walk: an import's shape
 * differs across three grammars (`import_clause`, `named_imports`,
 * `dotted_name`, aliases) and the question here is only *which names does this
 * statement bring into scope*. A module path is a string literal and not an
 * identifier, so it is not collected; an alias collects both sides, which is
 * correct — both are names that came from elsewhere.
 */
function identifiersIn(node: Node): readonly string[] {
  const found: string[] = [];
  const walk = (current: Node): void => {
    if (current.type === 'identifier' || current.type === 'property_identifier') {
      found.push(current.text);
      return;
    }
    for (let index = 0; index < current.namedChildCount; index += 1) {
      const child = current.namedChild(index);
      if (child !== null) walk(child);
    }
  };
  walk(node);
  return found;
}

/**
 * The name a reference names — EPIC-035 §8.1.
 *
 * The **last identifier** of the callee, so `a.b.save()` reports `save` and
 * `applyTax()` reports `applyTax`. Name-based by construction: resolving
 * `a.save` to the right `save` needs the type of `a`, which no grammar carries
 * and Ferret has no type checker for. §8.3 records what that costs and why the
 * resolution band is `PROBABLE` rather than `STRONG`.
 *
 * A callee that is not ultimately an identifier — an immediately-invoked
 * function, a call on a call's result — yields nothing rather than a guess.
 */
function calleeOf(
  node: Node,
): { readonly name: string; readonly qualified: boolean; readonly receiver?: string } | undefined {
  const callee = node.childForFieldName('function') ?? node.childForFieldName('constructor');
  if (callee === null || callee === undefined) return undefined;
  if (callee.type === 'identifier' || callee.type === 'property_identifier') {
    return { name: callee.text, qualified: false };
  }

  const property = callee.childForFieldName('property') ?? callee.childForFieldName('attribute');
  if (property !== null && property !== undefined) {
    // F-25. The receiver as written, so the resolver can tell `this.has()` —
    // whose type *is* the enclosing declaration — from `map.has()`, whose type
    // Ferret does not know. Bounded: the one thing this field is read for is an
    // equality test against `this`, and a receiver spanning half a line
    // corroborates nothing.
    const object = callee.childForFieldName('object') ?? callee.childForFieldName('value');
    const receiver =
      object === null || object === undefined || object.text.length > MAX_RECEIVER_TEXT
        ? undefined
        : object.text;
    return { name: property.text, qualified: true, ...(receiver === undefined ? {} : { receiver }) };
  }
  return undefined;
}

/** Longest receiver text kept. Anything longer is not a name and not evidence. */
const MAX_RECEIVER_TEXT = 128;

/**
 * The kind a node declares by virtue of its value, or `undefined`.
 *
 * Issue #106. Separate from {@link LanguageSpec.declarations} because that map
 * is keyed on node type alone, and here the node type is shared by a function
 * binding and every other binding in the language.
 */
function functionValuedKind(spec: LanguageSpec, node: Node): DeclarationKind | undefined {
  const values = spec.functionValued[node.type];
  if (values === undefined) return undefined;
  const value = node.childForFieldName('value');
  if (value === null || !values.includes(value.type)) return undefined;
  return DeclarationKind.FUNCTION;
}

function nameOf(node: Node): string | undefined {
  // `name` for a declaration, `key` for an object-literal `pair` — issue #106
  // added the second, because `{ onClick: () => {} }` names the function in a
  // field the grammar calls `key` and there is no `name` anywhere in the node.
  for (const field of ['name', 'key']) {
    const direct = node.childForFieldName(field);
    if (direct !== null) return direct.text;
  }
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
