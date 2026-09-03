import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ErrorCode, FerretError } from '../../src/errors/index.js';
import {
  GITHUB_API_VERSION,
  GITHUB_PROVIDER_ID,
  GithubClient,
  createGithubProvider,
} from '../../src/github/index.js';
import { Capability } from '../../src/providers/capabilities.js';
import { ProjectItemState, isProjectSource } from '../../src/providers/contracts/source-project.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import { RecordedTransport, healthyRateLimit } from '../support/github-transport.js';
import type { GithubProvider } from '../../src/github/index.js';

/**
 * EPIC-021. The GitHub provider, against a recorded transport.
 *
 * §16 is honest about what this cannot prove: nothing here has spoken to
 * GitHub. What it does prove is every protocol behaviour the provider is
 * responsible for, which is the part a live test would be worst at asserting.
 */

const TOKEN = 'ghp_notarealtokenbutlongenoughtolookliketone';

async function provider(transport: RecordedTransport, options = {}): Promise<GithubProvider> {
  const instance = createGithubProvider({ token: TOKEN, fetch: transport.fetch, ...options });
  const registry = new ProviderRegistry();
  registry.register(instance);
  await instance.initialize(testProviderContext());
  return instance;
}

function testProviderContext(): Parameters<GithubProvider['initialize']>[0] {
  const operation = createTestOperationContext();
  return {
    logger: operation.logger,
    config: {} as never,
    environment: {} as never,
    settings: { enabled: true, options: {} },
    signal: operation.signal,
  };
}

const ISSUE = {
  node_id: 'I_kwDO123',
  number: 7,
  title: 'Index refuses a symlink',
  body: 'Steps to reproduce…',
  state: 'open',
  html_url: 'https://github.com/o/r/issues/7',
  user: { node_id: 'U_abc', login: 'octocat', name: 'Mona' },
  assignees: [{ node_id: 'U_def', login: 'hubot' }],
  labels: [{ name: 'bug' }, 'defect'],
  created_at: '2026-01-02T03:04:05Z',
  updated_at: '2026-01-03T03:04:05Z',
};

const PULL = {
  node_id: 'PR_kwDO456',
  number: 12,
  title: 'Fix the symlink refusal',
  state: 'closed',
  merged_at: '2026-02-01T00:00:00Z',
  merge_commit_sha: 'abc123',
  head: { ref: 'fix/symlink' },
  base: { ref: 'main' },
  draft: false,
  user: { node_id: 'U_abc', login: 'octocat' },
  requested_reviewers: [{ node_id: 'U_ghi', login: 'reviewer' }],
  labels: [],
};

describe('GitHub provider — the capability', () => {
  it('declares source.project with the operations it implements — AC-1', async () => {
    const instance = await provider(new RecordedTransport([]));
    const declaration = instance.capabilities[0];
    expect(declaration?.capability).toBe(Capability.SOURCE_PROJECT);
    // Five at EPIC-021, seven since EPIC-073 added deployments. Named per
    // operation rather than claimed wholesale, so the next one added does not
    // arrive already claimed.
    expect(declaration?.operations).toStrictEqual([
      'list-issues',
      'list-pull-requests',
      'list-reviews',
      'list-comments',
      'list-releases',
      'list-deployments',
      'list-deployment-statuses',
    ]);
    expect(isProjectSource(instance)).toBe(true);
  });

  it('is selectable by capability, never by name — AC-1', () => {
    const registry = new ProviderRegistry();
    registry.register(createGithubProvider({ fetch: new RecordedTransport([]).fetch }));
    expect(registry.forCapability(Capability.SOURCE_PROJECT)?.id).toBe(GITHUB_PROVIDER_ID);
  });
});

