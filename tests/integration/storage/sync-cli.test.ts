import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * EPIC-113 — `ferret sync`, driving the built binary.
 *
 * The capability was already covered twice: the pass decides correctly against
 * fakes, and the records store against a real database. What neither could
 * assert is that an **operator can get at it** — that configuration reaches the
 * provider, that the token is read from where EPIC-015 puts it, and that the
 * `(planned)` entry is genuinely retired rather than shadowed.
 *
 * GitHub is a local HTTP server. That is not a compromise: `baseUrl` is a
 * supported option precisely so a GitHub Enterprise address can be configured,
 * so pointing it at `127.0.0.1` exercises the same code path a real deployment
 * does, and a test that reached github.com would be a flake with a rate limit.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;

interface Json {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: { code: string; message: string; remediation?: string };
}

let db: TestDatabase;
let server: Server;
let baseUrl: string;
let configPath: string;
/** Every path the fake API was asked for, in order. */
let requests: string[] = [];
/** Authorization headers seen, so a test can prove the token travelled. */
let authorizations: (string | undefined)[] = [];

const ISSUE = {
  node_id: 'I_kwDO1',
  number: 1,
  title: 'The symlink refusal is too broad',
  state: 'open',
  body: 'Reproduced on a junction.',
  html_url: 'https://example.invalid/o/r/issues/1',
  user: { node_id: 'U_1', login: 'octocat', type: 'User' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  labels: ['bug'],
};

const PULL = {
  node_id: 'PR_kwDO9',
  number: 9,
  title: 'Narrow the symlink refusal',
  state: 'open',
  body: 'Fixes #1',
  html_url: 'https://example.invalid/o/r/pull/9',
  user: { node_id: 'U_2', login: 'ada', type: 'User' },
  created_at: '2026-01-03T00:00:00Z',
  updated_at: '2026-01-04T00:00:00Z',
  base: { ref: 'main' },
  head: { ref: 'fix/symlink' },
  labels: [],
};

const REVIEW = {
  node_id: 'PRR_kwDO1',
  id: 55,
  state: 'APPROVED',
  user: { node_id: 'U_3', login: 'grace', type: 'User' },
  submitted_at: '2026-01-05T00:00:00Z',
};

function body(path: string): unknown {
  if (path.startsWith('/repos/o/r/pulls/9/reviews')) return [REVIEW];
  if (path.startsWith('/repos/o/r/pulls')) return [PULL];
  if (path.startsWith('/repos/o/r/issues')) return [ISSUE];
  if (path.startsWith('/rate_limit')) return { rate: { limit: 5000, remaining: 4999 } };
  return [];
}

async function sync(args: readonly string[]): Promise<{ code: number; json: Json; failure: string }> {
  const result = await runCli(['sync', ...args, '--json'], {
    env: { ...db.env, FERRET_CONFIG: configPath },
  });
  let json: Json = { ok: false, data: {} };
  try {
    json = JSON.parse(result.stdout) as Json;
  } catch {
    // Left as the failing default; the assertion reports the raw streams.
  }
  return {
    code: result.code,
    json,
    failure: `${json.error?.code ?? ''} ${json.error?.message ?? ''}${result.stderr}`,
  };
}

/** Writes the user configuration file the CLI will read. */
function configure(providers: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify({ version: 1, config: { providers } }), 'utf8');
}

