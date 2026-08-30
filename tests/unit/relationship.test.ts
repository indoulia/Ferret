import { afterEach, describe, expect, it } from 'vitest';

import {
  EntityKind,
  OPEN_INTERVAL,
  RELATIONSHIP_TYPES,
  RelationshipType,
  createRelationship,
  isCanonicalId,
  isOpen,
  isValidAt,
  registerRelationshipType,
  registeredRelationshipTypes,
  relationshipKey,
  relationshipTypeDefinition,
  resetRelationshipTypeRegistry,
  type RelationshipInput,
} from '../../src/index.js';

afterEach(() => {
  resetRelationshipTypeRegistry();
});

const FROM = '11111111-1111-8111-8111-111111111111';
const TO = '22222222-2222-8222-8222-222222222222';
const OTHER = '33333333-3333-8333-8333-333333333333';

function branchPointsToCommit(overrides: Partial<RelationshipInput> = {}): RelationshipInput {
  return {
    fromId: FROM,
    type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
    toId: TO,
    sourceSystem: 'git',
    ...overrides,
  };
}

describe('relationship identity', () => {
  it('includes the start of the interval, so an edge can be true over several periods', () => {
    // A file removed from a directory and later restored, a branch checked out,
    // detached and checked out again. Identity without time would collapse
    // those into one and make the history unrepresentable.
    const first = createRelationship(branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }));
    const second = createRelationship(branchPointsToCommit({ validFrom: '2026-06-01T00:00:00.000Z' }));
    expect(second.id).not.toBe(first.id);
  });

  it('is stable — re-observing the same fact yields the same id', () => {
    const a = createRelationship(branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }));
    const b = createRelationship(branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }));
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it('is directed — reversing the endpoints is a different relationship', () => {
    const forward = createRelationship(
      branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }),
    );
    const backward = createRelationship(
      branchPointsToCommit({ fromId: TO, toId: FROM, validFrom: '2026-01-01T00:00:00.000Z' }),
    );
    expect(backward.id).not.toBe(forward.id);
  });

  it('produces a well-formed canonical id', () => {
    expect(isCanonicalId(createRelationship(branchPointsToCommit()).id)).toBe(true);
    expect(relationshipKey(FROM, 'a_b_c', TO, '2026-01-01T00:00:00.000Z')).toContain('relationship');
  });
});

