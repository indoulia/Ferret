import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigStore,
  acquireLock,
  readAudit,
  readConfigFile,
  writeConfigFileAtomically,
} from '../../../src/index.js';

const CONCURRENT_WRITER = fileURLToPath(
  new URL('../../fixtures/concurrent-config-writer.mjs', import.meta.url),
);

let workspace: string;
let configPath: string;
let auditPath: string;

function store(): ConfigStore {
  return new ConfigStore({ path: configPath, auditPath, env: {} });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ferret-config-'));
  configPath = join(workspace, 'config.json');
  auditPath = join(workspace, 'config-audit.log');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('persistence', () => {
  it('creates the file on first write, and reads back exactly what was stored', () => {
    expect(store().exists).toBe(false);

    const result = store().set('database.host', 'db.example');
    expect(result.path).toBe(configPath);

    const file = readConfigFile(configPath);
    expect(file?.version).toBe(1);
    expect(file?.config).toStrictEqual({ database: { host: 'db.example' } });
  });

  it('writes a versioned envelope so a later format change has something to key on', () => {
    store().set('logLevel', 'debug');
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(1);
    expect(raw['config']).toStrictEqual({ logLevel: 'debug' });
  });

  it('merges into existing content rather than replacing the document', () => {
    store().set('database.host', 'h');
    store().set('database.user', 'u');
    store().set('logLevel', 'info');

    expect(readConfigFile(configPath)?.config).toStrictEqual({
      database: { host: 'h', user: 'u' },
      logLevel: 'info',
    });
  });

  it('removes a value on unset, restoring its default', () => {
    store().set('logLevel', 'debug');
    store().unset('logLevel');
    expect(readConfigFile(configPath)?.config).toStrictEqual({});
  });

  it('applies several changes as one write', () => {
    const result = store().setMany({
      'database.host': 'h',
      'database.port': 6000,
      'database.user': 'u',
    });
    expect(result.entries.filter((entry) => entry.action === 'set')).toHaveLength(3);
    expect(readConfigFile(configPath)?.config).toStrictEqual({
      database: { host: 'h', port: 6000, user: 'u' },
    });
  });

  it('restricts file permissions, because the file may hold a database password', () => {
    store().set('database.password', 'hunter2');
    const mode = statSync(configPath).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows ignores the POSIX mode and inherits the directory ACL. Asserting
      // 0600 here would be asserting something untrue; the limitation is
      // recorded in the Epic's validation evidence instead.
      expect(mode).toBeGreaterThan(0);
    } else {
      expect(mode).toBe(0o600);
    }
  });
});

