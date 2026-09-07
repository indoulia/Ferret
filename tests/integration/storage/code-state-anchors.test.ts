import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AnchorVerdict,
  ContextKind,
  EntityKind,
  LifecycleState,
  RelationshipType,
  UnknownReason,
  createNullLogger,
  evidenceKey,
} from '../../../src/index.js';
import {
  CodeStateStore,
  DurableContextStore,
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
  type WorktreeReader,
} from '../../../src/storage/index.js';
import { PUBLIC_ACCESS } from '../../../src/retrieval/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-137 — anchors against a real PostgreSQL.
 *
 * The verdict rules are unit-covered in `tests/unit/code-state-verification.test.ts`.
 * What only a database proves is the part the Epic's acceptance criteria are
 * about: that a path resolves to the version it currently holds, that a
 * re-anchored observation is a *second* row rather than a dedupe onto the
 * first, and that a read never writes.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const ANCHOR = 'src/config/exclusions.ts';
const HEAD = 'a'.repeat(40);

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let evidence: EvidenceStore;
let relationships: RelationshipStore;
let repository: string;
/** Mutable so a test can move the tree under a recorded statement. */
let live: { headCommit: string | undefined; branch: string | undefined; dirtyPaths: string[]; dirtySampleTruncated: boolean };

const worktree: WorktreeReader = { read: () => Promise.resolve({ ...live, dirtyPaths: [...live.dirtyPaths] }) };

function by(producer: string, overrides: Partial<ContextProvenance> = {}): ContextProvenance {
  return { producer, producerVersion: '1.0.0', sourceSystem: 'ferret', ...overrides };
}

function storeWith(access = PUBLIC_ACCESS): DurableContextStore {
  return new DurableContextStore(handle, { codeState: new CodeStateStore(handle, { access, worktree }) });
}

/** Points a path at `hash`, closing whatever version it held before. */
async function setContent(path: string, hash: string): Promise<void> {
  const file = (
    await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: path, scope: repository },
      attributes: { path },
    })
  ).entity.id;
  const version = (
    await entities.upsert({
      kind: EntityKind.FILE_VERSION,
      source: { system: 'git', id: hash, scope: file },
      attributes: { contentHash: hash, path },
    })
  ).entity.id;

  const open = await relationships.outgoing(file, { type: RelationshipType.FILE_HAS_VERSION });
  for (const edge of open) {
    if (edge.toId !== version) await relationships.retire(file, RelationshipType.FILE_HAS_VERSION, edge.toId);
  }
  await relationships.assert(
    { fromId: file, type: RelationshipType.FILE_HAS_VERSION, toId: version, fromKind: 'file', toKind: 'file_version', sourceSystem: 'git' },
    new Date(),
  );
}

