import { describe, expect, it } from 'vitest';

import {
  ResolutionRule,
  UnresolvedReason,
  resolveReferences,
  type CodeReference,
  type CodeSymbol,
} from '../../src/index.js';
import { createCodeParserProvider } from '../../src/parsers/index.js';
import { ParserFramework } from '../../src/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import { FILE_REFERENCES_SYMBOL, SYMBOL_REFERENCES_SYMBOL } from '../../src/code/index.js';
import { REFERENCE_EDGE_TYPES, REFUSAL_REASONS } from '../../src/storage/retrieval.js';

/**
 * **A member call does not resolve to a homonym because they share a file — F-25.**
 *
 * EPIC-035 §8.3 refuses the repository rule for a member call, for a reason it
 * states well: `map.has(x)` names `has`, and which `has` it means depends on
 * what `map` is. The guard was placed in front of the *repository* rule only,
 * and the `same-file` rule runs before it — so a member call still resolved,
 * to whatever declaration in the same file happened to carry the name, at
 * `STRONG` (0.95), the highest band the resolver has.
 *
 * Verified live against Ferret's own index before this was written:
 * `ferret_neighbours(ProviderRegistry.has, direction: in)` returned **8**
 * inbound edges, every one `rule: "same-file"`, and every cited line a
 * `Map`/`Set` `.has()` call on a private field. The Epic's validation record
 * says this class was eliminated. It was narrowed from repository-wide to
 * file-scoped and left at the top confidence band.
 *
 * **Corroboration, not refusal.** Dropping every member call would take
 * `this.helper()` with it, which is a real edge and most of what a call graph
 * inside a class *is*. The receiver is the corroboration: `this.has()` and
 * `self.has()` are scoped by the enclosing declaration, and Ferret knows what
 * that is. Every other receiver — `map.has()`, `this.#providers.has()` — is
 * scoped by a type Ferret does not know, and stays unresolved.
 */

function symbol(qualifiedName: string, id = `sym-${qualifiedName}`): CodeSymbol {
  const parts = qualifiedName.split('.');
  return {
    id,
    kind: 'function',
    name: parts[parts.length - 1] ?? qualifiedName,
    qualifiedName,
    parentId: undefined,
    span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 },
    signature: undefined,
    modifiers: [],
    overload: 0,
    declaredKind: 'function',
  } as unknown as CodeSymbol;
}

function reference(
  name: string,
  enclosing: readonly string[],
  qualified: boolean,
  receiver?: string,
): CodeReference {
  return {
    kind: 'call',
    name,
    qualified,
    enclosing,
    span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 },
    ...(receiver === undefined ? {} : { receiver }),
  } as unknown as CodeReference;
}

const NONE = (): readonly { id: string }[] => [];

describe('a member call and a same-file homonym — F-25', () => {
  const declared = [symbol('Registry.has'), symbol('Registry.check')];

  it('refuses a member call on an unknown receiver, however local the homonym', () => {
    // The measured case, reduced: `map.has(key)` inside `Registry.check`, with
    // `Registry.has` declared in the same file.
    const { resolved, unresolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], true, 'map')],
      declared,
      NONE,
    );

    expect(resolved, 'a Map.has() call resolved to a same-file declaration').toStrictEqual([]);
    expect(unresolved.map((one) => one.reason)).toStrictEqual([UnresolvedReason.RECEIVER_UNKNOWN]);
  });

  it('refuses it when the receiver is a member expression, not just a bare name', () => {
    // `this.#providers.has(key)` — the exact shape of all eight edges the live
    // query returned. The receiver mentions `this`, and matching on that would
    // reintroduce the defect wearing a different spelling.
    const { resolved, unresolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], true, 'this.#providers')],
      declared,
      NONE,
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved.map((one) => one.reason)).toStrictEqual([UnresolvedReason.RECEIVER_UNKNOWN]);
  });

  it('resolves a call on `this` to a member of the enclosing declaration', () => {
    // The corroborated case, which must survive: `this.has(key)` inside
    // `Registry.check` means `Registry.has`, and the language says so.
    const { resolved, unresolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], true, 'this')],
      declared,
      NONE,
    );

    expect(unresolved).toStrictEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toSymbolId).toBe('sym-Registry.has');
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
  });

  it('resolves `self` the same way, for Python', () => {
    const { resolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], true, 'self')],
      declared,
      NONE,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toSymbolId).toBe('sym-Registry.has');
  });

  it('refuses `this.x()` when the homonym belongs to a different declaration', () => {
    // `this` corroborates *the enclosing type*, and nothing else. A file holding
    // two classes must not resolve one's method call to the other's method.
    const twoClasses = [symbol('Registry.check'), symbol('Cache.has')];
    const { resolved, unresolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], true, 'this')],
      twoClasses,
      NONE,
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved.map((one) => one.reason)).toStrictEqual([UnresolvedReason.RECEIVER_UNKNOWN]);
  });

  it('leaves a bare call alone — the control', () => {
    // Unqualified references are what the `same-file` rule was written for, and
    // this change must not touch them.
    const { resolved } = resolveReferences(
      [reference('has', ['Registry', 'check'], false)],
      declared,
      NONE,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
  });

  it('still refuses a member call the repository rule would have taken', () => {
    // §8.3's original case, unchanged: a member call never reaches the
    // repository-wide lookup.
    const { resolved, unresolved } = resolveReferences(
      [reference('save', ['top'], true, 'record')],
      [],
      () => [{ id: 'sym-elsewhere' }],
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved.map((one) => one.reason)).toStrictEqual([UnresolvedReason.RECEIVER_UNKNOWN]);
  });
});