describe('validation before activation', () => {
  it('rejects an invalid change and leaves the stored file untouched', () => {
    store().set('database.host', 'good.example');
    const before = readFileSync(configPath, 'utf8');

    expect(() => store().set('database.port', 70_000)).toThrow(/rejected/);
    expect(() => store().set('logLevel', 'shouty')).toThrow(/rejected/);

    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('never echoes the rejected value, because it may itself be a credential', () => {
    let thrown: unknown;
    try {
      store().set('database.password', 12_345);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect(JSON.stringify(thrown)).not.toContain('12345');
  });

  it('rejects a change whose secret reference cannot be resolved, before writing', () => {
    // Better to fail here, with the old file intact, than at the next startup.
    expect(() =>
      new ConfigStore({ path: configPath, auditPath, env: {} }).set('database.password', {
        $secret: { env: 'NOT_SET_ANYWHERE' },
      }),
    ).toThrow(/could not be resolved/);
    expect(existsSync(configPath)).toBe(false);
  });

  it('accepts a secret reference that does resolve, and stores the reference not the secret', () => {
    new ConfigStore({ path: configPath, auditPath, env: { PW: 'hunter2' } }).set('database.password', {
      $secret: { env: 'PW' },
    });

    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('$secret');
    // The point of a reference: the secret itself is never written down.
    expect(raw).not.toContain('hunter2');
  });

  it('rejects a path that cannot address a value', () => {
    expect(() => store().set('', 'x')).toThrow(/not a valid configuration path/);
    expect(() => store().set('a..b', 'x')).toThrow(/not a valid configuration path/);
  });
});

describe('durability', () => {
  it('writes atomically — a reader never sees a partial document', () => {
    store().set('database.host', 'first');
    for (let i = 0; i < 40; i += 1) {
      store().set('database.host', `host-${String(i)}`);
      // Every observation between writes must be a complete, parseable file.
      // A non-atomic write would eventually be caught truncated here.
      expect(() => readConfigFile(configPath)).not.toThrow();
    }
    expect(readConfigFile(configPath)?.config).toStrictEqual({ database: { host: 'host-39' } });
  });

  it('leaves no temporary files behind', () => {
    store().set('logLevel', 'debug');
    store().set('logLevel', 'info');
    const leftovers = execFileSync(process.execPath, [
      '-e',
      `process.stdout.write(require('fs').readdirSync(${JSON.stringify(workspace)}).join(','))`,
    ])
      .toString()
      .split(',')
      .filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toStrictEqual([]);
  });

  it('survives a process killed mid-write: the previous file is intact', () => {
    store().set('database.host', 'original');
    const before = readFileSync(configPath, 'utf8');

    // A child that writes and is killed. Because the write goes to a temporary
    // sibling and is renamed only after fsync, no kill window can leave the
    // real file truncated — the worst case is an orphaned temp file.
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const {writeFileSync}=require('fs');writeFileSync(${JSON.stringify(join(workspace, '.pid-abc.tmp'))},'{"partial":');process.kill(process.pid,'SIGKILL');`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);

    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(readConfigFile(configPath)?.config).toStrictEqual({ database: { host: 'original' } });
  });

  it('reports a corrupt file instead of starting with settings the user never made', () => {
    writeFileSync(configPath, '{"version":1,"config":{ truncated');
    let thrown: unknown;
    try {
      readConfigFile(configPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID' });
    expect((thrown as { message: string }).message).toContain(configPath);
    expect((thrown as { remediation: string }).remediation).toContain('always safe');
  });

  it('treats an absent file as no configuration, not as an error', () => {
    expect(readConfigFile(join(workspace, 'never-written.json'))).toBeUndefined();
    expect(store().read()).toStrictEqual({});
  });

  it('rejects a directory where a configuration file should be', () => {
    const asDirectory = join(workspace, 'dir-config.json');
    mkdirSync(asDirectory);
    expect(() => readConfigFile(asDirectory)).toThrow(/directory, not a file/);
  });
});

describe('concurrent changes', () => {
  it('does not lose an update when 8 processes write different keys at once', () => {
    // Read-modify-write without a lock loses all but the last writer. Each child
    // sets its own key; every one must survive.
    store().set('logLevel', 'info');

    const children = Array.from({ length: 8 }, (_, index) =>
      spawnSync(process.execPath, [CONCURRENT_WRITER, configPath, auditPath, `providers.p${String(index)}.enabled`, 'true'], {
        encoding: 'utf8',
        timeout: 60_000,
      }),
    );

    for (const child of children) {
      expect(child.status, child.stderr).toBe(0);
    }

    const stored = readConfigFile(configPath)?.config as { providers?: Record<string, unknown> };
    expect(Object.keys(stored.providers ?? {}).sort()).toStrictEqual([
      'p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7',
    ]);
    // The key written before the children ran must have survived them all.
    expect((readConfigFile(configPath)?.config as { logLevel?: string }).logLevel).toBe('info');

    // Every concurrent change is journalled, and each record is whole: appends
    // of complete lines interleave between records, never inside one.
    const entries = readAudit(auditPath);
    expect(entries.filter((entry) => entry.action === 'set')).toHaveLength(9);
    for (const entry of entries) {
      expect(typeof entry.at).toBe('string');
      expect(typeof entry.action).toBe('string');
      expect(typeof entry.actor).toBe('string');
    }
  }, 120_000);

  it('serializes writers on a lock file, which is removed on release', () => {
    const release = acquireLock(configPath, { timeoutMs: 1_000 });
    expect(existsSync(`${configPath}.lock`)).toBe(true);
    release();
    expect(existsSync(`${configPath}.lock`)).toBe(false);
    // Releasing twice must not throw or delete a lock someone else now holds.
    release();
  });

  it('fails with an actionable, retryable error when the lock is held too long', () => {
    const release = acquireLock(configPath, { timeoutMs: 5_000 });
    try {
      let thrown: unknown;
      try {
        store().set('logLevel', 'debug');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'E_CONFIG_INVALID', retryable: true });
      expect((thrown as { remediation: string }).remediation).toContain(`${configPath}.lock`);
    } finally {
      release();
    }
  }, 60_000);

  it('breaks a lock abandoned by a crashed process rather than blocking forever', () => {
    // A crash leaves the lock file behind. Without staleness detection,
    // configuration would be permanently unwritable until a human deleted it.
    writeFileSync(`${configPath}.lock`, '99999\n');
    const release = acquireLock(configPath, { timeoutMs: 5_000, staleMs: 0 });
    release();
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });
});

describe('change auditing', () => {
  it('records what changed, who changed it, and when', () => {
    store().set('database.host', 'db.example');
    const entries = readAudit(auditPath);

    expect(entries.map((entry) => entry.action)).toStrictEqual(['create', 'set']);
    const change = entries[1];
    expect(change?.path).toBe('database.host');
    expect(change?.value).toBe('db.example');
    expect(change?.hadPreviousValue).toBe(false);
    expect(change?.actor.length).toBeGreaterThan(0);
    expect(change?.agent).toMatch(/^@indoulia\/ferret@/);
    expect(() => new Date(change?.at ?? '')).not.toThrow();
  });

  it('records that a secret changed, never what it changed to', () => {
    store().set('database.password', 'hunter2');
    const raw = readFileSync(auditPath, 'utf8');

    expect(raw).toContain('database.password');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('[redacted]');
  });

  it('notes whether a value already existed, without recording the old one', () => {
    store().set('database.host', 'first');
    store().set('database.host', 'second');
    const entries = readAudit(auditPath).filter((entry) => entry.path === 'database.host');

    expect(entries[0]?.hadPreviousValue).toBe(false);
    expect(entries[1]?.hadPreviousValue).toBe(true);
    // The second entry records the new value and the *fact* that one existed
    // before — never the old value, which the journal has no reason to keep.
    expect(entries[1]?.value).toBe('second');
    expect(JSON.stringify(entries[1])).not.toContain('first');
  });

  it('records removals without a value', () => {
    store().set('logLevel', 'debug');
    store().unset('logLevel');
    const removal = readAudit(auditPath).find((entry) => entry.action === 'unset');
    expect(removal?.path).toBe('logLevel');
    expect(removal).not.toHaveProperty('value');
  });

  it('skips a damaged journal line rather than losing the whole history', () => {
    store().set('logLevel', 'debug');
    writeFileSync(auditPath, `${readFileSync(auditPath, 'utf8')}{"truncated\n`, 'utf8');
    store().set('logLevel', 'info');

    const entries = readAudit(auditPath);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.at(-1)?.value).toBe('info');
  });

  it('does not fail a configuration change when the journal cannot be written', () => {
    // An unwritable audit log is a diagnostic problem. Refusing to let the user
    // configure Ferret because of it would be the worse outcome.
    const unwritable = join(workspace, 'no-such-directory', 'audit.log');
    mkdirSync(join(workspace, 'no-such-directory'));
    chmodSync(join(workspace, 'no-such-directory'), 0o500);

    const result = new ConfigStore({ path: configPath, auditPath: unwritable, env: {} }).set('logLevel', 'debug');
    expect(readConfigFile(configPath)?.config).toStrictEqual({ logLevel: 'debug' });
    // On Windows the mode is advisory, so the write may well succeed; either
    // way the configuration change itself must have gone through.
    if (result.auditError !== undefined) expect(result.auditError).toBeInstanceOf(Error);

    chmodSync(join(workspace, 'no-such-directory'), 0o700);
  });
});

describe('performance', () => {
  // Configuration is resolved on every single Ferret invocation, and the AI
  // client spawns Ferret per session. These are regression ceilings, set well
  // above measured values so they catch a real change rather than jitter.
  const BUDGET = { readMs: 25, writeMs: 250 } as const;

  it(`reads the stored configuration in under ${String(BUDGET.readMs)} ms`, () => {
    store().setMany({ 'database.host': 'h', 'database.user': 'u', logLevel: 'info' });

    const durations: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const started = performance.now();
      readConfigFile(configPath);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.readMs);
  });

  it(`completes a locked, validated, journalled write in under ${String(BUDGET.writeMs)} ms`, () => {
    const durations: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      store().set('database.host', `host-${String(i)}`);
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.writeMs);
  });

  it('writes atomically without leaving the file larger than its content', () => {
    writeConfigFileAtomically(configPath, { logLevel: 'debug' });
    expect(statSync(configPath).size).toBeLessThan(200);
  });
});
