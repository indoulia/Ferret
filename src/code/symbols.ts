import type {
  ContentSegment,
  ContentSpan,
  OutlineNode,
  ParseOutput,
} from '../providers/contracts/parser.js';

import { codeSymbolId, type CodeSymbolContext } from './identity.js';

/**
 * Ferret's model of what a file declares.
 *
 * EPIC-025 produces segments and an outline, both shaped by tree-sitter's node
 * types. That is the right output for a parser and the wrong input for
 * everything else: `method_definition` and `function_definition` are grammar
 * vocabulary, and TECHNOLOGY-DECISIONS §4 recorded that two ecosystems'
 * grammars disagree by about 1.2% of named nodes over the same corpus. A
 * canonical model that spoke grammar would inherit that disagreement.
 *
 * What this models is *declarations*, not every syntax node. An expression, a
 * statement and a literal are not symbols. The loss of fidelity is deliberate:
 * the alternative is a model larger than the source that nothing downstream
 * would use.
 */

export const CodeSymbolKind = {
  MODULE: 'module',
  NAMESPACE: 'namespace',
  CLASS: 'class',
  INTERFACE: 'interface',
  ENUM: 'enum',
  FUNCTION: 'function',
  METHOD: 'method',
  PROPERTY: 'property',
  CONSTRUCTOR: 'constructor',
  TYPE: 'type',
  CONSTANT: 'constant',
  VARIABLE: 'variable',
  /** A declaration Ferret recognises as one but cannot name. */
  UNKNOWN: 'unknown',
} as const;

export type CodeSymbolKind = (typeof CodeSymbolKind)[keyof typeof CodeSymbolKind];

export const CODE_SYMBOL_KINDS: readonly CodeSymbolKind[] = Object.freeze(
  Object.values(CodeSymbolKind),
);

/**
 * Parser outline kinds, mapped onto Ferret's vocabulary.
 *
 * A kind absent here becomes `unknown` rather than leaking a grammar's node
 * type into the canonical model. That is the whole point of the mapping: the
 * canonical set is closed and Ferret owns it, so a grammar upgrade that renames
 * a node cannot silently change what a consumer switches on.
 */
const KIND_MAP: Readonly<Record<string, CodeSymbolKind>> = Object.freeze({
  module: CodeSymbolKind.MODULE,
  namespace: CodeSymbolKind.NAMESPACE,
  class: CodeSymbolKind.CLASS,
  interface: CodeSymbolKind.INTERFACE,
  enum: CodeSymbolKind.ENUM,
  function: CodeSymbolKind.FUNCTION,
  method: CodeSymbolKind.METHOD,
  property: CodeSymbolKind.PROPERTY,
  constructor: CodeSymbolKind.CONSTRUCTOR,
  type: CodeSymbolKind.TYPE,
  constant: CodeSymbolKind.CONSTANT,
  variable: CodeSymbolKind.VARIABLE,
});

/** The canonical kind for a parser's outline kind. */
export function codeSymbolKindOf(outlineKind: string): CodeSymbolKind {
  return KIND_MAP[outlineKind] ?? CodeSymbolKind.UNKNOWN;
}

/** Modifiers Ferret recognises, in the order they are reported. */
export const CODE_MODIFIERS: readonly string[] = Object.freeze([
  'export',
  'default',
  'declare',
  'abstract',
  'static',
  'async',
  'public',
  'protected',
  'private',
  'readonly',
  'const',
  'override',
]);

/** Longest signature retained. A pathological declaration must not be unbounded. */
export const MAX_SIGNATURE_LENGTH = 400;

export interface CodeSymbol {
  /** Stable across runs over identical content. See {@link codeSymbolId}. */
  readonly id: string;
  readonly kind: CodeSymbolKind;
  /** The declared name, as written. */
  readonly name: string;
  /** The path of enclosing scopes, e.g. `Box.width`. */
  readonly qualifiedName: string;
  /** The enclosing symbol's id, when there is one. */
  readonly parentId: string | undefined;
  readonly span: ContentSpan;
  /** The declaration's first line, without its body. */
  readonly signature: string;
  readonly modifiers: readonly string[];
  /** The comment immediately above, when there is one. */
  readonly documentation: string | undefined;
  /** 0 for the first declaration of a qualified name, 1 for the next. */
  readonly overload: number;
  /** The parser's own word for this, kept so a mapping gap is diagnosable. */
  readonly declaredKind: string;
}

/** Comment segments indexed by the line they end on. */
function commentsByEndLine(segments: readonly ContentSegment[]): ReadonlyMap<number, string> {
  const byLine = new Map<number, string>();
  for (const segment of segments) {
    if (segment.kind !== 'comment') continue;
    // Later comments win: two comments ending on the same line cannot both be
    // the documentation, and the nearer one in document order is the one a
    // reader would take.
    byLine.set(segment.span.endLine, segment.text);
  }
  return byLine;
}

/**
 * The comment attached to a declaration, if any.
 *
 * Adjacency, not inference: the comment must end on the line above the
 * declaration, or one blank line above it. Anything further is a comment about
 * something else, and guessing costs more than it gives.
 */
