import { describe, expect, it } from 'vitest';

import {
  NOTHING_WITHHELD,
  PUBLIC_ACCESS,
  ScopeKind,
  WithheldTally,
  WithholdReason,
  assertUsableAccess,
  includedRepositories,
  permits,
  restricts,
  visibleEntities,
  withholds,
  type AccessContext,
  type CanonicalEntity,
} from '../../src/index.js';

/**
 * Who may see what — EPIC-058, without a database.
 *
 * Governance §12: "Authorization must be evaluated **before** protected
 * information enters retrieval results." Before this Epic, Ferret had a
 * permission model, a scope model, an exclusion model, one working filter, and
 * no enforcement — `RetrievalPort` took no authorization parameter at all, so no
 * caller *could* filter and no reviewer could see that one had not.
 *
 * The evaluation is pure, which is what these tests exercise. The SQL half — a
 * protected row never being read — needs a real PostgreSQL and is proved in
 * `tests/integration/retrieval/permission.test.ts`, because a mock cannot
 * demonstrate that a row was not fetched.
 *
 * Two properties carry the Epic and both are refusals:
 *
 * - **Scoped content is denied by default.** A caller holding nothing sees
 *   unscoped content and nothing else.
 * - **What was withheld is counted, never described.** A count says an answer is
 *   short; anything more answers the question the filter exists to refuse.
 */

function entity(overrides: {
  readonly id?: string;
  readonly scope?: string;
  readonly path?: string;
}): CanonicalEntity {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111';
  return Object.freeze({
    id,
    kind: 'file',
    canonicalKey: `key-${id}`,
    schemaVersion: 1,
    source: Object.freeze({
      system: 'git',
      id: overrides.path ?? 'src/main.ts',
      ...(overrides.scope === undefined ? {} : { scope: overrides.scope }),
    }),
    lifecycle: 'active',
    attributes: Object.freeze(overrides.path === undefined ? {} : { path: overrides.path }),
    unknownFields: Object.freeze({}),
    externalIds: Object.freeze([]),
    sourceObservedAt: undefined,
    contentHash: `hash-${id}`,
  });
}

function access(overrides: Partial<AccessContext> = {}): AccessContext {
  return { ...PUBLIC_ACCESS, ...overrides };
}

describe('permission scopes', () => {
  it('shows unscoped content to a caller holding nothing — AC-4', () => {
    // Everything Ferret indexes today is unscoped. A default that hid it would
    // be a different product rather than a safer one.
    expect(permits(PUBLIC_ACCESS, undefined)).toBe(true);
  });

  it('hides scoped content from a caller holding nothing — AC-2', () => {
    // Default-deny, and the reason it is safe: nothing is scoped today, so a
    // provider that sets a scope is protected from the moment it does, without
    // anyone remembering to configure anything.
    expect(permits(PUBLIC_ACCESS, 'jira:restricted')).toBe(false);
  });

  it('shows scoped content to a caller holding that scope — AC-3', () => {
    // The assertion that makes the previous one mean something. A filter that
    // hides everything is not a filter.
    expect(permits(access({ permittedScopes: ['jira:restricted'] }), 'jira:restricted')).toBe(true);
  });

  it('does not treat one scope as another', () => {
    const held = access({ permittedScopes: ['jira:team-a'] });
    expect(permits(held, 'jira:team-b')).toBe(false);
    // Not a prefix match, not a hierarchy. The token is opaque
    // (`Checkpoints/EPIC-008.md:128`); turning it into a membership decision is
    // EPIC-083, and guessing at one here would be inventing a policy.
    expect(permits(held, 'jira:team-a:sub')).toBe(false);
  });
});