describeDb(`ferret sync (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('sync-cli');
    const init = await runCli(['init', '--json'], { env: db.env });
    expect(init.code, init.stderr).toBe(0);

    server = createServer((request, response) => {
      const path = request.url ?? '';
      requests.push(path);
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body(path)));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;

    configPath = join(mkdtempSync(join(tmpdir(), 'ferret-sync-')), 'config.json');
    configure({});
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await db.drop();
  });

  describe('the command exists and is no longer planned — AC-11', () => {
    it('is advertised without the planned marker', async () => {
      const help = await runCli(['--help'], { env: db.env });

      expect(help.stdout).toContain('sync');
      expect(help.stdout).not.toMatch(/sync.*\(planned/);
    });

    it('no longer exits 5', async () => {
      const result = await sync(['o/r']);
      expect(result.json.error?.code).not.toBe('E_NOT_IMPLEMENTED');
    });
  });

  describe('an unconfigured Ferret says so, and syncs nothing — AC-12', () => {
    it('refuses with a remediation naming what to configure', async () => {
      const result = await sync(['o/r']);

      expect(result.code).not.toBe(0);
      expect(result.json.ok).toBe(false);
      expect(result.json.error?.code).toBe('E_CONFIG_INVALID');
      expect(result.json.error?.remediation).toContain('ferret.source.github');
    });
  });

  describe('a configured tracker is read, modelled and stored — AC-13', () => {
    beforeAll(() => {
      configure({
        'ferret.source.github': {
          enabled: true,
          options: {
            baseUrl,
            // The token as a secret reference, which is the whole point of
            // EPIC-015's mechanism: the configuration file names *where* the
            // credential is, and never holds one.
            token: { $secret: { env: 'FERRET_TEST_GITHUB_TOKEN' } },
            projects: ['o/r'],
          },
        },
      });
    });

    it('synchronizes the configured project with no argument at all', async () => {
      requests = [];
      authorizations = [];

      const result = await runCli(['sync', '--json'], {
        env: { ...db.env, FERRET_CONFIG: configPath, FERRET_TEST_GITHUB_TOKEN: 'ghp_notarealtoken1234' },
      });
      const json = JSON.parse(result.stdout) as Json;

      expect(result.code, result.stderr).toBe(0);
      expect(json.ok).toBe(true);

      const entries = json.data['entries'] as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      const report = entries[0]?.['report'] as Record<string, unknown>;
      expect(report['project']).toBe('o/r');
      expect(report['counts']).toMatchObject({ issues: 1, pullRequests: 1, reviews: 1 });
      expect((report['writes'] as Record<string, number>)['entitiesCreated']).toBeGreaterThan(0);

      // The token resolved from the environment through the `$secret` reference
      // and reached the request. Nothing about it is persisted — D-113.1 — and
      // the next invocation resolves it again.
      expect(authorizations.some((header) => header === 'Bearer ghp_notarealtoken1234')).toBe(true);
      expect(requests.some((path) => path.startsWith('/repos/o/r/issues'))).toBe(true);
      expect(requests.some((path) => path.startsWith('/repos/o/r/pulls/9/reviews'))).toBe(true);
    }, 60_000);

    it('never writes the token anywhere it could be read back', async () => {
      const stored = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ferret.entity
          WHERE attributes::text LIKE '%ghp_notarealtoken%'
             OR unknown_fields::text LIKE '%ghp_notarealtoken%'`,
      );
      expect(stored.rows[0]?.n).toBe('0');

      const cursors = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ferret.derived_artifact
          WHERE metadata::text LIKE '%ghp_%'`,
      );
      expect(cursors.rows[0]?.n).toBe('0');
    });

    it('advances a cursor, so the second pass asks only for what changed — AC-14', async () => {
      requests = [];
      const again = await runCli(['sync', '--json'], {
        env: { ...db.env, FERRET_CONFIG: configPath, FERRET_TEST_GITHUB_TOKEN: 'ghp_notarealtoken1234' },
      });
      expect(again.code, again.stderr).toBe(0);

      const asked = requests.find((path) => path.startsWith('/repos/o/r/issues'));
      expect(asked).toContain('since=');
    }, 60_000);

    it('reads and writes nothing on a dry run — AC-15', async () => {
      const before = await db.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM ferret.entity',
      );
      const result = await runCli(['sync', 'o/other', '--dry-run', '--json'], {
        env: { ...db.env, FERRET_CONFIG: configPath, FERRET_TEST_GITHUB_TOKEN: 'ghp_notarealtoken1234' },
      });
      const after = await db.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM ferret.entity',
      );

      expect(result.code, result.stderr).toBe(0);
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      const json = JSON.parse(result.stdout) as Json;
      expect(json.data['dryRun']).toBe(true);
    }, 60_000);

    it('refuses a review limit that is not a whole number — AC-16', async () => {
      const result = await sync(['o/r', '--review-limit', 'lots']);

      expect(result.code).not.toBe(0);
      expect(result.json.error?.code).toBe('E_USAGE');
      expect(result.json.error?.remediation).toContain('--review-limit');
    });

    it('reports reviews as complete when the ceiling did not bite — AC-17', async () => {
      const result = await runCli(['sync', 'o/r', '--json'], {
        env: { ...db.env, FERRET_CONFIG: configPath, FERRET_TEST_GITHUB_TOKEN: 'ghp_notarealtoken1234' },
      });
      expect(result.code, result.stderr).toBe(0);

      const report = (JSON.parse(result.stdout) as Json).data['entries'] as Array<
        Record<string, unknown>
      >;
      const entry = report[0]?.['report'] as Record<string, unknown>;
      // One pull request, one review fetched. `false` is a claim — every pull
      // request this pass read had its reviews fetched — and it is not the same
      // as having skipped reviews altogether.
      expect(entry['reviewsPartial']).toBe(false);
      expect(entry['truncated']).toBe(false);
    }, 120_000);

    it('says the pass is not a schedule', async () => {
      const result = await runCli(['sync', 'o/r'], {
        env: { ...db.env, FERRET_CONFIG: configPath, FERRET_TEST_GITHUB_TOKEN: 'ghp_notarealtoken1234' },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Ferret runs no timer');
    }, 60_000);
  });
});
