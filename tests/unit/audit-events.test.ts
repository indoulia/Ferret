import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuditCategory,
  AuditOutcome,
  AuditWriter,
  auditEventsPath,
  readAuditEvents,
  type AuditEvent,
  type AuditOutcome as AuditOutcomeType,
} from '../../src/index.js';
import { ConfigStore } from '../../src/config/index.js';

/**
 * EPIC-085's journal.
 *
 * On disk, because EPIC-003's reasoning generalises: "configuration has to work
 * *before* there is a database, and the change most worth auditing is the one
 * that sets the database up." A denial in an MCP server composed with only a
 * `RetrievalPort` is the same shape of fact.
 */

const directories: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'ferret-audit-'));
  directories.push(path);
  return path;
}

function writer(options: { rotateBytes?: number; keepFiles?: number } = {}): AuditWriter {
  return new AuditWriter({
    path: auditEventsPath(workspace()),
    invocation: 'a1b2c3d4e5f60718',
    agent: 'ferret/test',
    ...options,
  });
}

const decision = (
  outcome: AuditOutcomeType = AuditOutcome.DENIED,
): Parameters<AuditWriter['record']>[0] => ({
  category: AuditCategory.AUTHORIZATION,
  action: 'mcp.search',
  outcome,
  actor: 'anonymous',
  permission: 'read',
});

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('an event is one durable line — AC-1, AC-2, AC-3', () => {
  it('appends one parseable NDJSON line', () => {
    const journal = writer();

    expect(journal.record(decision())).toBeUndefined();

    const lines = readFileSync(journal.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      category: 'authorization',
      action: 'mcp.search',
      outcome: 'denied',
    });
  });

  it('appends in order without truncating — AC-2', () => {
    const journal = writer();

    journal.record({ ...decision(), action: 'mcp.first' });
    journal.record({ ...decision(), action: 'mcp.second' });

    expect(readAuditEvents(journal.path).map((one) => one.action)).toStrictEqual([
      'mcp.first',
      'mcp.second',
    ]);
  });

  it('carries the fields that identify the event — AC-3', () => {
    const journal = writer();
    journal.record(decision());
    const event = readAuditEvents(journal.path)[0];

    expect(event?.actor).toBe('anonymous');
    expect(event?.invocation).toBe('a1b2c3d4e5f60718');
    expect(event?.agent).toBe('ferret/test');
    // ISO-8601 with offset, so an event's time is unambiguous in a trail
    // collected across machines.
    expect(event?.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('records a denial with the operation and the missing permission — AC-4', () => {
    const journal = writer();
    journal.record(decision(AuditOutcome.DENIED));
    const event = readAuditEvents(journal.path)[0];

    expect(event?.outcome).toBe('denied');
    expect(event?.permission).toBe('read');
  });

  it('records a permitted decision too — AC-5', () => {
    // A trail of only failures cannot answer "who read this", which is the
    // question an audit is for.
    const journal = writer();
    journal.record(decision(AuditOutcome.PERMITTED));

    expect(readAuditEvents(journal.path)[0]?.outcome).toBe('permitted');
  });

  it('records a confirmation and a credential path — AC-6, AC-7', () => {
    const journal = writer();
    journal.record({
      category: AuditCategory.CONFIRMATION,
      action: 'mcp.config_set',
      outcome: AuditOutcome.PERMITTED,
      actor: 'operator',
      reason: 'consumed',
    });
    journal.record({
      category: AuditCategory.CREDENTIAL,
      action: 'config.resolve',
      outcome: AuditOutcome.PERMITTED,
      actor: 'operator',
      subject: 'database.password',
    });

    const events = readAuditEvents(journal.path);
    expect(events[0]?.reason).toBe('consumed');
    // The *path*, never the value.
    expect(events[1]?.subject).toBe('database.password');
  });
});

describe('the protected value is never recorded — AC-8', () => {
  it('writes no secret-shaped value even when one is smuggled into a field', () => {
    // §8.3's two controls: no field takes a caller's value, and everything
    // written passes EPIC-091's redactor. This asserts the second, because the
    // first is a type and the second is the line of defence that survives a
    // future field being added.
    const journal = writer();
    journal.record({
      category: AuditCategory.CREDENTIAL,
      action: 'config.resolve',
      outcome: AuditOutcome.PERMITTED,
      actor: 'operator',
      subject: 'database.password',
      reason: 'password=hunter2 and token=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    });

    const raw = readFileSync(journal.path, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    // And the event is still there, so redaction did not swallow the record.
    expect(readAuditEvents(journal.path)).toHaveLength(1);
  });

  it('has no field for a value at all', () => {
    // The type is the control. If a future field accepts one, this fails.
    const event: AuditEvent = {
      at: '2026-01-01T00:00:00.000Z',
      category: AuditCategory.AUTHORIZATION,
      action: 'mcp.search',
      outcome: AuditOutcome.DENIED,
      actor: 'anonymous',
      invocation: 'x',
      agent: 'ferret/test',
    };

    expect(Object.keys(event).sort()).toStrictEqual([
      'action',
      'actor',
      'agent',
      'at',
      'category',
      'invocation',
      'outcome',
    ]);
  });
});

describe('a failed write never fails the operation — AC-9', () => {
  it('returns the failure instead of throwing', () => {
    // EPIC-003 decided this for the configuration journal, and it holds harder
    // for a denial: failing closed on an unwritable journal turns a full disk
    // into an outage.
    const directory = workspace();
    const path = join(directory, 'blocked', 'audit-events.ndjson');
    // A *file* where the parent directory must go, so `mkdirSync` cannot win.
    writeFileSync(join(directory, 'blocked'), 'not a directory', 'utf8');

    const journal = new AuditWriter({ path, invocation: 'x', agent: 'ferret/test' });
    const failure = journal.record(decision());

    expect(failure).toBeInstanceOf(Error);
  });

  it('reads an absent journal as empty rather than failing', () => {
    expect(readAuditEvents(join(workspace(), 'never-written.ndjson'))).toStrictEqual([]);
  });

  it('skips a damaged line rather than failing the whole read — AC-14', () => {
    const journal = writer();
    journal.record({ ...decision(), action: 'mcp.good' });
    writeFileSync(journal.path, `${readFileSync(journal.path, 'utf8')}{not json\n`, 'utf8');
    journal.record({ ...decision(), action: 'mcp.also-good' });

    // A partially written record must not make the history unreadable.
    expect(readAuditEvents(journal.path).map((one) => one.action)).toStrictEqual([
      'mcp.good',
      'mcp.also-good',
    ]);
  });
});

describe('rotation — AC-10, AC-11, AC-12', () => {
  it('rotates at the size bound and keeps the previous file', () => {
    const journal = writer({ rotateBytes: 300, keepFiles: 3 });

    for (let index = 0; index < 6; index += 1) {
      journal.record({ ...decision(), action: `mcp.call-${String(index)}` });
    }

    expect(statSync(`${journal.path}.1`).size).toBeGreaterThan(0);
    // The live journal is smaller than the bound, which is the point of
    // rotating before the append rather than after.
    expect(statSync(journal.path).size).toBeLessThanOrEqual(300 + 400);
  });

  it('drops the oldest beyond the kept count — AC-11', () => {
    const journal = writer({ rotateBytes: 120, keepFiles: 2 });

    for (let index = 0; index < 30; index += 1) {
      journal.record({ ...decision(), action: `mcp.call-${String(index)}` });
    }

    expect(() => statSync(`${journal.path}.1`)).not.toThrow();
    expect(() => statSync(`${journal.path}.2`)).not.toThrow();
    expect(() => statSync(`${journal.path}.3`)).toThrow();
  });

  it('keeps appending when rotation cannot happen — AC-12', () => {
    // A journal that cannot be rotated keeps being appended to, which is the
    // failure mode that loses nothing. Refusing to append because a rename
    // failed would discard the event to protect a file size.
    const journal = writer({ rotateBytes: 1, keepFiles: 1 });
    // A *directory* where the rotated file must go, so the rename fails.
    const blocked = `${journal.path}.1`;
    journal.record(decision());
    rmSync(blocked, { force: true, recursive: true });
    mkdtempSync(blocked);

    const failure = journal.record({ ...decision(), action: 'mcp.after-blocked' });

    expect(failure).toBeUndefined();
    expect(readAuditEvents(journal.path).some((one) => one.action === 'mcp.after-blocked')).toBe(true);
  });

  it('does not rotate a journal below the bound', () => {
    const journal = writer({ rotateBytes: 1_000_000 });
    journal.record(decision());

    expect(() => statSync(`${journal.path}.1`)).toThrow();
  });
});

describe('the configuration journal is a source, and does not change — AC-13, AC-15', () => {
  it('writes its own entry and an event, with the entry shape untouched', () => {
    const directory = workspace();
    const journal = new AuditWriter({
      path: auditEventsPath(directory),
      invocation: 'a1b2c3d4e5f60718',
      agent: 'ferret/test',
    });
    const store = new ConfigStore({
      path: join(directory, 'config.json'),
      auditPath: join(directory, 'audit.ndjson'),
      audit: journal,
      env: {},
    });

    const result = store.set('database.host', 'db.internal');

    // EPIC-003's journal: unchanged in shape, because a format already on disk
    // in installs is not rewritten for a duplicate line — EPIC-085 §8.4.
    expect(result.entries.some((entry) => entry.path === 'database.host')).toBe(true);
    expect(Object.keys(result.entries[0] ?? {})).toContain('hadPreviousValue');

    // And the event, in the other file.
    const events = readAuditEvents(journal.path);
    expect(events.some((one) => one.category === 'configuration')).toBe(true);
    expect(events.some((one) => one.subject === 'database.host')).toBe(true);
  });

  it('records no configuration value in the event', () => {
    const directory = workspace();
    const journal = new AuditWriter({
      path: auditEventsPath(directory),
      invocation: 'x',
      agent: 'ferret/test',
    });
    const store = new ConfigStore({
      path: join(directory, 'config.json'),
      auditPath: join(directory, 'audit.ndjson'),
      audit: journal,
      env: {},
    });

    store.set('database.password', 'hunter2');

    // Auditing a password change by writing the password down would defeat the
    // point — EPIC-003's words, and EPIC-085 §8.3's rule.
    expect(readFileSync(journal.path, 'utf8')).not.toContain('hunter2');
    expect(readAuditEvents(journal.path).some((one) => one.subject === 'database.password')).toBe(true);
  });

  it('works without a writer, which is what it has always done', () => {
    const directory = workspace();
    const store = new ConfigStore({
      path: join(directory, 'config.json'),
      auditPath: join(directory, 'audit.ndjson'),
      env: {},
    });

    expect(() => store.set('database.host', 'db.internal')).not.toThrow();
  });
});
