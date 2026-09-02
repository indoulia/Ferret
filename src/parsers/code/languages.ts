import { ReferenceKind } from '../../providers/contracts/parser.js';

/**
 * What Ferret knows about each language it parses, as data.
 *
 * A table rather than a class per language, because everything that differs
 * between TypeScript and Python is a set of node-type names. Adding a language
 * is an entry here plus a grammar in the build list — which is the whole reason
 * tree-sitter was selected (TECHNOLOGY-DECISIONS §4) over a parser per language.
 */

/** What a declaration is, for the outline. Parser-chosen, per EPIC-024. */
export const DeclarationKind = {
  MODULE: 'module',
  CLASS: 'class',
  INTERFACE: 'interface',
  FUNCTION: 'function',
  METHOD: 'method',
  TYPE: 'type',
  ENUM: 'enum',
  VARIABLE: 'variable',
} as const;

export type DeclarationKind = (typeof DeclarationKind)[keyof typeof DeclarationKind];

export interface LanguageSpec {
  /** Ferret's name for the language, reported in attributes. */
  readonly language: string;
  /** Grammar file base name: `tree-sitter-<grammar>.wasm`. */
  readonly grammar: string;
  /** EPIC-024 media types this grammar claims. */
  readonly mediaTypes: readonly string[];
  /**
   * Node types that are declarations, and what each one is.
   *
   * The values are what appears in the outline. A node type absent here is
   * walked through rather than skipped, so a method inside a class inside a
   * namespace is still found.
   */
  readonly declarations: Readonly<Record<string, DeclarationKind>>;
  /** Node types that are comments. */
  readonly comments: readonly string[];
  /** Node types that bring something into scope. */
  readonly imports: readonly string[];
  /**
   * Node types that *use* a name, and what kind of use each is — EPIC-035 §8.1.
   *
   * The same shape as `declarations`, for the same reason: the walk already
   * visits every node, and a tree-sitter query language here would be a second
   * place for language support to drift.
   *
   * Calls and constructions only. Every identifier occurrence is not a
   * reference to a declaration in any sense a name-based resolver can honour,
   * and indexing all of them would bury the ones that mean something.
   */
  readonly references: Readonly<Record<string, ReferenceKind>>;
  /**
   * Node types that wrap a declaration without being one.
   *
   * `export function add()` is an `export_statement` containing a
   * `function_declaration`. The declaration is what has a name; the wrapper is
   * what a reader recognises, and what a retrieval hit should quote. A segment
   * therefore spans the wrapper and is named after the declaration inside it.
   */
  readonly wrappers: readonly string[];
  /**
   * Node types that declare a function only when their value **is** one.
   *
   * `const x = () => {}` is a `variable_declarator`, and so is `const x = 1`.
   * The node type alone cannot tell them apart, so the value's type decides —
   * which is why this cannot live in {@link declarations}.
   *
   * Issue #106: without it, `const x = () => {}` produced no symbol at all, and
   * that is the dominant way functions are written in modern TypeScript and
   * JavaScript — React components, event handlers, most of `.tsx`. EPIC-097's
   * harness measured it as `symbolRecall 0.96` with `missing=[arrow]`.
   */
  readonly functionValued: Readonly<Record<string, readonly string[]>>;
}

/**
 * A value that makes its binding a function.
 *
 * `function_expression` and `generator_function` are the pre-arrow spellings and
 * still common in JavaScript. A class expression is deliberately absent: it
 * declares a class, and calling it a function would be a worse answer than
 * saying nothing.
 */
const ECMASCRIPT_FUNCTION_VALUES: readonly string[] = Object.freeze([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

const ECMASCRIPT_FUNCTION_VALUED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  variable_declarator: ECMASCRIPT_FUNCTION_VALUES,
  // `obj = { handler: () => {} }` — a property whose value is a function is a
  // function by the same reasoning, and object-literal handlers are how a
  // large amount of JavaScript is organised.
  pair: ECMASCRIPT_FUNCTION_VALUES,
  public_field_definition: ECMASCRIPT_FUNCTION_VALUES,
});

/**
 * TypeScript and TSX share every node type; they are separate grammars because
 * `<T>` is a type assertion in one and a JSX element in the other, and no single
 * grammar can be right about both.
 */
const TYPESCRIPT_DECLARATIONS: Readonly<Record<string, DeclarationKind>> = Object.freeze({
  class_declaration: DeclarationKind.CLASS,
  abstract_class_declaration: DeclarationKind.CLASS,
  interface_declaration: DeclarationKind.INTERFACE,
  function_declaration: DeclarationKind.FUNCTION,
  generator_function_declaration: DeclarationKind.FUNCTION,
  method_definition: DeclarationKind.METHOD,
  abstract_method_signature: DeclarationKind.METHOD,
  type_alias_declaration: DeclarationKind.TYPE,
  enum_declaration: DeclarationKind.ENUM,
  module: DeclarationKind.MODULE,
  internal_module: DeclarationKind.MODULE,
});

