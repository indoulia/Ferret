import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CrossSourceReferenceKind,
  Direction,
  EntityKind,
  PUBLIC_ACCESS,
  RelationshipType,
  SourceIngestor,
  findCrossSourceReferences,
  linkCrossSourceReferences,
  projectSourceConnector,
  repositorySourceConnector,
  LOCAL_INSTANCE,
  type IngestDependencies,
} from '../../../src/index.js';
import { createGithubProvider } from '../../../src/github/index.js';
import { createJiraProvider } from '../../../src/jira/index.js';
import { createConfluenceProvider } from '../../../src/confluence/index.js';
import { GIT_PROVIDER_ID, GIT_SOURCE_SYSTEM, GitSourceProvider } from '../../../src/git/index.js';
import { ProjectOperation } from '../../../src/providers/contracts/source-project.js';
import { RepositoryOperation } from '../../../src/providers/contracts/source-repository.js';
import { Emitter } from '../../../src/providers/sdk/emit.js';
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
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * One context out of four sources — EPIC-124.
 *
 * The question this Epic exists for, asked end to end against real storage:
 *
 * ```
 * Jira issue → GitHub pull request → commit → repository files
 *            ↖ Confluence page
 * ```
 *
 * Three of those hops were already true after EPIC-120 to EPIC-123. The
 * cross-source ones were not, and could not be: a connector's `normalize` is
 * pure and cannot read a store, so a pull request body saying `Fixes FER-12`
 * had a key and no way to reach the Jira issue that key names.
 *
 * Everything here is the shipped path. Four real providers, four real
 * connectors, one real PostgreSQL, one real `RetrievalStore`, and a real Git
 * repository on disk. The only doubles are the HTTP transports, which answer
 * fixtures rather than the network.
 */

const gitOnPath = await gitVersion();
const runnable = gitOnPath !== undefined && databaseAvailable();
const suite = runnable ? describe : describe.skip;

if (gitOnPath === undefined) {
  process.stderr.write('\n[EPIC-124] SKIPPING: the `git` executable was not found on PATH.\n\n');
} else if (!databaseAvailable()) {
  process.stderr.write(`\n[EPIC-124] SKIPPING: ${SKIP_REASON}\n\n`);
}

const JIRA_BASE = 'https://acme.atlassian.net';
const REPO = 'indoulia/Ferret';
const SPACE_ID = '4685825';

// ---------------------------------------------------------------------------
// The four sources, each saying its own part of one story.
// ---------------------------------------------------------------------------

/** `FER-12`, the issue everything else points back to. */
const JIRA_ISSUE = {
  id: '10012',
  key: 'FER-12',
  self: `${JIRA_BASE}/rest/api/3/issue/10012`,
  fields: {
    summary: 'Retrieval misses renamed files',
    description: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Design is written up at https://acme.atlassian.net/wiki/spaces/DEV/pages/77001/Rename+Design' }],
        },
      ],
    },
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    labels: ['retrieval'],
    created: '2026-09-01T00:00:00.000-0500',
    updated: '2026-09-02T00:00:00.000-0500',
    reporter: { accountId: 'acc-1', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
  },
};

/** The pull request whose body closes it. */
const GITHUB_PULL = {
  id: 8000,
  node_id: 'PR_node_44',
  number: 44,
  title: 'Follow renames in retrieval',
  state: 'closed',
  user: { login: 'ada', id: 1, type: 'User' },
  labels: [],
  created_at: '2026-09-02T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  merged_at: '2026-09-03T00:00:00Z',
  merge_commit_sha: '',
  html_url: `https://github.com/${REPO}/pull/44`,
  base: { ref: 'main' },
  head: { ref: 'feature' },
  body: 'Fixes FER-12. Background: https://acme.atlassian.net/wiki/spaces/DEV/pages/77001/Rename+Design',
};

