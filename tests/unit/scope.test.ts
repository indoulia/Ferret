import { describe, expect, it } from 'vitest';

import {
  ACTOR_CLASSES,
  ActorClass,
  EntityKind,
  GLOBAL_SCOPE,
  ScopeDecision,
  ScopeKind,
  actorClassForKind,
  assertSameActorClass,
  constrains,
  createIdentityAlias,
  entityKindForActor,
  evaluateScope,
  isActorClass,
  isCanonicalId,
  isInScope,
  mergeSelectors,
  type ScopeSelector,
} from '../../src/index.js';

const REPO_A = 'aaaaaaaa-1111-8111-8111-111111111111';
const REPO_B = 'bbbbbbbb-1111-8111-8111-111111111111';
const WORKTREE = 'cccccccc-1111-8111-8111-111111111111';
const SESSION = 'dddddddd-1111-8111-8111-111111111111';
const ACTOR = 'eeeeeeee-1111-8111-8111-111111111111';

describe('scope evaluation', () => {
  it('includes everything when nothing is specified', () => {
    // The safe default for a filter: a caller who forgets to configure inclusion
    // sees what they are otherwise entitled to, rather than silently seeing
    // nothing and concluding the index is empty.
    expect(isInScope({ repositoryId: REPO_A }, {})).toBe(true);
    expect(isInScope({}, { include: [], exclude: [] })).toBe(true);
  });

  it('includes only what an inclusion rule names', () => {
    const selector: ScopeSelector = { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] };
    expect(isInScope({ repositoryId: REPO_A }, selector)).toBe(true);
    expect(isInScope({ repositoryId: REPO_B }, selector)).toBe(false);
  });

  it('lets exclusion win over inclusion', () => {
    // Exclusion is the direction that protects, and a rule that a broader
    // inclusion could override would not be a protection.
    const selector: ScopeSelector = {
      include: [{ kind: ScopeKind.GLOBAL }],
      exclude: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }],
    };
    expect(isInScope({ repositoryId: REPO_A }, selector)).toBe(false);
    expect(isInScope({ repositoryId: REPO_B }, selector)).toBe(true);
  });

  it('treats repository and session as independent dimensions', () => {
    // AC-4. "Everything in repository A, except during session S" is a coherent
    // instruction, and a model that flattened the two into one ordered list
    // could only express it by accident of ordering.
    const selector: ScopeSelector = {
      include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }],
      exclude: [{ kind: ScopeKind.SESSION, id: SESSION }],
    };

    expect(isInScope({ repositoryId: REPO_A }, selector)).toBe(true);
    expect(isInScope({ repositoryId: REPO_A, sessionId: SESSION }, selector)).toBe(false);
    expect(isInScope({ repositoryId: REPO_A, sessionId: 'other' }, selector)).toBe(true);
    expect(isInScope({ sessionId: SESSION }, selector)).toBe(false);
  });

  it('keeps a worktree scope distinct from its repository', () => {
    // Governance §9. A rule about one checkout must not become a rule about
    // every checkout of the same repository.
    const selector: ScopeSelector = { exclude: [{ kind: ScopeKind.WORKTREE, id: WORKTREE }] };
    expect(isInScope({ repositoryId: REPO_A, worktreeId: WORKTREE }, selector)).toBe(false);
    expect(isInScope({ repositoryId: REPO_A, worktreeId: 'other-worktree' }, selector)).toBe(true);
  });

  it('reports which rule decided, so the outcome can be explained', () => {
    // Governance §18: Ferret should be able to explain why something was
    // included or excluded. A bare boolean cannot.
    const decision = evaluateScope(
      { repositoryId: REPO_A },
      { exclude: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] },
    );
    expect(decision.decision).toBe(ScopeDecision.EXCLUDED);
    expect(decision.rule).toStrictEqual({ kind: ScopeKind.REPOSITORY, id: REPO_A });
    expect(decision.dimension).toBe(ScopeKind.REPOSITORY);
  });

  it('matches a global rule against any context', () => {
    expect(isInScope({}, { include: [GLOBAL_SCOPE] })).toBe(true);
    expect(isInScope({ sessionId: SESSION }, { exclude: [GLOBAL_SCOPE] })).toBe(false);
  });

  it('rejects a non-global scope that names nothing', () => {
    expect(() => evaluateScope({}, { include: [{ kind: ScopeKind.REPOSITORY }] })).toThrow(
      /E_CONFIG_INVALID|not valid/,
    );
  });

  it('does not match a rule against a dimension the context does not have', () => {
    // Absent is not a wildcard: a context with no session is not "in" a session
    // exclusion, and must not be excluded by one.
    expect(isInScope({ repositoryId: REPO_A }, { exclude: [{ kind: ScopeKind.SESSION, id: SESSION }] })).toBe(
      true,
    );
  });
});

