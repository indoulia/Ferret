import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_JOURNAL_KEEP,
  RETENTION_TARGETS,
  RetentionService,
  RetentionTarget,
  planReclaims,
} from '../../src/storage/index.js';
import { AuditWriter, auditEventsPath } from '../../src/audit/index.js';
import type { FerretDatabase } from '../../src/storage/index.js';

/**
 * EPIC-088's targets that need no database.
 *
 * The journal target is filesystem-only, and the two refusals — an evidence
 * sweep with no age, and a plan that deletes nothing by default — are decided
 * before a query is issued. Those are asserted here; the anti-joins are
 * `tests/integration/storage/retention.test.ts`.
 */

const directories: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'ferret-retention-'));
  directories.push(path);
  return path;
}

/**
 * A service with no reachable database.
 *
 * The journal target never touches one, and the two refusals return before a
 * query. A stub that throws proves that rather than asserting it.
 */
function servicing(): RetentionService {
  const unreachable = {
    execute: () => {
      throw new Error('the database was queried when it should not have been');
    },
    select: () => {
      throw new Error('the database was queried when it should not have been');
    },
  };
  return new RetentionService(unreachable as unknown as FerretDatabase);
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('nothing is deleted unless it is asked for — AC-1, AC-2', () => {
  it('plans without applying by default', async () => {
    const directory = workspace();
    const journal = auditEventsPath(directory);
    writeFileSync(journal, '', 'utf8');
    for (const suffix of [1, 2, 7, 8]) writeFileSync(`${journal}.${String(suffix)}`, 'x'.repeat(10), 'utf8');

    const plan = await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: journal,
      journalKeep: 5,
    });

    expect(plan.applied).toBe(false);
    expect(planReclaims(plan)).toBe(true);
    // `.7` and `.8` are above the kept count; `.1` and `.2` are not.
    expect(plan.counts[0]?.rows).toBe(2);
    // And every file is still there, which is what `--dry-run` means.
    expect(readdirSync(directory)).toHaveLength(5);
  });

  it('reports the same counts in both modes — AC-10', async () => {
    const directory = workspace();
    const journal = auditEventsPath(directory);
    writeFileSync(journal, '', 'utf8');
    writeFileSync(`${journal}.9`, 'x'.repeat(40), 'utf8');

    const request = { targets: [RetentionTarget.JOURNALS], journalPath: journal, journalKeep: 2 };
    const planned = await servicing().prune(request);
    const applied = await servicing().prune({ ...request, apply: true });

    expect(planned.counts[0]).toMatchObject({ rows: 1, bytes: 40 });
    expect(applied.counts[0]).toMatchObject({ rows: 1, bytes: 40 });
    expect(applied.applied).toBe(true);
  });
});

describe('rotated journals above the kept count — AC-5', () => {
  it('deletes the orphans and keeps the live journal and the kept copies', async () => {
    // EPIC-085's writer removes exactly `keepFiles + 1` per rotation, which
    // bounds growth at a fixed setting and orphans everything above it when
    // the setting drops. This is the file that install never touches again.
    const directory = workspace();
    const journal = auditEventsPath(directory);
    writeFileSync(journal, 'live\n', 'utf8');
    for (const suffix of [1, 2, 3, 4, 5]) writeFileSync(`${journal}.${String(suffix)}`, 'old\n', 'utf8');

    const plan = await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: journal,
      journalKeep: 2,
      apply: true,
    });

    expect(plan.counts[0]?.rows).toBe(3);
    const left = readdirSync(directory).sort();
    expect(left).toStrictEqual([
      'audit-events.ndjson',
      'audit-events.ndjson.1',
      'audit-events.ndjson.2',
    ]);
  });

  it('never deletes the live journal, whatever the kept count', async () => {
    const directory = workspace();
    const journal = auditEventsPath(directory);
    const writer = new AuditWriter({ path: journal, invocation: 'x', agent: 'ferret/test' });
    writer.record({
      category: 'authorization',
      action: 'mcp.search',
      outcome: 'denied',
      actor: 'anonymous',
    });

    await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: journal,
      journalKeep: 0,
      apply: true,
    });

    // The suffixless file has no rotation number, so it is not a candidate at
    // any keep count — including zero.
    expect(readdirSync(directory)).toContain('audit-events.ndjson');
  });

  it('reads an install that has never written an event as nothing to reclaim', async () => {
    const plan = await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: join(workspace(), 'never', 'audit-events.ndjson'),
    });

    expect(plan.counts[0]).toMatchObject({ rows: 0, bytes: 0 });
  });

  it('ignores a file whose suffix is not a rotation number', async () => {
    const directory = workspace();
    const journal = auditEventsPath(directory);
    writeFileSync(`${journal}.backup`, 'not a rotation\n', 'utf8');
    writeFileSync(`${journal}.1.gz`, 'not a rotation either\n', 'utf8');

    const plan = await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: journal,
      journalKeep: 0,
      apply: true,
    });

    expect(plan.counts[0]?.rows).toBe(0);
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it('says so rather than guessing when no journal path is given', async () => {
    const plan = await servicing().prune({ targets: [RetentionTarget.JOURNALS] });

    expect(plan.counts[0]?.rows).toBe(0);
    expect(plan.counts[0]?.note).toContain('nothing to examine');
  });

  it('keeps EPIC-085 s default as the default', () => {
    expect(DEFAULT_JOURNAL_KEEP).toBe(5);
  });
});

