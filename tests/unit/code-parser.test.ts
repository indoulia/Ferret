import { describe, expect, it } from 'vitest';

import { ParserFramework, ParserSupport, SegmentKind, UnparsedReason } from '../../src/index.js';
import {
  CODE_PARSER_ID,
  CodeParserProvider,
  REQUIRED_GRAMMARS,
  createCodeParserProvider,
  languageFor,
} from '../../src/parsers/index.js';
import { createTestOperationContext, runConformance } from '../../src/providers/sdk/testing.js';
import type { OutlineNode, ParsedContent } from '../../src/index.js';
import { GRAMMARS } from '../../scripts/copy-grammars.mjs';

const encoder = new TextEncoder();

/**
 * One provider for the whole suite.
 *
 * Grammars load once per process and are cached; a provider per test would
 * reload 5.6 MB of WASM twenty times over for no added coverage.
 */
const parser = createCodeParserProvider();
const framework = new ParserFramework({ parsers: [parser] });

async function parse(path: string, source: string): Promise<ParsedContent> {
  const outcome = await framework.parse(
    { path, bytes: encoder.encode(source) },
    createTestOperationContext(),
  );
  if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

function labels(outcome: ParsedContent): readonly string[] {
  return outcome.segments.map((segment) => segment.label).filter((label): label is string => label !== undefined);
}

function titles(nodes: readonly OutlineNode[]): readonly string[] {
  return nodes.map((node) => node.title);
}

describe('the grammar list', () => {
  it('is the same in the build script and in the language table — AC-12', () => {
    // The script runs under plain Node and cannot import the TypeScript table,
    // so the duplication is real. This is what keeps it from drifting: adding a
    // language without shipping its grammar fails here rather than at a user's
    // first parse.
    expect([...GRAMMARS].sort()).toStrictEqual([...REQUIRED_GRAMMARS]);
  });

  it('is four grammars, not the forty the dependency carries', () => {
    expect(REQUIRED_GRAMMARS).toStrictEqual(['javascript', 'python', 'tsx', 'typescript']);
  });
});

describe('language selection', () => {
  it('routes .tsx by path, because the media type cannot tell it from .ts', () => {
    expect(languageFor('a/b.tsx', 'text/x-typescript')?.language).toBe('tsx');
    expect(languageFor('a/b.ts', 'text/x-typescript')?.language).toBe('typescript');
  });

  it('claims the media types it has grammars for, and nothing else — AC-9', () => {
    const target = { path: 'a.ts', mediaType: 'text/x-typescript', binary: false, sizeBytes: 10 };
    expect(parser.supports(target)).toBe(ParserSupport.NATIVE);
    expect(parser.supports({ ...target, path: 'a.rs', mediaType: 'text/x-rust' })).toBe(
      ParserSupport.NONE,
    );
    expect(parser.supports({ ...target, binary: true })).toBe(ParserSupport.NONE);
  });

  it('declines rather than guessing, so the framework says no-parser — AC-9', async () => {
    const outcome = await framework.parse(
      { path: 'main.rs', bytes: encoder.encode('fn main() {}') },
      createTestOperationContext(),
    );
    expect(outcome.parsed).toBe(false);
    if (!outcome.parsed) expect(outcome.reason).toBe(UnparsedReason.NO_PARSER);
  });
});

describe('TypeScript', () => {
  const source = [
    "import { readFile } from 'node:fs';",
    '',
    '/** Adds two numbers. */',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export interface Shape {',
    '  area(): number;',
    '}',
    '',
    'export type Id = string;',
    '',
    'export enum Colour {',
    '  Red,',
    '}',
    '',
    'export class Box {',
    '  width(): number {',
    '    return 1;',
    '  }',
    '  height(): number {',
    '    return 2;',
    '  }',
    '}',
    '',
    'export const unused = readFile;',
  ].join('\n');

  it('finds every kind of declaration, labelled — AC-1, AC-2', async () => {
    const outcome = await parse('src/shapes.ts', source);

    expect(outcome.parserId).toBe(CODE_PARSER_ID);
    expect(labels(outcome)).toEqual(expect.arrayContaining(['add', 'Shape', 'Id', 'Colour', 'Box']));
  });

  it('nests a method inside its class rather than beside it — AC-3', async () => {
    const outcome = await parse('src/shapes.ts', source);

    expect(titles(outcome.outline)).toEqual(expect.arrayContaining(['add', 'Shape', 'Box']));
    const box = outcome.outline.find((node) => node.title === 'Box');
    expect(box?.kind).toBe('class');
    expect(titles(box?.children ?? [])).toStrictEqual(['width', 'height']);
    // And the methods are not also top-level.
    expect(titles(outcome.outline)).not.toContain('width');
  });

  it('keeps a documentation comment as its own segment — AC-4', async () => {
    const outcome = await parse('src/shapes.ts', source);
    const comments = outcome.segments.filter((segment) => segment.kind === SegmentKind.COMMENT);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toContain('Adds two numbers');
  });

  it('collects imports into one segment — AC-5', async () => {
    const outcome = await parse('src/shapes.ts', source);
    const imports = outcome.segments.filter((segment) => segment.label === 'imports');

    expect(imports).toHaveLength(1);
    expect(imports[0]?.text).toContain("from 'node:fs'");
    expect(imports[0]?.kind).toBe(SegmentKind.METADATA);
  });

  it('has no import segment when a file imports nothing — AC-5', async () => {
    const outcome = await parse('src/plain.ts', 'export function one(): number {\n  return 1;\n}\n');
    expect(outcome.segments.some((segment) => segment.label === 'imports')).toBe(false);
  });

  it('does not mistake an exported declaration for an import — AC-5', async () => {
    // `export class Foo {}` and `export { x } from './y'` are the same node
    // type. Treating both as imports loses every exported class in the file.
    const outcome = await parse('src/only-exports.ts', 'export class Only {}\n');
    expect(titles(outcome.outline)).toStrictEqual(['Only']);
  });

  it('records the grammar that produced the result — AC-8', async () => {
    const outcome = await parse('src/shapes.ts', source);

    expect(outcome.attributes).toMatchObject({ language: 'typescript', grammar: 'typescript' });
    expect(outcome.attributes['grammarAbiVersion']).toBeTypeOf('number');
    expect(outcome.attributes['grammarBinaryHash']).toMatch(/^[0-9a-f]{16}$/);
    expect(outcome.parserVersion).toContain('wts0.25.10');
  });
});

describe('TSX, JavaScript and Python', () => {
  it('parses TSX with the TSX grammar — AC-1', async () => {
    const outcome = await parse(
      'src/Button.tsx',
      'export function Button(): JSX.Element {\n  return <button>ok</button>;\n}\n',
    );

    expect(outcome.attributes['grammar']).toBe('tsx');
    expect(outcome.attributes['hasSyntaxErrors']).toBe(false);
    expect(titles(outcome.outline)).toStrictEqual(['Button']);
  });

  it('parses JavaScript — AC-1', async () => {
    const outcome = await parse(
      'src/util.js',
      "import x from './x.js';\nexport class Util {\n  run() { return x; }\n}\n",
    );

    expect(outcome.attributes['language']).toBe('javascript');
    const util = outcome.outline.find((node) => node.title === 'Util');
    expect(titles(util?.children ?? [])).toStrictEqual(['run']);
  });

  it('parses Python, including a decorated function — AC-1, AC-3', async () => {
    const outcome = await parse(
      'app/service.py',
      [
        'import os',
        '',
        'class Service:',
        '    def start(self):',
        '        return os.getcwd()',
        '',
        '@cache',
        'def helper():',
        '    return 1',
      ].join('\n'),
    );

    expect(outcome.attributes['language']).toBe('python');
    const service = outcome.outline.find((node) => node.title === 'Service');
    expect(titles(service?.children ?? [])).toStrictEqual(['start']);
    expect(titles(outcome.outline)).toContain('helper');
  });
});

describe('broken and unusual files', () => {
  it('returns what parsed, plus a warning — AC-6', async () => {
    const outcome = await parse(
      'src/broken.ts',
      'export function good(): number {\n  return 1;\n}\n\nexport function bad(: {\n',
    );

    expect(labels(outcome)).toContain('good');
    expect(outcome.warnings.map((warning) => warning.code)).toContain('syntax-error');
    expect(outcome.attributes['hasSyntaxErrors']).toBe(true);
  });

  it('gives a script with no declarations one segment for the whole file', async () => {
    const outcome = await parse('scripts/run.js', 'console.log(1);\nconsole.log(2);\n');

    expect(outcome.segments).toHaveLength(1);
    expect(outcome.segments[0]?.span).toMatchObject({ startLine: 1, endByte: 32 });
  });

  it('stops at the segment cap and says so', async () => {
    const capped = new ParserFramework({
      parsers: [createCodeParserProvider({ maxSegments: 3 })],
    });
    const source = Array.from({ length: 20 }, (_, index) => `function f${String(index)}() {}`).join('\n');

    const outcome = await capped.parse(
      { path: 'src/many.ts', bytes: encoder.encode(source) },
      createTestOperationContext(),
    );

    expect(outcome.parsed).toBe(true);
    if (outcome.parsed) {
      expect(outcome.segments).toHaveLength(3);
      expect(outcome.truncated).toBe(true);
      expect(outcome.warnings.map((warning) => warning.code)).toContain('segment-limit');
    }
  });
});

describe('byte-accurate spans', () => {
  it('indexes the original bytes, not UTF-16 code units — AC-7', async () => {
    // Three characters that are three bytes each, before the declaration. A
    // parser reporting UTF-16 offsets would be six bytes short at every span
    // after them, and the quoted evidence would start mid-character.
    const source = '// 日本語\nexport function after(): void {}\n';
    const bytes = encoder.encode(source);
    const outcome = await parse('src/unicode.ts', source);

    const declaration = outcome.segments.find((segment) => segment.label === 'after');
    expect(declaration).toBeDefined();

    const sliced = new TextDecoder().decode(
      bytes.subarray(declaration?.span.startByte ?? 0, declaration?.span.endByte ?? 0),
    );
    expect(sliced).toBe('export function after(): void {}');
  });

  it('agrees with the framework, which rejects a span past the end — AC-7', async () => {
    // The framework validates spans against the byte length. A parser reporting
    // UTF-16 offsets on a file that is mostly multi-byte would fail there, so
    // this passing is itself the assertion.
    const source = `const emoji = '🚀🚀🚀🚀🚀';\nexport function tail(): string {\n  return emoji;\n}\n`;
    const outcome = await parse('src/emoji.ts', source);

    const total = encoder.encode(source).length;
    for (const segment of outcome.segments) {
      expect(segment.span.endByte).toBeLessThanOrEqual(total);
    }
  });
});

describe('a grammar that will not load', () => {
  it('fails that language only — AC-10', async () => {
    const broken = new CodeParserProvider({ grammarPaths: ['/nonexistent/grammars'] });
    const brokenFramework = new ParserFramework({ parsers: [broken] });

    const outcome = await brokenFramework.parse(
      { path: 'src/a.ts', bytes: encoder.encode('export const a = 1;') },
      createTestOperationContext(),
    );

    expect(outcome.parsed).toBe(false);
    if (!outcome.parsed) {
      expect(outcome.reason).toBe(UnparsedReason.PARSER_FAILED);
      expect(outcome.detail).toContain('typescript');
    }
    // The working provider, with real grammar paths, is unaffected.
    expect((await parse('src/b.ts', 'export const b = 2;')).parsed).toBe(true);
  });
});

describe('the provider contract', () => {
  it('satisfies the EPIC-016 conformance suite — AC-11', async () => {
    const report = await runConformance({ create: () => createCodeParserProvider() });

    expect(
      report.checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`),
    ).toStrictEqual([]);
    expect(report.conformant).toBe(true);
  }, 60_000);
});

describe('a function bound to a name — issue #106', () => {
  const source = [
    'export const arrow = (a: number): number => a + 1;',
    'const plain = 1;',
    "const alias = require('x');",
    'export const named = function namedExpr(): void {};',
    'export const gen = function* (): Generator<number> { yield 1; };',
    'export const asyncArrow = async (): Promise<void> => {};',
    'export const handlers = {',
    '  onClick: () => {},',
    '};',
    'export class Widget {',
    '  render = (): string => "x";',
    '}',
  ].join('\n');

  it('extracts an arrow function assigned to a const', async () => {
    // The defect: `const x = () => {}` produced no symbol at all, which is the
    // dominant way functions are written in modern TypeScript and JavaScript.
    // EPIC-097's harness measured it as `symbolRecall 0.96 missing=[arrow]`.
    const outcome = await parse('src/arrows.ts', source);

    expect(titles(outcome.outline)).toContain('arrow');
    expect(outcome.outline.find((node) => node.title === 'arrow')?.kind).toBe('function');
  });

  it('extracts a function expression, an async arrow and a generator', async () => {
    const found = titles((await parse('src/arrows.ts', source)).outline);

    expect(found).toContain('named');
    expect(found).toContain('asyncArrow');
    expect(found).toContain('gen');
  });

  it('extracts a function-valued property and a class field', async () => {
    const outcome = await parse('src/arrows.ts', source);
    const flat = [...titles(outcome.outline), ...outcome.outline.flatMap((n) => titles(n.children))];

    // Object-literal handlers are how a large amount of JavaScript is
    // organised, and a class field arrow is how a bound React method is.
    expect(flat).toContain('onClick');
    expect(flat).toContain('render');
  });

  it('does not turn every const into a function', async () => {
    // The reason this cannot live in the node-type map: `const x = 1` and
    // `const x = () => {}` are both `variable_declarator`, so a blanket rule
    // would name every binding in the language a function.
    const found = titles((await parse('src/arrows.ts', source)).outline);

    expect(found).not.toContain('plain');
    expect(found).not.toContain('alias');
  });

  it('quotes the export keyword, not just the declarator', async () => {
    // `wrapper ?? child` keeps the outermost wrapper, so a retrieval hit shows
    // `export const arrow = ...` rather than starting mid-statement.
    const outcome = await parse('src/arrows.ts', source);
    const segment = outcome.segments.find((one) => one.text.includes('arrow'));

    expect(segment?.text.startsWith('export const arrow')).toBe(true);
  });
});
