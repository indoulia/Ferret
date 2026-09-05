import { describe, expect, it } from 'vitest';

import { createNullLogger } from '../../src/logging/index.js';
import {
  DEFAULT_REVIEW_LIMIT,
  ProjectSynchronizer,
  SYNC_PRODUCER,
  type ProjectSyncOptions,
} from '../../src/project/index.js';
import { ProjectItemState, ProjectOperation } from '../../src/providers/contracts/source-project.js';
import type {
  ProjectIssue,
  ProjectPage,
  ProjectPullRequest,
  ProjectQuery,
  ProjectRateLimit,
  ProjectReview,
  ProjectSource,
} from '../../src/providers/contracts/source-project.js';
import type { EntityWriter, EvidenceWriter, RelationshipWriter, SyncCursors } from '../../src/indexing/index.js';

/**
 * EPIC-113 — the pass, without a tracker and without a database.
 *
 * The synchronizer is the one part of `ferret sync` that decides anything:
 * what to ask for, whether to advance the cursor, and in what order to write.
 * Every one of those decisions is testable against fakes, and testing them
 * here rather than through the CLI is what makes them assertable one at a time.
 *
 * What is *not* asserted here is that the records store — that needs
 * PostgreSQL's own constraints and lives in `project-sync.test.ts` under
 * `tests/integration/storage`.
 */

const ALL_OPERATIONS = [
  ProjectOperation.LIST_ISSUES,
  ProjectOperation.LIST_PULL_REQUESTS,
  ProjectOperation.LIST_REVIEWS,
];

function issue(id: string, title = 'An issue'): ProjectIssue {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title,
    state: 'open',
    lifecycle: ProjectItemState.OPEN,
    author: { identity: `U_${id}`, login: 'octocat' },
    labels: [],
  };
}

function pull(id: string, number: number): ProjectPullRequest {
  return {
    id,
    number,
    title: `Pull ${String(number)}`,
    state: 'open',
    lifecycle: ProjectItemState.OPEN,
    targetBranch: 'main',
    author: { identity: `U_${id}`, login: 'ada' },
    labels: [],
  };
}

function review(id: string, pullRequestId: string): ProjectReview {
  return { id, pullRequestId, state: 'APPROVED', approved: true, reviewer: { identity: 'U_r' } };
}

/** What each collection returned, and what it was asked. */
interface Script {
  readonly issues?: readonly ProjectPage<ProjectIssue>[];
  readonly pulls?: readonly ProjectPage<ProjectPullRequest>[];
  readonly reviews?: readonly ProjectPage<ProjectReview>[];
  readonly rateLimit?: ProjectRateLimit;
}

class FakeSource implements ProjectSource {
  readonly asked: ProjectQuery[] = [];
  readonly reviewedPulls: number[] = [];
  #issues = 0;
  #pulls = 0;
  #reviews = 0;

  constructor(private readonly script: Script) {}

