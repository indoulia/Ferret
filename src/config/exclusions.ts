import picomatch from 'picomatch';
import { z } from 'zod';

/**
 * Exclusions.
 *
 * An exclusion says "do not index this, and do not return it" — it never says
 * "delete this". Governance §6 requires source evidence to keep its provenance
 * and forbids silently rewriting it, and EPIC-003's acceptance criteria state
 * the requirement directly: exclusions must be representable *without deleting
 * historical evidence*.
 *
 * That shapes the model in three ways:
 *
 * 1. Evaluation is a **pure decision**. {@link evaluateExclusion} returns which
 *    rule matched and why. Nothing here removes, rewrites or forgets anything;
 *    there is deliberately no code path that could.
 * 2. Every rule carries `effectiveFrom`, so a question about the past can be
 *    answered as it stood then rather than as policy stands now.
 * 3. Rules carry the scope and source they came from, so `ferret config` can
 *    explain *why* something was excluded rather than only *that* it was.
 *
 * EPIC-022 consumes this at discovery time, EPIC-058 at retrieval time, and
 * EPIC-088 owns retention — which is where actual deletion, if it is ever
 * wanted, has to be requested explicitly.
 */

/**
 * Where a rule came from, which is also its precedence.
 *
 * A narrower scope may add exclusions but never remove one a broader scope
 * imposed: a repository cannot un-exclude what the user excluded globally, and
 * a session cannot un-exclude what the repository excluded. Exclusion is
 * one-way, so a shared repository file cannot widen what Ferret indexes on
 * someone else's machine.
 */
export const ExclusionScope = {
  GLOBAL: 'global',
  REPOSITORY: 'repository',
  SESSION: 'session',
} as const;

export type ExclusionScope = (typeof ExclusionScope)[keyof typeof ExclusionScope];

export const exclusionRuleSchema = z.object({
  /** Glob pattern, matched against repository-relative POSIX paths. */
  pattern: z.string().min(1),
  scope: z.enum([ExclusionScope.GLOBAL, ExclusionScope.REPOSITORY, ExclusionScope.SESSION]).default(
    ExclusionScope.GLOBAL,
  ),
  /** Why the rule exists. Shown by `ferret config` and in query explanations. */
  reason: z.string().min(1).optional(),
  /**
   * When the rule started applying, as an ISO-8601 instant.
   *
   * Evidence indexed before this point is *retained* and remains addressable;
   * the rule governs indexing and retrieval from this instant onward. Omitted
   * means "has always applied".
   */
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
});

export type ExclusionRule = z.infer<typeof exclusionRuleSchema>;

/**
 * Accepts either the shorthand `"node_modules/**"` or the full rule object.
 *
 * The shorthand exists because Governance §2 caps ordinary setup at database
 * details plus optional exclusions — asking a user to write a JSON object to
 * skip a directory would breach that.
 */
export const exclusionInputSchema = z.union([z.string().min(1), exclusionRuleSchema]).transform(
  (value): ExclusionRule =>
    typeof value === 'string' ? { pattern: value, scope: ExclusionScope.GLOBAL } : value,
);

export interface ExclusionDecision {
  readonly excluded: boolean;
  /** The rule that decided it, when one did. */
  readonly rule: ExclusionRule | undefined;
}

/** Normalizes a path for matching so Windows and POSIX rules behave alike. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** `secrets/` must exclude, not silently match nothing: the expansion below turned it into `secrets//**`. */
function withoutTrailingSlash(pattern: string): string {
  const trimmed = pattern.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : pattern;
}

/**
 * Compiled matcher for one rule.
 *
 * A bare directory name such as `node_modules` is treated as "that directory
 * and everything under it", because that is what a user means by it. Requiring
 * `**\/node_modules/**` would be a configuration question Governance §2 says to
 * eliminate.
 */
