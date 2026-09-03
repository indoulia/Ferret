import { describe, expect, it } from 'vitest';

import { ErrorCode } from '../../src/errors/index.js';
import {
  JIRA_PROVIDER_ID,
  JiraClient,
  createJiraProvider,
  documentText,
  jqlFor,
} from '../../src/jira/index.js';
import { Capability } from '../../src/providers/capabilities.js';
import { ProjectItemState, isProjectSource } from '../../src/providers/contracts/source-project.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import type { JiraProvider } from '../../src/jira/index.js';
import type { FetchLike, JiraResponse } from '../../src/jira/index.js';
import type { FerretError } from '../../src/errors/index.js';
import type { ProjectSource } from '../../src/providers/contracts/source-project.js';

/**
 * EPIC-071. The second implementation of `source.project`.
 *
 * The point of this suite is not that Jira works. It is that the contract
 * EPIC-021 wrote survived a provider it was not written against — and where it
 * did not, §17 records what changed.
 */

const TOKEN = 'ATATT-not-a-real-token';
const BASE = 'https://acme.atlassian.net';

interface Recorded {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

class Transport {
  readonly calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  readonly #responses: Recorded[];

  constructor(responses: readonly Recorded[]) {
    this.#responses = [...responses];
  }

  readonly fetch: FetchLike = (url, init) => {
    this.calls.push({ url, headers: init.headers });
    const recorded = this.#responses.shift() ?? { status: 200, body: {} };
    const headers = new Map(
      Object.entries(recorded.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const response: JiraResponse = {
      status: recorded.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      text: () => Promise.resolve(recorded.body === undefined ? '' : JSON.stringify(recorded.body)),
    };
    return Promise.resolve(response);
  };
}

async function provider(transport: Transport, options = {}): Promise<JiraProvider> {
  const instance = createJiraProvider({
    baseUrl: BASE,
    email: 'ada@example.com',
    token: TOKEN,
    fetch: transport.fetch,
    ...options,
  });
  await instance.initialize(context());
  return instance;
}

function context(): Parameters<JiraProvider['initialize']>[0] {
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
  id: '10042',
  key: 'FER-12',
  self: `${BASE}/rest/api/3/issue/10042`,
  fields: {
    summary: 'Index refuses a symlink',
    description: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps to ' }, { type: 'text', text: 'reproduce.' }] },
      ],
    },
    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    labels: ['bug'],
    created: '2026-01-02T03:04:05.000+0000',
    updated: '2026-01-03T03:04:05.000+0000',
    reporter: { accountId: 'acc-1', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' },
    assignee: { accountId: 'acc-2', displayName: 'Grace Hopper' },
  },
};

describe('Jira provider — the capability', () => {
  it('declares the two operations it implements, and no more', async () => {
    // Jira has no pull requests and no reviews. Declaring five and returning
    // empty pages would make "Jira has no pull requests" and "this project has
    // no pull requests" the same answer.
    const instance = await provider(new Transport([]));
    const declaration = instance.capabilities[0];
    expect(declaration?.capability).toBe(Capability.SOURCE_PROJECT);
    expect(declaration?.operations).toStrictEqual(['list-issues', 'list-comments']);
    // Through the interface, and by name rather than by reference: the concrete
    // class does not declare them at all, which is the stronger statement and
    // the one the compiler already makes.
    const asSource: ProjectSource = instance;
    for (const method of ['listPullRequests', 'listReviews', 'listReleases'] as const) {
      expect(typeof asSource[method]).toBe('undefined');
    }
  });

  it('satisfies the contract with two methods — the contract correction', () => {
    // `isProjectSource` required four methods until this Epic. It would have
    // refused this provider, which is how a contract "written for two
    // providers" gets tested.
    const instance = createJiraProvider({ baseUrl: BASE, fetch: new Transport([]).fetch });
    expect(isProjectSource(instance)).toBe(true);
  });

  it('is selectable by capability', () => {
    const registry = new ProviderRegistry();
    registry.register(createJiraProvider({ baseUrl: BASE, fetch: new Transport([]).fetch }));
    expect(registry.forCapability(Capability.SOURCE_PROJECT)?.id).toBe(JIRA_PROVIDER_ID);
  });

  it('reports no rate limit, because Jira publishes none', async () => {
    // `undefined` rather than a fabricated budget: a caller that cannot see a
    // limit should pace itself on `Retry-After`, and inventing numbers would
    // give it a reason not to.
    const instance = await provider(new Transport([]));
    expect(instance.rateLimit()).toBeUndefined();
  });
});

describe('Jira provider — mapping', () => {
  it('maps an issue, keeping the key a person quotes', async () => {
    const transport = new Transport([{ status: 200, body: { issues: [ISSUE], total: 1 } }]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    const issue = page.items[0];

    // The stable id, not the key: a Jira issue moved between projects gets a new
    // key and keeps its id — the property EPIC-072 §8.1 needs from an identity.
    expect(issue?.id).toBe('10042');
    expect(issue?.key).toBe('FER-12');
    expect(issue?.title).toBe('Index refuses a symlink');
    expect(issue?.author?.identity).toBe('acc-1');
    expect(issue?.assignees?.[0]?.displayName).toBe('Grace Hopper');
    expect(issue?.labels).toStrictEqual(['bug']);
  });

  it('reads the status category, and keeps the administrator word beside it', async () => {
    // "In Review" is a workflow column somebody named. Comparing those across
    // projects is meaningless; the category is Jira's own cross-project reading.
    const transport = new Transport([{ status: 200, body: { issues: [ISSUE], total: 1 } }]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    expect(page.items[0]?.state).toBe('In Review');
    expect(page.items[0]?.lifecycle).toBe(ProjectItemState.OPEN);
  });

  it('reads done as closed', async () => {
    const done = {
      ...ISSUE,
      fields: { ...ISSUE.fields, status: { name: 'Shipped', statusCategory: { key: 'done' } } },
    };
    const transport = new Transport([{ status: 200, body: { issues: [done], total: 1 } }]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    expect(page.items[0]?.lifecycle).toBe(ProjectItemState.CLOSED);
  });

  it('flattens an Atlassian document into text', () => {
    // A Cloud description is a tree, not a string. Formatting is presentation —
    // EPIC-027 §4's position for Word, applied here.
    expect(documentText(ISSUE.fields.description)).toBe('Steps to reproduce.');
    // A Server instance sends a plain string, which is the other branch.
    expect(documentText('plain text')).toBe('plain text');
    expect(documentText(undefined)).toBe('');
    expect(documentText({ type: 'doc' })).toBe('');
  });

  it('does not recurse for ever on a self-referential document', () => {
    const cyclic: { type: string; content: unknown[] } = { type: 'doc', content: [] };
    cyclic.content.push(cyclic);
    expect(() => documentText(cyclic)).not.toThrow();
  });

  it('maps comments to their issue key', async () => {
    const transport = new Transport([
      {
        status: 200,
        body: {
          comments: [{ id: '9001', body: 'A remark', author: { accountId: 'acc-1' } }],
          total: 1,
        },
      },
    ]);
    const instance = await provider(transport);
    const page = await instance.listComments(
      { project: 'FER', item: 'FER-12' },
      createTestOperationContext(),
    );
    expect(page.items[0]?.parentId).toBe('FER-12');
    expect(page.items[0]?.body).toBe('A remark');
  });
});

describe('Jira provider — JQL', () => {
  it('builds a project query ordered for stable paging', () => {
    // Ordering by anything else moves a page boundary as issues change, which
    // is what makes a resumed read skip or repeat.
    expect(jqlFor({ project: 'FER' })).toBe('project = FER ORDER BY updated ASC');
  });

  it('turns `since` into JQL, in the format JQL actually accepts', () => {
    // JQL rejects the `T` and the seconds — a small enough incompatibility to
    // miss and a total enough one to make every incremental query fail.
    expect(jqlFor({ project: 'FER', since: '2026-01-02T03:04:05.000Z' })).toContain(
      'updated >= "2026-01-02 03:04"',
    );
  });

  it('turns a state filter into a resolution clause', () => {
    expect(jqlFor({ project: 'FER', state: ProjectItemState.OPEN })).toContain(
      'resolution IS EMPTY',
    );
    expect(jqlFor({ project: 'FER', state: ProjectItemState.CLOSED })).toContain(
      'resolution IS NOT EMPTY',
    );
  });

  it('refuses a project key that is not one', () => {
    // The value reaches a query. A legitimate key never contains a quote.
    for (const bad of ['FER" OR "1"="1', 'a b', '', '../x']) {
      expect(() => jqlFor({ project: bad })).toThrow(/not a Jira project key/u);
    }
  });

  it('refuses an issue key that is not one, before a request', async () => {
    const transport = new Transport([]);
    const instance = await provider(transport);
    await expect(
      instance.listComments({ project: 'FER', item: 'not-a-key' }, createTestOperationContext()),
    ).rejects.toThrow(/not a Jira issue key/u);
    expect(transport.calls).toStrictEqual([]);
  });
});

describe('Jira provider — pagination', () => {
  it('pages by offset, and stops when the total is reached', async () => {
    const transport = new Transport([
      { status: 200, body: { issues: [ISSUE, ISSUE], total: 3 } },
      { status: 200, body: { issues: [ISSUE], total: 3 } },
    ]);
    const instance = await provider(transport);

    const first = await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    // A `startAt` offset, not a URL — which is what makes EPIC-021's decision
    // to keep a cursor opaque a correct one rather than a lucky one.
    expect(first.cursor).toBe('2');

    const second = await instance.listIssues(
      { project: 'FER', cursor: first.cursor ?? '' },
      createTestOperationContext(),
    );
    expect(second.cursor).toBeUndefined();
    expect(transport.calls[1]?.url).toContain('startAt=2');
  });

  it('has no cursor for an empty result', async () => {
    const transport = new Transport([{ status: 200, body: { issues: [], total: 0 } }]);
    const instance = await provider(transport);
    const page = await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    expect(page.items).toStrictEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  it('refuses a cursor it did not issue', async () => {
    const instance = await provider(new Transport([]));
    await expect(
      instance.listIssues({ project: 'FER', cursor: 'not-a-number' }, createTestOperationContext()),
    ).rejects.toThrow(/not a Jira page cursor/u);
  });

  it('names only the fields it reads', async () => {
    // A large instance's custom fields are megabytes Ferret does not read.
    const transport = new Transport([{ status: 200, body: { issues: [], total: 0 } }]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    expect(transport.calls[0]?.url).toContain('fields=summary');
  });
});

describe('Jira provider — the credential', () => {
  it('uses Basic for Cloud, because that is what Atlassian documents', async () => {
    const transport = new Transport([{ status: 200, body: { issues: [], total: 0 } }]);
    const instance = await provider(transport);
    await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    const expected = `Basic ${Buffer.from(`ada@example.com:${TOKEN}`, 'utf8').toString('base64')}`;
    expect(transport.calls[0]?.headers['authorization']).toBe(expected);
  });

  it('uses Bearer when there is no email, which is a Server token', async () => {
    // Decided from the credential's shape rather than a mode flag, so the two
    // cannot be configured inconsistently.
    const transport = new Transport([{ status: 200, body: { issues: [], total: 0 } }]);
    const instance = await provider(transport, { email: undefined });
    await instance.listIssues({ project: 'FER' }, createTestOperationContext());
    expect(transport.calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('declares the token as a secret option', () => {
    expect(createJiraProvider({ baseUrl: BASE }).secretOptions).toStrictEqual(['token']);
  });

  it('keeps the credential and the query out of every error', async () => {
    const transport = new Transport([
      { status: 401, body: { errorMessages: ['Client must be authenticated'] } },
    ]);
    const client = new JiraClient({
      baseUrl: BASE,
      fetch: transport.fetch,
      email: 'ada@example.com',
      token: TOKEN,
    });
    try {
      await client.get({
        path: '/rest/api/3/search',
        query: { jql: 'project = SECRETPROJECT' },
        signal: new AbortController().signal,
      });
      expect.unreachable('a 401 should throw');
    } catch (error) {
      const rendered = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(rendered).not.toContain(TOKEN);
      expect(rendered).not.toContain('SECRETPROJECT');
      expect((error as FerretError).code).toBe(ErrorCode.SOURCE_UNAUTHORIZED);
    }
  });
});

describe('Jira provider — failures', () => {
  const slept: number[] = [];
  const sleep = (milliseconds: number): Promise<void> => {
    slept.push(milliseconds);
    return Promise.resolve();
  };

  it('honours Retry-After on a 429', async () => {
    slept.length = 0;
    const transport = new Transport([
      { status: 429, headers: { 'retry-after': '2' }, body: { errorMessages: ['slow down'] } },
      { status: 200, body: { issues: [], total: 0 } },
    ]);
    const client = new JiraClient({ baseUrl: BASE, fetch: transport.fetch, sleep });
    await client.get({ path: '/x', signal: new AbortController().signal });
    expect(slept).toStrictEqual([2000]);
  });

  it('surfaces a long Retry-After rather than sleeping through it', async () => {
    slept.length = 0;
    const transport = new Transport([
      { status: 429, headers: { 'retry-after': '3600' }, body: { errorMessages: ['later'] } },
    ]);
    const client = new JiraClient({ baseUrl: BASE, fetch: transport.fetch, sleep });
    await expect(client.get({ path: '/x', signal: new AbortController().signal })).rejects.toThrow(
      /later/u,
    );
    expect(slept).toStrictEqual([]);
  });

  it('never retries a 403', async () => {
    const transport = new Transport([{ status: 403, body: { errorMessages: ['no'] } }]);
    const client = new JiraClient({ baseUrl: BASE, fetch: transport.fetch, sleep });
    await expect(client.get({ path: '/x', signal: new AbortController().signal })).rejects.toThrow(
      /403/u,
    );
    expect(transport.calls).toHaveLength(1);
  });

  it('retries a 503 and then fails as unavailable', async () => {
    const transport = new Transport([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    const client = new JiraClient({ baseUrl: BASE, fetch: transport.fetch, sleep });
    try {
      await client.get({ path: '/x', signal: new AbortController().signal });
      expect.unreachable('three 503s should throw');
    } catch (error) {
      expect((error as FerretError).code).toBe(ErrorCode.SOURCE_UNAVAILABLE);
      expect((error as FerretError).retryable).toBe(true);
    }
    expect(transport.calls).toHaveLength(3);
  });

  it('reports a rejected credential as degraded, not unavailable', async () => {
    const transport = new Transport([{ status: 401, body: { errorMessages: ['nope'] } }]);
    const instance = await provider(transport);
    const results = await instance.checkDependencies(context());
    expect(results[0]?.status).toBe('degraded');
    expect(results[0]?.remediation).toContain('personal access token');
  });
});

describe('Jira provider — what it will not do', () => {
  it('has no method that writes', () => {
    const client = new JiraClient({ baseUrl: BASE, fetch: new Transport([]).fetch });
    const methods = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(client) as object));
    expect(methods.has('get')).toBe(true);
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'request', 'transition']) {
      expect(methods.has(forbidden)).toBe(false);
    }
  });
});
