import { describe, expect, it } from 'vitest';

import {
  CODE_SYMBOL_KIND,
  CodeSymbolKind,
  MAX_SIGNATURE_LENGTH,
  ParserFramework,
  SegmentKind,
  buildCodeSymbols,
  codeSymbolAttributes,
  codeSymbolAttributesFrom,
  codeSymbolId,
  codeSymbolKindOf,
  codeSymbolTree,
  createEntity,
  entityKindDefinition,
  registerCodeSymbolKind,
  type CodeSymbol,
  type CodeSymbolContext,
  type ContentSegment,
  type ContentSpan,
  type OutlineNode,
} from '../../src/index.js';
import { createCodeParserProvider } from '../../src/parsers/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';

const CONTEXT: CodeSymbolContext = { path: 'src/shapes.ts', scope: 'repo-1' };

function span(startLine: number, endLine = startLine, startByte = startLine * 100): ContentSpan {
  return { startByte, endByte: startByte + 50, startLine, endLine };
}

function outline(
  title: string,
  kind: string,
  at: ContentSpan,
  children: readonly OutlineNode[] = [],
): OutlineNode {
  return { title, kind, span: at, children };
}

function segment(text: string, at: ContentSpan, kind: SegmentKind = SegmentKind.CODE): ContentSegment {
  return { kind, text, span: at };
}

describe('kind mapping', () => {
  it.each([
    ['class', CodeSymbolKind.CLASS],
    ['interface', CodeSymbolKind.INTERFACE],
    ['function', CodeSymbolKind.FUNCTION],
    ['method', CodeSymbolKind.METHOD],
    ['type', CodeSymbolKind.TYPE],
    ['enum', CodeSymbolKind.ENUM],
    ['module', CodeSymbolKind.MODULE],
  ])('maps the parser kind %s to %s — AC-1', (declared, expected) => {
    expect(codeSymbolKindOf(declared)).toBe(expected);
  });

  it('maps an unrecognised kind to unknown, not to the grammar word — AC-1', () => {
    // The point of the mapping: a grammar upgrade that renames a node must not
    // change what a consumer switches on.
    expect(codeSymbolKindOf('lexical_declaration')).toBe(CodeSymbolKind.UNKNOWN);
  });

  it('keeps the parser word so a mapping gap is diagnosable — AC-1', () => {
    const symbols = buildCodeSymbols(
      { segments: [], outline: [outline('thing', 'lexical_declaration', span(1))] },
      CONTEXT,
    );

    expect(symbols[0]?.kind).toBe(CodeSymbolKind.UNKNOWN);
    expect(symbols[0]?.declaredKind).toBe('lexical_declaration');
  });
});

describe('structure', () => {
  const box = outline('Box', 'class', span(10, 20), [
    outline('width', 'method', span(11, 13)),
    outline('height', 'method', span(14, 16)),
  ]);
  const parse = { segments: [], outline: [outline('add', 'function', span(1, 3)), box] };

  it('returns symbols flat, in document order, each naming its parent — AC-2', () => {
    const symbols = buildCodeSymbols(parse, CONTEXT);

    expect(symbols.map((symbol) => symbol.name)).toStrictEqual(['add', 'Box', 'width', 'height']);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get('add')?.parentId).toBeUndefined();
    expect(byName.get('width')?.parentId).toBe(byName.get('Box')?.id);
  });

  it('reassembles the same nesting — AC-2', () => {
    const tree = codeSymbolTree(buildCodeSymbols(parse, CONTEXT));

    expect(tree.map((node) => node.name)).toStrictEqual(['add', 'Box']);
    expect(tree[1]?.children.map((node) => node.name)).toStrictEqual(['width', 'height']);
    expect(tree[0]?.children).toStrictEqual([]);
  });

  it('keeps a symbol whose parent was filtered out, as a root', () => {
    const symbols = buildCodeSymbols(parse, CONTEXT);
    const withoutBox = symbols.filter((symbol) => symbol.name !== 'Box');

    // Losing a symbol silently because its parent was filtered is worse than a
    // shallower tree.
    expect(codeSymbolTree(withoutBox).map((node) => node.name)).toStrictEqual([
      'add',
      'width',
      'height',
    ]);
  });

  it('qualifies a nested name with its enclosing scopes — AC-3', () => {
    const symbols = buildCodeSymbols(parse, CONTEXT);
    expect(symbols.map((symbol) => symbol.qualifiedName)).toStrictEqual([
      'add',
      'Box',
      'Box.width',
      'Box.height',
    ]);
  });

  it('qualifies three levels deep — AC-3', () => {
    const nested = [
      outline('Outer', 'namespace', span(1, 30), [
        outline('Inner', 'class', span(2, 20), [outline('run', 'method', span(3, 5))]),
      ]),
    ];
    const symbols = buildCodeSymbols({ segments: [], outline: nested }, CONTEXT);

    expect(symbols.at(-1)?.qualifiedName).toBe('Outer.Inner.run');
  });

  it('yields nothing for a parse with no outline, and does not fail — AC-9', () => {
    expect(buildCodeSymbols({ segments: [], outline: [] }, CONTEXT)).toStrictEqual([]);
    expect(buildCodeSymbols({ segments: [] }, CONTEXT)).toStrictEqual([]);
  });
});