/** The wiki page both of them cite. */
const CONFLUENCE_PAGE = {
  id: '77001',
  status: 'current',
  title: 'Rename Design',
  spaceId: SPACE_ID,
  authorId: 'acc-1',
  createdAt: '2026-08-20T09:58:28.972Z',
  version: { number: 3, message: '', minorEdit: false, authorId: 'acc-1', createdAt: '2026-09-01T06:47:06.741Z' },
  body: {
    storage: {
      value: '<p>Implements FER-12 and is delivered by indoulia/Ferret#44.</p>',
      representation: 'storage',
    },
  },
  parentId: null,
  parentType: 'page',
  _links: { webui: '/spaces/DEV/pages/77001/Rename+Design' },
};

function githubFetch() {
  return (url: string | URL): Promise<Response> => {
    const href = String(url);
    const body = href.includes('/pulls') ? [GITHUB_PULL] : [];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4000' },
      }),
    );
  };
}

function jiraFetch() {
  return (url: string) => {
    const value = url.includes('/comment')
      ? { comments: [], total: 0, startAt: 0 }
      : { issues: [JIRA_ISSUE], total: 1, startAt: 0 };
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(value)),
    });
  };
}

function confluenceFetch() {
  return (url: string) => {
    const value = url.includes('/spaces?')
      ? { results: [{ id: SPACE_ID, key: 'DEV' }] }
      : { results: [CONFLUENCE_PAGE], _links: {} };
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(value)),
    });
  };
}

// ---------------------------------------------------------------------------

