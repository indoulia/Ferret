import { Confidence } from '../domain/index.js';
import type { CodeReference } from '../providers/contracts/parser.js';

import type { CodeSymbol } from './symbols.js';

/**
 * Resolving a name a file uses to the declaration it means — EPIC-035.
 *
 * Four Epics deferred this and one issue is parked on it: `findSymbols` could
 * answer "where is this defined" and nothing could answer "where is it used".
 *
 * **Name-based, and unambiguous-only.** Ferret has no type checker, so
 * `a.save()` is a reference to the name `save` and nothing more. Where a name
 * has one plausible declaration this resolves it and records which rule
 * concluded that; where it has two, it resolves **nothing**. An edge asserting
 * one of two possibilities is manufacturing certainty, and a wrong call graph is
 * worse than an absent one because it reads as knowledge.
 *
 * Pure. The repository-wide lookup is a function the caller supplies, so this
 * module needs no store and can be tested on paper.
 */

/** How a reference was resolved. */
export const ResolutionRule = {
  /** A declaration with that name in the same file. */
  SAME_FILE: 'same-file',
  /** Exactly one declaration with that name in the repository. */
  UNIQUE_IN_REPOSITORY: 'unique-in-repository',
} as const;

export type ResolutionRule = (typeof ResolutionRule)[keyof typeof ResolutionRule];

/**
 * What each rule is worth — EPIC-046's bands, not new numbers.
 *
 * `same-file` outranks `unique-in-repository` because a language's own scoping
 * makes the first nearly certain, while the second is an inference from the
 * *absence* of a homonym — and one new file with the same function name would
 * change the answer without changing the code being read.
 */
export const RULE_CONFIDENCE: Readonly<Record<ResolutionRule, number>> = Object.freeze({
  [ResolutionRule.SAME_FILE]: Confidence.STRONG,
  [ResolutionRule.UNIQUE_IN_REPOSITORY]: Confidence.PROBABLE,
});

/** Why a reference was left unresolved. Counted and reported, never guessed at. */
export const UnresolvedReason = {
  /** Two or more declarations carry the name. */
  AMBIGUOUS: 'ambiguous',
  /** No declaration carries it — an import, a built-in, another repository. */
  NOT_FOUND: 'not-found',
  /**
   * A member call whose receiver's type Ferret does not know.
   *
   * `map.has(x)` names `has`, and which `has` it means depends on what `map` is.
   * Found by dogfooding: allowing the repository rule here gave
   * `ProviderRegistry.has` 84 references on Ferret's own code, nearly all of
   * them `Map.has`. §8.3 refuses the inference rather than publishing a call
   * graph that reads as knowledge and is wrong.
   */
  RECEIVER_UNKNOWN: 'receiver-unknown',
  /**
   * The file imports the name, so it is declared somewhere else.
   *
   * Found by dogfooding, and it is the sharper half of the same lesson as
   * `receiver-unknown`: `describe(...)` in every test file resolved to
   * `ProviderRegistry.describe` — 111 references — because that is the only
   * `describe` Ferret *declares*, while every one of those calls meant Vitest's.
   * An import is the file saying where a name comes from, and ignoring it to
   * prefer a homonym Ferret happens to hold is the opposite of evidence-first.
   */
  IMPORTED: 'imported',
} as const;

export type UnresolvedReason = (typeof UnresolvedReason)[keyof typeof UnresolvedReason];

export interface ResolvedReference {
  readonly reference: CodeReference;
  /**
   * The symbol the reference sits inside, or `undefined` for top-level code.
   *
   * `undefined` is attributed to the *file* by the caller — EPIC-035 §8.2 —
   * rather than dropped, because a top-level call is still a use.
   */
  readonly fromSymbolId: string | undefined;
  readonly toSymbolId: string;
  readonly rule: ResolutionRule;
  readonly confidence: number;
}

export interface UnresolvedReference {
  readonly reference: CodeReference;
  readonly reason: UnresolvedReason;
  /** How many declarations carried the name. `0` for `not-found`. */
  readonly candidates: number;
}

export interface ReferenceResolution {
  readonly resolved: readonly ResolvedReference[];
  readonly unresolved: readonly UnresolvedReference[];
}

/** A declaration a repository-wide lookup can return. */
export interface SymbolCandidate {
  readonly id: string;
}

/**
 * Receivers whose type Ferret knows.
 *
 * `this` and `self` name the enclosing declaration, which is the one type this
 * resolver has without a type checker. `cls` is deliberately absent: a Python
 * classmethod's `cls` is the class *or a subclass of it*, and resolving it to
 * the enclosing declaration would be the guess this module refuses.
 */
const SELF_RECEIVERS: ReadonlySet<string> = new Set(['this', 'self']);

/**
 * The member of the enclosing declaration a `this.x()` call means — F-25.
 *
 * `undefined` for every other receiver, which is what leaves a member call
 * unresolved. Three conditions, all required: the receiver is exactly `this` or
 * `self` (not `this.items`, which is a different object of a type Ferret does
 * not know), the reference sits inside a declaration that has an owner, and the
 * owner declares this name in this file.
 */
function selfMemberTarget(
  reference: CodeReference,
  byQualifiedName: ReadonlyMap<string, CodeSymbol>,
): CodeSymbol | undefined {
  const receiver = reference.receiver;
  if (receiver === undefined || !SELF_RECEIVERS.has(receiver)) return undefined;
  // The declaration containing the call, minus the call's own frame: for
  // `Registry.check` the owner is `Registry`. Top-level code has no owner, and
  // `this` there is not the enclosing declaration.
  if (reference.enclosing.length < 2) return undefined;
  const owner = reference.enclosing.slice(0, -1).join('.');
  return byQualifiedName.get(`${owner}.${reference.name}`);
}