describe('documentation', () => {
  const declaration = span(10, 12);

  function withComment(commentEndLine: number): readonly CodeSymbol[] {
    return buildCodeSymbols(
      {
        segments: [segment('/** Adds. */', span(commentEndLine), SegmentKind.COMMENT)],
        outline: [outline('add', 'function', declaration)],
      },
      CONTEXT,
    );
  }

  it('attaches a comment on the line directly above — AC-4', () => {
    expect(withComment(9)[0]?.documentation).toBe('/** Adds. */');
  });

  it('attaches a comment one blank line above — AC-4', () => {
    expect(withComment(8)[0]?.documentation).toBe('/** Adds. */');
  });

  it('does not reach further than that — AC-4', () => {
    // Two blank lines is a comment about something else, and guessing costs
    // more than it gives.
    expect(withComment(7)[0]?.documentation).toBeUndefined();
  });

  it('leaves documentation absent when there is no comment — AC-4', () => {
    const symbols = buildCodeSymbols(
      { segments: [], outline: [outline('add', 'function', declaration)] },
      CONTEXT,
    );
    expect(symbols[0]?.documentation).toBeUndefined();
  });
});

describe('signature and modifiers', () => {
  function fromText(text: string): CodeSymbol {
    const at = span(1, 4);
    const symbols = buildCodeSymbols(
      { segments: [segment(text, at)], outline: [outline('thing', 'function', at)] },
      CONTEXT,
    );
    const symbol = symbols[0];
    if (symbol === undefined) throw new Error('expected a symbol');
    return symbol;
  }

  it('takes the first line and stops at the body — AC-6', () => {
    expect(fromText('export function add(a: number): number {\n  return a;\n}').signature).toBe(
      'export function add(a: number): number',
    );
  });

  it('keeps a declaration with no body intact — AC-6', () => {
    expect(fromText('export type Id = string;').signature).toBe('export type Id = string;');
  });

  it('bounds a pathological signature — AC-6', () => {
    const signature = fromText(`export function wide(${'a: number, '.repeat(200)}) {`).signature;
    expect(signature.length).toBeLessThanOrEqual(MAX_SIGNATURE_LENGTH);
    expect(signature.endsWith('…')).toBe(true);
  });

  it.each([
    ['export function a() {}', ['export']],
    ['export default class A {}', ['export', 'default']],
    ['  static async run() {}', ['static', 'async']],
    ['  private readonly x = 1;', ['private', 'readonly']],
    ['  protected abstract go(): void;', ['abstract', 'protected']],
    ['export abstract class A {}', ['export', 'abstract']],
  ])('reads the modifiers of %o — AC-5', (text, expected) => {
    expect(fromText(text).modifiers).toStrictEqual(expected);
  });

  it('reports none for an unmodified declaration — AC-5', () => {
    expect(fromText('function plain() {}').modifiers).toStrictEqual([]);
  });

  it('does not find a modifier inside a name — AC-5', () => {
    // Only the leading run of tokens is inspected; scanning the whole line
    // would find `readonly` in the name.
    expect(fromText('export function readonlyThing() {}').modifiers).toStrictEqual(['export']);
  });

  it('reports modifiers in a canonical order, not the source order — AC-5', () => {
    expect(fromText('static export run() {}').modifiers).toStrictEqual(
      fromText('export static run() {}').modifiers,
    );
  });
});