describe('an age is required, and never invented — AC-6, AC-7', () => {
  it('refuses an evidence sweep with no age rather than choosing one', async () => {
    // §8.3: "how long is the history worth keeping" is the caller's judgement.
    // The stub throws if a query is issued, so this also proves the refusal
    // happens before the database is touched.
    const plan = await servicing().prune({ targets: [RetentionTarget.EVIDENCE] });

    expect(plan.counts[0]).toMatchObject({ target: 'evidence', rows: 0 });
    expect(plan.counts[0]?.note).toContain('age in days is required');
  });

  it('refuses a negative age', async () => {
    const plan = await servicing().prune({
      targets: [RetentionTarget.EVIDENCE],
      supersededOlderThanDays: -1,
    });

    expect(plan.counts[0]?.rows).toBe(0);
  });

  it('refuses a session sweep with no age rather than choosing one — EPIC-112', async () => {
    // The same rule, and the same reason it is the caller's: a memory is the
    // longest-lived thing Ferret records about its own work. The stub throws on
    // any query, so this also proves the refusal happens before the database is
    // touched.
    const plan = await servicing().prune({ targets: [RetentionTarget.SESSIONS] });

    expect(plan.counts[0]).toMatchObject({ target: 'sessions', rows: 0 });
    expect(plan.counts[0]?.note).toContain('age in days is required');
  });

  it('refuses a negative session age', async () => {
    const plan = await servicing().prune({
      targets: [RetentionTarget.SESSIONS],
      sessionsEndedOlderThanDays: -1,
    });

    expect(plan.counts[0]?.rows).toBe(0);
  });
});

describe('the target list is the contract — AC-9', () => {
  it('has no target for a tombstone, and no way to name one', () => {
    // §8.4. EPIC-006 §D-009: erasing the row would erase the answer along with
    // the file. A test rather than a comment, so a future flag fails the build.
    //
    // **`sessions` added 2026-09-05 by EPIC-112, and this is the review the pin
    // exists to force.** It does not weaken §8.4: a tombstone still has no flag
    // and cannot be named. What it does do is follow `evidence` rather than
    // `blobs`, and the distinction is the whole justification.
    //
    // §8.3's rule is that a target "answers no question", and an unreferenced
    // blob genuinely answers none. A session's memories plainly do — "what did
    // we decide" is what they are for. So does superseded evidence, and
    // `evidence` is a target anyway: the resolution EPIC-088 already reached is
    // that history which answers a question may be discarded *only* on an age
    // the caller names, with no default, so that discarding it is always
    // someone's explicit judgement rather than a sweep's side effect. Sessions
    // are gated the same way, by `--sessions-older-than`, and refuse to run
    // without it.
    //
    // A tombstone is not gated that way and must not become so. It is the
    // record that something was deleted, and there is no age at which the
    // answer stops mattering.
    expect([...RETENTION_TARGETS]).toStrictEqual(['blobs', 'journals', 'evidence', 'sessions']);
    expect(RETENTION_TARGETS).not.toContain('tombstones');
    expect(RETENTION_TARGETS).not.toContain('entities');
  });

  it('has no target for a cursor or a watermark — AC-15', () => {
    // §16's finding: `CURSOR_ARTIFACT_KIND` is `'index'`, the same
    // `derived_artifact` kind a watermark uses, so a delete keyed on it could
    // remove the watermark incremental indexing depends on. Not deliverable
    // here; EPIC-075 owns the distinguishing column.
    expect(RETENTION_TARGETS).not.toContain('cursors');
    expect(RETENTION_TARGETS).not.toContain('artifacts');
  });

  it('runs only the targets it was given', async () => {
    const plan = await servicing().prune({
      targets: [RetentionTarget.JOURNALS],
      journalPath: join(workspace(), 'audit-events.ndjson'),
    });

    expect(plan.counts.map((count) => count.target)).toStrictEqual(['journals']);
  });
});
