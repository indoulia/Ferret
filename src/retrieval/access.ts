import {
  ScopeKind,
  evaluateScope,
  type CanonicalEntity,
  type ScopeContext,
  type ScopeSelector,
} from '../domain/index.js';
import { evaluateExclusion, type ExclusionRule } from '../config/index.js';

/**
 * Who may see what, evaluated before anything becomes a result — EPIC-058.
 *
 * Governance §12: "Authorization must be evaluated **before** protected
 * information enters retrieval results." Before this, Ferret had a permission
 * model (EPIC-008), a scope model (EPIC-009), an exclusion model (EPIC-003), one
 * working filter, and no enforcement:
 *
 * - `RetrievalPort` took no authorization parameter, so no caller *could* filter
 *   and no reviewer could see that one had not.
 * - `storage/retrieval.ts` selected `permission_scope` onto every evidence hit
 *   and never consulted it. Full-text search covers evidence statements, so a
 *   protected observation's content was matched and returned verbatim.
 * - `EvidenceStore.forSubject` filtered correctly and had no caller doing so.
 *   Three Epics threaded the parameter through their contracts and every one
 *   passed nothing.
 *
 * The fix is one value, required everywhere. `AccessContext` is a **parameter**
 * rather than a default, because a default is a thing you forget and a required
 * parameter is a compile error.
 *
 * **Where it comes from matters as much as what it says.** The context is built
 * from configuration — registered, trusted input. Never from tool input, never
 * from an evidence statement, never from a file that declares itself public.
 * Governance §12: repository content is data, never policy.
 */

export interface AccessContext {
  /**
   * Permission scope tokens the caller holds.
   *
   * Empty means the caller sees unscoped content and nothing else — the
   * default-deny half of the contract. Opaque: Ferret compares these, and does
   * not parse them into groups or roles (`Checkpoints/EPIC-008.md:128`). Turning
   * a token into a membership decision is EPIC-083.
   */
  readonly permittedScopes: readonly string[];
  /**
   * Which repositories, worktrees and sessions the caller may see — EPIC-009.
   *
   * An empty `include` means everything, which is that model's documented and
   * deliberate default: "a caller that forgets to configure inclusion sees
   * everything they are otherwise entitled to, rather than silently seeing
   * nothing and concluding the index is empty."
   */
  readonly scope: ScopeSelector;
  /**
   * Paths excluded from answers — EPIC-003 D-003, which assigns retrieval-time
   * application here.
   *
   * EPIC-022 already excludes at discovery, so this catches a rule added *after*
   * something was indexed. That case is the reason EPIC-003 made exclusion
   * incapable of deletion: the rule takes effect without erasing history.
   */
  readonly exclusions: readonly ExclusionRule[];
  /**
   * Apply the rules as they stood at this instant.
   *
   * `effectiveFrom` on an exclusion exists so a question about the past can be
   * answered as policy stood then rather than having the answer retroactively
   * erased (EPIC-003 D-003).
   */
  readonly at?: string | undefined;
}

/**
 * The view a caller holding no permission scope gets.
 *
 * Unscoped content, everything in scope, nothing excluded. Named rather than
 * implied so that a caller meaning "no restriction beyond the default" says so
 * in code a reviewer can grep for — which is the difference between an audited
 * decision and a forgotten one.
 *
 * There is deliberately **no** `UNRESTRICTED_ACCESS`. A caller who needs to see
 * scoped content names the scope; a constant that saw everything would be the
 * opt-out this Epic exists to remove.
 */
export const PUBLIC_ACCESS: AccessContext = Object.freeze({
  permittedScopes: Object.freeze([]),
  scope: Object.freeze({ include: [], exclude: [] }),
  exclusions: Object.freeze([]),
  at: undefined,
});

/** Why something a caller asked about is not in the answer. */
export const WithholdReason = {
  /** It carries a permission scope the caller does not hold. */
  PERMISSION: 'permission',
  /** It sits outside the caller's scope selector. */
  SCOPE: 'scope',
  /** An exclusion rule covers its path. */
  EXCLUSION: 'exclusion',
} as const;

export type WithholdReason = (typeof WithholdReason)[keyof typeof WithholdReason];