describe('scope selectors', () => {
  it('shows everything when nothing is included — AC-6 boundary', () => {
    // EPIC-009's documented default, quoted in that model: "a caller that
    // forgets to configure inclusion sees everything they are otherwise entitled
    // to, rather than silently seeing nothing and concluding the index is empty."
    expect(withholds(PUBLIC_ACCESS, entity({ scope: 'repo-a' }))).toBeUndefined();
  });

  it('hides an entity outside the included repositories — AC-6', () => {
    const restricted = access({
      scope: { include: [{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }], exclude: [] },
    });

    expect(withholds(restricted, entity({ scope: 'repo-a' }))).toBeUndefined();
    expect(withholds(restricted, entity({ id: OTHER, scope: 'repo-b' }))).toBe(WithholdReason.SCOPE);
  });

  it('lets exclusion beat inclusion — AC-7', () => {
    // EPIC-009's rule, not a new one: "exclusion is the direction that protects,
    // and a rule that could be overridden by a broader inclusion would not be a
    // protection."
    const both = access({
      scope: {
        include: [{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }],
        exclude: [{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }],
      },
    });

    expect(withholds(both, entity({ scope: 'repo-a' }))).toBe(WithholdReason.SCOPE);
  });

  it('reports which repositories a selector narrows to, for the SQL predicate', () => {
    const narrowed = access({
      scope: {
        include: [
          { kind: ScopeKind.REPOSITORY, id: 'repo-a' },
          { kind: ScopeKind.SESSION, id: 'session-1' },
        ],
        exclude: [],
      },
    });

    // Only the repository dimension is expressible in SQL; the rest is evaluated
    // by EPIC-009's own evaluator in the core, so include/exclude precedence
    // stays that model's rule rather than becoming a second copy of it.
    expect(includedRepositories(narrowed)).toStrictEqual(['repo-a']);
  });
});

describe('path exclusions at retrieval time', () => {
  // EPIC-003 D-003 assigns this here: "EPIC-022 consumes this at discovery time
  // and EPIC-058 at retrieval time." A rule added *after* something was indexed
  // is the case EPIC-003 made exclusion incapable of deletion for.

  it('hides an indexed path a rule now excludes — AC-8', () => {
    const excluded = access({ exclusions: [{ pattern: '**/*.env', scope: 'global' }] });

    expect(withholds(excluded, entity({ path: 'config/prod.env' }))).toBe(WithholdReason.EXCLUSION);
    expect(withholds(excluded, entity({ id: OTHER, path: 'src/main.ts' }))).toBeUndefined();
  });

  it('applies the rules in force at the instant asked about — AC-9', () => {
    // `effectiveFrom` is what lets a question about the past be answered as
    // policy stood then, instead of retroactively erasing the answer.
    const rule = { pattern: 'secrets/**', scope: 'global' as const, effectiveFrom: '2026-06-01T00:00:00.000Z' };
    const target = entity({ path: 'secrets/keys.txt' });

    expect(withholds(access({ exclusions: [rule], at: '2026-09-01T00:00:00.000Z' }), target)).toBe(
      WithholdReason.EXCLUSION,
    );
    expect(
      withholds(access({ exclusions: [rule], at: '2026-01-01T00:00:00.000Z' }), target),
    ).toBeUndefined();
  });

  it('ignores an entity with no path', () => {
    const excluded = access({ exclusions: [{ pattern: '**', scope: 'global' }] });
    // A commit has no path. An exclusion that swallowed every entity because a
    // pattern matched nothing in particular would be a filter nobody could
    // configure safely.
    expect(withholds(excluded, entity({}))).toBeUndefined();
  });
});