describe('type constraints', () => {
  it('keeps branch and worktree relationships distinct', () => {
    // EPIC-007 AC-4. Enforced by the type's declared endpoint kinds, so it is a
    // rule rather than a convention: a worktree cannot appear where a branch
    // belongs, whatever the caller intends.
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.REPOSITORY_CONTAINS_BRANCH,
        toId: TO,
        fromKind: EntityKind.REPOSITORY,
        toKind: EntityKind.WORKTREE,
        sourceSystem: 'git',
      }),
    ).toThrow(/cannot end at a worktree/);

    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
        toId: TO,
        fromKind: EntityKind.BRANCH,
        toKind: EntityKind.BRANCH,
        sourceSystem: 'git',
      }),
    ).toThrow(/cannot start at a branch/);
  });

  it('accepts the kinds a type does allow', () => {
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
        toId: TO,
        fromKind: EntityKind.WORKTREE,
        toKind: EntityKind.BRANCH,
        sourceSystem: 'git',
      }),
    ).not.toThrow();
  });

  it('allows any kind where a type deliberately does not constrain it', () => {
    // Evidence can support anything; a supersedes relationship can connect any
    // two entities of the same kind.
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.EVIDENCE_SUPPORTS_ENTITY,
        toId: TO,
        fromKind: EntityKind.EVIDENCE,
        toKind: EntityKind.RELEASE,
        sourceSystem: 'ferret',
      }),
    ).not.toThrow();
  });

  it('rejects an unregistered type', () => {
    expect(() =>
      createRelationship({ fromId: FROM, type: 'invented_link', toId: TO, sourceSystem: 'x' }),
    ).toThrow(/not registered/);
  });

  it('rejects a self-loop', () => {
    // Almost always a provider bug — a commit is not its own parent — and
    // letting one in produces traversals that never terminate.
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.COMMIT_PARENT_OF_COMMIT,
        toId: FROM,
        sourceSystem: 'git',
      }),
    ).toThrow(/cannot connect an entity to itself/);
  });

  it('ships a type for every structural question the Epic names', () => {
    expect(RELATIONSHIP_TYPES.length).toBeGreaterThanOrEqual(24);
    for (const type of RELATIONSHIP_TYPES) {
      expect(relationshipTypeDefinition(type)?.builtIn).toBe(true);
    }
  });

  it('marks the types where an entity may hold only one open relationship', () => {
    // A branch points at exactly one commit; a worktree holds at most one
    // branch. Asserting a new one closes the previous.
    expect(relationshipTypeDefinition(RelationshipType.BRANCH_POINTS_TO_COMMIT)?.exclusiveFrom).toBe(true);
    expect(relationshipTypeDefinition(RelationshipType.WORKTREE_CHECKS_OUT_BRANCH)?.exclusiveFrom).toBe(true);
    // A commit modifies many files; a release includes many commits.
    expect(relationshipTypeDefinition(RelationshipType.COMMIT_MODIFIES_FILE)?.exclusiveFrom).toBe(false);
    expect(relationshipTypeDefinition(RelationshipType.RELEASE_INCLUDES_COMMIT)?.exclusiveFrom).toBe(false);
  });
});

