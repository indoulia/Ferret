import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ENTITY_KINDS,
  ENTITY_SCHEMA_VERSION,
  EntityKind,
  LifecycleState,
  assertCanonicalEntity,
  canonicalId,
  canonicalKey,
  contentHash,
  createEntity,
  encodeKeyParts,
  entityKindDefinition,
  identify,
  isCanonicalId,
  isUnchanged,
  registerEntityKind,
  registeredEntityKinds,
  resetEntityKindRegistry,
  stableStringify,
  type EntityInput,
} from '../../src/index.js';

afterEach(() => {
  resetEntityKindRegistry();
});

function repository(overrides: Partial<EntityInput> = {}): EntityInput {
  return {
    kind: EntityKind.REPOSITORY,
    source: { system: 'git', id: 'https://github.com/indoulia/Ferret.git' },
    attributes: { name: 'Ferret', defaultBranch: 'main' },
    ...overrides,
  };
}

describe('canonical keys', () => {
  it('cannot be made ambiguous by a separator appearing inside a part', () => {
    // Source identifiers are arbitrary strings from systems Ferret does not
    // control — a branch really can be called `feature/a:b`. Length prefixing
    // makes two different identities unable to collide by construction.
    expect(encodeKeyParts(['a', 'b:c'])).not.toBe(encodeKeyParts(['a:b', 'c']));
    expect(encodeKeyParts(['ab', ''])).not.toBe(encodeKeyParts(['a', 'b']));
  });

  it('counts bytes, not characters, so multi-byte parts stay unambiguous', () => {
    expect(encodeKeyParts(['é'])).toBe('2:é');
  });

  it('distinguishes entities that differ only by kind, source or scope', () => {
    const base = { kind: 'file', sourceSystem: 'git', sourceId: 'README.md' };
    const keys = new Set([
      canonicalKey(base),
      canonicalKey({ ...base, kind: 'document' }),
      canonicalKey({ ...base, sourceSystem: 'github' }),
      canonicalKey({ ...base, scope: 'repo-a' }),
      canonicalKey({ ...base, scope: 'repo-b' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('treats an absent scope and an empty scope as the same thing', () => {
    const withUndefined = canonicalKey({ kind: 'k', sourceSystem: 's', sourceId: 'i' });
    const withEmpty = canonicalKey({ kind: 'k', sourceSystem: 's', sourceId: 'i', scope: '' });
    expect(withUndefined).toBe(withEmpty);
  });
});

describe('canonical ids', () => {
  it('are stable — the same identity always yields the same id', () => {
    // This is the property idempotent ingestion rests on. If it fails, every
    // re-index duplicates the knowledge base.
    const first = identify({ kind: 'repository', sourceSystem: 'git', sourceId: 'x' });
    const second = identify({ kind: 'repository', sourceSystem: 'git', sourceId: 'x' });
    expect(second.id).toBe(first.id);
  });

  it('are well-formed UUIDs, so PostgreSQL can store them natively', () => {
    const { id } = identify({ kind: 'repository', sourceSystem: 'git', sourceId: 'x' });
    expect(isCanonicalId(id)).toBe(true);
  });

  it('declare version 8 and the RFC variant', () => {
    // RFC 9562 reserves v8 for application-defined generation. Claiming v4
    // would advertise randomness these ids deliberately do not have.
    const { id } = identify({ kind: 'repository', sourceSystem: 'git', sourceId: 'x' });
    expect(id[14]).toBe('8');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('differ for different identities', () => {
    const ids = new Set(
      ['a', 'b', 'c', 'd'].map((sourceId) => canonicalId(canonicalKey({ kind: 'file', sourceSystem: 'git', sourceId }))),
    );
    expect(ids.size).toBe(4);
  });

  it('is not the SHA-1 of a UUIDv5', () => {
    // Ferret derives ids from identifiers found in repositories it did not
    // write. SHA-1 chosen-prefix collisions are practical, and a collision here
    // would let a hostile repository alias one entity onto another.
    const { id } = identify({ kind: 'repository', sourceSystem: 'git', sourceId: 'x' });
    expect(id[14]).not.toBe('5');
  });
});

describe('content fingerprints', () => {
  it('ignore key order, so a provider reordering fields is not a change', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it('respect array order, because a list is not a set', () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it('treat an absent field and an explicitly undefined one alike', () => {
    expect(stableStringify({ a: 1 })).toBe(stableStringify({ a: 1, b: undefined }));
  });

  it('distinguish values that differ', () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: '1' })).not.toBe(contentHash({ a: 1 }));
    // At the top level `undefined` is not representable in JSON, so it hashes
    // as null. Inside an object the distinction that matters — absent versus
    // explicitly undefined — is already collapsed deliberately, above.
    expect(contentHash(null)).toBe(contentHash(undefined));
  });

  it('handle nesting', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: [3, { f: 4, e: 5 }] })).toBe(
      '{"a":[3,{"e":5,"f":4}],"b":{"c":2,"d":1}}',
    );
  });
});

describe('creating entities', () => {
  it('derives identity and fingerprint rather than taking them from the caller', () => {
    const created = createEntity(repository());
    expect(isCanonicalId(created.id)).toBe(true);
    expect(created.canonicalKey).toContain('repository');
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.schemaVersion).toBe(ENTITY_SCHEMA_VERSION);
    expect(created.lifecycle).toBe(LifecycleState.ACTIVE);
  });

  it('produces the same entity twice from the same input', () => {
    const a = createEntity(repository());
    const b = createEntity(repository());
    expect(b.id).toBe(a.id);
    expect(b.contentHash).toBe(a.contentHash);
    expect(isUnchanged(a, b)).toBe(true);
  });

  it('changes the fingerprint but not the id when content changes', () => {
    // The distinction the whole ingestion path depends on: same thing, new
    // content. A changed id would orphan every relationship pointing at it.
    const before = createEntity(repository());
    const after = createEntity(repository({ attributes: { name: 'Ferret', defaultBranch: 'develop' } }));

    expect(after.id).toBe(before.id);
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(isUnchanged(before, after)).toBe(false);
  });

  it('is frozen, so a caller cannot mutate a canonical entity after the fact', () => {
    const created = createEntity(repository());
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.attributes)).toBe(true);
  });

  it('covers every kind the Epic requires', () => {
    // Repositories, branches, worktrees, developers, agents, sessions, files,
    // file versions, commits, pull requests, reviews, issues, releases,
    // deployments, documents, evidence.
    expect(ENTITY_KINDS).toHaveLength(16);
    for (const kind of ENTITY_KINDS) {
      expect(entityKindDefinition(kind)?.builtIn).toBe(true);
    }
  });

  it('keeps branch and worktree distinct', () => {
    // Governance §9 forbids conflating them: one branch can be checked out in
    // several worktrees, and a worktree can be detached from any branch.
    const branch = createEntity({
      kind: EntityKind.BRANCH,
      source: { system: 'git', id: 'refs/heads/main', scope: 'repo-1' },
      attributes: { ref: 'refs/heads/main', shortName: 'main' },
    });
    const worktree = createEntity({
      kind: EntityKind.WORKTREE,
      source: { system: 'git', id: '/home/dev/ferret', scope: 'repo-1' },
      attributes: { path: '/home/dev/ferret', ref: 'refs/heads/main' },
    });
    expect(worktree.id).not.toBe(branch.id);
  });

  it('keeps a file and one of its versions distinct', () => {
    const file = createEntity({
      kind: EntityKind.FILE,
      source: { system: 'git', id: 'src/index.ts', scope: 'repo-1' },
      attributes: { path: 'src/index.ts' },
    });
    const version = createEntity({
      kind: EntityKind.FILE_VERSION,
      source: { system: 'git', id: 'src/index.ts@abc123', scope: 'repo-1' },
      attributes: { contentHash: 'abc123', path: 'src/index.ts' },
    });
    expect(version.id).not.toBe(file.id);
  });
});