describe('GitHub provider — mapping', () => {
  it('maps an issue onto the contract — AC-2', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [ISSUE], headers: healthyRateLimit() },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());

    expect(page.items).toHaveLength(1);
    const issue = page.items[0];
    expect(issue?.id).toBe('I_kwDO123');
    expect(issue?.number).toBe(7);
    expect(issue?.lifecycle).toBe(ProjectItemState.OPEN);
    expect(issue?.author?.login).toBe('octocat');
    expect(issue?.author?.displayName).toBe('Mona');
    // Labels arrive as objects or as strings depending on the endpoint.
    expect(issue?.labels).toStrictEqual(['bug', 'defect']);
    expect(issue?.assignees?.[0]?.identity).toBe('U_def');
  });

  it('does not report a pull request as an issue — AC-3', async () => {
    // GitHub's issues endpoint returns pull requests, because in its model a
    // pull request *is* an issue. Without the filter every one is counted twice.
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [ISSUE, { ...PULL, state: 'open', pull_request: { url: 'https://…' } }],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.items.map((item) => item.number)).toStrictEqual([7]);
  });

  it('reports a merged pull request as merged, not closed — AC-4', async () => {
    // `merged` is not a GitHub state: the API says `closed` and carries
    // `merged_at`. Reporting `closed` would erase what EPIC-072 exists to model.
    const transport = new RecordedTransport([
      { status: 200, body: [PULL], headers: healthyRateLimit() },
    ]);
    const instance = await provider(transport);
    const page = await instance.listPullRequests({ project: 'o/r' }, createTestOperationContext());
    const pull = page.items[0];
    expect(pull?.state).toBe('closed');
    expect(pull?.lifecycle).toBe(ProjectItemState.MERGED);
    expect(pull?.mergeCommit).toBe('abc123');
    expect(pull?.sourceBranch).toBe('fix/symlink');
    expect(pull?.targetBranch).toBe('main');
    expect(pull?.requestedReviewers?.[0]?.login).toBe('reviewer');
  });

  it('reports a closed, unmerged pull request as closed — AC-4', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [{ ...PULL, merged_at: null, merge_commit_sha: null }],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listPullRequests({ project: 'o/r' }, createTestOperationContext());
    expect(page.items[0]?.lifecycle).toBe(ProjectItemState.CLOSED);
  });

  it('treats only APPROVED as approval — AC-15', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [
          { node_id: 'R_1', state: 'APPROVED', user: { node_id: 'U_a' } },
          { node_id: 'R_2', state: 'CHANGES_REQUESTED', user: { node_id: 'U_b' } },
          { node_id: 'R_3', state: 'COMMENTED', user: { node_id: 'U_c' } },
          { node_id: 'R_4', state: 'DISMISSED', user: { node_id: 'U_d' } },
        ],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listReviews(
      { project: 'o/r', pullRequest: 12 },
      createTestOperationContext(),
    );
    expect(page.items.map((review) => review.approved)).toStrictEqual([true, false, false, false]);
    expect(page.items[0]?.pullRequestId).toBe('o/r#12');
  });

  it('keys an actor on node_id, not on login — AC-16', async () => {
    // GitHub lets an account be renamed and the name reused. Keying on `login`
    // would silently merge two people.
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [{ ...ISSUE, user: { node_id: 'U_stable', login: 'renamed-since' } }],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.items[0]?.author?.identity).toBe('U_stable');
    expect(page.items[0]?.author?.login).toBe('renamed-since');
  });

  it('falls back to the numeric id when an old server sends no node_id — AC-16', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [{ ...ISSUE, node_id: undefined, user: { id: 42, login: 'old' } }],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.items[0]?.author?.identity).toBe('github:42');
    expect(page.items[0]?.id).toBe('o/r#7');
  });

  it('maps comments and releases — AC-2', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [{ node_id: 'C_1', body: 'A remark', user: { node_id: 'U_a' } }],
        headers: healthyRateLimit(),
      },
      {
        status: 200,
        body: [{ node_id: 'RE_1', tag_name: 'v1.2.0', name: 'Spring', prerelease: false }],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const comments = await instance.listComments(
      { project: 'o/r', item: 7 },
      createTestOperationContext(),
    );
    expect(comments.items[0]?.parentId).toBe('o/r#7');
    expect(comments.items[0]?.body).toBe('A remark');

    const releases = await instance.listReleases({ project: 'o/r' }, createTestOperationContext());
    expect(releases.items[0]?.tag).toBe('v1.2.0');
    expect(releases.items[0]?.name).toBe('Spring');
  });
});

