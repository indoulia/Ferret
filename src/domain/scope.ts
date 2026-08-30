import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * Scopes.
 *
 * A scope names *where* something applies: everywhere, within one repository,
 * within one worktree, or within one session. EPIC-009 requires repository and
 * session scopes to be includable and excludable **independently**, which is the
 * constraint that shapes the model.
 *
 * Independent means the dimensions are evaluated separately and then combined,
 * not flattened into one list. "Everything in repository A, except during
 * session S" is a coherent instruction, and a model that put repositories and
 * sessions in the same ordered list could only express it by accident of
 * ordering.
 */

export const ScopeKind = {
  /** Applies everywhere. */
  GLOBAL: 'global',
  REPOSITORY: 'repository',
  /**
   * A specific checkout.
   *
   * Distinct from `repository` and from a branch: Governance §9 forbids
   * conflating worktree identity with branch identity, and a rule that applied
   * to "the branch" would apply in every worktree that has it checked out.
   */
  WORKTREE: 'worktree',
  SESSION: 'session',
} as const;

export type ScopeKind = (typeof ScopeKind)[keyof typeof ScopeKind];

export const SCOPE_KINDS: readonly ScopeKind[] = Object.freeze(Object.values(ScopeKind));

export const scopeSchema = z
  .object({
    kind: z.enum(SCOPE_KINDS as [ScopeKind, ...ScopeKind[]]),
    /** Canonical id of the repository, worktree or session. Absent for global. */
    id: z.string().min(1).optional(),
  })
  .strict()
  .refine((scope) => scope.kind === ScopeKind.GLOBAL || scope.id !== undefined, {
    message: 'A non-global scope must name the entity it applies to',
  });

export type Scope = z.infer<typeof scopeSchema>;

export const GLOBAL_SCOPE: Scope = Object.freeze({ kind: ScopeKind.GLOBAL });

/**
 * What a selector includes and excludes.
 *
 * An empty `include` means "everything", which is the safe default for a
 * selector used to *filter*: a caller that forgets to configure inclusion sees
 * everything they are otherwise entitled to, rather than silently seeing
 * nothing and concluding the index is empty.
 *
 * `exclude` always wins. Exclusion is the direction that protects, and a rule
 * that could be overridden by a broader inclusion would not be a protection.
 */
export const scopeSelectorSchema = z
  .object({
    include: z.array(scopeSchema).default([]),
    exclude: z.array(scopeSchema).default([]),
  })
  .strict();

export type ScopeSelector = z.input<typeof scopeSelectorSchema>;

/** The scopes something actually sits in, which may be several at once. */
export const scopeContextSchema = z
  .object({
    repositoryId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

export type ScopeContext = z.infer<typeof scopeContextSchema>;

export const ScopeDecision = {
  INCLUDED: 'included',
  EXCLUDED: 'excluded',
} as const;

export type ScopeDecision = (typeof ScopeDecision)[keyof typeof ScopeDecision];

export interface ScopeEvaluation {
  readonly decision: ScopeDecision;
  /** The rule that decided it, when one did. */
  readonly rule: Scope | undefined;
  /** Which dimension decided: `repository`, `session`, `worktree`, or `global`. */
  readonly dimension: ScopeKind | undefined;
}

function idFor(context: ScopeContext, kind: ScopeKind): string | undefined {
  switch (kind) {
    case ScopeKind.REPOSITORY:
      return context.repositoryId;
    case ScopeKind.WORKTREE:
      return context.worktreeId;
    case ScopeKind.SESSION:
      return context.sessionId;
    default:
      return undefined;
  }
}

function matches(scope: Scope, context: ScopeContext): boolean {
  if (scope.kind === ScopeKind.GLOBAL) return true;
  const actual = idFor(context, scope.kind);
  return actual !== undefined && actual === scope.id;
}

/**
 * Decides whether a context falls within a selector.
 *
 * Exclusion is checked first and wins outright. Inclusion is then satisfied by
 * *any* matching rule, and by everything when no inclusion rule is given.
 *
 * Pure, and returns which rule decided — Governance §18 requires Ferret to be
 * able to explain why something was included or excluded, and a bare boolean
 * cannot.
 */
export function evaluateScope(context: ScopeContext, selector: ScopeSelector): ScopeEvaluation {
  const parsed = scopeSelectorSchema.safeParse(selector);
  if (!parsed.success) {
    throw new FerretError(ErrorCode.CONFIG_INVALID, 'Scope selector is not valid', {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.') })) },
      remediation: 'A non-global scope must name the entity it applies to.',
    });
  }

  for (const rule of parsed.data.exclude) {
    if (matches(rule, context)) {
      return { decision: ScopeDecision.EXCLUDED, rule, dimension: rule.kind };
    }
  }

  if (parsed.data.include.length === 0) {
    return { decision: ScopeDecision.INCLUDED, rule: undefined, dimension: undefined };
  }

  for (const rule of parsed.data.include) {
    if (matches(rule, context)) {
      return { decision: ScopeDecision.INCLUDED, rule, dimension: rule.kind };
    }
  }

  return { decision: ScopeDecision.EXCLUDED, rule: undefined, dimension: undefined };
}

/** Convenience for callers that only need the verdict. */
export function isInScope(context: ScopeContext, selector: ScopeSelector): boolean {
  return evaluateScope(context, selector).decision === ScopeDecision.INCLUDED;
}

/**
 * Combines selectors so that every exclusion survives.
 *
 * Used when a user's selector meets a repository's, or a session's meets both.
 * Inclusions union — a broader scope may add — but exclusions accumulate, so no
 * layer can widen what a narrower one refused. Same one-way rule as EPIC-003's
 * exclusions, and for the same reason: exclusion is the direction that protects.
 */
export function mergeSelectors(...selectors: readonly ScopeSelector[]): ScopeSelector {
  const include: Scope[] = [];
  const exclude: Scope[] = [];
  const seen = new Set<string>();

  for (const selector of selectors) {
    const parsed = scopeSelectorSchema.parse(selector);
    for (const rule of parsed.include) {
      const key = `i ${rule.kind} ${rule.id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      include.push(rule);
    }
    for (const rule of parsed.exclude) {
      const key = `e ${rule.kind} ${rule.id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      exclude.push(rule);
    }
  }

  return { include, exclude };
}

/**
 * True when the selector constrains a dimension at all.
 *
 * Lets a caller distinguish "this selector says nothing about sessions" from
 * "this selector excludes every session", which are different answers and
 * different bugs.
 */
export function constrains(selector: ScopeSelector, kind: ScopeKind): boolean {
  const parsed = scopeSelectorSchema.parse(selector);
  return [...parsed.include, ...parsed.exclude].some((rule) => rule.kind === kind);
}
