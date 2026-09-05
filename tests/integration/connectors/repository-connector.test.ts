import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BRANCH_RECORD,
  COMMIT_RECORD,
  Direction,
  FILE_RECORD,
  LOCAL_INSTANCE,
  PUBLIC_ACCESS,
  REPOSITORY_RECORD,
  RelationshipType,
  SourceIngestor,
  WORKTREE_RECORD,
  ingestSources,
  repositorySourceConnector,
  sourceIdentityKey,
  type IngestReport,
  type RepositorySourcePort,
  type ProviderOperationContext,
  type SourceConnector,
} from '../../../src/index.js';
import { GIT_PROVIDER_ID, GIT_SOURCE_SYSTEM, GitSourceProvider } from '../../../src/git/index.js';
import { RepositoryOperation } from '../../../src/providers/contracts/source-repository.js';
import {
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  RetrievalStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createNullLogger } from '../../../src/logging/index.js';
import { VERSION } from '../../../src/version.js';
import { connectorContext, connectorStore } from '../../support/connector-store.js';
import { addWorktree, createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * A repository on the universal connector boundary — EPIC-120.
 *
 * EPIC-119 proved the contract with a tracker, which is the easy case: one flat
 * collection, one cursor, one record shape. A repository is the case that tests
 * whether the seam was cut in the right place — a description, its checkouts,
 * its refs, its tree and its history, paging independently, none of them shaped
 * like an issue.
 *
 * Nothing here is a double. Every case runs a **real Git repository on disk**
 * through the `GitSourceProvider` Ferret ships, through the connector, through
 * `SourceIngestor`. Where a fact can be checked against Git itself, it is:
 * `git ls-files` and `git log` are the oracle, so a disagreement is a defect
 * rather than a matter of opinion. The last section takes the same path all the
 * way into PostgreSQL and asks the retrieval layer an agent's question, because
 * a graph that is written correctly and cannot be read back is not context.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-120] SKIPPING repository connector tests: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-epic120-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

afterAll(async () => {
  if (version === undefined) return;
  await provider.shutdown();
  await workspace.cleanup();
});

/** The connector under test, wired to the provider Ferret actually ships. */
function connector(overrides: { observedAt?: () => Date; pageSizes?: number } = {}): SourceConnector {
  return repositorySourceConnector({
    source: provider,
    connectorId: GIT_PROVIDER_ID,
    system: GIT_SOURCE_SYSTEM,
    instance: LOCAL_INSTANCE,
    operations: [
      RepositoryOperation.DESCRIBE,
      RepositoryOperation.LIST_WORKTREES,
      RepositoryOperation.LIST_BRANCHES,
      RepositoryOperation.LIST_FILES,
      RepositoryOperation.READ_HISTORY,
    ],
    ...(overrides.observedAt === undefined ? {} : { observedAt: overrides.observedAt }),
    ...(overrides.pageSizes === undefined
      ? {}
      : {
          branchPageSize: overrides.pageSizes,
          filePageSize: overrides.pageSizes,
          commitPageSize: overrides.pageSizes,
        }),
  });
}