  listIssues(query: ProjectQuery): Promise<ProjectPage<ProjectIssue>> {
    this.asked.push(query);
    const page = this.script.issues?.[this.#issues++] ?? { items: [] };
    return Promise.resolve(page);
  }

  listPullRequests(query: ProjectQuery): Promise<ProjectPage<ProjectPullRequest>> {
    this.asked.push(query);
    return Promise.resolve(this.script.pulls?.[this.#pulls++] ?? { items: [] });
  }

  listReviews(query: ProjectQuery & { pullRequest: number }): Promise<ProjectPage<ProjectReview>> {
    this.reviewedPulls.push(query.pullRequest);
    return Promise.resolve(this.script.reviews?.[this.#reviews++] ?? { items: [] });
  }

  rateLimit(): ProjectRateLimit | undefined {
    return this.script.rateLimit;
  }
}

interface Written {
  readonly entities: { id: string; ifAbsent: boolean }[];
  readonly relationships: string[];
  readonly evidence: string[];
  /** The order writes happened in, as `entity`/`relationship`/`evidence`. */
  readonly order: string[];
}

function writers(): {
  entities: EntityWriter;
  relationships: RelationshipWriter;
  evidence: EvidenceWriter;
  written: Written;
} {
  const written: Written = { entities: [], relationships: [], evidence: [], order: [] };
  return {
    written,
    entities: {
      upsert: (input, _now, options) => {
        written.order.push('entity');
        written.entities.push({
          id: `${input.kind}:${input.source.id}`,
          ifAbsent: options?.ifAbsent === true,
        });
        return Promise.resolve({
          entity: { id: `${input.kind}:${input.source.id}` } as never,
          outcome: 'created',
        });
      },
    },
    relationships: {
      assert: (input) => {
        written.order.push('relationship');
        written.relationships.push(input.type);
        return Promise.resolve({ relationship: {} as never, outcome: 'created' });
      },
    },
    evidence: {
      record: (input) => {
        written.order.push('evidence');
        written.evidence.push(String(input.statement));
        return Promise.resolve({
          evidence: {} as never,
          state: 'current',
          recordedAt: new Date().toISOString(),
          supersededBy: undefined,
          deduplicated: false,
        });
      },
    },
  };
}

/** A cursor store that remembers, so a second pass can read the first's position. */
function cursors(): SyncCursors & { position: Record<string, unknown> | undefined; producer: string | undefined } {
  const state = {
    position: undefined as Record<string, unknown> | undefined,
    producer: undefined as string | undefined,
    read: (): Promise<{ position: Readonly<Record<string, unknown>> } | undefined> =>
      Promise.resolve(state.position === undefined ? undefined : { position: state.position }),
    advance: (producer: string, _scope: string, position: Readonly<Record<string, unknown>>) => {
      state.producer = producer;
      state.position = { ...position };
      return Promise.resolve();
    },
  };
  return state;
}

function context(): { logger: ReturnType<typeof createNullLogger>; signal: AbortSignal } {
  return { logger: createNullLogger(), signal: new AbortController().signal };
}

function synchronizer(
  source: ProjectSource,
  options: {
    operations?: readonly string[];
    cursors?: SyncCursors;
    ports?: ReturnType<typeof writers>;
  } = {},
): { sync: (o: ProjectSyncOptions) => ReturnType<ProjectSynchronizer['sync']>; written: Written } {
  const ports = options.ports ?? writers();
  const instance = new ProjectSynchronizer({
    source,
    providerId: 'ferret.source.github',
    sourceSystem: 'github',
    operations: options.operations ?? ALL_OPERATIONS,
    entities: ports.entities,
    relationships: ports.relationships,
    evidence: ports.evidence,
    ...(options.cursors === undefined ? {} : { cursors: options.cursors }),
  });
  return {
    sync: (o: ProjectSyncOptions) => instance.sync(o, context()),
    written: ports.written,
  };
}

describe('one pass reads, models and writes — AC-1', () => {
  it('stores entities before relationships before evidence', async () => {
    const source = new FakeSource({
      issues: [{ items: [issue('I1')] }],
      pulls: [{ items: [pull('P1', 7)] }],
      reviews: [{ items: [review('R1', 'P1')] }],
    });
    const run = synchronizer(source);

    const report = await run.sync({ project: 'o/r' });

    expect(report.counts).toStrictEqual({ issues: 1, pullRequests: 1, reviews: 1 });
    expect(report.writes.entitiesCreated).toBeGreaterThan(0);
    expect(report.writes.relationships).toBeGreaterThan(0);
    expect(report.writes.evidenceRecorded).toBeGreaterThan(0);

    // The database has foreign keys; the reverse order fails on a project never
    // synchronized before. Asserted as a partition of the sequence rather than
    // as exact indices, so adding a record kind does not rewrite the test.
    const order = run.written.order;
    expect(order.lastIndexOf('entity')).toBeLessThan(order.indexOf('relationship'));
    expect(order.lastIndexOf('relationship')).toBeLessThan(order.indexOf('evidence'));
  });

  it('writes a gap-filling endpoint only when it is absent — issue #48', async () => {
    const source = new FakeSource({ pulls: [{ items: [pull('P1', 7)] }] });
    const run = synchronizer(source);

    await run.sync({ project: 'o/r' });

    // The target branch and the repository are emitted only so an edge has an
    // endpoint. A stub that overwrote a record an earlier run read in full is
    // the defect `ifAbsent` exists for.
    const guarded = run.written.entities.filter((one) => one.ifAbsent);
    expect(guarded.length).toBeGreaterThan(0);
    expect(guarded.some((one) => one.id.startsWith('branch:'))).toBe(true);
  });

  it('names a project, and refuses an empty one', async () => {
    const run = synchronizer(new FakeSource({}));
    await expect(run.sync({ project: '   ' })).rejects.toMatchObject({ code: 'E_USAGE' });
  });
});

describe('the cursor is what makes a second pass cheap — AC-2', () => {
  it('advances to the instant the pass started, and asks from it next time', async () => {
    const store = cursors();
    const source = new FakeSource({ issues: [{ items: [issue('I1')] }] });
    const run = synchronizer(source, { cursors: store });

    const first = await run.sync({ project: 'o/r' });
    expect(first.since).toBeUndefined();
    expect(first.cursorAdvancedTo).toBeDefined();
    expect(store.producer).toBe(SYNC_PRODUCER);

    const second = await run.sync({ project: 'o/r' });
    expect(second.since).toBe(first.cursorAdvancedTo);
    expect(source.asked.at(-1)?.since).toBe(first.cursorAdvancedTo);
  });

  it('ignores the cursor for a full pass, and does not pretend otherwise', async () => {
    const store = cursors();
    const source = new FakeSource({ issues: [{ items: [issue('I1')] }] });
    const run = synchronizer(source, { cursors: store });

    await run.sync({ project: 'o/r' });
    const full = await run.sync({ project: 'o/r', full: true });

    expect(full.since).toBeUndefined();
    expect(source.asked.at(-1)?.since).toBeUndefined();
  });

  it('does not advance when a page limit stopped the enumeration short — AC-3', async () => {
    const store = cursors();
    const source = new FakeSource({
      issues: [
        { items: [issue('I1')], cursor: 'page-2' },
        { items: [issue('I2')], cursor: 'page-3' },
      ],
    });
    const run = synchronizer(source, { cursors: store });

    const report = await run.sync({ project: 'o/r', pageLimit: 2 });

    expect(report.truncated).toBe(true);
    expect(report.cursorAdvancedTo).toBeUndefined();
    expect(store.position).toBeUndefined();
  });

  it('follows pagination to the end when it fits', async () => {
    const source = new FakeSource({
      issues: [{ items: [issue('I1')], cursor: 'page-2' }, { items: [issue('I2')] }],
    });
    const run = synchronizer(source);

    const report = await run.sync({ project: 'o/r', withPullRequests: false });

    expect(report.counts.issues).toBe(2);
    expect(report.truncated).toBe(false);
    expect(source.asked[1]?.cursor).toBe('page-2');
  });
});

describe('what the tracker cannot answer is named, never invented — AC-4', () => {
  it('never calls an operation the provider did not declare', async () => {
    const source = new FakeSource({ issues: [{ items: [issue('I1')] }] });
    const run = synchronizer(source, { operations: [ProjectOperation.LIST_ISSUES] });

    const report = await run.sync({ project: 'FER' });

    expect(report.unsupported).toContain('pullRequests');
    expect(report.counts.pullRequests).toBe(0);
    // Jira has no pull requests. Asking anyway and reading the empty page as
    // "there are none" is exactly the collapse EPIC-071 §8.2 refused.
    // Only `listIssues` was asked; the fake records every query it is given,
    // so one entry means one call.
    expect(source.asked.length).toBe(1);
    expect(source.reviewedPulls).toStrictEqual([]);
  });

  it('reports a conditional 304 as unchanged rather than as empty', async () => {
    const store = cursors();
    const source = new FakeSource({
      issues: [{ items: [issue('I1')], etag: 'W/"abc"' }, { items: [], unchanged: true }],
    });
    const run = synchronizer(source, { cursors: store });

    await run.sync({ project: 'o/r', withPullRequests: false });
    const second = await run.sync({ project: 'o/r', withPullRequests: false });

    expect(second.unchanged).toContain('issues');
    expect(source.asked.at(-1)?.etag).toBe('W/"abc"');
    // The etag survives, so a third pass can still ask conditionally.
    expect((store.position?.['etags'] as Record<string, string>)['issues']).toBe('W/"abc"');
  });

  it('bounds reviews, and says so when the bound bit', async () => {
    const pulls = Array.from({ length: DEFAULT_REVIEW_LIMIT + 2 }, (_, index) =>
      pull(`P${String(index)}`, index + 1),
    );
    const source = new FakeSource({ pulls: [{ items: pulls }] });
    const run = synchronizer(source);

    const report = await run.sync({ project: 'o/r', withIssues: false });

    expect(source.reviewedPulls.length).toBe(DEFAULT_REVIEW_LIMIT);
    expect(report.truncated).toBe(true);
    expect(report.cursorAdvancedTo).toBeUndefined();
  });

  it('carries the rate-limit budget through, and undefined when there is none', async () => {
    const budget = { limit: 5000, remaining: 4980 };
    const withBudget = synchronizer(new FakeSource({ rateLimit: budget }));
    expect((await withBudget.sync({ project: 'o/r' })).rateLimit).toStrictEqual(budget);

    const without = synchronizer(new FakeSource({}));
    expect((await without.sync({ project: 'o/r' })).rateLimit).toBeUndefined();
  });
});

describe('a dry run reads and writes nothing — AC-5', () => {
  it('models the records and stores none of them', async () => {
    const store = cursors();
    const source = new FakeSource({ issues: [{ items: [issue('I1')] }] });
    const run = synchronizer(source, { cursors: store });

    const report = await run.sync({ project: 'o/r', dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.counts.issues).toBe(1);
    expect(run.written.order).toStrictEqual([]);
    expect(report.cursorAdvancedTo).toBeUndefined();
    expect(store.position).toBeUndefined();
  });
});

describe('one malformed record does not fail a project — AC-6', () => {
  it('skips it, names it, and stores the rest', async () => {
    // An instant the canonical model refuses. Chosen over a missing field
    // because it fails in the *domain*, which is where §8.9's isolation has to
    // hold — a modelling failure, not a shape the contract already excludes.
    const broken = { ...issue('I_broken'), updatedAt: 'the day before yesterday' } as ProjectIssue;
    const source = new FakeSource({ issues: [{ items: [broken, issue('I_good')] }] });
    const run = synchronizer(source);

    const report = await run.sync({ project: 'o/r', withPullRequests: false });

    expect(report.counts.issues).toBe(2);
    expect(report.skipped.map((one) => one.id)).toContain('I_broken');
    expect(report.writes.entitiesCreated).toBeGreaterThan(0);
  });
});

describe('every project is scoped to one repository entity — AC-7', () => {
  it('derives the same id a foreign reference would', () => {
    const run = new ProjectSynchronizer({
      source: new FakeSource({}),
      providerId: 'ferret.source.github',
      sourceSystem: 'github',
      operations: ALL_OPERATIONS,
      ...writers(),
    });

    const first = run.repositoryIdFor('o/r');
    expect(run.repositoryIdFor('o/r')).toBe(first);
    expect(run.repositoryIdFor('o/other')).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