describe('reporting what was withheld', () => {
  it('reports nothing when nothing was withheld', () => {
    expect(new WithheldTally().report).toStrictEqual(NOTHING_WITHHELD);
    expect(NOTHING_WITHHELD.total).toBe(0);
  });

  it('carries counts and no identifying field at all — AC-10', () => {
    const tally = new WithheldTally();
    tally.add(WithholdReason.PERMISSION, 3);
    tally.add(WithholdReason.EXCLUSION);
    const report = tally.report;

    expect(report.total).toBe(4);
    expect(report.byReason).toStrictEqual({ exclusion: 1, permission: 3 });

    // The assertion that matters, and the reason it is written as a shape check
    // rather than a spot check: a field added later that named an id, a kind, a
    // path or a rule would answer the question the filter exists to refuse, and
    // this fails the moment one appears.
    expect(Object.keys(report).sort()).toStrictEqual(['byReason', 'total']);
    expect(JSON.stringify(report)).not.toMatch(/id|kind|path|source|rule|pattern/i);
  });

  it('is deterministic across runs', () => {
    const one = new WithheldTally();
    one.add(WithholdReason.SCOPE);
    one.add(WithholdReason.PERMISSION);
    const other = new WithheldTally();
    other.add(WithholdReason.PERMISSION);
    other.add(WithholdReason.SCOPE);

    expect(JSON.stringify(one.report)).toBe(JSON.stringify(other.report));
  });

  it('filters a page and counts what went, without describing it — AC-11', () => {
    // Withholding produces a smaller result, never a thrown error: an error is
    // itself a disclosure, and a partial answer is a normal outcome.
    const restricted = access({
      scope: { include: [{ kind: ScopeKind.REPOSITORY, id: 'repo-a' }], exclude: [] },
      exclusions: [{ pattern: '**/*.env', scope: 'global' }],
    });
    const page = [
      entity({ id: A, scope: 'repo-a', path: 'src/main.ts' }),
      entity({ id: B, scope: 'repo-b', path: 'src/other.ts' }),
      entity({ id: C, scope: 'repo-a', path: 'config/prod.env' }),
    ];

    const tally = new WithheldTally();
    const kept = visibleEntities(page, (item) => item, restricted, tally);

    expect(kept.map((item) => item.id)).toStrictEqual([A]);
    expect(tally.report.total).toBe(2);
    expect(tally.report.byReason).toStrictEqual({ exclusion: 1, scope: 1 });
  });

  it('knows when a context could hide nothing, so a count need not be computed', () => {
    expect(restricts(PUBLIC_ACCESS)).toBe(false);
    expect(restricts(access({ exclusions: [{ pattern: '**', scope: 'global' }] }))).toBe(true);
    expect(
      restricts(access({ scope: { include: [{ kind: ScopeKind.REPOSITORY, id: 'r' }], exclude: [] } })),
    ).toBe(true);
  });
});

describe('a policy Ferret cannot evaluate', () => {
  // Found by the integration test: a selector naming a repository whose id was
  // not yet resolved made every read *throw* rather than return nothing. On the
  // answer path that is the wrong failure — a policy Ferret cannot read must
  // withhold, not break the query.

  const malformed = access({
    // A non-global scope with no id. `scopeSelectorSchema` rejects it, which is
    // right; what matters is what the answer path does about that.
    scope: { include: [{ kind: ScopeKind.REPOSITORY }], exclude: [] },
  });

  it('withholds rather than throwing, per row', () => {
    expect(() => withholds(malformed, entity({}))).not.toThrow();
    expect(withholds(malformed, entity({}))).toBe(WithholdReason.SCOPE);
  });

  it('withholds rather than throwing on an unusable exclusion instant', () => {
    const badInstant = access({
      exclusions: [{ pattern: 'src/**', scope: 'global', effectiveFrom: 'not-a-date' }],
      at: 'also-not-a-date',
    });
    expect(() => withholds(badInstant, entity({ path: 'src/main.ts' }))).not.toThrow();
  });

  it('is loud at composition, where an operator can fix it', () => {
    // The other half of the rule. Failing closed on every row keeps a bad policy
    // from leaking and would keep it from being noticed: an operator with a typo
    // would see an empty index and conclude Ferret was broken.
    expect(() => assertUsableAccess(malformed)).toThrow();
    expect(() => assertUsableAccess(PUBLIC_ACCESS)).not.toThrow();
  });
});

describe('content cannot widen what a caller sees', () => {
  it('takes no visibility signal from an entity attribute', () => {
    // Governance §12: repository content is data, never policy. A file that
    // declares itself public is a claim by an untrusted source.
    const claimant = Object.freeze({
      ...entity({ path: 'config/prod.env' }),
      attributes: Object.freeze({
        path: 'config/prod.env',
        permissionScope: null,
        public: true,
        visibility: 'unrestricted',
        ferretAccess: 'allow',
      }),
    });
    const excluded = access({ exclusions: [{ pattern: '**/*.env', scope: 'global' }] });

    expect(withholds(excluded, claimant)).toBe(WithholdReason.EXCLUSION);
  });
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OTHER = B;