async function repository(name: string, options: { origin?: string } = {}): Promise<string> {
  const parent = join(workspace.path, name);
  await mkdir(parent, { recursive: true });
  return createRepository(parent, name, {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
}

async function commit(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', message]);
}

/** Every tracked path at HEAD, straight from Git. The oracle. */
async function trackedFiles(root: string): Promise<readonly string[]> {
  const out = await git(root, ['ls-files']);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort();
}

/** Every commit reachable from HEAD, straight from Git. The oracle. */
async function commitShas(root: string): Promise<readonly string[]> {
  const out = await git(root, ['log', '--format=%H']);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------

withGit('EPIC-120 — ingesting a repository', () => {
  it('acquires description, checkouts, refs, tree and history through one cursor', async () => {
    const root = await repository('walk');
    await writeFile(join(root, 'src.ts'), 'export const a = 1;\n', 'utf8');
    await commit(root, 'add source');

    const acquired: string[] = [];
    const instrumented = connector();
    let cursor: string | undefined;
    let pages = 0;
    const identity = instrumented.identify(root);

    // The stages are walked here directly rather than through the ingestor, so
    // that the claim under test — *one* cursor carries four enumerations — is
    // asserted about the connector rather than inferred from what was stored.
    do {
      const page = await instrumented.acquire(
        { identity, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      for (const record of page.records) acquired.push(record.kind);
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(new Set(acquired)).toEqual(
      new Set([REPOSITORY_RECORD, WORKTREE_RECORD, BRANCH_RECORD, FILE_RECORD, COMMIT_RECORD]),
    );
    // The tree is acquired before the history, so a commit's change edge has a
    // file entity to point at rather than a placeholder to repair later.
    expect(acquired.indexOf(FILE_RECORD)).toBeLessThan(acquired.indexOf(COMMIT_RECORD));
  });

  it('stores every file Git reports, and no file Git does not', async () => {
    const root = await repository('tree');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'one.ts'), 'export const one = 1;\n', 'utf8');
    await writeFile(join(root, 'two.md'), '# two\n', 'utf8');
    await commit(root, 'two files');

    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    const stored = [...state.entities.values()]
      .filter((row) => row.entity.kind === 'file')
      .map((row) => String(row.entity.attributes['path']))
      .sort();

    expect(stored).toEqual(await trackedFiles(root));
    expect(report.counts.records).toBeGreaterThan(0);
    expect(report.truncated).toBe(false);
  });

  it('stores every commit Git reports, with the metadata the commit carries', async () => {
    const root = await repository('history');
    await writeFile(join(root, 'a.txt'), 'a\n', 'utf8');
    await commit(root, 'second commit');

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    const shas = await commitShas(root);
    const commits = new Map(
      [...state.entities.values()]
        .filter((row) => row.entity.kind === 'commit')
        .map((row) => [String(row.entity.attributes['sha']), row.entity]),
    );

    for (const sha of shas) expect(commits.has(sha)).toBe(true);

    const head = commits.get(shas[0] as string);
    expect(head?.attributes['message']).toContain('second commit');
    // The instants are the commit's own, carried rather than re-derived.
    expect(String(head?.attributes['committedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(head?.attributes['parents']).toEqual([shas[1]]);
  });

  it('records the branch Git says is there', async () => {
    const root = await repository('refs');
    await git(root, ['branch', 'feature/x']);

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    const branches = [...state.entities.values()]
      .filter((row) => row.entity.kind === 'branch')
      .map((row) => String(row.entity.attributes['shortName']))
      .sort();

    expect(branches).toEqual(['feature/x', 'main']);
  });

  it('records a linked worktree as a checkout of the same repository', async () => {
    const root = await repository('worktrees');
    await addWorktree(root, join(workspace.path, 'worktrees'), 'linked');

    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    const worktrees = [...state.entities.values()].filter((row) => row.entity.kind === 'worktree');
    expect(worktrees.length).toBe(2);
    // Governance §9: a checkout is a worktree, and both belong to one
    // repository rather than being two repositories.
    for (const worktree of worktrees) {
      expect(worktree.entity.source.scope).toBe(report.sourceEntityId);
    }
  });
});

// ---------------------------------------------------------------------------

withGit('EPIC-120 — identity, scope and provenance', () => {
  it('files a repository under one source entity, and roots the whole graph there', async () => {
    const root = await repository('rooted');
    await writeFile(join(root, 'f.txt'), 'f\n', 'utf8');
    await commit(root, 'a file');

    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    // The defect this asserts against: `emit()` derives the repository entity
    // from `identityKey` and the ingestor derives a source entity from
    // `sourceIdentityKey`, so an unrooted connector writes *two* repository
    // rows — one holding the graph, one holding a name.
    const repositories = [...state.entities.values()].filter(
      (row) => row.entity.kind === 'repository',
    );
    expect(repositories.length).toBe(1);
    expect(repositories[0]?.entity.id).toBe(report.sourceEntityId);
    expect(report.identityKey).toBe(sourceIdentityKey(report.identity));

    // And the graph hangs off it rather than off something else.
    const files = [...state.entities.values()].filter((row) => row.entity.kind === 'file');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file.entity.source.scope).toBe(report.sourceEntityId);
  });

  it('keeps two repositories that share a file path apart', async () => {
    const left = await repository('scope-left');
    const right = await repository('scope-right');
    for (const root of [left, right]) {
      await writeFile(join(root, 'shared.ts'), 'export const x = 1;\n', 'utf8');
      await commit(root, 'shared path');
    }

    const { deps, state } = connectorStore();
    const first = await new SourceIngestor(connector(), deps).ingest({ resource: left }, context);
    const second = await new SourceIngestor(connector(), deps).ingest({ resource: right }, context);

    expect(first.sourceEntityId).not.toBe(second.sourceEntityId);
    const shared = [...state.entities.values()].filter(
      (row) => row.entity.kind === 'file' && row.entity.attributes['path'] === 'shared.ts',
    );
    // Two files, not one: identical path, different repository.
    expect(shared.length).toBe(2);
    expect(new Set(shared.map((row) => row.entity.source.scope))).toEqual(
      new Set([first.sourceEntityId, second.sourceEntityId]),
    );
  });

  it('attaches producer, version and system to every record it writes', async () => {
    const root = await repository('provenance');
    await writeFile(join(root, 'p.txt'), 'p\n', 'utf8');
    await commit(root, 'provenance');

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    expect(state.evidence.size).toBeGreaterThan(0);
    for (const record of state.evidence.values()) {
      expect(record.producer).toBe(GIT_PROVIDER_ID);
      expect(record.producerVersion).toBe(VERSION);
      expect(record.sourceSystem).toBe(GIT_SOURCE_SYSTEM);
    }
    for (const row of state.entities.values()) {
      expect(row.entity.source.system).toBe(GIT_SOURCE_SYSTEM);
    }
  });

  it('keeps the remote on the entity, so two clones remain resolvable later', async () => {
    const root = await repository('remote', { origin: 'https://github.com/indoulia/ferret.git' });

    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);

    const entity = state.entities.get(report.sourceEntityId)?.entity;
    // Identity is the connector's, but nothing the real identity carried is
    // lost: the remote is still on the record for the resolution layer.
    expect(entity?.attributes['remoteUrl']).toBe('https://github.com/indoulia/ferret.git');
    expect(entity?.unknownFields['identityKind']).toBe('remote');
  });
});

// ---------------------------------------------------------------------------

withGit('EPIC-120 — change handling', () => {
  it('adds a file added to the repository, without disturbing the others', async () => {
    const root = await repository('added');
    await writeFile(join(root, 'first.txt'), 'first\n', 'utf8');
    await commit(root, 'first');

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);
    const before = state.entities.get(fileId(state, 'first.txt'))?.entity.contentHash;

    await writeFile(join(root, 'second.txt'), 'second\n', 'utf8');
    await commit(root, 'second');
    await new SourceIngestor(connector(), deps).ingest({ resource: root, full: true }, context);

    expect(paths(state)).toEqual(await trackedFiles(root));
    expect(state.entities.get(fileId(state, 'first.txt'))?.entity.contentHash).toBe(before);
  });

  it('records a modified file as a new version of the same file', async () => {
    const root = await repository('modified');
    await writeFile(join(root, 'm.txt'), 'one\n', 'utf8');
    await commit(root, 'one');

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);
    const versionsBefore = versions(state).length;
    const identity = fileId(state, 'm.txt');

    await writeFile(join(root, 'm.txt'), 'two\n', 'utf8');
    await commit(root, 'two');
    await new SourceIngestor(connector(), deps).ingest({ resource: root, full: true }, context);

    // The file is one entity across the change — its identity is the path, not
    // the content — and the content change is a second `file_version`.
    expect(fileId(state, 'm.txt')).toBe(identity);
    expect(versions(state).length).toBe(versionsBefore + 1);
  });

  it('reports a deleted file as removed from the tree, and keeps the history that touched it', async () => {
    const root = await repository('deleted');
    await writeFile(join(root, 'gone.txt'), 'gone\n', 'utf8');
    await writeFile(join(root, 'stays.txt'), 'stays\n', 'utf8');
    await commit(root, 'two files');

    const { deps, state } = connectorStore();
    await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);
    const deletedId = fileId(state, 'gone.txt');

    await rm(join(root, 'gone.txt'));
    await commit(root, 'remove one');
    const after = await new SourceIngestor(connector(), deps).ingest(
      { resource: root, full: true },
      context,
    );

    // Git no longer lists it, so the connector no longer *acquires* it.
    // Asserted on the acquired tree rather than on the store, because the store
    // is a memory and legitimately still holds the file — both from the pass
    // before the deletion and from the history that touched it. Conflating
    // "not in the tree now" with "not in the graph" is what the next assertion
    // exists to keep apart.
    expect(await acquiredPaths(root)).toEqual(await trackedFiles(root));
    expect(await acquiredPaths(root)).not.toContain('gone.txt');

    // The entity is *not* deleted — Ferret is a memory, and the commits that
    // touched the file still point at it. Retiring it is the lifecycle sweep's
    // job (EPIC-031), which is a reconciliation over a complete listing and not
    // something a connector may do from a page.
    expect(state.entities.has(deletedId)).toBe(true);
    const edges = [...state.relationships.values()].filter(
      (edge) => edge.toId === deletedId && edge.type === RelationshipType.COMMIT_MODIFIES_FILE,
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(after.writes.entitiesCreated).toBeGreaterThan(0);
  });

  it('asks only for what changed once a pass has completed', async () => {
    const root = await repository('incremental');
    const asked: (string | undefined)[] = [];
    const base = connector();
    const watched: SourceConnector = {
      ...base,
      acquire: (request, operation) => {
        asked.push(request.since);
        return base.acquire(request, operation);
      },
    };

    const { deps } = connectorStore();
    const first = await new SourceIngestor(watched, deps).ingest({ resource: root }, context);
    expect(asked.every((since) => since === undefined)).toBe(true);
    expect(first.cursorAdvancedTo).toBeDefined();

    asked.length = 0;
    await new SourceIngestor(watched, deps).ingest({ resource: root }, context);
    expect(asked.some((since) => since === first.cursorAdvancedTo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

withGit('EPIC-120 — idempotence and determinism', () => {
  it('creates nothing new when the same repository is ingested twice', async () => {
    const root = await repository('idempotent');
    await writeFile(join(root, 'i.ts'), 'export const i = 1;\n', 'utf8');
    await commit(root, 'idempotence');

    const { deps, state } = connectorStore();
    const clock = (): Date => new Date('2026-09-05T00:00:00.000Z');

    await new SourceIngestor(connector({ observedAt: clock }), deps).ingest({ resource: root }, context);
    const entities = state.entities.size;
    const relationships = state.relationships.size;
    const evidence = state.evidence.size;

    const second = await new SourceIngestor(connector({ observedAt: clock }), deps).ingest(
      { resource: root, full: true },
      context,
    );

    expect(state.entities.size).toBe(entities);
    expect(state.relationships.size).toBe(relationships);
    expect(state.evidence.size).toBe(evidence);
    expect(second.writes.entitiesCreated).toBe(0);
    // Every observation was already on record, so none of it was written again.
    expect(second.writes.evidenceRecorded).toBe(0);
    expect(second.writes.evidenceDeduplicated).toBeGreaterThan(0);
  });

  it('derives the same graph in two independent runs against two stores', async () => {
    const root = await repository('deterministic');
    await writeFile(join(root, 'd.ts'), 'export const d = 1;\n', 'utf8');
    await commit(root, 'determinism');
    const clock = (): Date => new Date('2026-09-05T00:00:00.000Z');

    const runs: { entities: string[]; relationships: string[] }[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { deps, state } = connectorStore();
      await new SourceIngestor(connector({ observedAt: clock }), deps).ingest({ resource: root }, context);
      runs.push({
        entities: [...state.entities.keys()].sort(),
        relationships: [...state.relationships.keys()].sort(),
      });
    }

    expect(runs[0]?.entities).toEqual(runs[1]?.entities);
    expect(runs[0]?.relationships).toEqual(runs[1]?.relationships);
  });

  it('pages a tree forward rather than re-reading its first page', async () => {
    const root = await repository('tree-paging');
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, `p${String(index)}.txt`), `${String(index)}
`, 'utf8');
    }
    await commit(root, 'five files');

    // The defect this pins: `listFiles` returned a cursor it would not accept
    // back, so a caller that paged the tree got page one for ever. It is
    // asserted against the provider directly, because the provider is where the
    // asymmetry was — a connector-level test would pass again the moment
    // anybody re-broke it behind a different adapter.
    const discovered = await provider.describeRepository(root, context);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await provider.listFiles(
        discovered,
        { limit: 2, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      for (const entry of page.entries) seen.push(entry.path);
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(seen.sort()).toEqual(await trackedFiles(root));
    // Each path exactly once: a re-read page would duplicate them.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('derives the same ids however the acquisition was paged', async () => {
    const root = await repository('paged');
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(root, `f${String(index)}.txt`), `${String(index)}\n`, 'utf8');
      await commit(root, `commit ${String(index)}`);
    }
    const clock = (): Date => new Date('2026-09-05T00:00:00.000Z');

    const whole = connectorStore();
    await new SourceIngestor(connector({ observedAt: clock }), whole.deps).ingest(
      { resource: root },
      context,
    );

    // One record per page, which is the pathological case for a staged cursor.
    const split = connectorStore();
    await new SourceIngestor(connector({ observedAt: clock, pageSizes: 1 }), split.deps).ingest(
      { resource: root, pageLimit: 100 },
      context,
    );

    expect([...split.state.entities.keys()].sort()).toEqual([...whole.state.entities.keys()].sort());
  });
});

// ---------------------------------------------------------------------------

withGit('EPIC-120 — failure isolation', () => {
  it('reports an unreadable source instead of failing the pass', async () => {
    const missing = join(workspace.path, 'not-a-repository');
    await mkdir(missing, { recursive: true });
    const healthy = await repository('healthy');

    const { deps, state } = connectorStore();
    const outcomes = await ingestSources(
      [
        { connector: connector(), options: { resource: missing } },
        { connector: connector(), options: { resource: healthy } },
      ],
      deps,
      connectorContext(),
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[1]?.status).toBe('ingested');
    // The healthy repository is whole: one source failing did not cost the
    // other its graph.
    const second = outcomes[1] as { status: 'ingested'; report: IngestReport };
    expect(state.entities.get(second.report.sourceEntityId)).toBeDefined();
    // And nothing was filed under the failed one.
    expect(state.cursorPositions.size).toBe(1);
  });

  it('leaves a failed repository unremembered, so nothing is skipped next time', async () => {
    const broken = join(workspace.path, 'broken');
    await mkdir(broken, { recursive: true });

    const { deps, state } = connectorStore();
    const outcomes = await ingestSources(
      [{ connector: connector(), options: { resource: broken } }],
      deps,
      connectorContext(),
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(state.cursorPositions.size).toBe(0);
  });

  it('refuses a source that cannot be described rather than failing four stages later', async () => {
    const declared = repositorySourceConnector({
      source: provider,
      connectorId: GIT_PROVIDER_ID,
      system: GIT_SOURCE_SYSTEM,
      instance: LOCAL_INSTANCE,
      // A provider that declares no operations at all.
      operations: [],
    });

    const { deps } = connectorStore();
    await expect(
      new SourceIngestor(declared, deps).ingest({ resource: workspace.path }, context),
    ).rejects.toMatchObject({ code: 'E_CAPABILITY_UNAVAILABLE' });
  });

  it('never calls an operation the provider did not declare', async () => {
    const root = await repository('partial');
    const called: string[] = [];
    // A delegating spy rather than a `Proxy`: the provider reads private fields
    // on `this`, and a proxy receiver is not an instance of the class that
    // declared them.
    const watched: RepositorySourcePort = {
      describeRepository: (...args) => {
        called.push(RepositoryOperation.DESCRIBE);
        return provider.describeRepository(...args);
      },
      listWorktrees: (...args) => {
        called.push(RepositoryOperation.LIST_WORKTREES);
        return provider.listWorktrees(...args);
      },
      listBranches: (...args) => {
        called.push(RepositoryOperation.LIST_BRANCHES);
        return provider.listBranches(...args);
      },
      listFiles: (...args) => {
        called.push(RepositoryOperation.LIST_FILES);
        return provider.listFiles(...args);
      },
      readHistory: (...args) => {
        called.push(RepositoryOperation.READ_HISTORY);
        return provider.readHistory(...args);
      },
      // The modelling passes straight through. The casts are the price of the
      // port being stated in core's own terms rather than Git's: a tree entry
      // the connector describes structurally is the provider's `TreeEntry` at
      // run time, and only the compiler needs telling.
      emitGraph: (repo, parts) => provider.emitGraph(repo, parts),
      emitFiles: (repo, entries, options) => provider.emitFiles(repo, entries as never, options),
      emitHistory: (repo, commits, options) =>
        provider.emitHistory(repo, commits as never, options),
    };

    const limited = repositorySourceConnector({
      source: watched,
      connectorId: GIT_PROVIDER_ID,
      system: GIT_SOURCE_SYSTEM,
      instance: LOCAL_INSTANCE,
      // Tree only: no refs, no checkouts, no history.
      operations: [RepositoryOperation.DESCRIBE, RepositoryOperation.LIST_FILES],
    });

    const { deps, state } = connectorStore();
    await new SourceIngestor(limited, deps).ingest({ resource: root }, context);

    expect(called).not.toContain(RepositoryOperation.LIST_BRANCHES);
    expect(called).not.toContain(RepositoryOperation.READ_HISTORY);
    expect(called).not.toContain(RepositoryOperation.LIST_WORKTREES);
    // And a partial source still produces a usable graph rather than nothing.
    expect(paths(state).length).toBeGreaterThan(0);
  });

  it('starts over rather than failing when handed a cursor it cannot read', async () => {
    const root = await repository('bad-cursor');
    const identity = connector().identify(root);

    const page = await connector().acquire({ identity, cursor: 'not-a-cursor' }, context);

    // A cursor is opaque to the ingestor, which stores and returns it verbatim.
    // Re-reading is free; failing a source over a value the source did not
    // produce is not.
    expect(page.records.some((record) => record.kind === REPOSITORY_RECORD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real path, all the way to an answer.
// ---------------------------------------------------------------------------

const endToEnd = version !== undefined && databaseAvailable() ? describe : describe.skip;

if (version !== undefined && !databaseAvailable()) {
  process.stderr.write(`\n[EPIC-120] SKIPPING end-to-end retrieval: ${SKIP_REASON}\n\n`);
}

endToEnd('EPIC-120 — acquisition to retrieval, against the real stores', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('epic120');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('answers an agent asking what a repository holds and who changed it', async () => {
    const root = await repository('retrievable', { origin: 'https://github.com/indoulia/retrievable.git' });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'planner.ts'), 'export const plan = () => 1;\n', 'utf8');
    await commit(root, 'add the planner');

    const report = await new SourceIngestor(connector(), {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    }).ingest({ resource: root }, context);

    const retrieval = new RetrievalStore(handle);

    // 1. The repository is retrievable as one entity, by the identity it was
    //    filed under.
    const repositories = await retrieval.findEntities({ kind: 'repository' }, PUBLIC_ACCESS);
    expect(repositories.entities.map((entity) => entity.id)).toContain(report.sourceEntityId);

    // 2. Its files are retrievable *by scope*, which is the query an agent
    //    actually issues — "what is in this repository".
    const files = await retrieval.findEntities(
      { kind: 'file', scope: report.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );
    expect(files.entities.map((entity) => String(entity.attributes['path'])).sort()).toEqual(
      await trackedFiles(root),
    );

    // 3. The graph is walkable from the repository to the commit that touched
    //    a file — the relationship an agent follows to answer "why is this
    //    file like this".
    const planner = files.entities.find((entity) => entity.attributes['path'] === 'src/planner.ts');
    expect(planner).toBeDefined();
    const touching = await retrieval.neighbours(
      {
        from: planner?.id ?? '',
        types: [RelationshipType.COMMIT_MODIFIES_FILE],
        direction: Direction.IN,
        // "This commit deleted this file" is an edge that ended by definition,
        // and a `MODIFIES` edge is recorded at the commit's instant. Asking for
        // only what is true *now* would answer a different question.
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    const shas = await commitShas(root);
    expect(
      touching.neighbours.map((neighbour) => String(neighbour.entity.attributes['sha'])),
    ).toContain(shas[0]);

    // 4. And the provenance survived storage: every answer can say what
    //    produced it and when it was read.
    const evidence = await handle.execute<{ producer: string; producer_version: string }>(
      sql`SELECT DISTINCT producer, producer_version FROM ferret.evidence`,
    );
    expect(evidence.rows.map((row) => row.producer)).toContain(GIT_PROVIDER_ID);
    expect(evidence.rows.map((row) => row.producer_version)).toContain(VERSION);
  }, 300_000);

  it('writes one graph however many times the repository is ingested', async () => {
    const root = await repository('twice');
    await writeFile(join(root, 'once.ts'), 'export const once = 1;\n', 'utf8');
    await commit(root, 'once');

    const deps = {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    };

    const first = await new SourceIngestor(connector(), deps).ingest({ resource: root }, context);
    const retrieval = new RetrievalStore(handle);
    const before = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    await new SourceIngestor(connector(), deps).ingest({ resource: root, full: true }, context);
    const after = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    expect(after.entities.map((entity) => entity.id).sort()).toEqual(
      before.entities.map((entity) => entity.id).sort(),
    );
  }, 300_000);
});

// ---------------------------------------------------------------------------

/** The paths one acquisition pass listed from the tree, in Git's own order. */
async function acquiredPaths(root: string): Promise<readonly string[]> {
  const source = connector();
  const identity = source.identify(root);
  const listed: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await source.acquire(
      { identity, ...(cursor === undefined ? {} : { cursor }) },
      context,
    );
    for (const record of page.records) {
      if (record.kind === FILE_RECORD) listed.push(record.id);
    }
    cursor = page.cursor;
  } while (cursor !== undefined);
  return listed.sort();
}

function paths(state: ReturnType<typeof connectorStore>['state']): readonly string[] {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === 'file')
    .map((row) => String(row.entity.attributes['path']))
    .sort();
}

function versions(state: ReturnType<typeof connectorStore>['state']): readonly string[] {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === 'file_version')
    .map((row) => row.entity.id);
}

function fileId(state: ReturnType<typeof connectorStore>['state'], path: string): string {
  const match = [...state.entities.values()].find(
    (row) => row.entity.kind === 'file' && row.entity.attributes['path'] === path,
  );
  return match?.entity.id ?? '';
}