/**
 * How much was withheld, and by which mechanism.
 *
 * **Counts only.** No id, no kind, no path, no source system, no rule. A count
 * says an answer is partial; anything more would answer the question the filter
 * exists to refuse.
 *
 * That it discloses anything at all is a decision rather than a finding — see
 * the specification §16. Silent filtering was rejected because an answer that is
 * quietly short is the failure mode every honesty contract in Ferret exists to
 * prevent.
 */
export interface WithheldReport {
  readonly total: number;
  readonly byReason: Readonly<Partial<Record<WithholdReason, number>>>;
}

export const NOTHING_WITHHELD: WithheldReport = Object.freeze({
  total: 0,
  byReason: Object.freeze({}),
});

/** Accumulates withheld counts without ever holding what was withheld. */
export class WithheldTally {
  #total = 0;
  readonly #byReason = new Map<WithholdReason, number>();

  add(reason: WithholdReason, count = 1): void {
    if (count <= 0) return;
    this.#total += count;
    this.#byReason.set(reason, (this.#byReason.get(reason) ?? 0) + count);
  }

  get report(): WithheldReport {
    if (this.#total === 0) return NOTHING_WITHHELD;
    const byReason: Partial<Record<WithholdReason, number>> = {};
    // Sorted so two runs over the same result compare equal.
    for (const reason of [...this.#byReason.keys()].sort()) {
      byReason[reason] = this.#byReason.get(reason);
    }
    return Object.freeze({ total: this.#total, byReason: Object.freeze(byReason) });
  }
}

/**
 * True when the caller may see something carrying this permission scope.
 *
 * `undefined` — unscoped — is visible to everyone. Everything Ferret indexes
 * today is unscoped, and a default that hid it would be a different product
 * rather than a safer one. A provider that sets a scope is protected from the
 * moment it does, without anyone remembering to configure anything.
 */
export function permits(access: AccessContext, permissionScope: string | undefined): boolean {
  if (permissionScope === undefined) return true;
  return access.permittedScopes.some((grant) => scopeGrants(grant, permissionScope));
}

/**
 * The separator between the segments of a permission scope.
 *
 * Chosen because it is what the scopes already written use — `jira:restricted-team`
 * in EPIC-058's own fixture — rather than introduced here.
 */
export const SCOPE_SEPARATOR = ':';

/**
 * Whether holding `grant` lets a caller see something scoped `scope` — EPIC-083.
 *
 * Until now a scope was an opaque token compared by string equality
 * (`Checkpoints/EPIC-008.md:128`), and four records park deciding what one *means*
 * here. This is that decision, and it is deliberately the smallest one that is
 * useful: a scope is a `:`-separated path, and a grant covers itself and its
 * descendants. `jira:proj-a` grants `jira:proj-a:issue-1`.
 *
 * **Segment-wise, never a substring.** `jira:proj-a` must not grant
 * `jira:proj-ab`, which is what a bare `startsWith` would do — a silent
 * over-grant, and the failure mode of every prefix-matching authorization bug
 * there has ever been. The separator is required, so a descendant is a descendant
 * and a sibling with a longer name is not.
 *
 * **Total, and denying on anything it does not understand.** No throw: this runs
 * per row on the read path, and EPIC-058 already learned that failing loudly
 * there turns a policy typo into an unusable index (`withholds` fails closed per
 * row for the same reason). An empty grant is denied rather than treated as a
 * wildcard — `'' + ':'` is a prefix of everything, and a blank line in a config
 * file must not become root access.
 *
 * Pure: no clock, no I/O, same answer every time. The SQL predicates in
 * `storage/` implement this same rule and are tested against it, because a
 * membership decision that differs between the filter and the checker is two
 * decisions.
 */
export function scopeDescendantPattern(grant: string): string {
  // `%` and `_` are LIKE wildcards and `\` is its escape character, so a grant
  // containing one would otherwise match more than it names — the same
  // caller-controlled-pattern hazard `storage/retrieval.ts` already guards for
  // abbreviated object ids. The value is still bound as a parameter; escaping is
  // what makes the *pattern* mean what the grant says.
  const escaped = grant.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `${escaped}${SCOPE_SEPARATOR}%`;
}

export function scopeGrants(grant: string, scope: string): boolean {
  if (typeof grant !== 'string' || typeof scope !== 'string') return false;
  if (grant.length === 0 || scope.length === 0) return false;
  if (grant === scope) return true;
  return scope.startsWith(grant + SCOPE_SEPARATOR);
}

/**
 * Why an entity is not visible, or `undefined` when it is.
 *
 * Two dimensions, both from Epics that already own them. The scope selector is
 * evaluated by EPIC-009's `evaluateScope`, so include/exclude precedence is that
 * model's rule rather than a second copy of it here. The path is evaluated by
 * EPIC-003's `evaluateExclusion`, likewise.
 *
 * Returns a *reason* rather than a boolean so the tally can say which mechanism
 * shortened an answer — which is what makes "why is this answer short"
 * answerable without making "what am I not allowed to see" answerable.
 */
export function withholds(access: AccessContext, entity: CanonicalEntity): WithholdReason | undefined {
  // Fail closed, and never throw.
  //
  // `evaluateScope` and `evaluateExclusion` both reject malformed input, which is
  // right — but this runs per row on the answer path, and a policy Ferret cannot
  // evaluate must not turn every query into an error. It must withhold. Found by
  // the integration test: a selector naming a repository whose id was not yet
  // resolved made every read throw instead of returning nothing.
  //
  // A policy that cannot be read is loud at *composition* — see
  // {@link assertUsableAccess}, which the composition root calls once — and
  // conservative here.
  try {
    const evaluation = evaluateScope(scopeContextFor(entity), access.scope);
    if (evaluation.decision === 'excluded') return WithholdReason.SCOPE;
  } catch {
    return WithholdReason.SCOPE;
  }

  const path = entity.attributes['path'];
  if (typeof path === 'string' && path.length > 0) {
    try {
      const decision = evaluateExclusion(path, access.exclusions, {
        ...(access.at === undefined ? {} : { at: new Date(access.at) }),
      });
      if (decision.excluded) return WithholdReason.EXCLUSION;
    } catch {
      return WithholdReason.EXCLUSION;
    }
  }

  return undefined;
}

/**
 * Rejects a policy Ferret cannot evaluate, at the point it is composed.
 *
 * The other half of the rule above. Failing closed on every row keeps a bad
 * policy from leaking, and would keep it from being *noticed* — an operator
 * whose selector has a typo would see an empty index and conclude Ferret was
 * broken rather than that their configuration was. Called once by the
 * composition root, where a `FerretError` reaches a person who can fix it.
 *
 * @throws {FerretError} when the scope selector is not valid.
 */
export function assertUsableAccess(access: AccessContext): void {
  // Evaluated against an empty context, which exercises parsing without
  // depending on any entity.
  evaluateScope({}, access.scope);
}

/**
 * Which scopes an entity sits in.
 *
 * `source.scope` is EPIC-006's scoping identity — the repository a file was
 * discovered in, say. Worktree and session are absent because an entity does not
 * carry them: a *session* scope constrains what a caller is asking on behalf of,
 * and EPIC-009's evaluator treats an absent dimension as unconstrained, which is
 * the honest reading. Narrowing by session belongs to whatever knows the session.
 */
function scopeContextFor(entity: CanonicalEntity): ScopeContext {
  const scope = entity.source.scope;
  return scope === undefined ? {} : { repositoryId: scope };
}

/**
 * Filters entities and tallies what went, without describing any of it.
 *
 * Applied in the core rather than in SQL because glob matching is not SQL —
 * `evaluateExclusion` uses picomatch. Bounded by the page already fetched, and
 * small by construction: EPIC-022 excludes at discovery, so this catches only
 * rules added afterwards.
 */
export function visibleEntities<T>(
  items: readonly T[],
  entityOf: (item: T) => CanonicalEntity,
  access: AccessContext,
  tally: WithheldTally,
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const reason = withholds(access, entityOf(item));
    if (reason === undefined) {
      kept.push(item);
      continue;
    }
    tally.add(reason);
  }
  return kept;
}

/** True when this context could hide something, and a count is worth computing. */
export function restricts(access: AccessContext): boolean {
  return (
    access.exclusions.length > 0 ||
    (access.scope.include ?? []).length > 0 ||
    (access.scope.exclude ?? []).length > 0
  );
}

/** Scope ids the caller is restricted to, when the selector names repositories. */
export function includedRepositories(access: AccessContext): readonly string[] {
  return (access.scope.include ?? [])
    .filter((scope) => scope.kind === ScopeKind.REPOSITORY && scope.id !== undefined)
    .map((scope) => scope.id as string);
}
