import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import { runCli } from '../../helpers/cli.js';

/**
 * EPIC-110 — `ferret session`, the surface that finally reaches the store.
 *
 * EPIC-109 made session context durable and left it reachable only as a
 * library; this is the command, and these cases drive the real binary against a
 * real database rather than calling the store directly. That is the point of
 * them: the capability was already tested, and what was never tested was that
 * an operator could get at it.
 *
 * Every case asserts the `--json` shape, because EPIC-111 will expose these as
 * MCP tools from the same surface and a human-text-only command would force a
 * second implementation.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;

let db: TestDatabase;

interface Json {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: { code: string; message: string; remediation?: string };
}

/**
 * Runs a subcommand under `--json`.
 *
 * A failure is a JSON document on **stdout** with `ok: false`, not a line on
 * stderr — EPIC-001's contract is one JSON document per invocation whichever
 * way it went, so a caller parses one stream and never scrapes two.
 */
async function session(args: readonly string[]): Promise<{ code: number; json: Json; failure: string }> {
  const result = await runCli(['session', ...args, '--json'], { env: db.env });
  let json: Json = { ok: false, data: {} };
  try {
    json = JSON.parse(result.stdout) as Json;
  } catch {
    // Left as the failing default; the assertion reports the raw streams.
  }
  const failure = `${json.error?.message ?? ''} ${json.error?.remediation ?? ''}${result.stderr}`;
  return { code: result.code, json, failure };
}

/** Starts a session and returns its id. */
async function started(...args: readonly string[]): Promise<string> {
  const result = await session(['start', ...args]);
  expect(result.code, result.failure).toBe(0);
  return result.json.data['sessionId'] as string;
}