describe('identity', () => {
  const two = {
    segments: [],
    outline: [outline('handle', 'function', span(1, 3)), outline('handle', 'function', span(5, 7))],
  };

  it('gives two same-named declarations distinct ids, and records the ordinal — AC-7', () => {
    const symbols = buildCodeSymbols(two, CONTEXT);

    expect(symbols[0]?.overload).toBe(0);
    expect(symbols[1]?.overload).toBe(1);
    expect(symbols[0]?.id).not.toBe(symbols[1]?.id);
  });

  it('is stable across two builds over the same content — AC-8', () => {
    const first = buildCodeSymbols(two, CONTEXT).map((symbol) => symbol.id);
    const second = buildCodeSymbols(two, CONTEXT).map((symbol) => symbol.id);
    expect(second).toStrictEqual(first);
  });

  it('differs for the same name in another file or repository — AC-8', () => {
    const here = codeSymbolId(CONTEXT, 'Box.width', 0);
    const otherFile = codeSymbolId({ ...CONTEXT, path: 'src/other.ts' }, 'Box.width', 0);
    const otherRepo = codeSymbolId({ ...CONTEXT, scope: 'repo-2' }, 'Box.width', 0);

    expect(new Set([here, otherFile, otherRepo]).size).toBe(3);
  });

  it('is a well-formed canonical id', () => {
    expect(codeSymbolId(CONTEXT, 'add', 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe('the canonical entity kind', () => {
  it('registers without changing the core envelope — AC-11', () => {
    registerCodeSymbolKind();
    // Idempotent: more than one entry point may compose the code model.
    registerCodeSymbolKind();

    expect(entityKindDefinition(CODE_SYMBOL_KIND)?.kind).toBe(CODE_SYMBOL_KIND);
  });

  it('round-trips a symbol through createEntity — AC-11', () => {
    registerCodeSymbolKind();
    const symbols = buildCodeSymbols(
      {
        segments: [segment('export class Box {', span(10, 20))],
        outline: [outline('Box', 'class', span(10, 20))],
      },
      CONTEXT,
    );
    const symbol = symbols[0];
    if (symbol === undefined) throw new Error('expected a symbol');

    const entity = createEntity({
      kind: CODE_SYMBOL_KIND,
      source: { system: 'git', id: symbol.qualifiedName, scope: CONTEXT.path },
      attributes: codeSymbolAttributesFrom(symbol, CONTEXT.path),
    });

    expect(entity.attributes).toMatchObject({
      qualifiedName: 'Box',
      symbolKind: 'class',
      path: 'src/shapes.ts',
      startLine: 10,
      endLine: 20,
      modifiers: ['export'],
    });
  });

  it('rejects an attribute set the schema does not describe', () => {
    expect(() =>
      codeSymbolAttributes.parse({ name: 'x', qualifiedName: 'x', symbolKind: 'invented' }),
    ).toThrow();
  });
});

describe('against a real parse', () => {
  it('builds symbols from what EPIC-025 actually produces — AC-10', async () => {
    // The unit tests above drive the model with hand-built outlines, which
    // proves the mapping and nothing about whether the parser's real output
    // fits it. This is that check, and it is the one that would fail if the
    // two Epics drifted.
    const framework = new ParserFramework({ parsers: [createCodeParserProvider()] });
    const source = [
      '/** A box. */',
      'export class Box {',
      '  width(): number {',
      '    return 1;',
      '  }',
      '}',
    ].join('\n');

    const outcome = await framework.parse(
      { path: 'src/box.ts', bytes: new TextEncoder().encode(source) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse: ${outcome.reason}`);

    const symbols = buildCodeSymbols(outcome, { path: 'src/box.ts', scope: 'repo-1' });

    expect(symbols.map((symbol) => symbol.qualifiedName)).toStrictEqual(['Box', 'Box.width']);
    expect(symbols[0]).toMatchObject({
      kind: CodeSymbolKind.CLASS,
      modifiers: ['export'],
      signature: 'export class Box',
      documentation: '/** A box. */',
    });
    expect(symbols[1]).toMatchObject({ kind: CodeSymbolKind.METHOD, signature: 'width(): number' });
  }, 60_000);
});