describe('the parser reports the receiver it saw', () => {
  const framework = new ParserFramework({ parsers: [createCodeParserProvider()] });
  const encoder = new TextEncoder();

  async function referencesIn(path: string, source: string): Promise<readonly CodeReference[]> {
    const outcome = await framework.parse(
      { path, bytes: encoder.encode(source) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    return outcome.references ?? [];
  }

  it('names the receiver for TypeScript, and leaves a bare call without one', async () => {
    const found = await referencesIn(
      'src/registry.ts',
      `export class Registry {
  #providers = new Map<string, number>();
  has(key: string): boolean {
    return this.#providers.has(key);
  }
  check(key: string): boolean {
    return this.has(key) && plain(key);
  }
}
function plain(key: string): boolean {
  return key.length > 0;
}
`,
    );

    const byName = new Map(found.map((one) => [`${one.name}@${one.span.startLine}`, one]));
    const memberCall = [...byName.values()].find(
      (one) => one.name === 'has' && one.receiver === 'this.#providers',
    );
    const selfCall = [...byName.values()].find((one) => one.name === 'has' && one.receiver === 'this');
    const bare = [...byName.values()].find((one) => one.name === 'plain');

    expect(memberCall, 'the Map.has() receiver was not reported').toBeDefined();
    expect(selfCall, 'the this.has() receiver was not reported').toBeDefined();
    expect(bare?.receiver, 'a bare call was given a receiver').toBeUndefined();
    expect(bare?.qualified).toBe(false);
  });

  it('names the receiver for Python', async () => {
    const found = await referencesIn(
      'app/registry.py',
      `class Registry:
    def has(self, key):
        return self._items.has(key)

    def check(self, key):
        return self.has(key)
`,
    );

    const selfCall = found.find((one) => one.name === 'has' && one.receiver === 'self');
    const memberCall = found.find((one) => one.name === 'has' && one.receiver === 'self._items');

    expect(selfCall, 'self.has() was not reported with its receiver').toBeDefined();
    expect(memberCall, 'self._items.has() was not reported with its receiver').toBeDefined();
  });
});

/**
 * **The duplicated constants cannot drift — F-27's read half.**
 *
 * `src/storage/retrieval.ts` names the reference edge types and the unresolved
 * reasons as string literals. That is not laziness: `code_symbol` is a
 * *registered* kind and storage may not import `src/code/`, which
 * `boundaries.test.ts` enforces. But a duplicated constant nobody checks is how
 * a control goes quietly stale — rename an edge in the registration and the
 * verdict silently switches itself off, with every test still green because
 * nothing asserts the two agree.
 *
 * So this is the check the comment in that file promises. It belongs here rather
 * than beside the storage code because only a test may import both sides.
 */
describe('the reference verdict is wired to the edges that exist — F-27', () => {
  it('names exactly the reference edge types the code model registers', () => {
    expect([...REFERENCE_EDGE_TYPES].sort()).toStrictEqual(
      [FILE_REFERENCES_SYMBOL, SYMBOL_REFERENCES_SYMBOL].sort(),
    );
  });

  it('classifies every unresolved reason as a refusal or an absence', () => {
    // The control against the derived rule's own reach — Batch 6's lesson, and
    // here the reach runs the other way: a reason added later would be treated
    // as an absence by default and quietly shrink the verdict. Adding one now
    // fails this until somebody decides which half it belongs in.
    const ABSENCES = new Set(['not-found']);
    for (const reason of Object.values(UnresolvedReason)) {
      expect(
        REFUSAL_REASONS.has(reason) || ABSENCES.has(reason),
        `${reason} is classified as neither a refusal nor an absence`,
      ).toBe(true);
    }
    expect(REFUSAL_REASONS.size + ABSENCES.size).toBe(Object.values(UnresolvedReason).length);
  });

  it('keeps an import on the refusal side, where the missing edge lives', () => {
    // The one it would be easiest to get wrong. `import { foo } from './bar.js'`
    // names a symbol the repository very probably declares, and §8.4 does not
    // follow the import — so the edge is missing, not absent. Treating it as an
    // absence would report `complete` over exactly the graph that is short.
    expect(REFUSAL_REASONS.has(UnresolvedReason.IMPORTED)).toBe(true);
    expect(REFUSAL_REASONS.has(UnresolvedReason.NOT_FOUND)).toBe(false);
  });
});