const JAVASCRIPT_DECLARATIONS: Readonly<Record<string, DeclarationKind>> = Object.freeze({
  class_declaration: DeclarationKind.CLASS,
  function_declaration: DeclarationKind.FUNCTION,
  generator_function_declaration: DeclarationKind.FUNCTION,
  method_definition: DeclarationKind.METHOD,
});

const PYTHON_DECLARATIONS: Readonly<Record<string, DeclarationKind>> = Object.freeze({
  class_definition: DeclarationKind.CLASS,
  function_definition: DeclarationKind.FUNCTION,
});

/**
 * `new_expression` is a construction and `call_expression` is a call. TypeScript
 * and JavaScript share both node types, as they share every other.
 */
const ECMASCRIPT_REFERENCES: Readonly<Record<string, ReferenceKind>> = Object.freeze({
  call_expression: ReferenceKind.CALL,
  new_expression: ReferenceKind.CONSTRUCTION,
});

/**
 * Python has one node for both: `Invoice()` is a `call` whether `Invoice` is a
 * class or a function, and the grammar cannot tell which without resolving the
 * name. Reporting it as a call is the honest reading — EPIC-035 §8.1 keeps the
 * vocabulary coarse for exactly this reason.
 */
const PYTHON_REFERENCES: Readonly<Record<string, ReferenceKind>> = Object.freeze({
  call: ReferenceKind.CALL,
});

export const CODE_LANGUAGES: readonly LanguageSpec[] = Object.freeze([
  Object.freeze({
    language: 'typescript',
    grammar: 'typescript',
    mediaTypes: ['text/x-typescript'],
    declarations: TYPESCRIPT_DECLARATIONS,
    references: ECMASCRIPT_REFERENCES,
    comments: ['comment'],
    imports: ['import_statement', 'export_statement'],
    wrappers: ['export_statement', 'lexical_declaration', 'variable_declaration'],
    functionValued: ECMASCRIPT_FUNCTION_VALUED,
  }),
  Object.freeze({
    language: 'tsx',
    grammar: 'tsx',
    // Claimed by path rather than by media type: `.tsx` and `.ts` share one
    // media type, and the two grammars disagree about `<T>`. See `provider.ts`.
    mediaTypes: [],
    declarations: TYPESCRIPT_DECLARATIONS,
    references: ECMASCRIPT_REFERENCES,
    comments: ['comment'],
    imports: ['import_statement', 'export_statement'],
    wrappers: ['export_statement', 'lexical_declaration', 'variable_declaration'],
    functionValued: ECMASCRIPT_FUNCTION_VALUED,
  }),
  Object.freeze({
    language: 'javascript',
    grammar: 'javascript',
    mediaTypes: ['text/javascript'],
    declarations: JAVASCRIPT_DECLARATIONS,
    references: ECMASCRIPT_REFERENCES,
    comments: ['comment'],
    imports: ['import_statement', 'export_statement'],
    wrappers: ['export_statement', 'lexical_declaration', 'variable_declaration'],
    functionValued: ECMASCRIPT_FUNCTION_VALUED,
  }),
  Object.freeze({
    language: 'python',
    grammar: 'python',
    mediaTypes: ['text/x-python'],
    declarations: PYTHON_DECLARATIONS,
    references: PYTHON_REFERENCES,
    comments: ['comment'],
    imports: ['import_statement', 'import_from_statement', 'future_import_statement'],
    wrappers: ['decorated_definition'],
    // Python's `f = lambda x: x` is deliberately absent — PEP 8 says use `def`,
    // so a named lambda is rare, and treating an assignment as a declaration
    // would cost more false symbols than it found real ones.
    functionValued: {},
  }),
]);

/** The grammars the build must copy. Kept beside the table so they cannot drift. */
export const REQUIRED_GRAMMARS: readonly string[] = Object.freeze(
  [...new Set(CODE_LANGUAGES.map((spec) => spec.grammar))].sort(),
);

/** Every media type any grammar claims. */
export const CODE_MEDIA_TYPES: readonly string[] = Object.freeze(
  [...new Set(CODE_LANGUAGES.flatMap((spec) => spec.mediaTypes))].sort(),
);

/**
 * The language for a file, by path first and media type second.
 *
 * The path decides for `.tsx`, and only for `.tsx`: EPIC-024 maps it to the same
 * `text/x-typescript` as `.ts`, correctly — it *is* TypeScript — but the two
 * grammars parse `<T>` differently and one of them will be wrong.
 */
export function languageFor(path: string, mediaType: string): LanguageSpec | undefined {
  if (/\.tsx$/i.test(path)) return CODE_LANGUAGES.find((spec) => spec.language === 'tsx');
  if (/\.jsx$/i.test(path)) return CODE_LANGUAGES.find((spec) => spec.language === 'tsx');
  return CODE_LANGUAGES.find((spec) => spec.mediaTypes.includes(mediaType));
}