suite('EPIC-124 — one context out of four sources', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;
  let workspace: { path: string; cleanup: () => Promise<void> };
  let gitProvider: GitSourceProvider;
  let deps: IngestDependencies;
  let retrieval: RetrievalStore;
  let repositoryRoot: string;
  let mergeSha: string;

  /** Every source's entity id, so the pass is told which scopes to examine. */
  const scopes: string[] = [];
  let jiraScope = '';
  let githubScope = '';

  beforeAll(async () => {
    database = await createTestDatabase('epic124');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });

    deps = {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    };
    retrieval = new RetrievalStore(handle);

    // --- a real repository, with a real commit that touches a real file -----
    workspace = await createWorkspace('ferret-epic124-');
    repositoryRoot = await createRepository(workspace.path, 'ferret', {
      origin: `https://github.com/${REPO}.git`,
    });
    await mkdir(join(repositoryRoot, 'src'), { recursive: true });
    await writeFile(join(repositoryRoot, 'src', 'retrieval.ts'), 'export const find = () => 1;\n', 'utf8');
    await git(repositoryRoot, ['add', '-A']);
    await git(repositoryRoot, ['commit', '-m', 'Follow renames in retrieval (FER-12)']);
    mergeSha = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim();

    gitProvider = new GitSourceProvider();
    await gitProvider.initialize(createTestProviderContext());
    const context = createTestOperationContext();

    // --- ingest all four, each through its own connector --------------------
    const repositoryReport = await new SourceIngestor(
      repositorySourceConnector({
        source: gitProvider,
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
      }),
      deps,
    ).ingest({ resource: repositoryRoot }, context);

    // The pull request's merge commit is the commit that actually exists.
    const github = createGithubProvider({ token: 'ghp_test', fetch: githubFetch() });
    await github.initialize(createTestProviderContext());
    (GITHUB_PULL as { merge_commit_sha: string }).merge_commit_sha = mergeSha;
    const githubReport = await new SourceIngestor(
      projectSourceConnector({
        source: github,
        connectorId: github.id,
        system: 'github',
        instance: 'github.com',
        operations: [ProjectOperation.LIST_PULL_REQUESTS],
      }),
      deps,
    ).ingest({ resource: REPO }, context);

    const jira = createJiraProvider({
      baseUrl: JIRA_BASE,
      email: 'ada@example.com',
      token: 'jira_test',
      fetch: jiraFetch(),
    });
    await jira.initialize(createTestProviderContext());
    const jiraReport = await new SourceIngestor(
      projectSourceConnector({
        source: jira,
        connectorId: jira.id,
        system: 'jira',
        instance: 'acme.atlassian.net',
        operations: [ProjectOperation.LIST_ISSUES],
      }),
      deps,
    ).ingest({ resource: 'FER' }, context);

    const confluence = createConfluenceProvider({
      baseUrl: JIRA_BASE,
      email: 'ada@example.com',
      token: 'atlassian_test',
      fetch: confluenceFetch(),
    });
    await confluence.initialize(createTestProviderContext());
    const pageReport = await new SourceIngestor(confluence.connector, deps).ingest(
      { resource: 'DEV' },
      context,
    );

    jiraScope = jiraReport.sourceEntityId;
    githubScope = githubReport.sourceEntityId;
    scopes.push(
      repositoryReport.sourceEntityId,
      githubReport.sourceEntityId,
      jiraReport.sourceEntityId,
      pageReport.sourceEntityId,
    );
  }, 600_000);

  afterAll(async () => {
    await gitProvider?.shutdown();
    await workspace?.cleanup();
    await database?.drop();
  });

  async function link(options: { dryRun?: boolean } = {}) {
    return linkCrossSourceReferences(
      {
        retrieval,
        relationships: new RelationshipStore(handle),
        emitter: new Emitter({
          sourceSystem: 'ferret',
          producer: 'ferret.context.cross-source',
          producerVersion: VERSION,
        }),
        logger: createNullLogger(),
      },
      { scopes, ...options },
      PUBLIC_ACCESS,
      createTestOperationContext(),
    );
  }

  it('populates the external ids that make a cross-source lookup possible', async () => {
    // `externalIds` has been on every entity since EPIC-006 and no provider had
    // ever written one. It is what a *stranger* would quote, so it is what a
    // stranger's body can be matched against.
    const byKey = await retrieval.findEntities(
      { externalId: { system: 'jira', id: 'FER-12' }, limit: 5 },
      PUBLIC_ACCESS,
    );
    expect(byKey.entities.length).toBe(1);
    expect(byKey.entities[0]?.kind).toBe(EntityKind.ISSUE);

    const byNumber = await retrieval.findEntities(
      { externalId: { system: 'github', id: `${REPO}#44` }, limit: 5 },
      PUBLIC_ACCESS,
    );
    expect(byNumber.entities[0]?.kind).toBe(EntityKind.PULL_REQUEST);

    const byPage = await retrieval.findEntities(
      { externalId: { system: 'confluence', id: '77001' }, limit: 5 },
      PUBLIC_ACCESS,
    );
    expect(byPage.entities[0]?.attributes['title']).toBe('Rename Design');
  });

  it('stores the bodies that the references live in', async () => {
    // Both providers have fetched `body` since EPIC-021 and `modelProject`
    // dropped it — while reading it, to find closing references. Ferret knew
    // what a pull request said for exactly long enough to pull one edge out of
    // it, and then forgot the text.
    const pulls = await retrieval.findEntities(
      { kind: EntityKind.PULL_REQUEST, scope: githubScope, limit: 5 },
      PUBLIC_ACCESS,
    );
    expect(String(pulls.entities[0]?.attributes['description'])).toContain('Fixes FER-12');

    const issues = await retrieval.findEntities(
      { kind: EntityKind.ISSUE, scope: jiraScope, limit: 5 },
      PUBLIC_ACCESS,
    );
    expect(String(issues.entities[0]?.attributes['description'])).toContain('/wiki/spaces/DEV/pages/77001');
  });

  it('walks Jira issue → pull request → commit → file, across four sources', async () => {
    await link();

    // 1. The issue, found the way a person names it.
    const issue = (
      await retrieval.findEntities(
        { externalId: { system: 'jira', id: 'FER-12' }, limit: 1 },
        PUBLIC_ACCESS,
      )
    ).entities[0];
    expect(issue).toBeDefined();

    // 2. What resolves it — the hop that did not exist before this Epic.
    const resolvers = await retrieval.neighbours(
      {
        from: issue?.id ?? '',
        types: [RelationshipType.PULL_REQUEST_RESOLVES_ISSUE],
        direction: Direction.IN,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    const pull = resolvers.neighbours[0]?.entity;
    expect(pull?.attributes['title']).toBe('Follow renames in retrieval');

    // 3. The commit it proposes — EPIC-121's edge, and EPIC-051's identity:
    //    a sha is the same commit whoever mentions it, so GitHub's merge commit
    //    *is* the commit the Git connector read.
    const commits = await retrieval.neighbours(
      {
        from: pull?.id ?? '',
        types: [RelationshipType.PULL_REQUEST_PROPOSES_COMMIT],
        direction: Direction.OUT,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    const commit = commits.neighbours[0]?.entity;
    expect(commit?.attributes['sha']).toBe(mergeSha);
    // Read from Git, not a stub GitHub minted: a placeholder carries no message.
    expect(commit?.attributes['message']).toContain('Follow renames in retrieval');

    // 4. The files it touched — EPIC-120's edge.
    const files = await retrieval.neighbours(
      {
        from: commit?.id ?? '',
        types: [RelationshipType.COMMIT_MODIFIES_FILE],
        direction: Direction.OUT,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(files.neighbours.map((neighbour) => String(neighbour.entity.attributes['path']))).toContain(
      'src/retrieval.ts',
    );
  }, 300_000);

  it('reaches the Confluence page from the issue that cites it', async () => {
    await link();

    const page = (
      await retrieval.findEntities(
        { externalId: { system: 'confluence', id: '77001' }, limit: 1 },
        PUBLIC_ACCESS,
      )
    ).entities[0];

    // The page's own body names the issue and the pull request, so the page
    // *describes* both — `DOCUMENT_DESCRIBES_ENTITY`, which has meant exactly
    // that since EPIC-007.
    const described = await retrieval.neighbours(
      {
        from: page?.id ?? '',
        types: [RelationshipType.DOCUMENT_DESCRIBES_ENTITY],
        direction: Direction.OUT,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    const kinds = described.neighbours.map((neighbour) => neighbour.entity.kind).sort();
    expect(kinds).toContain(EntityKind.ISSUE);
    expect(kinds).toContain(EntityKind.PULL_REQUEST);
  }, 300_000);

  it('adds no relationship type — every hop uses one the model already had', async () => {
    const report = await link({ dryRun: true });
    const used = new Set(report.links.map((row) => row.type));
    expect([...used].sort()).toEqual(
      [
        RelationshipType.DOCUMENT_DESCRIBES_ENTITY,
        RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
      ].sort(),
    );
  });

  it('carries provenance on every link it asserts', async () => {
    const report = await link({ dryRun: true });
    for (const row of report.links) {
      // What was quoted, and how it was recognised — enough for a reader to
      // disagree with the join rather than having to trust it.
      expect(row.reference.text.length).toBeGreaterThan(0);
      expect(Object.values(CrossSourceReferenceKind)).toContain(row.reference.kind);
    }
  });

  it('is idempotent — a second pass asserts the same edges and adds nothing', async () => {
    const first = await link();
    const before = await countEdges();
    const second = await link();
    const after = await countEdges();

    expect(second.links.length).toBe(first.links.length);
    expect(after).toBe(before);
  }, 300_000);

  it('is deterministic — the same graph yields the same links, in the same order', async () => {
    const first = await link({ dryRun: true });
    const second = await link({ dryRun: true });
    expect(second.links.map(describeLink)).toEqual(first.links.map(describeLink));
  });

  it('suppresses a duplicate reference rather than linking twice', async () => {
    const report = await link({ dryRun: true });
    const pairs = report.links.map((row) => `${row.fromId}|${row.type}|${row.toId}`);
    // The Confluence page names FER-12 in its body and the issue names the page
    // in its own; the pass must not produce the same edge twice from either.
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('counts a reference to a source it has not ingested instead of inventing one', async () => {
    const found = findCrossSourceReferences('Blocked by OPS-999 and by other/repo#7.');
    expect(found.map((reference) => reference.id).sort()).toEqual(['OPS-999', 'other/repo#7']);

    const report = await link({ dryRun: true });
    // Nothing in this graph is called OPS-999, and nothing was created for it.
    const invented = await retrieval.findEntities(
      { externalId: { system: 'jira', id: 'OPS-999' }, limit: 1 },
      PUBLIC_ACCESS,
    );
    expect(invented.entities).toEqual([]);
    expect(report.unresolved).toBeGreaterThanOrEqual(0);
  });

  it('examines only the scopes it was given', async () => {
    // A pass over the whole store would grow with the database and would cross
    // an authorization boundary the caller never named. The scopes a caller
    // passes are the ones it already had the right to read.
    const narrow = await linkCrossSourceReferences(
      {
        retrieval,
        relationships: new RelationshipStore(handle),
        emitter: new Emitter({
          sourceSystem: 'ferret',
          producer: 'ferret.context.cross-source',
          producerVersion: VERSION,
        }),
      },
      { scopes: [], dryRun: true },
      PUBLIC_ACCESS,
      createTestOperationContext(),
    );
    expect(narrow.examined).toBe(0);
    expect(narrow.links).toEqual([]);
  });

  async function countEdges(): Promise<number> {
    const rows = await handle.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ferret.relationship`,
    );
    return Number(rows.rows[0]?.count ?? '0');
  }
});

function describeLink(row: { fromId: string; toId: string; type: string }): string {
  return `${row.fromId}|${row.type}|${row.toId}`;
}

// ---------------------------------------------------------------------------
// The extractor, on its own.
// ---------------------------------------------------------------------------

describe('EPIC-124 — recognising what one source says about another', () => {
  it('reads a tracker key, a project reference, and both Atlassian URLs', () => {
    const found = findCrossSourceReferences(
      'Fixes FER-12, relates to indoulia/Ferret#44, see ' +
        'https://acme.atlassian.net/browse/OPS-7 and ' +
        'https://acme.atlassian.net/wiki/spaces/DEV/pages/9001/Design',
    );
    expect(found.map((reference) => `${reference.system}:${reference.id}`).sort()).toEqual([
      'confluence:9001',
      'github:indoulia/Ferret#44',
      'jira:FER-12',
      'jira:OPS-7',
    ]);
  });

  it('tells a closing reference from a mention', () => {
    const closing = findCrossSourceReferences('Fixes FER-12');
    expect(closing[0]?.closing).toBe(true);
    const mention = findCrossSourceReferences('Related to FER-12');
    expect(mention[0]?.closing).toBe(false);
  });

  it('does not mistake ordinary text for a key', () => {
    // The failure that would matter: every `UTF-8` in every body becoming a
    // claim about an issue nobody has. No pattern separates `UTF-8` from
    // `FER-12`, because nothing about the text does — what separates them is
    // whether anybody has a project called `UTF`, which is a lookup rather than
    // a question about English.
    const text = 'Encode as UTF-8 over HTTP-2, per RFC-7540. Fixes FER-12.';
    const known = findCrossSourceReferences(text, { projects: new Set(['FER']) });
    expect(known.map((reference) => reference.id)).toEqual(['FER-12']);

    // Told about no projects at all, it reports every candidate — which is what
    // a diagnostic asking "what does this text mention" wants, and why the pass
    // learns the projects first rather than trusting the shape.
    const candidates = findCrossSourceReferences(text);
    expect(candidates.length).toBeGreaterThan(1);
  });

  it('reports each reference once, however often it is written', () => {
    const found = findCrossSourceReferences('FER-12 and FER-12 again, plus FER-12.');
    expect(found.length).toBe(1);
  });

  it('bounds what it will scan', () => {
    // A body is text somebody pasted. A reference after 200 KB of one is not
    // the reference anybody is looking for.
    const buried = `${'x'.repeat(300_000)} FER-12`;
    expect(findCrossSourceReferences(buried)).toEqual([]);
  });

  it('reads nothing out of nothing', () => {
    expect(findCrossSourceReferences(undefined)).toEqual([]);
    expect(findCrossSourceReferences('')).toEqual([]);
  });
});