function documentationFor(
  startLine: number,
  comments: ReadonlyMap<number, string>,
): string | undefined {
  return comments.get(startLine - 1) ?? comments.get(startLine - 2);
}

/**
 * The declaration's first line, without its body.
 *
 * A signature is what a person scanning results reads, so it stops at the
 * opening brace or the colon that begins a block, and is length-bounded.
 */
function signatureOf(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const trimmed = firstLine.trim();
  const brace = trimmed.indexOf('{');
  const cut = brace === -1 ? trimmed : trimmed.slice(0, brace).trimEnd();
  return cut.length > MAX_SIGNATURE_LENGTH ? `${cut.slice(0, MAX_SIGNATURE_LENGTH - 1)}…` : cut;
}

/**
 * Modifiers, from the tokens before the declaration keyword.
 *
 * Only the leading run is inspected: `export async function readonlyThing()`
 * has two modifiers, not three, and scanning the whole line would find the
 * third in the name.
 */
function modifiersOf(text: string): readonly string[] {
  const found: string[] = [];
  const leading = (text.split('\n', 1)[0] ?? '').trimStart();
  let cursor = 0;
  for (;;) {
    const rest = leading.slice(cursor);
    const match = /^([A-Za-z]+)\s+/.exec(rest);
    if (match === null) break;
    const token = match[1];
    if (token === undefined || !CODE_MODIFIERS.includes(token)) break;
    if (!found.includes(token)) found.push(token);
    cursor += match[0].length;
  }
  // Reported in the canonical order rather than the source's, so two
  // declarations written differently compare equal.
  return CODE_MODIFIERS.filter((modifier) => found.includes(modifier));
}

/** The segment whose span starts a declaration, so its text can be read. */
function segmentAt(
  segments: readonly ContentSegment[],
  span: ContentSpan,
): ContentSegment | undefined {
  return segments.find(
    (segment) => segment.span.startByte === span.startByte && segment.span.endByte === span.endByte,
  );
}

/**
 * Builds the canonical symbols a parse describes.
 *
 * Flat and in document order, each naming its parent. Flat because every
 * consumer — the symbol index, retrieval, a context pack — wants to filter and
 * rank a list; {@link codeSymbolTree} reassembles the nesting for the ones that
 * want structure.
 */
export function buildCodeSymbols(
  parse: Pick<ParseOutput, 'segments' | 'outline'>,
  context: CodeSymbolContext,
): readonly CodeSymbol[] {
  const outline = parse.outline ?? [];
  if (outline.length === 0) return [];

  const segments = parse.segments;
  const comments = commentsByEndLine(segments);
  const symbols: CodeSymbol[] = [];
  /** Qualified name to how many have been seen, for overload ordinals. */
  const seen = new Map<string, number>();

  const visit = (nodes: readonly OutlineNode[], prefix: string, parentId: string | undefined): void => {
    for (const node of nodes) {
      const qualifiedName = prefix === '' ? node.title : `${prefix}.${node.title}`;
      const overload = seen.get(qualifiedName) ?? 0;
      seen.set(qualifiedName, overload + 1);

      const segment = segmentAt(segments, node.span);
      const text = segment?.text ?? '';
      const documentation = documentationFor(node.span.startLine, comments);
      const id = codeSymbolId(context, qualifiedName, overload);

      symbols.push({
        id,
        kind: codeSymbolKindOf(node.kind),
        name: node.title,
        qualifiedName,
        parentId,
        span: node.span,
        signature: signatureOf(text),
        modifiers: modifiersOf(text),
        ...(documentation === undefined ? {} : { documentation }),
        overload,
        declaredKind: node.kind,
      } as CodeSymbol);

      visit(node.children, qualifiedName, id);
    }
  };

  visit(outline, '', undefined);
  return symbols;
}

export interface CodeSymbolNode extends CodeSymbol {
  readonly children: readonly CodeSymbolNode[];
}

/** The same symbols, nested by `parentId`. */
export function codeSymbolTree(symbols: readonly CodeSymbol[]): readonly CodeSymbolNode[] {
  const children = new Map<string, CodeSymbolNode[]>();
  const nodes = new Map<string, CodeSymbolNode>();
  const roots: CodeSymbolNode[] = [];

  for (const symbol of symbols) {
    const bucket: CodeSymbolNode[] = [];
    children.set(symbol.id, bucket);
    nodes.set(symbol.id, { ...symbol, children: bucket });
  }
  for (const symbol of symbols) {
    const node = nodes.get(symbol.id);
    if (node === undefined) continue;
    // A parent that is not in the list — a caller passed a filtered slice —
    // makes this a root rather than dropping it. Losing a symbol silently
    // because its parent was filtered out is worse than a shallower tree.
    const parent = symbol.parentId === undefined ? undefined : children.get(symbol.parentId);
    if (parent === undefined) roots.push(node);
    else parent.push(node);
  }
  return roots;
}