describeDb(`ferret session (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('session-cli');
    const init = await runCli(['init', '--json'], { env: db.env });
    expect(init.code, init.stderr).toBe(0);
  }, 180_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('the command exists and is no longer planned — AC-1', () => {
    it('is advertised without the planned marker', async () => {
      const help = await runCli(['--help'], { env: db.env });

      expect(help.stdout).toContain('session');
      expect(help.stdout).not.toMatch(/session.*\(planned/);
    });

    it('no longer exits 5', async () => {
      const result = await runCli(['session', 'list', '--json'], { env: db.env });
      expect(result.code, result.stdout).toBe(0);
    });
  });

  describe('a session is opened and closed — AC-2', () => {
    it('starts one and generates an identifier', async () => {
      const result = await session(['start', '--provider', 'claude-code', '--branch', 'feat/x']);

      expect(result.code, result.failure).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.data['status']).toBe('active');
      expect(result.json.data['branch']).toBe('feat/x');
      expect(result.json.data['sessionId']).toMatch(/[0-9a-f-]{36}/);
      expect(result.json.data['endedAt']).toBeNull();
    });

    it('accepts an identifier the caller chose', async () => {
      expect(await started('--id', 'cli-chosen-1')).toBe('cli-chosen-1');
    });

    it('closes one, and a closed one cannot be closed again', async () => {
      const id = await started('--id', 'cli-end-1');

      const ended = await session(['end', id]);
      expect(ended.code, ended.failure).toBe(0);
      expect(ended.json.data['status']).toBe('completed');
      expect(ended.json.data['endedAt']).not.toBeNull();

      const again = await session(['end', id]);
      expect(again.code).not.toBe(0);
    });

    it('records an abandoned session as abandoned', async () => {
      const id = await started('--id', 'cli-end-2');
      const ended = await session(['end', id, '--abandoned']);

      expect(ended.json.data['status']).toBe('abandoned');
    });
  });

  describe('checkpoints and memories are recorded — AC-3, AC-4', () => {
    it('numbers checkpoints without being told the sequence', async () => {
      const id = await started('--id', 'cli-cp-1');

      const first = await session(['checkpoint', id, '--summary', 'first']);
      const second = await session(['checkpoint', id, '--summary', 'second']);

      expect(first.json.data['checkpointSequence']).toBe(1);
      expect(second.json.data['checkpointSequence']).toBe(2);
    });

    it('carries continuation state through as an object', async () => {
      const id = await started('--id', 'cli-cp-2');
      const result = await session([
        'checkpoint',
        id,
        '--summary',
        'halfway',
        '--state',
        '{"next":"run the suite"}',
        '--through',
        '7',
      ]);

      expect(result.json.data['continuationState']).toEqual({ next: 'run the suite' });
      expect(result.json.data['capturedThroughSequence']).toBe(7);
    });

    it('refuses state that is not a JSON object, and says why', async () => {
      const id = await started('--id', 'cli-cp-3');

      const broken = await session(['checkpoint', id, '--summary', 's', '--state', '{oops']);
      expect(broken.code).toBe(2);
      expect(broken.failure).toContain('not valid JSON');

      const array = await session(['checkpoint', id, '--summary', 's', '--state', '[1,2]']);
      expect(array.code).toBe(2);
      expect(array.failure).toContain('must be a JSON object');
    });

    it('records a memory with its rationale', async () => {
      const id = await started('--id', 'cli-mem-1');
      const result = await session([
        'remember',
        id,
        '--kind',
        'decision',
        '--statement',
        'timestamps are timestamptz and hashes canonicalise',
        '--rationale',
        'a hash over a spelling cannot be recomputed from the row',
      ]);

      expect(result.code, result.failure).toBe(0);
      expect(result.json.data['kind']).toBe('decision');
      expect(result.json.data['origin']).toBe('explicit');
      expect(result.json.data['rationale']).toContain('cannot be recomputed');
    });

    it('redacts a credential a person pasted into a statement — EPIC-112', async () => {
      // The gap EPIC-112 found on the path this Epic opened. Extraction always
      // redacted; the explicit path — the one a person types into — did not, and
      // `ferret_session_recall` would have handed the result to an AI client.
      const id = await started('--id', 'cli-redact-1');
      const result = await session([
        'remember',
        id,
        '--kind',
        'gotcha',
        '--statement',
        'the deploy needs AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY set',
      ]);

      expect(result.code, result.failure).toBe(0);
      expect(String(result.json.data['statement'])).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCY');
      expect(result.json.data['redactedSecrets']).toBe(1);

      // And it does not come back on the way out either.
      const recalled = await session(['recall', id]);
      expect(JSON.stringify(recalled.json)).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCY');
    });

    it('names the kinds when given one that does not exist', async () => {
      const id = await started('--id', 'cli-mem-2');
      const result = await session(['remember', id, '--kind', 'opinion', '--statement', 'x']);

      expect(result.code).toBe(2);
      expect(result.failure).toContain('is not a memory kind');
      // The remediation lists them, so the next attempt does not need the docs.
      expect(result.failure).toContain('next-step');
    });
  });

  describe('recall assembles what a later session needs — AC-5', () => {
    it('returns the checkpoint and the memories in priority order', async () => {
      const id = await started('--id', 'cli-recall-1');
      await session(['checkpoint', id, '--summary', 'store landed']);
      for (const [kind, statement] of [
        ['preference', 'terse comments'],
        ['next-step', 'wire the CLI'],
        ['constraint', 'no weakened tests'],
      ] as const) {
        await session(['remember', id, '--kind', kind, '--statement', statement]);
      }

      const result = await session(['recall', id]);
      expect(result.code, result.failure).toBe(0);
      expect(result.json.data['empty']).toBe(false);

      const memories = result.json.data['memories'] as { memory: { kind: string } }[];
      expect(memories.map((entry) => entry.memory.kind)).toEqual(['next-step', 'constraint', 'preference']);
    });

    it('says a session with nothing recorded is empty, rather than printing nothing', async () => {
      const id = await started('--id', 'cli-recall-2');
      const result = await session(['recall', id]);

      expect(result.json.data['empty']).toBe(true);
      expect(result.json.data['reason']).toContain('nothing to recover');
    });

    it('reports what a limit left out instead of truncating silently — AC-6', async () => {
      const id = await started('--id', 'cli-recall-3');
      for (const n of [1, 2, 3]) {
        await session(['remember', id, '--kind', 'gotcha', '--statement', `gotcha ${String(n)}`]);
      }

      const result = await session(['recall', id, '--limit', '1']);
      const omissions = result.json.data['omissions'] as { reason: string; count: number }[];

      expect((result.json.data['memories'] as unknown[]).length).toBe(1);
      expect(omissions.find((omission) => omission.reason === 'memory-limit')?.count).toBe(2);
    });

    it('walks a lineage the CLI itself created', async () => {
      const parent = await started('--id', 'cli-lineage-parent');
      await session(['remember', parent, '--kind', 'decision', '--statement', 'decided upstream']);
      await session(['end', parent]);
      await started('--id', 'cli-lineage-child', '--parent', parent);

      const result = await session(['recall', 'cli-lineage-child']);
      expect(result.json.data['lineage']).toEqual(['cli-lineage-child', 'cli-lineage-parent']);
    });

    it('refuses to recall a session that is not on record', async () => {
      const result = await session(['recall', 'never-existed']);

      expect(result.code).not.toBe(0);
      expect(result.failure).toContain('not on record');
    });
  });

  describe('list and show report what is held — AC-7', () => {
    it('lists sessions for the local operator, newest first', async () => {
      const result = await session(['list']);

      expect(result.code, result.failure).toBe(0);
      const sessions = result.json.data['sessions'] as { startedAt: string }[];
      expect(sessions.length).toBeGreaterThan(0);

      const times = sessions.map((value) => value.startedAt);
      expect([...times].sort().reverse()).toEqual(times);
      expect(result.json.data['total']).toBeGreaterThan(0);
    });

    it('shows a session with its checkpoint and memories', async () => {
      const id = await started('--id', 'cli-show-1');
      await session(['checkpoint', id, '--summary', 'the only checkpoint']);
      await session(['remember', id, '--kind', 'constraint', '--statement', 'the only memory']);

      const result = await session(['show', id]);
      const checkpoint = result.json.data['checkpoint'] as { summary: string };

      expect(checkpoint.summary).toBe('the only checkpoint');
      expect((result.json.data['memories'] as unknown[]).length).toBe(1);
    });

    it('rejects a limit that is not a positive whole number', async () => {
      const result = await session(['list', '--limit', '0']);

      expect(result.code).toBe(2);
      expect(result.failure).toContain('at least 1');
    });
  });

  describe('human output is readable — AC-8', () => {
    it('prints the bundle rather than JSON when --json is absent', async () => {
      const id = 'cli-human-1';
      await runCli(['session', 'start', '--id', id, '--json'], { env: db.env });
      await runCli(['session', 'remember', id, '--kind', 'next-step', '--statement', 'finish EPIC-110', '--json'], {
        env: db.env,
      });

      const result = await runCli(['session', 'recall', id], { env: db.env });

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('[next-step] finish EPIC-110');
      expect(result.stdout).not.toContain('"ok"');
    });
  });
});
