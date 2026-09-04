import { describe, expect, it } from 'vitest';

import { RepositoryIndexer, type IndexableSource, type IndexerDependencies } from '../../src/indexing/index.js';
import { VERSION } from '../../src/version.js';
import type { CanonicalEntity } from '../../src/domain/index.js';
import type { DiscoveredRepository, ProviderOperationContext } from '../../src/providers/index.js';

/**
 * How a run reads a history longer than one page — F-01.
 *
 * Two properties, both invisible from a report and both load-bearing.
 *
 * **A bounded read is followed to its end.** The provider says a page was cut
 * short by returning a cursor. A run that reads the first page and then records
 * a position past its end loses every commit it did not reach, and no later run
 * goes back for them.
 *
 * **A resumed read applies its exclusion to every page.** A cursor is an offset
 * into a particular walk. Carrying the offset without the filter that defined
 * the walk pages into a different history — which returns commits that were
 * already indexed while skipping the ones that were not.
 *
 * These are asserted against a recorded source rather than a repository because
 * the requests are the behaviour: the same defect over a real Git returns a
 * plausible number of commits and says nothing about the ones it missed.
 */

const REPOSITORY: DiscoveredRepository = {
  identityKey: 'github.com/indoulia/ferret',
  identityKind: 'remote',
  root: '/repo',
  gitDir: '/repo/.git',
  commonGitDir: '/repo/.git',
  bare: false,
  linkedWorktree: false,
  remotes: [],
  originUrl: 'https://github.com/indoulia/ferret.git',
};

const REPOSITORY_ENTITY = { id: '00000000-0000-4000-8000-000000000001', kind: 'repository' } as unknown as CanonicalEntity;

const TIP = 'a'.repeat(40);

function context(): ProviderOperationContext {
  return { logger: undefined as never, signal: new AbortController().signal };
}

interface Recorded {
  readonly cursor?: string;
  readonly exclude?: readonly string[];
  readonly since?: string;
}

/**
 * A source with a two-page history that records what it was asked for.
 *
 * `tip` is reported on every page, as a real provider does: the ref stands
 * where it stands whether or not this page was the first.
 */
function pagedSource(requests: Recorded[], pages: number): IndexableSource {
  const empty = { entities: [], relationships: [], evidence: [] };
  let page = 0;
  const source = {
    listWorktrees: () => Promise.resolve([]),
    listBranches: () => Promise.resolve({ items: [] }),
    readHistory: (_repository: DiscoveredRepository, request: Recorded) => {
      requests.push({ ...request });
      page += 1;
      return Promise.resolve({
        commits: [{ committedAt: '2026-01-01T00:00:00Z', sha: `${String(page)}`.repeat(40).slice(0, 40) }],
        cursor: page < pages ? `cursor-${String(page)}` : undefined,
        tip: TIP,
      });
    },
    listFiles: () => Promise.resolve({ entries: [], cursor: undefined }),
    emit: () => ({ entity: REPOSITORY_ENTITY, evidence: [] }),
    emitGraph: () => empty,
    emitHistory: () => empty,
    emitFiles: () => ({ ...empty, skipped: [] }),
  };
  return source;
}

/** Stores that accept everything, over a position the caller supplies. */
function stores(position: Record<string, unknown> | undefined, written: Record<string, unknown>[]): Omit<IndexerDependencies, 'source'> {
  return {
    entities: { upsert: () => Promise.resolve({ entity: REPOSITORY_ENTITY, outcome: 'unchanged' }) },
    relationships: { assert: () => Promise.resolve({ relationship: {}, outcome: 'unchanged' }) },
    evidence: { record: () => Promise.resolve({ evidence: {}, deduplicated: true }) },
    watermarks: {
      getArtifact: () =>
        Promise.resolve(position === undefined ? undefined : { producerVersion: VERSION, metadata: position }),
      recordArtifact: (artifact: { metadata: Record<string, unknown> }) => {
        written.push(artifact.metadata);
        return Promise.resolve(undefined);
      },
    },
  } as unknown as Omit<IndexerDependencies, 'source'>;
}

function indexer(source: IndexableSource, rest: Omit<IndexerDependencies, 'source'>): RepositoryIndexer {
  return new RepositoryIndexer({ source, ...rest });
}

describe('reading a history longer than one page', () => {
  it('follows the cursor until the provider stops offering one', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    const report = await indexer(pagedSource(requests, 3), stores(undefined, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false },
      context(),
    );

    expect({ pages: requests.length, commitsRead: report.commitsRead }).toStrictEqual({
      pages: 3,
      commitsRead: 3,
    });
  });

  it('carries the exclusion onto every page of a resumed read', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    await indexer(pagedSource(requests, 3), stores({ tips: [TIP] }, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false },
      context(),
    );

    expect(requests.map((request) => request.exclude)).toStrictEqual([[TIP], [TIP], [TIP]]);
  });

  it('records the tip it read, so the next run excludes it', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    await indexer(pagedSource(requests, 1), stores(undefined, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false },
      context(),
    );

    expect(written.at(-1)?.['tips']).toStrictEqual([TIP]);
  });

  it('resumes by reachability rather than by date once a tip is known', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    await indexer(pagedSource(requests, 1), stores({ tips: [TIP], lastCommitAt: '2026-01-01T00:00:00Z' }, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false },
      context(),
    );

    // Never both: a date filter on top of an exclusion reintroduces exactly the
    // commits the exclusion exists to stop losing.
    expect({ exclude: requests[0]?.exclude, since: requests[0]?.since }).toStrictEqual({
      exclude: [TIP],
      since: undefined,
    });
  });

  it('falls back to the stored date when a position has no tip, so an upgrade re-reads nothing', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    await indexer(pagedSource(requests, 1), stores({ lastCommitAt: '2026-01-01T00:00:00Z' }, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false },
      context(),
    );

    expect({ exclude: requests[0]?.exclude, since: requests[0]?.since }).toStrictEqual({
      exclude: undefined,
      since: '2026-01-01T00:00:00Z',
    });
  });

  it('never stores a position dated after the run that wrote it', async () => {
    const requests: Recorded[] = [];
    const written: Record<string, unknown>[] = [];
    const source = pagedSource(requests, 1);
    const future = {
      ...source,
      readHistory: (repository: DiscoveredRepository, request: Recorded, operation: ProviderOperationContext) => {
        void repository;
        void operation;
        requests.push({ ...request });
        return Promise.resolve({
          commits: [{ committedAt: '2035-06-01T00:00:00Z' }],
          cursor: undefined,
          tip: TIP,
        });
      },
    } as unknown as IndexableSource;

    const observedAt = new Date('2026-01-01T00:00:00Z');
    await indexer(future, stores(undefined, written)).index(
      REPOSITORY,
      { withHistory: true, withFiles: false, observedAt },
      context(),
    );

    expect(written.at(-1)?.['lastCommitAt']).toBe(observedAt.toISOString());
  });
});