describe('GitHub provider — deployments (EPIC-073)', () => {
  it('declares both deployment operations — AC-12', async () => {
    const instance = await provider(new RecordedTransport([]));
    expect(instance.capabilities[0]?.operations).toContain('list-deployments');
    expect(instance.capabilities[0]?.operations).toContain('list-deployment-statuses');
  });

  it('lists deployments in one request, without their statuses — AC-13', async () => {
    // A deployment's outcome is a separate collection. Filling it in here would
    // cost one request per deployment against somebody else's rate limit.
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [
          {
            node_id: 'DE_1',
            sha: 'c'.repeat(40),
            ref: 'v2.0.0',
            environment: 'production',
            production_environment: true,
            created_at: '2026-02-02T00:00:00Z',
          },
        ],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listDeployments({ project: 'o/r' }, createTestOperationContext());
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toContain('/repos/o/r/deployments');
    const deployment = page.items[0];
    expect(deployment?.id).toBe('DE_1');
    expect(deployment?.revision).toBe('c'.repeat(40));
    expect(deployment?.ref).toBe('v2.0.0');
    expect(deployment?.production).toBe(true);
    // No state: the record does not carry one, and inventing it here is what
    // §8.4 refuses.
    expect('state' in (deployment ?? {})).toBe(false);
  });

  it('maps GitHub seven status states onto the contract five — AC-14', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [
          { node_id: 'S1', state: 'success' },
          { node_id: 'S2', state: 'failure' },
          { node_id: 'S3', state: 'error' },
          { node_id: 'S4', state: 'in_progress' },
          { node_id: 'S5', state: 'queued' },
          { node_id: 'S6', state: 'pending' },
          { node_id: 'S7', state: 'inactive' },
        ],
        headers: healthyRateLimit(),
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listDeploymentStatuses(
      { project: 'o/r', deployment: '42' },
      createTestOperationContext(),
    );
    expect(page.items.map((one) => one.lifecycle)).toStrictEqual([
      'succeeded',
      // `error` and `failure` differ by *who* failed, which Ferret has no use
      // for; `queued` and `pending` are both "not started".
      'failed',
      'failed',
      'in-progress',
      'pending',
      'pending',
      // Superseded, not failed. Counting it as a failure would be wrong in the
      // direction that matters.
      'inactive',
    ]);
    expect(page.items[0]?.deploymentId).toBe('42');
    // The vendor's own word is kept beside the comparable reading.
    expect(page.items.map((one) => one.state)).toContain('error');
  });

  it('refuses a project name on the deployment paths too — AC-17', async () => {
    const transport = new RecordedTransport([]);
    const instance = await provider(transport);
    await expect(
      instance.listDeployments({ project: '../../etc' }, createTestOperationContext()),
    ).rejects.toThrow(/owner\/repository/u);
    expect(transport.calls).toStrictEqual([]);
  });
});

describe('GitHub provider — pagination', () => {
  it('returns the server link as the cursor — AC-5', async () => {
    const next = 'https://api.github.com/repositories/1/issues?page=2';
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [ISSUE],
        headers: { ...healthyRateLimit(), link: `<${next}>; rel="next", <…>; rel="last"` },
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.cursor).toBe(next);
  });

  it('has no cursor on the last page — AC-5', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [ISSUE], headers: { ...healthyRateLimit(), link: '<…>; rel="prev"' } },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.cursor).toBeUndefined();
  });

  it('follows a cursor verbatim, appending nothing — AC-6', async () => {
    const cursor = 'https://api.github.com/repositories/1/issues?page=2&per_page=100';
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit() },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r', cursor }, createTestOperationContext());
    // The server's URL already carries its parameters. Appending this call's
    // would re-sort a page the server had already ordered.
    expect(transport.calls[0]?.url).toBe(cursor);
  });

  it('pages through the client until the links run out — AC-5', async () => {
    const transport = new RecordedTransport([
      {
        status: 200,
        body: [1],
        headers: { ...healthyRateLimit(), link: '<https://api.github.com/x?page=2>; rel="next"' },
      },
      { status: 200, body: [2], headers: healthyRateLimit() },
    ]);
    const client = new GithubClient({ fetch: transport.fetch, token: TOKEN });
    const seen: number[][] = [];
    for await (const page of client.paginate<number>({
      path: '/x',
      signal: new AbortController().signal,
    })) {
      seen.push(page.body ?? []);
    }
    expect(seen).toStrictEqual([[1], [2]]);
    expect(transport.remaining).toBe(0);
  });
});