describe('temporal validity', () => {
  it('is open by default — a relationship observed now is still true', () => {
    const created = createRelationship(branchPointsToCommit());
    expect(created.validTo).toBe(OPEN_INTERVAL);
    expect(isOpen(created)).toBe(true);
  });

  it('uses a half-open interval, so closing and reopening at one instant is unambiguous', () => {
    // Without this, an interval that ended at T and one that began at T would
    // both be true *at* T, and a point-in-time query would return two answers
    // where there is one fact.
    const closed = createRelationship(
      branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-06-01T00:00:00.000Z' }),
    );

    expect(isValidAt(closed, new Date('2026-01-01T00:00:00.000Z'))).toBe(true);
    expect(isValidAt(closed, new Date('2026-03-01T00:00:00.000Z'))).toBe(true);
    expect(isValidAt(closed, new Date('2026-06-01T00:00:00.000Z'))).toBe(false);
    expect(isValidAt(closed, new Date('2025-12-31T23:59:59.000Z'))).toBe(false);
  });

  it('treats an open relationship as true at any instant from its start', () => {
    const open = createRelationship(branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }));
    expect(isValidAt(open, new Date('2030-01-01T00:00:00.000Z'))).toBe(true);
    expect(isValidAt(open, new Date('2020-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('rejects an interval that ends before it starts', () => {
    expect(() =>
      createRelationship(
        branchPointsToCommit({ validFrom: '2026-06-01T00:00:00.000Z', validTo: '2026-01-01T00:00:00.000Z' }),
      ),
    ).toThrow(/cannot stop being true before it started/);
  });

  it('defaults validFrom to the moment of assertion rather than inventing a past', () => {
    const now = new Date('2026-08-30T12:00:00.000Z');
    const created = createRelationship(branchPointsToCommit(), now);
    expect(created.validFrom).toBe('2026-08-30T12:00:00.000Z');
  });
});

describe('source traceability', () => {
  it('records which system observed the relationship', () => {
    const created = createRelationship(
      branchPointsToCommit({ sourceSystem: 'github', sourceId: 'event-12345' }),
    );
    expect(created.sourceSystem).toBe('github');
    expect(created.sourceId).toBe('event-12345');
  });

  it('connects entities from different providers', () => {
    // AC-5. Endpoints are canonical ids, which carry no provider in them, so a
    // Jira issue and a Git commit relate without either system knowing.
    const created = createRelationship({
      fromId: FROM,
      type: RelationshipType.COMMIT_RESOLVES_ISSUE,
      toId: TO,
      fromKind: EntityKind.COMMIT,
      toKind: EntityKind.ISSUE,
      sourceSystem: 'ferret',
    });
    expect(created.type).toBe(RelationshipType.COMMIT_RESOLVES_ISSUE);
  });

  it('carries metadata the source supplied about the relationship itself', () => {
    const created = createRelationship(
      branchPointsToCommit({ metadata: { via: 'push', force: false } }),
    );
    expect(created.metadata).toStrictEqual({ via: 'push', force: false });
  });

  it('includes metadata in the fingerprint, so a metadata change is a change', () => {
    const a = createRelationship(
      branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z', metadata: { via: 'push' } }),
    );
    const b = createRelationship(
      branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z', metadata: { via: 'merge' } }),
    );
    expect(b.id).toBe(a.id);
    expect(b.contentHash).not.toBe(a.contentHash);
  });
});

describe('extensibility', () => {
  it('accepts a type a provider registers, without a core change', () => {
    registerRelationshipType('pipeline_builds_commit', {
      fromKinds: ['build_pipeline'],
      toKinds: [EntityKind.COMMIT],
    });

    const created = createRelationship({
      fromId: FROM,
      type: 'pipeline_builds_commit',
      toId: TO,
      fromKind: 'build_pipeline',
      toKind: EntityKind.COMMIT,
      sourceSystem: 'jenkins',
    });
    expect(created.type).toBe('pipeline_builds_commit');
    expect(relationshipTypeDefinition('pipeline_builds_commit')?.builtIn).toBe(false);
  });

  it('enforces a registered type\'s own endpoint constraints', () => {
    registerRelationshipType('pipeline_builds_commit', { toKinds: [EntityKind.COMMIT] });
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: 'pipeline_builds_commit',
        toId: TO,
        toKind: EntityKind.ISSUE,
        sourceSystem: 'jenkins',
      }),
    ).toThrow(/cannot end at an issue|cannot end at a issue/);
  });

  it('refuses to redefine an existing type', () => {
    expect(() => {
      registerRelationshipType(RelationshipType.BRANCH_POINTS_TO_COMMIT);
    }).toThrow(/already registered/);
  });

  it('rejects a type name that is not snake_case', () => {
    expect(() => {
      registerRelationshipType('Pipeline Builds');
    }).toThrow(/not a valid relationship type name/);
  });

  it('reports built-in and registered types distinguishably', () => {
    registerRelationshipType('pipeline_builds_commit');
    const types = registeredRelationshipTypes();
    expect(types.filter((type) => !type.builtIn).map((type) => type.type)).toStrictEqual([
      'pipeline_builds_commit',
    ]);
  });
});

describe('validation', () => {
  it('requires a source system, so no relationship is untraceable', () => {
    expect(() =>
      createRelationship({
        fromId: FROM,
        type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        toId: TO,
      } as unknown as RelationshipInput),
    ).toThrow();
  });

  it('rejects an unknown field rather than silently dropping it', () => {
    expect(() =>
      createRelationship({
        ...branchPointsToCommit(),
        weight: 5,
      } as unknown as RelationshipInput),
    ).toThrow();
  });

  it('rejects a malformed timestamp', () => {
    expect(() => createRelationship(branchPointsToCommit({ validFrom: 'last Tuesday' }))).toThrow();
  });

  it('does not confuse two different targets from the same source', () => {
    const a = createRelationship(branchPointsToCommit({ validFrom: '2026-01-01T00:00:00.000Z' }));
    const b = createRelationship(
      branchPointsToCommit({ toId: OTHER, validFrom: '2026-01-01T00:00:00.000Z' }),
    );
    expect(b.id).not.toBe(a.id);
  });
});