function matcherFor(rule: ExclusionRule): (path: string) => boolean {
  const pattern = withoutTrailingSlash(normalizePath(rule.pattern));
  const patterns = /[*?[\]{}!]/.test(pattern)
    ? [pattern]
    : [pattern, `${pattern}/**`, `**/${pattern}`, `**/${pattern}/**`];
  return picomatch(patterns, { dot: true });
}

const compiled = new WeakMap<ExclusionRule, (path: string) => boolean>();

function match(rule: ExclusionRule, path: string): boolean {
  let matcher = compiled.get(rule);
  if (matcher === undefined) {
    matcher = matcherFor(rule);
    compiled.set(rule, matcher);
  }
  return matcher(path);
}

export interface EvaluateOptions {
  /**
   * The instant to evaluate at, for asking what policy was in force then.
   * Defaults to now. A rule whose `effectiveFrom` is later than this is not
   * applied, which is what keeps historical evidence answerable.
   */
  readonly at?: Date;
}

/**
 * Decides whether `path` is excluded, and by which rule.
 *
 * Pure: it reads rules and returns a decision. It cannot delete, rewrite or
 * hide anything by itself — a caller that wants to act on the decision does so
 * explicitly, which is what makes the non-destructive property auditable rather
 * than merely intended.
 */
export function evaluateExclusion(
  path: string,
  rules: readonly ExclusionRule[],
  options: EvaluateOptions = {},
): ExclusionDecision {
  const normalized = normalizePath(path);
  const at = options.at ?? new Date();

  for (const rule of rules) {
    if (rule.effectiveFrom !== undefined && new Date(rule.effectiveFrom) > at) continue;
    if (match(rule, normalized)) return { excluded: true, rule };
  }
  return { excluded: false, rule: undefined };
}

/** Convenience wrapper for callers that only need the verdict. */
export function isExcluded(
  path: string,
  rules: readonly ExclusionRule[],
  options: EvaluateOptions = {},
): boolean {
  return evaluateExclusion(path, rules, options).excluded;
}

/**
 * Merges rule sets from several sources, keeping every rule.
 *
 * Union rather than override: exclusion is additive across scopes, so a later
 * source can only ever exclude more. Duplicates by pattern *and* scope are
 * collapsed so a rule repeated in two files is not reported twice.
 */
export function mergeExclusions(...sets: ReadonlyArray<readonly ExclusionRule[]>): ExclusionRule[] {
  const seen = new Set<string>();
  const merged: ExclusionRule[] = [];
  for (const set of sets) {
    for (const rule of set) {
      const key = `${rule.scope}\u0000${normalizePath(rule.pattern)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(rule);
    }
  }
  return merged;
}

/**
 * Exclusions Ferret applies before any user configuration.
 *
 * These are not a performance optimization. `.git` holds object storage that is
 * meaningless as text; the rest are dependency and build trees whose contents
 * belong to their source repositories rather than to this one. Indexing them
 * would fill the knowledge base with content that is not the user's work.
 *
 * A user can add exclusions but cannot remove these, because exclusion is
 * one-way — see {@link ExclusionScope}.
 */
export const DEFAULT_EXCLUSIONS: readonly ExclusionRule[] = Object.freeze(
  [
    ['.git', 'Git internal object storage, not source content'],
    ['node_modules', 'Installed dependencies belong to their own repositories'],
    ['.venv', 'Python virtual environment'],
    ['__pycache__', 'Compiled Python bytecode'],
    ['dist', 'Build output, derived from source that is already indexed'],
    ['build', 'Build output, derived from source that is already indexed'],
    ['coverage', 'Generated coverage reports'],
    ['.next', 'Framework build cache'],
    ['target', 'Build output for JVM and Rust toolchains'],
    ['vendor', 'Vendored third-party source'],
  ].map(([pattern, reason]): ExclusionRule => ({
    pattern: pattern ?? '',
    scope: ExclusionScope.GLOBAL,
    reason: reason ?? '',
  })),
);