async function evidenceCount(subjectId: string): Promise<number> {
  const rows = await handle.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM ferret.evidence WHERE subject_id = ${subjectId}
  `);
  return Number(rows.rows[0]?.count ?? '0');
}

describeDb(`code-state anchors (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('code-state-anchors');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);
    relationships = new RelationshipStore(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/anchor-repo' },
        attributes: { path: '/anchor-repo' },
      })
    ).entity.id;
    await entities.upsert({
      kind: EntityKind.BRANCH,
      source: { system: 'git', id: 'refs/heads/main', scope: repository },
      attributes: { ref: 'refs/heads/main', shortName: 'main', isDefault: true, headCommit: HEAD },
    });
    await setContent(ANCHOR, 'git-blob:aaa');
    await setContent('README.md', 'git-blob:readme');
    live = { headCommit: HEAD, branch: 'main', dirtyPaths: [], dirtySampleTruncated: false };
  });

  afterAll(async () => {
    await db.drop();
  });

  it('AC-1, AC-2: an anchor resolves to the version the path currently holds', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'Exclusions treat a directory prefix as a literal',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR, symbol: 'matchesExclusion' }] }),
    });

    expect(stored.anchors).toHaveLength(1);
    expect(stored.anchors[0]?.resolved).toMatchObject({ path: ANCHOR, contentHash: 'git-blob:aaa' });

    const rows = await evidence.forSubject(stored.context.entity.id, { permittedScopes: [] });
    expect(rows[0]).toMatchObject({ sourceContentHash: 'git-blob:aaa' });
    expect(rows[0]?.locator).toMatchObject({ kind: 'path', start: ANCHOR, detail: 'matchesExclusion' });
  });

  it('AC-3: an anchor naming no indexed file is reported, not dropped', async () => {
    const stored = await storeWith().record({
      statement: 'A statement anchored to a path that does not exist',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: 'src/does/not/exist.ts' }] }),
    });

    expect(stored.anchors).toHaveLength(1);
    expect(stored.anchors[0]?.resolved).toBeUndefined();
    expect(stored.anchors[0]?.failure).toBe(UnknownReason.ANCHOR_UNRESOLVED);
    expect(stored.anchors[0]?.detail).toContain('no indexed file');
  });

  it('AC-4: anchoring does not change statement identity, and merge still converges', async () => {
    const store = storeWith();
    const statement = 'Anchoring must not fork a statement';
    const plain = await store.record({
      statement,
      contextKind: ContextKind.DECISION,
      scope: repository,
      provenance: by('agent-a'),
    });
    const anchored = await store.record({
      statement,
      contextKind: ContextKind.DECISION,
      scope: repository,
      provenance: by('agent-b', { anchors: [{ path: ANCHOR }] }),
    });

    expect(anchored.context.entity.id).toBe(plain.context.entity.id);
    expect(anchored.outcome).toBe('merged');
  });

  it('AC-6: a matching anchor with correspondence verifies', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'Verified when the bytes match',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    const belief = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.VERIFIED);
    expect(belief?.current).toBe(true);
  });

  it('AC-7, AC-9, AC-14: a changed file goes stale, reverting verifies again, and neither writes', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'Drift is not falsity',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    const before = await evidenceCount(stored.context.entity.id);

    await setContent(ANCHOR, 'git-blob:bbb');
    const drifted = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(drifted?.verification?.verdict).toBe(AnchorVerdict.STALE);
    expect(drifted?.verification?.anchors[0]).toMatchObject({ observedHash: 'git-blob:aaa', currentHash: 'git-blob:bbb' });
    // Drift is not falsity: the statement is untouched.
    expect(drifted?.state).toBe(LifecycleState.ACTIVE);
    expect(drifted?.supersededBy).toBeUndefined();
    expect(await evidenceCount(stored.context.entity.id)).toBe(before);

    await setContent(ANCHOR, 'git-blob:aaa');
    const reverted = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(reverted?.verification?.verdict).toBe(AnchorVerdict.VERIFIED);
    expect(await evidenceCount(stored.context.entity.id)).toBe(before);
  });

  it('AC-8: an unrelated file changing leaves the verdict verified', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'Only the anchor set is consulted',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    await setContent('README.md', 'git-blob:readme-2');
    const belief = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.VERIFIED);
  });

  it('AC-10: a different commit with identical content is unknown, not verified', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A commit id is provenance, not the key',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    live = { ...live, headCommit: 'b'.repeat(40) };
    const moved = await storeWith().trust(stored.context.entity.id, { permittedScopes: [] });
    // The bytes still match; correspondence does not, so it is not verified.
    expect(moved?.verification?.anchors[0]?.matches).toBe(true);
    expect(moved?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(moved?.verification?.reason).toBe(UnknownReason.NO_CORRESPONDENCE);

    live = { ...live, headCommit: HEAD };
    const back = await storeWith().trust(stored.context.entity.id, { permittedScopes: [] });
    expect(back?.verification?.verdict).toBe(AnchorVerdict.VERIFIED);
  });

  it('AC-11: a dirty anchored path is unknown', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A locally modified anchor cannot verify',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    live = { ...live, dirtyPaths: [ANCHOR] };
    const dirty = await storeWith().trust(stored.context.entity.id, { permittedScopes: [] });
    expect(dirty?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(dirty?.verification?.reason).toBe(UnknownReason.PATH_DIRTY);

    live = { ...live, dirtyPaths: [] };
  });

  it('AC-11: a detached HEAD cannot establish correspondence', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A detached head has no branch to compare',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    live = { ...live, branch: undefined };
    const belief = await storeWith().trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(belief?.verification?.reason).toBe(UnknownReason.NOT_INDEXED);
    live = { ...live, branch: 'main' };
  });

  it('AC-11: a branch the index has never seen cannot establish correspondence', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'An unindexed branch is not a correspondence',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    live = { ...live, branch: 'feature/never-indexed' };
    const belief = await storeWith().trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    live = { ...live, branch: 'main' };
  });

  it('AC-12: an unanchored statement is unanchored, never verified', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A statement with no anchor at all',
      contextKind: ContextKind.PREFERENCE,
      scope: repository,
      provenance: by('agent-a'),
    });

    const belief = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNANCHORED);
    expect(belief?.current).toBe(true);
  });

  it('AC-13: a path named only in prose creates no anchor', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: `The literal-prefix bug is at ${ANCHOR}:96`,
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('agent-a'),
    });

    expect(stored.anchors).toHaveLength(0);
    const belief = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNANCHORED);
  });

  it('AC-15: an explicit replacement outranks a matching anchor', async () => {
    const store = storeWith();
    const first = await store.record({
      statement: 'The original claim about exclusions',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    await store.record({
      statement: 'The corrected claim about exclusions',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      supersedes: first.context.entity.id,
      provenance: by('agent-b', { anchors: [{ path: ANCHOR }] }),
    });

    const belief = await store.trust(first.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.SUPERSEDED);
    expect(belief?.supersededBy).toBeDefined();
  });

  it('AC-21: re-anchoring at a new hash adds an observation and verifies against it', async () => {
    const store = storeWith();
    const statement = 'Re-anchoring must take effect';
    const first = await store.record({
      statement,
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    const before = await evidenceCount(first.context.entity.id);

    await setContent(ANCHOR, 'git-blob:ccc');
    expect((await store.trust(first.context.entity.id, { permittedScopes: [] }))?.verification?.verdict).toBe(
      AnchorVerdict.STALE,
    );

    // Same statement, same producer, same locator — only the bytes differ.
    const again = await store.record({
      statement,
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    expect(again.context.entity.id).toBe(first.context.entity.id);
    expect(await evidenceCount(first.context.entity.id)).toBe(before + 1);

    const belief = await store.trust(first.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.VERIFIED);
    expect(belief?.verification?.anchors[0]?.observedHash).toBe('git-blob:ccc');
    expect(belief?.supersededBy).toBeUndefined();

    await setContent(ANCHOR, 'git-blob:aaa');
  });

  it('AC-22: re-anchoring at an unchanged hash deduplicates', async () => {
    const store = storeWith();
    const statement = 'An unchanged re-observation is not a second row';
    const first = await store.record({
      statement,
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    const before = await evidenceCount(first.context.entity.id);

    await store.record({
      statement,
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    expect(await evidenceCount(first.context.entity.id)).toBe(before);
  });

  it('AC-23: evidence identity is unchanged by this Epic', () => {
    // The inputs `evidenceKey` hashes are fixed. A change here would alter every
    // stored evidence id in every installation.
    const key = evidenceKey({
      subjectId: 'subject',
      field: undefined,
      statement: 'a statement',
      method: 'asserted',
      producer: 'p',
      producerVersion: '1.0.0',
      sourceSystem: 'ferret',
      sourceId: undefined,
      locator: undefined,
    });
    expect(key).toBe(
      '8:evidence7:subject0:13:"a statement"8:asserted1:p5:1.0.06:ferret0:0:',
    );
  });

  it('AC-16: an excluded anchor is unknown by exclusion, disclosing no path or hash', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A statement anchored under an excluded path',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    const excluded = new DurableContextStore(handle, {
      codeState: new CodeStateStore(handle, {
        access: { ...PUBLIC_ACCESS, exclusions: [{ pattern: 'src/config', scope: 'repository' }] },
        worktree,
      }),
    });
    const belief = await excluded.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    // An exclusion is the operator's intent working, never an authorization
    // boundary — the distinction EPIC-135 was fixed for.
    expect(belief?.verification?.reason).toBe(UnknownReason.EXCLUDED);
    expect(belief?.verification?.anchors[0]?.currentHash).toBeUndefined();
  });

  it('AC-16: an anchor outside the caller scope selector is unknown, not excluded', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A statement anchored outside the caller scope',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });

    const narrowed = new DurableContextStore(handle, {
      codeState: new CodeStateStore(handle, {
        access: { ...PUBLIC_ACCESS, scope: { include: [], exclude: [{ kind: 'repository', id: repository }] } },
        worktree,
      }),
    });
    const belief = await narrowed.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.UNKNOWN);
    expect(belief?.verification?.reason).toBe(UnknownReason.NOT_PERMITTED);
  });

  it('AC-18: a credential-shaped symbol in a locator is masked', async () => {
    const store = storeWith();
    const stored = await store.record({
      statement: 'A statement whose symbol carries a secret-shaped value',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', {
        anchors: [{ path: ANCHOR, symbol: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }],
      }),
    });

    const rows = await evidence.forSubject(stored.context.entity.id, { permittedScopes: [] });
    const detail = String((rows[0]?.locator as { detail?: string } | undefined)?.detail ?? '');
    expect(detail).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('every anchor must match: one drifted file of two is not verified', async () => {
    const store = storeWith();
    await setContent('src/second.ts', 'git-blob:second');
    const stored = await store.record({
      statement: 'A finding resting on two files',
      contextKind: ContextKind.DECISION,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }, { path: 'src/second.ts' }] }),
    });
    expect(stored.anchors).toHaveLength(2);
    expect((await store.trust(stored.context.entity.id, { permittedScopes: [] }))?.verification?.verdict).toBe(
      AnchorVerdict.VERIFIED,
    );

    await setContent('src/second.ts', 'git-blob:second-2');
    const belief = await store.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification?.verdict).toBe(AnchorVerdict.STALE);
    expect(belief?.verification?.anchors).toHaveLength(2);
  });

  it('no code-state reader reports no verdict, which is not "unanchored"', async () => {
    const bare = new DurableContextStore(handle);
    const stored = await bare.record({
      statement: 'A build that cannot read code state',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('agent-a', { anchors: [{ path: ANCHOR }] }),
    });
    // The anchor is refused rather than silently accepted unresolved.
    expect(stored.anchors[0]?.failure).toBe(UnknownReason.NOT_INDEXED);
    const belief = await bare.trust(stored.context.entity.id, { permittedScopes: [] });
    expect(belief?.verification).toBeUndefined();
  });
});