describe('GitHub provider — the rate limit', () => {
  it('records what the response said — AC-7', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit(4_321) },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    const limit = instance.rateLimit();
    expect(limit?.limit).toBe(5_000);
    expect(limit?.remaining).toBe(4_321);
    expect(limit?.reserved).toBe(100);
    expect(limit?.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('refuses before sending when the reserve is reached — AC-8', async () => {
    // Checked before the request, not after: a check that ran afterwards would
    // report the exhaustion it had just caused.
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit(50) },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    const callsAfterFirst = transport.calls.length;

    await expect(
      instance.listIssues({ project: 'o/r' }, createTestOperationContext()),
    ).rejects.toThrow(/rate limit nearly exhausted/u);
    // The refusal cost no request, which is the point.
    expect(transport.calls).toHaveLength(callsAfterFirst);
  });

  it('names the reset and is retryable — AC-8', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit(1) },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    try {
      await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
      expect.unreachable('the second call should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(FerretError);
      const ferret = error as FerretError;
      expect(ferret.code).toBe(ErrorCode.SOURCE_UNAVAILABLE);
      expect(ferret.retryable).toBe(true);
      expect(ferret.remediation).toContain('Wait until');
    }
  });

  it('spends a smaller reserve when one is configured', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit(50) },
      { status: 200, body: [], headers: healthyRateLimit(49) },
    ]);
    const instance = await provider(transport, { rateLimitReserve: 10 });
    await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    await expect(
      instance.listIssues({ project: 'o/r' }, createTestOperationContext()),
    ).resolves.toBeDefined();
  });
});

describe('GitHub provider — conditional requests', () => {
  it('sends If-None-Match when given an etag — AC-10', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: { ...healthyRateLimit(), etag: 'W/"abc"' } },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r', etag: 'W/"abc"' }, createTestOperationContext());
    expect(transport.calls[0]?.headers['if-none-match']).toBe('W/"abc"');
  });

  it('reports a 304 as unchanged, not as an empty page — AC-9', async () => {
    // "Nothing exists" and "nothing changed" must not be the same answer: an
    // incremental sync built on the first would delete everything.
    const transport = new RecordedTransport([
      { status: 304, headers: { ...healthyRateLimit(), etag: 'W/"abc"' } },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues(
      { project: 'o/r', etag: 'W/"abc"' },
      createTestOperationContext(),
    );
    expect(page.unchanged).toBe(true);
    expect(page.items).toStrictEqual([]);
    expect(page.etag).toBe('W/"abc"');
  });

  it('returns the etag so a caller can send it back — AC-10', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [ISSUE], headers: { ...healthyRateLimit(), etag: 'W/"xyz"' } },
    ]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    expect(page.etag).toBe('W/"xyz"');
  });
});

describe('GitHub provider — failures', () => {
  const slept: number[] = [];
  const sleep = (milliseconds: number): Promise<void> => {
    slept.push(milliseconds);
    return Promise.resolve();
  };

  it('honours Retry-After up to the bound — AC-11', async () => {
    slept.length = 0;
    const transport = new RecordedTransport([
      { status: 403, headers: { 'retry-after': '2' }, body: { message: 'secondary rate limit' } },
      { status: 200, body: [ISSUE], headers: healthyRateLimit() },
    ]);
    const client = new GithubClient({ fetch: transport.fetch, sleep });
    const result = await client.get<unknown[]>({
      path: '/x',
      signal: new AbortController().signal,
    });
    expect(slept).toStrictEqual([2000]);
    expect(result.body).toHaveLength(1);
  });

  it('surfaces a Retry-After beyond the bound rather than sleeping — AC-11', async () => {
    slept.length = 0;
    const transport = new RecordedTransport([
      { status: 403, headers: { 'retry-after': '3600' }, body: { message: 'come back later' } },
    ]);
    const client = new GithubClient({ fetch: transport.fetch, sleep });
    await expect(
      client.get({ path: '/x', signal: new AbortController().signal }),
    ).rejects.toThrow(/come back later/u);
    // An hour is not a retry, it is a hang. The caller decides.
    expect(slept).toStrictEqual([]);
  });

  it('fails a 401 as unauthorized and never retries — AC-12', async () => {
    const transport = new RecordedTransport([
      { status: 401, body: { message: 'Bad credentials' } },
    ]);
    const client = new GithubClient({ fetch: transport.fetch, token: TOKEN, sleep });
    try {
      await client.get({ path: '/x', signal: new AbortController().signal });
      expect.unreachable('a 401 should throw');
    } catch (error) {
      const ferret = error as FerretError;
      expect(ferret.code).toBe(ErrorCode.SOURCE_UNAUTHORIZED);
      expect(ferret.retryable).toBe(false);
      expect(ferret.remediation).toContain('token');
    }
    // Retrying a 401 is how a machine gets blocked.
    expect(transport.calls).toHaveLength(1);
  });

  it('retries a 5xx, then fails as unavailable — AC-13', async () => {
    slept.length = 0;
    const transport = new RecordedTransport(
      [
        { status: 503, body: { message: 'no' } },
        { status: 503, body: { message: 'no' } },
        { status: 503, body: { message: 'still no' } },
      ],
      { status: 503, body: { message: 'still no' } },
    );
    const client = new GithubClient({ fetch: transport.fetch, sleep });
    try {
      await client.get({ path: '/x', signal: new AbortController().signal });
      expect.unreachable('three 503s should throw');
    } catch (error) {
      const ferret = error as FerretError;
      expect(ferret.code).toBe(ErrorCode.SOURCE_UNAVAILABLE);
      expect(ferret.retryable).toBe(true);
    }
    expect(transport.calls).toHaveLength(3);
  });

  it('refuses a project name that is not owner/repo — AC-17', async () => {
    const transport = new RecordedTransport([]);
    const instance = await provider(transport);
    for (const name of ['../../etc', 'owner', 'a/b/c', 'owner/repo?x=1']) {
      await expect(
        instance.listIssues({ project: name }, createTestOperationContext()),
      ).rejects.toThrow(/owner\/repository/u);
    }
    // Refused before a request, which is the whole point of validating it.
    expect(transport.calls).toStrictEqual([]);
  });
});