describe('merging selectors', () => {
  it('unions inclusions and accumulates exclusions', () => {
    // Same one-way rule as EPIC-003's exclusions: a broader layer may add, but
    // no layer can widen what a narrower one refused.
    const merged = mergeSelectors(
      { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }], exclude: [{ kind: ScopeKind.SESSION, id: SESSION }] },
      { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_B }] },
    );

    expect(merged.include).toHaveLength(2);
    expect(merged.exclude).toHaveLength(1);
    expect(isInScope({ repositoryId: REPO_B }, merged)).toBe(true);
    expect(isInScope({ repositoryId: REPO_B, sessionId: SESSION }, merged)).toBe(false);
  });

  it('cannot be widened by a later layer', () => {
    const merged = mergeSelectors(
      { exclude: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] },
      { include: [{ kind: ScopeKind.GLOBAL }] },
    );
    expect(isInScope({ repositoryId: REPO_A }, merged)).toBe(false);
  });

  it('collapses duplicate rules', () => {
    const merged = mergeSelectors(
      { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] },
      { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] },
    );
    expect(merged.include).toHaveLength(1);
  });

  it('reports whether a dimension is constrained at all', () => {
    // "Says nothing about sessions" and "excludes every session" are different
    // answers and different bugs.
    const selector: ScopeSelector = { include: [{ kind: ScopeKind.REPOSITORY, id: REPO_A }] };
    expect(constrains(selector, ScopeKind.REPOSITORY)).toBe(true);
    expect(constrains(selector, ScopeKind.SESSION)).toBe(false);
  });
});

describe('actor classes', () => {
  it('has exactly two, and they map to distinct entity kinds', () => {
    expect(ACTOR_CLASSES).toStrictEqual(['developer', 'agent']);
    expect(entityKindForActor(ActorClass.DEVELOPER)).toBe(EntityKind.DEVELOPER);
    expect(entityKindForActor(ActorClass.AGENT)).toBe(EntityKind.AGENT);
  });

  it('recognizes an actor kind and rejects anything else', () => {
    expect(actorClassForKind(EntityKind.DEVELOPER)).toBe(ActorClass.DEVELOPER);
    expect(actorClassForKind(EntityKind.AGENT)).toBe(ActorClass.AGENT);
    expect(actorClassForKind(EntityKind.COMMIT)).toBeUndefined();
    expect(isActorClass('robot')).toBe(false);
  });

  it('refuses to reconcile a developer with an agent', () => {
    // Merging them would answer "who wrote this" with a bot.
    let thrown: unknown;
    try {
      assertSameActorClass(ActorClass.DEVELOPER, ActorClass.AGENT, { context: 'test' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_IDENTITY_INVALID' });
    expect((thrown as { remediation: string }).remediation).toContain('two actors');
  });

  it('allows reconciling two actors of the same class', () => {
    expect(() => {
      assertSameActorClass(ActorClass.DEVELOPER, ActorClass.DEVELOPER, {});
    }).not.toThrow();
  });
});

describe('identity aliases', () => {
  function alias(overrides: Record<string, unknown> = {}) {
    return createIdentityAlias({
      system: 'git',
      externalId: 'dev@example.com',
      actorId: ACTOR,
      actorClass: ActorClass.DEVELOPER,
      ...overrides,
    });
  }

  it('derives a stable id', () => {
    const a = alias({ validFrom: '2026-01-01T00:00:00.000Z' });
    const b = alias({ validFrom: '2026-01-01T00:00:00.000Z' });
    expect(b.id).toBe(a.id);
    expect(isCanonicalId(a.id)).toBe(true);
  });

  it('includes the interval start, so a mapping can recur', () => {
    // An address reassigned within an organisation and later returned. Identity
    // without time collapses those and loses the history AC-6 requires.
    const first = alias({ validFrom: '2026-01-01T00:00:00.000Z' });
    const second = alias({ validFrom: '2026-06-01T00:00:00.000Z' });
    expect(second.id).not.toBe(first.id);
  });

  it('opens the interval by default', () => {
    expect(alias().validTo).toBeNull();
  });

  it('keeps confidence unknown rather than defaulting it', () => {
    expect(alias().confidence).toBeUndefined();
    expect(alias({ confidence: 0.9 }).confidence).toBe(0.9);
  });

  it('carries the evidence that supports the mapping', () => {
    // AC-3: reconciliation must be auditable. A conclusion whose basis is not
    // recorded cannot be reviewed or reversed.
    const supported = alias({ evidenceId: 'ffffffff-1111-8111-8111-111111111111' });
    expect(supported.evidenceId).toBe('ffffffff-1111-8111-8111-111111111111');
  });

  it('rejects a malformed alias', () => {
    expect(() => alias({ system: '' })).toThrow();
    expect(() => alias({ externalId: '' })).toThrow();
    expect(() => alias({ actorClass: 'robot' })).toThrow();
    expect(() => alias({ confidence: 2 })).toThrow();
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(() => alias({ nickname: 'dev' })).toThrow();
  });
});
