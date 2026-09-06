import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../../src/cli/exit-codes.js';
import { createNullLogger } from '../../../src/index.js';
import { migrate } from '../../../src/storage/index.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { parseEnvelope, runCli } from '../../helpers/cli.js';

/**
 * `ferret reconcile` end to end — EPIC-078.
 *
 * Through the CLI over **two real repositories**, because the property under
 * test is that one command reconciles what Ferret already knows: an operator
 * with six repositories writes one cron line, and adding a seventh needs no
 * cron change. A service-level test would prove the loop and not the claim.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeCli = runnable ? describe : describe.skip;

let db: TestDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let first: string;
let second: string;

interface Envelope {
  readonly ok: boolean;
  readonly data: {
    readonly entries: readonly {
      readonly repositoryId: string;
      readonly path: string;
      readonly outcome: string;
      readonly ageMs: number;
      readonly overdue: boolean;
      readonly failureCode?: string;
    }[];
    readonly indexed: number;
    readonly skipped: number;
    readonly failed: number;
    readonly applied: boolean;
  };
}

async function reconcile(args: readonly string[] = []): Promise<{ code: number; body: Envelope['data'] }> {
  const result = await runCli(['reconcile', '--json', ...args], { env: db.env });
  // Through `parseEnvelope`, so a run that timed out under load says so rather
  // than surfacing as `JSON.parse('')`. Observed once on 2026-09-06 in a
  // full-suite run that took 787s against a usual 520s; the command passes in
  // isolation, and what was missing was never the failure — it was the reason.
  return { code: result.code, body: parseEnvelope<Envelope>(result, 'reconcile').data };
}

/**
 * A path with one separator, for comparison.
 *
 * The report carries the path Git recorded, which on Windows uses backslashes,
 * while the fixture builds forward-slashed paths. Comparing the two verbatim
 * asserts a platform detail rather than the property under test.
 */
function samePath(value: string): string {
  return value.split('\\').join('/');
}

