import { describe, expect, it } from 'vitest';

import {
  Confidence,
  ResolutionRule,
  UnresolvedReason,
  resolveReferences,
  type CodeReference,
  type CodeSymbol,
} from '../../src/index.js';

/**
 * EPIC-035's resolver, on paper.
 *
 * The Epic's central claim is a refusal — that an ambiguous name resolves to
 * **nothing** — so the tests that matter most are the ones asserting no edge is
 * produced. A wrong call graph is worse than an absent one, because it reads as
 * knowledge.
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
  enclosing: readonly string[] = [],
  qualified = false,
  receiver?: string,
): CodeReference {
  return {
    kind: 'call',
    name,
    qualified,
    enclosing,
    span: { startByte: 0, endByte: 1, startLine: 2, endLine: 2 },
    ...(receiver === undefined ? {} : { receiver }),
  };
}

const nothing = (): readonly { id: string }[] => [];

describe('resolving within the file — AC-1, AC-3', () => {
  it('resolves a call to a declaration in the same file, at STRONG', () => {
    const declared = [symbol('applyTax'), symbol('refundInvoice')];

    const { resolved, unresolved } = resolveReferences(
      [reference('applyTax', ['refundInvoice'])],
      declared,
      nothing,
    );

    expect(unresolved).toStrictEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toSymbolId).toBe('sym-applyTax');
    expect(resolved[0]?.fromSymbolId).toBe('sym-refundInvoice');
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
    expect(resolved[0]?.confidence).toBe(Confidence.STRONG);
  });

  it('prefers the same file over the repository', () => {
    // A local declaration is what the language's own scoping means. Consulting
    // the repository first would resolve a name to a homonym in another file
    // while the answer was in front of it.
    const { resolved } = resolveReferences([reference('save')], [symbol('save', 'sym-local')], () => [
      { id: 'sym-elsewhere' },
    ]);

    expect(resolved[0]?.toSymbolId).toBe('sym-local');
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
  });

  it('resolves a recursive call to the declaration itself', () => {
    const { resolved } = resolveReferences([reference('walk', ['walk'])], [symbol('walk')], nothing);

    expect(resolved[0]?.fromSymbolId).toBe('sym-walk');
    expect(resolved[0]?.toSymbolId).toBe('sym-walk');
  });

  it('attributes a nested call to the method it sits inside — AC-7', () => {
    const declared = [symbol('Invoice'), symbol('Invoice.total'), symbol('applyTax')];

    const { resolved } = resolveReferences(
      [reference('applyTax', ['Invoice', 'total'])],
      declared,
      nothing,
    );

    expect(resolved[0]?.fromSymbolId).toBe('sym-Invoice.total');
  });
});

describe('resolving across the repository — AC-4', () => {
  it('resolves a uniquely named declaration elsewhere, at PROBABLE', () => {
    const { resolved } = resolveReferences([reference('applyTax', ['refund'])], [symbol('refund')], () => [
      { id: 'sym-remote' },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toSymbolId).toBe('sym-remote');
    expect(resolved[0]?.rule).toBe(ResolutionRule.UNIQUE_IN_REPOSITORY);
    // Lower than same-file, because this is an inference from the *absence* of a
    // homonym: one new file with the same function name changes the answer
    // without changing the code being read.
    expect(resolved[0]?.confidence).toBe(Confidence.PROBABLE);
    expect(Confidence.PROBABLE).toBeLessThan(Confidence.STRONG);
  });

  it('asks the repository once per distinct name, not once per reference', () => {
    let calls = 0;
    const lookup = (): readonly { id: string }[] => {
      calls += 1;
      return [{ id: 'sym-remote' }];
    };

    resolveReferences([reference('applyTax'), reference('applyTax'), reference('applyTax')], [], lookup);

    expect(calls).toBe(1);
  });
});

describe('what is not resolved is not guessed — AC-5, AC-6', () => {
  it('writes nothing for a name with two declarations in the repository — AC-5', () => {
    const { resolved, unresolved } = resolveReferences([reference('save')], [], () => [
      { id: 'sym-a' },
      { id: 'sym-b' },
    ]);

    expect(resolved).toStrictEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.AMBIGUOUS);
    expect(unresolved[0]?.candidates).toBe(2);
  });

  it('writes nothing for a name with two declarations in the same file — AC-5', () => {
    // An overload set, or a shadowing scope the outline flattens. Which one is
    // meant needs scoping this resolver does not model, so it says so.
    const { resolved, unresolved } = resolveReferences(
      [reference('handle')],
      [symbol('handle', 'sym-1'), symbol('handle', 'sym-2')],
      nothing,
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.AMBIGUOUS);
    expect(unresolved[0]?.candidates).toBe(2);
  });

  it('writes nothing for a name with no declaration — AC-6', () => {
    // An import, a built-in, another repository. Reported, not invented.
    const { resolved, unresolved } = resolveReferences([reference('fetch')], [], nothing);

    expect(resolved).toStrictEqual([]);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.NOT_FOUND);
    expect(unresolved[0]?.candidates).toBe(0);
  });

  it('keeps the reference itself on an unresolved entry, so it can be reported', () => {
    const { unresolved } = resolveReferences([reference('fetch', ['main'])], [], nothing);

    expect(unresolved[0]?.reference.name).toBe('fetch');
    expect(unresolved[0]?.reference.span.startLine).toBe(2);
  });
});

describe('a reference with no enclosing declaration — AC-7', () => {
  it('resolves with no source symbol, for the file to own', () => {
    const { resolved } = resolveReferences([reference('applyTax')], [symbol('applyTax')], nothing);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.fromSymbolId).toBeUndefined();
  });

  it('attributes to the file when the enclosing path names nothing indexed', () => {
    // A call inside a lambda the outline does not model. The file is the true
    // answer rather than the convenient one, and it is the same answer
    // top-level code gets.
    const { resolved } = resolveReferences(
      [reference('applyTax', ['someLambda'])],
      [symbol('applyTax')],
      nothing,
    );

    expect(resolved[0]?.fromSymbolId).toBeUndefined();
    expect(resolved[0]?.toSymbolId).toBe('sym-applyTax');
  });
});

describe('a degenerate input still resolves', () => {
  it('returns nothing for no references', () => {
    expect(resolveReferences([], [symbol('applyTax')], nothing)).toStrictEqual({
      resolved: [],
      unresolved: [],
    });
  });

  it('resolves nothing when the file declares nothing and the repository is empty', () => {
    const { resolved, unresolved } = resolveReferences([reference('anything')], [], nothing);

    expect(resolved).toStrictEqual([]);
    expect(unresolved).toHaveLength(1);
  });
});

describe('a member call does not reach the repository rule — AC-6a', () => {
  it('refuses a repository-unique name when the callee was a member access', () => {
    // Found by dogfooding, not by reasoning. Allowing this gave
    // `ProviderRegistry.has` 84 references on Ferret's own code — nearly all of
    // them `Map.has` — and `IdentityStore.resolve` 139, nearly all `path.resolve`.
    // A call graph that says `Map.has` is `ProviderRegistry.has` is not an
    // imperfect answer; it is a wrong one that reads as knowledge.
    const { resolved, unresolved } = resolveReferences([reference('has', [], true)], [], () => [
      { id: 'sym-registry-has' },
    ]);

    expect(resolved).toStrictEqual([]);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.RECEIVER_UNKNOWN);
  });

  it('still resolves a member call on `this` to a declaration in the same file', () => {
    // Bounded by the file, which is the case a language's own scoping makes
    // reasonable: `this.total()` in a class that declares `total`.
    //
    // **This test named the right case and did not test it — F-25.** It passed
    // no receiver, so what it actually asserted was that *any* member call
    // resolves to a same-file homonym — which is the defect. `map.has(k)` in a
    // file declaring `has` got an edge at STRONG, and on Ferret's own index all
    // eight inbound edges on `ProviderRegistry.has` were `Map`/`Set` calls. The
    // receiver is given now, so the assertion is the one the comment claimed.
    const { resolved } = resolveReferences(
      [reference('total', ['Invoice', 'render'], true, 'this')],
      [symbol('Invoice.total', 'sym-total'), symbol('Invoice.render', 'sym-render')],
      nothing,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.toSymbolId).toBe('sym-total');
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
  });

  it('refuses the same call on any other receiver', () => {
    // The half that was missing, and the reason the test above could pass while
    // the defect shipped: same file, same homonym, a receiver whose type Ferret
    // does not know.
    const { resolved, unresolved } = resolveReferences(
      [reference('total', ['Invoice', 'render'], true, 'line')],
      [symbol('Invoice.total', 'sym-total'), symbol('Invoice.render', 'sym-render')],
      nothing,
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.RECEIVER_UNKNOWN);
  });

  it('never asks the repository about a member call at all', () => {
    let asked = 0;
    resolveReferences([reference('has', [], true)], [], () => {
      asked += 1;
      return [];
    });

    expect(asked).toBe(0);
  });

  it('still resolves a bare identifier across the repository', () => {
    const { resolved } = resolveReferences([reference('applyTax', [], false)], [], () => [
      { id: 'sym-remote' },
    ]);

    expect(resolved[0]?.rule).toBe(ResolutionRule.UNIQUE_IN_REPOSITORY);
  });
});

describe('an imported name is declared elsewhere — AC-6c', () => {
  it('refuses the repository rule for a name the file imports', () => {
    // The sharper half of the dogfooding lesson: `describe(...)` in every test
    // file resolved to `ProviderRegistry.describe` — 111 references — because
    // that is the only `describe` Ferret *declares*, while every one of those
    // calls meant Vitest's. An import is the file saying where a name comes
    // from; preferring a homonym Ferret happens to hold is the opposite of
    // evidence-first.
    const { resolved, unresolved } = resolveReferences(
      [reference('describe')],
      [],
      () => [{ id: 'sym-registry-describe' }],
      new Set(['describe']),
    );

    expect(resolved).toStrictEqual([]);
    expect(unresolved[0]?.reason).toBe(UnresolvedReason.IMPORTED);
  });

  it('still resolves an imported name to a declaration in the same file', () => {
    // A file may import one name and declare another of the same name in a
    // different scope. The local declaration is what its own scoping means.
    const { resolved } = resolveReferences(
      [reference('helper')],
      [symbol('helper', 'sym-local')],
      () => [{ id: 'sym-remote' }],
      new Set(['helper']),
    );

    expect(resolved[0]?.toSymbolId).toBe('sym-local');
    expect(resolved[0]?.rule).toBe(ResolutionRule.SAME_FILE);
  });

  it('leaves a name the file does not import alone', () => {
    const { resolved } = resolveReferences([reference('applyTax')], [], () => [{ id: 'sym-remote' }], new Set(['other']));

    expect(resolved[0]?.rule).toBe(ResolutionRule.UNIQUE_IN_REPOSITORY);
  });
});