describe('validation', () => {
  it('rejects an unknown kind', () => {
    let thrown: unknown;
    try {
      createEntity({ ...repository(), kind: 'not-a-kind' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_ENTITY_INVALID' });
  });

  it('rejects a missing required attribute, naming the path', () => {
    let thrown: unknown;
    try {
      createEntity({
        kind: EntityKind.BRANCH,
        source: { system: 'git', id: 'refs/heads/main' },
        attributes: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_ENTITY_INVALID' });
    expect((thrown as { message: string }).message).toContain('ref');
  });

  it('rejects a misspelled canonical field rather than accepting it silently', () => {
    // The reason the attribute schemas are strict: `titel` must fail, not land
    // in the canonical model as a field nothing will ever read.
    expect(() =>
      createEntity({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-1' },
        attributes: { titel: 'typo' },
      }),
    ).toThrow(/E_ENTITY_INVALID|not valid/);
  });

  it('points the caller at unknownFields when a field is not modelled', () => {
    let thrown: unknown;
    try {
      createEntity({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-1' },
        attributes: { storyPoints: 5 },
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { remediation: string }).remediation).toContain('unknownFields');
  });

  it('rejects a source without a system or an id', () => {
    expect(() =>
      createEntity({ kind: EntityKind.REPOSITORY, source: { system: '', id: 'x' }, attributes: {} }),
    ).toThrow();
    expect(() =>
      createEntity({ kind: EntityKind.REPOSITORY, source: { system: 'git', id: '' }, attributes: {} }),
    ).toThrow();
  });

  it('never echoes a rejected value, which may come from an untrusted repository', () => {
    let thrown: unknown;
    try {
      createEntity({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-1' },
        attributes: { labels: 'super-secret-value-not-an-array' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify(thrown)).not.toContain('super-secret-value');
  });

  it('rejects a stored value that is not a canonical entity', () => {
    expect(() => {
      assertCanonicalEntity({ id: 'not-a-uuid', kind: 'repository' });
    }).toThrow(/canonical identifier/);
    expect(() => {
      assertCanonicalEntity(null);
    }).toThrow(/must be an object/);
  });
});

describe('unknown source fields', () => {
  it('are retained verbatim without touching the canonical attributes', () => {
    // AC-5: unsupported source fields must survive *without corrupting the
    // canonical model*. Two boxes satisfy both halves at once.
    const created = createEntity(
      repository({
        unknownFields: { githubStars: 42, nested: { anything: [1, 2, 3] }, nullish: null },
      }),
    );

    expect(created.unknownFields).toStrictEqual({
      githubStars: 42,
      nested: { anything: [1, 2, 3] },
      nullish: null,
    });
    expect(created.attributes).not.toHaveProperty('githubStars');
  });

  it('take part in the fingerprint, so a change upstream is still a change', () => {
    const before = createEntity(repository({ unknownFields: { stars: 1 } }));
    const after = createEntity(repository({ unknownFields: { stars: 2 } }));
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.id).toBe(before.id);
  });

  it('are never validated, however odd they are', () => {
    expect(() => createEntity(repository({ unknownFields: { '': '', 'weird key': undefined } }))).not.toThrow();
  });
});

describe('external identifiers', () => {
  it('are recorded so a source identifier stays traceable', () => {
    const created = createEntity(
      repository({
        externalIds: [
          { system: 'github', id: 'R_kgDOABC', url: 'https://github.com/indoulia/Ferret' },
          { system: 'jira', id: 'FERRET' },
        ],
      }),
    );
    expect(created.externalIds).toHaveLength(2);
    expect(created.externalIds[0]?.system).toBe('github');
  });

  it('are deduplicated and ordered, so ingestion order does not change the fingerprint', () => {
    const a = createEntity(
      repository({ externalIds: [{ system: 'github', id: 'X' }, { system: 'jira', id: 'Y' }] }),
    );
    const b = createEntity(
      repository({
        externalIds: [
          { system: 'jira', id: 'Y' },
          { system: 'github', id: 'X' },
          { system: 'github', id: 'X' },
        ],
      }),
    );
    expect(b.externalIds).toHaveLength(2);
    expect(b.contentHash).toBe(a.contentHash);
  });
});

describe('extensibility', () => {
  it('accepts a kind the core does not ship, without any core change', () => {
    // AC-4: entity extensions must not require a core redesign.
    registerEntityKind('build_pipeline', z.object({ name: z.string(), stages: z.number() }).strict());

    const created = createEntity({
      kind: 'build_pipeline',
      source: { system: 'jenkins', id: 'main-pipeline' },
      attributes: { name: 'main', stages: 4 },
    });

    expect(created.kind).toBe('build_pipeline');
    expect(isCanonicalId(created.id)).toBe(true);
    expect(entityKindDefinition('build_pipeline')?.builtIn).toBe(false);
  });

  it('validates a registered kind against its own schema', () => {
    registerEntityKind('build_pipeline', z.object({ stages: z.number() }).strict());
    expect(() =>
      createEntity({
        kind: 'build_pipeline',
        source: { system: 'jenkins', id: 'x' },
        attributes: { stages: 'four' },
      }),
    ).toThrow(/E_ENTITY_INVALID|not valid/);
  });

  it('refuses to redefine an existing kind', () => {
    // Letting a provider redefine `commit` would change what every other
    // provider's data validates against.
    expect(() => {
      registerEntityKind(EntityKind.COMMIT, z.object({}));
    }).toThrow(/already registered/);
  });

  it('reports built-in and registered kinds distinguishably', () => {
    registerEntityKind('build_pipeline', z.object({}));
    const kinds = registeredEntityKinds();
    expect(kinds.filter((kind) => kind.builtIn)).toHaveLength(16);
    expect(kinds.filter((kind) => !kind.builtIn).map((kind) => kind.kind)).toStrictEqual(['build_pipeline']);
  });
});

describe('lifecycle', () => {
  it('defaults to active', () => {
    expect(createEntity(repository()).lifecycle).toBe(LifecycleState.ACTIVE);
  });

  it('can represent a tombstone without discarding the entity', () => {
    const tombstoned = createEntity(repository({ lifecycle: LifecycleState.DELETED }));
    expect(tombstoned.lifecycle).toBe(LifecycleState.DELETED);
    // Still fully addressable: "what happened to this, and when" stays
    // answerable, which is most of why Ferret indexes history at all.
    expect(tombstoned.attributes).toStrictEqual({ name: 'Ferret', defaultBranch: 'main' });
  });

  it('changes the fingerprint, so a deletion is detected as a change', () => {
    const active = createEntity(repository());
    const deleted = createEntity(repository({ lifecycle: LifecycleState.DELETED }));
    expect(deleted.contentHash).not.toBe(active.contentHash);
    expect(deleted.id).toBe(active.id);
  });
});