describe('GitHub provider — the credential', () => {
  it('sends the token as a bearer, with the pinned API version', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit() },
    ]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'o/r' }, createTestOperationContext());
    const headers = transport.calls[0]?.headers ?? {};
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['x-github-api-version']).toBe(GITHUB_API_VERSION);
  });

  it('declares the token as a secret option — AC-14', () => {
    // Redaction by key name cannot know that `token` is a credential. Declaring
    // the path is what makes `describeConfig` redact it.
    expect(createGithubProvider().secretOptions).toStrictEqual(['token']);
  });

  it('keeps the token out of every error — AC-14', async () => {
    const transport = new RecordedTransport([
      { status: 401, body: { message: 'Bad credentials' } },
    ]);
    const client = new GithubClient({ fetch: transport.fetch, token: TOKEN });
    try {
      await client.get({ path: '/x?q=secret-search', signal: new AbortController().signal });
      expect.unreachable('a 401 should throw');
    } catch (error) {
      const rendered = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(rendered).not.toContain(TOKEN);
      // Nor the query, which a caller could have put anything into.
      expect(rendered).not.toContain('secret-search');
    }
  });

  it('works without a token, as an unauthenticated caller', async () => {
    const transport = new RecordedTransport([
      { status: 200, body: [], headers: healthyRateLimit() },
    ]);
    const client = new GithubClient({ fetch: transport.fetch });
    await client.get({ path: '/x', signal: new AbortController().signal });
    expect(transport.calls[0]?.headers['authorization']).toBeUndefined();
  });
});

describe('GitHub provider — what it will not do', () => {
  it('has no method that writes — AC-18', () => {
    // The HTTP method is not a parameter, so a future caller cannot make it one
    // by accident. EPIC-069's reasoning about destructive tools, one layer down.
    const client = new GithubClient({ fetch: new RecordedTransport([]).fetch });
    const methods = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object),
    ]);
    expect(methods.has('get')).toBe(true);
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'request', 'send']) {
      expect(methods.has(forbidden)).toBe(false);
    }

    const source = readFileSync(
      fileURLToPath(new URL('../../src/github/client.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("method: 'GET'");
    expect(source.replaceAll(/^\s*\*.*$/gmu, '')).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/u);
  });

  it('checks reachability without spending budget — AC-19', async () => {
    // `/rate_limit` is the one endpoint that costs nothing, so a health check
    // cannot become the reason a budget ran out.
    const transport = new RecordedTransport([
      { status: 200, body: { rate: {} }, headers: healthyRateLimit(4_999) },
    ]);
    const instance = await provider(transport);
    const results = await instance.checkDependencies(testProviderContext());
    expect(transport.calls[0]?.url).toContain('/rate_limit');
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.detail).toContain('4999');
  });

  it('reports a rejected token as degraded rather than unavailable — AC-19', async () => {
    const transport = new RecordedTransport([
      { status: 401, body: { message: 'Bad credentials' } },
    ]);
    const instance = await provider(transport);
    const results = await instance.checkDependencies(testProviderContext());
    // GitHub answered. The difference is what tells an operator to look at the
    // token rather than at the network.
    expect(results[0]?.status).toBe('degraded');
    expect(results[0]?.remediation).toContain('token');
  });
});