/**
 * Resolves a file's references.
 *
 * `declaredHere` is the symbols this file declares — the same list
 * `buildCodeSymbols` produced, so `enclosing` matches a `qualifiedName` by
 * construction rather than by a second convention. `candidatesFor` answers
 * "which declarations in this repository carry this name", and is consulted only
 * when the file itself cannot answer.
 */
export function resolveReferences(
  references: readonly CodeReference[],
  declaredHere: readonly CodeSymbol[],
  candidatesFor: (name: string) => readonly SymbolCandidate[],
  imported: ReadonlySet<string> = new Set(),
): ReferenceResolution {
  const byQualifiedName = new Map(declaredHere.map((symbol) => [symbol.qualifiedName, symbol]));
  const localByName = new Map<string, CodeSymbol[]>();
  for (const symbol of declaredHere) {
    const list = localByName.get(symbol.name) ?? [];
    list.push(symbol);
    localByName.set(symbol.name, list);
  }

  const resolved: ResolvedReference[] = [];
  const unresolved: UnresolvedReference[] = [];
  // One lookup per distinct name per file, not one per reference — §13.
  const repositoryCache = new Map<string, readonly SymbolCandidate[]>();

  for (const reference of references) {
    // The declaration the reference sits inside. An `enclosing` path naming a
    // declaration this file did not produce — a call inside a lambda the outline
    // does not model — attributes to the file, which is the same answer
    // top-level code gets and is true rather than convenient.
    const from = byQualifiedName.get(reference.enclosing.join('.'));
    const fromSymbolId = from?.id;

    // §8.3, and F-25. A member call is scoped by the receiver's type, and the
    // guard for that sat in front of the *repository* rule only — so the
    // `same-file` rule below ran first and resolved `map.has(k)` to whatever
    // `has` the file happened to declare, at the highest confidence band this
    // resolver has. Measured on Ferret's own index before the fix:
    // `ProviderRegistry.has` had eight inbound edges, every one
    // `rule: "same-file"`, and every one a `Map`/`Set` `.has()` call on a
    // private field.
    //
    // A check rather than a blanket refusal, because `this.helper()` is a real
    // edge and is most of what a call graph inside a class *is*. `this` and
    // `self` are the receivers whose type Ferret knows — it is the enclosing
    // declaration — so those corroborate, and nothing else does.
    if (reference.qualified) {
      const target = selfMemberTarget(reference, byQualifiedName);
      if (target === undefined) {
        unresolved.push({ reference, reason: UnresolvedReason.RECEIVER_UNKNOWN, candidates: 0 });
        continue;
      }
      // Resolved to *that* member, not to whatever the file's only `has` is.
      // Going through the by-name lookup below would call a file holding
      // `Registry.has` and `Cache.has` ambiguous, when `this.has()` inside
      // `Registry.check` is not ambiguous at all.
      resolved.push({
        reference,
        fromSymbolId,
        toSymbolId: target.id,
        rule: ResolutionRule.SAME_FILE,
        confidence: RULE_CONFIDENCE[ResolutionRule.SAME_FILE],
      });
      continue;
    }

    const local = localByName.get(reference.name) ?? [];
    if (local.length === 1) {
      const target = local[0];
      if (target !== undefined) {
        resolved.push({
          reference,
          fromSymbolId,
          toSymbolId: target.id,
          rule: ResolutionRule.SAME_FILE,
          confidence: RULE_CONFIDENCE[ResolutionRule.SAME_FILE],
        });
        continue;
      }
    }
    if (local.length > 1) {
      // Two declarations of one name in one file — an overload set, or a
      // shadowing scope the outline flattens. Which one is meant needs scoping
      // this resolver does not model, so it says so.
      unresolved.push({ reference, reason: UnresolvedReason.AMBIGUOUS, candidates: local.length });
      continue;
    }

    // §8.3. An imported name is declared elsewhere — the file said so. It may
    // still resolve `same-file` above (a file can import one name and declare
    // another of the same name in a different scope), but it never reaches the
    // repository rule.
    if (imported.has(reference.name)) {
      unresolved.push({ reference, reason: UnresolvedReason.IMPORTED, candidates: 0 });
      continue;
    }

    // §8.3's guard against the repository rule used to sit here. It has moved
    // *above* the same-file rule, which is F-25: placed here it never ran,
    // because a member call that matched a same-file homonym had already
    // resolved. Every qualified reference now leaves the loop before this
    // point, so a second copy here would be dead code claiming to be a control.

    const candidates = repositoryCache.get(reference.name) ?? candidatesFor(reference.name);
    repositoryCache.set(reference.name, candidates);

    if (candidates.length === 1) {
      const target = candidates[0];
      if (target !== undefined) {
        resolved.push({
          reference,
          fromSymbolId,
          toSymbolId: target.id,
          rule: ResolutionRule.UNIQUE_IN_REPOSITORY,
          confidence: RULE_CONFIDENCE[ResolutionRule.UNIQUE_IN_REPOSITORY],
        });
        continue;
      }
    }

    unresolved.push({
      reference,
      reason: candidates.length === 0 ? UnresolvedReason.NOT_FOUND : UnresolvedReason.AMBIGUOUS,
      candidates: candidates.length,
    });
  }

  return { resolved, unresolved };
}

/**
 * How much of one file's code Ferret resolved — F-27.
 *
 * The subset of {@link ReferenceCounts} that belongs on the `file` entity: what
 * was found, what became an edge, and what was refused and why. The rule and
 * evidence counters stay in the run report, because they are about the indexer
 * rather than about the file.
 */
export interface FileReferenceResolution {
  readonly extracted: number;
  readonly resolved: number;
  readonly unresolved: Readonly<Record<string, number>>;
}