describeCli(`ferret reconcile (${runnable ? 'real PostgreSQL and git' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('reconcile');
    await migrate(db.pool, { logger: createNullLogger() });

    workspace = await createWorkspace('ferret-reconcile-');
    first = await createRepository(workspace.path, 'alpha', {
      origin: 'https://github.com/indoulia/alpha.git',
    });
    second = await createRepository(workspace.path, 'beta', {
      origin: 'https://github.com/indoulia/beta.git',
    });
    for (const repository of [first, second]) {
      await git(repository, ['commit', '--allow-empty', '-m', 'feat: something to index']);
    }

    const initialised = await runCli(['init', '--json'], { env: db.env });
    expect(initialised.code, initialised.stderr).toBe(0);
    // Indexed once each, so `reconcile` has something to *reconcile* — a pass
    // does not go looking for repositories, deliberately (§4).
    for (const repository of [first, second]) {
      const indexed = await runCli(['index', repository, '--json', '--no-changes'], { env: db.env });
      expect(indexed.code, indexed.stderr).toBe(0);
    }
  }, 300_000);

  afterAll(async () => {
    await workspace.cleanup();
    await db.drop();
  });

  it('reconciles every known repository without being given a path — AC-1', async () => {
    const { code, body } = await reconcile();

    expect(code).toBe(ExitCode.OK);
    expect(body.entries).toHaveLength(2);
    expect(body.entries.map((one) => one.outcome)).toStrictEqual(['indexed', 'indexed']);
    expect(body.indexed).toBe(2);
    expect(body.failed).toBe(0);
  }, 180_000);

  it('reports each repository by path, so a failure is attributable — AC-8, AC-12', async () => {
    const { body } = await reconcile();

    const paths = body.entries.map((one) => samePath(one.path));
    expect(paths).toContain(samePath(first));
    expect(paths).toContain(samePath(second));
    // AC-12 — the age is what makes a stopped schedule visible.
    for (const entry of body.entries) {
      expect(entry.ageMs).toBeGreaterThanOrEqual(0);
      expect(typeof entry.overdue).toBe('boolean');
    }
  }, 180_000);

  it('skips a repository indexed more recently than the threshold — AC-3, AC-4, AC-10', async () => {
    // Just reconciled, so a generous threshold skips both.
    const { code, body } = await reconcile(['--stale-after', '1h']);

    expect(body.entries.map((one) => one.outcome)).toStrictEqual(['fresh', 'fresh']);
    expect(body.skipped).toBe(2);
    // AC-4 — skipped is not indexed.
    expect(body.indexed).toBe(0);
    // AC-10 — a pass that skipped everything is the pass working.
    expect(code).toBe(ExitCode.OK);
  }, 180_000);

  it('attempts everything when no threshold is given — AC-5', async () => {
    const { body } = await reconcile();

    expect(body.entries.every((one) => one.outcome === 'indexed')).toBe(true);
  }, 180_000);

  it('reports the plan and indexes nothing with --dry-run — AC-17', async () => {
    const { code, body } = await reconcile(['--dry-run']);

    expect(code).toBe(ExitCode.OK);
    expect(body.applied).toBe(false);
    expect(body.entries.map((one) => one.outcome)).toStrictEqual(['planned', 'planned']);
    expect(body.indexed).toBe(0);
  }, 120_000);

  it('goes oldest first — AC-2', async () => {
    // `beta` is re-indexed on its own, so it becomes the fresher of the two and
    // must be attempted second.
    await runCli(['index', second, '--json', '--no-changes'], { env: db.env });

    const { body } = await reconcile(['--dry-run']);

    expect(samePath(body.entries[0]?.path ?? '')).toBe(samePath(first));
    expect(samePath(body.entries[1]?.path ?? '')).toBe(samePath(second));
  }, 180_000);

  it('reports a checkout that is not on this machine as elsewhere, not failed — AC-18', async () => {
    // A repository's path is deliberately *not* a canonical attribute:
    // `src/git/provider.ts` records that "where this checkout happens to live
    // is a fact about **this machine**". So a pass against a shared database
    // legitimately meets repositories it cannot reach, and calling those
    // failures would make every such pass exit non-zero for ever.
    const moved = await createRepository(workspace.path, 'delta', {
      origin: 'https://github.com/indoulia/delta.git',
    });
    await git(moved, ['commit', '--allow-empty', '-m', 'feat: about to move']);
    expect((await runCli(['index', moved, '--json', '--no-changes'], { env: db.env })).code).toBe(0);
    rmSync(moved, { recursive: true, force: true });

    const { code, body } = await reconcile();
    const elsewhere = body.entries.filter((one) => one.outcome === 'elsewhere');

    expect(elsewhere.map((one) => samePath(one.path))).toStrictEqual([samePath(moved)]);
    // Counted as a skip, and the pass is still a success.
    expect(body.failed).toBe(0);
    expect(code).toBe(ExitCode.OK);
  }, 240_000);

  it('keeps going when one repository fails, and names it — AC-7, AC-8, AC-11', async () => {
    // The path is here and is *not a repository*: a genuine failure, unlike a
    // checkout that simply lives on another machine.
    const broken = await createRepository(workspace.path, 'gamma', {
      origin: 'https://github.com/indoulia/gamma.git',
    });
    await git(broken, ['commit', '--allow-empty', '-m', 'feat: about to break']);
    expect((await runCli(['index', broken, '--json', '--no-changes'], { env: db.env })).code).toBe(0);
    rmSync(join(broken, '.git'), { recursive: true, force: true });

    const { code, body } = await reconcile();

    const failed = body.entries.filter((one) => one.outcome === 'failed');
    expect(failed.map((one) => samePath(one.path))).toStrictEqual([samePath(broken)]);
    // The code, never the message — EPIC-093's rule.
    expect(failed[0]?.failureCode).toBeDefined();

    // AC-7 — the healthy repositories still landed.
    expect(body.indexed).toBeGreaterThanOrEqual(2);
    // AC-11 — non-zero, so a scheduler's failure mail means something.
    expect(code).not.toBe(ExitCode.OK);
  }, 240_000);

  it('reconciles an empty index as a no-op — AC-16', async () => {
    const empty = await createTestDatabase('reconcile-empty');
    try {
      await migrate(empty.pool, { logger: createNullLogger() });
      const result = await runCli(['reconcile', '--json'], { env: empty.env });

      expect(result.code).toBe(ExitCode.OK);
      const body = (JSON.parse(result.stdout) as Envelope).data;
      expect(body.entries).toStrictEqual([]);
      expect(body.failed).toBe(0);
    } finally {
      await empty.drop();
    }
  }, 120_000);

  it('refuses a threshold it cannot read rather than guessing', async () => {
    // A silently-misparsed threshold is a pass that quietly does nothing, or
    // everything — both worse than a usage error.
    const result = await runCli(['reconcile', '--stale-after', 'soon', '--json'], { env: db.env });

    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stdout + result.stderr).toContain('not a duration');
  }, 120_000);

  it('names the scheduler rather than becoming one — AC-15', async () => {
    // §8.1, in the human rendering an operator setting this up will read.
    const result = await runCli(['reconcile', '--dry-run'], { env: db.env });
    expect(result.stdout).not.toContain('No repositories are indexed');

    expect(result.stdout).toContain('Ferret runs no timer');
    expect(result.stdout).toContain('cron');
  }, 120_000);
});
