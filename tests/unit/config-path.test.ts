import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, getAt, parsePath, setAt, unsetAt } from '../../src/config/index.js';
import { ErrorCode, FerretError } from '../../src/errors/index.js';

/**
 * Configuration paths, and the object internals they must not reach — EPIC-003.
 *
 * These three helpers turn a caller's string into a place in a document, and
 * until now nothing tested them directly. What that let through:
 * `setAt(document, ['__proto__', 'polluted'], v)` walked into `Object.prototype`
 * — `isRecord` says yes, because it is one — and assigned to it, polluting every
 * object in the process. It left no trace, because `JSON.stringify` serializes
 * own enumerable properties only: the file written to disk was clean and
 * `validateCandidate` never saw anything to reject.
 *
 * A local operator could only ever have done that to their own process, which is
 * why it sat here. EPIC-066 puts configuration writes on the MCP surface, where
 * the path is a string a model chooses and EPIC-084's threat model says indexed
 * content can influence what a model asks for. Same defect, materially different
 * blast radius — so it is fixed in EPIC-003, which owns the code, rather than
 * worked around in the Epic that exposed it.
 */

const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];

function expectUsage(run: () => unknown, because: string): FerretError {
  try {
    run();
  } catch (error) {
    expect(error, because).toBeInstanceOf(FerretError);
    const ferret = error as FerretError;
    // USAGE, not CONFIG_INVALID: the stored configuration is fine and what
    // arrived was a malformed request.
    expect(ferret.code, because).toBe(ErrorCode.USAGE);
    return ferret;
  }
  throw new Error(`expected a refusal: ${because}`);
}

describe('parsePath', () => {
  it('splits an ordinary dotted path', () => {
    expect(parsePath('database.host')).toStrictEqual(['database', 'host']);
    expect(parsePath('logLevel')).toStrictEqual(['logLevel']);
  });

  it('refuses a shape that cannot address a value', () => {
    for (const path of ['', '.', 'a..b', 'a.', '.a']) {
      expectUsage(() => parsePath(path), `path ${JSON.stringify(path)}`);
    }
  });

  it('refuses every segment that addresses object internals', () => {
    for (const key of FORBIDDEN) {
      // Alone, leading, trailing and in the middle: the guard filters every
      // segment rather than inspecting the first.
      for (const path of [key, `${key}.x`, `a.${key}`, `a.${key}.b`]) {
        const error = expectUsage(() => parsePath(path), `path ${path}`);
        expect(error.details.forbidden).toStrictEqual([key]);
      }
    }
  });

  it('names the whole forbidden vocabulary in its remediation', () => {
    // An operator who hit one of these should not have to find the other two.
    const error = expectUsage(() => parsePath('__proto__'), 'remediation');
    for (const key of FORBIDDEN) expect(error.remediation).toContain(key);
  });

  it('still accepts a segment that merely contains a forbidden word', () => {
    // The check is on the whole segment, not a substring. `constructorName` is a
    // perfectly ordinary key and refusing it would be a bug of its own.
    expect(parsePath('providers.constructorName')).toStrictEqual(['providers', 'constructorName']);
    expect(parsePath('myPrototype')).toStrictEqual(['myPrototype']);
  });
});

describe('setAt and unsetAt', () => {
  afterEach(() => {
    // If any assertion below ever fails open, every later test in this process
    // would inherit the pollution. Cleaning up here makes a failure local.
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('sets and unsets an ordinary path without touching the input', () => {
    const original = { database: { host: 'localhost' } };
    const set = setAt(original, ['database', 'port'], 5432);
    expect(set).toStrictEqual({ database: { host: 'localhost', port: 5432 } });
    // EPIC-003's rule: a layer is never mutated through its own result.
    expect(original).toStrictEqual({ database: { host: 'localhost' } });

    expect(unsetAt(set, ['database', 'host'])).toStrictEqual({ database: { port: 5432 } });
  });

  it('creates intermediate objects on the way to a leaf', () => {
    expect(setAt({}, ['authorization', 'scope', 'include'], ['repo'])).toStrictEqual({
      authorization: { scope: { include: ['repo'] } },
    });
  });

  it('refuses raw segments that address object internals — the second layer', () => {
    // `parsePath` already rejects these, and every caller inside Ferret goes
    // through it. These functions are *exported*, so the guarantee has to belong
    // to the function that does the dangerous thing rather than to the discipline
    // of whoever calls it.
    for (const key of FORBIDDEN) {
      expectUsage(() => setAt({}, [key, 'polluted'], 'OWNED'), `setAt ${key}`);
      expectUsage(() => unsetAt({ a: 1 }, [key, 'polluted']), `unsetAt ${key}`);
    }
  });

  it('does not pollute Object.prototype — the regression', () => {
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expectUsage(() => setAt({ logLevel: 'warn' }, ['__proto__', 'polluted'], 'OWNED'), 'the exploit');
    // The assertion that would have failed before the fix, on a fresh object
    // that never went near the call.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reads nothing through a forbidden path either', () => {
    // `getAt` cannot pollute, only disclose — but disclosing `Object.prototype`
    // to a caller asking about configuration is still an answer about the wrong
    // thing, and it goes through `parsePath` on every real surface.
    expectUsage(() => parsePath('__proto__.constructor'), 'read path');
    // Unguarded by design: `getAt` is a pure read and its callers parse first.
    expect(getAt({ a: { b: 1 } }, ['a', 'b'])).toBe(1);
  });
});

describe('ConfigStore refuses a polluting write', () => {
  let directory: string;
  let store: ConfigStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ferret-config-path-'));
    store = new ConfigStore({
      path: join(directory, 'config.json'),
      auditPath: join(directory, 'audit.jsonl'),
      env: {},
    });
  });

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    rmSync(directory, { recursive: true, force: true });
  });

  it('refuses through the real read-modify-write path, leaving no file behind', () => {
    expectUsage(() => store.set('__proto__.polluted', 'OWNED'), 'store.set');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Refused before the lock, the write and the journal: a rejected change
    // leaves the stored configuration byte-identical, and here there is not even
    // a file yet.
    expect(store.exists).toBe(false);
  });

  it('refuses on unset too', () => {
    store.set('logLevel', 'debug');
    expectUsage(() => store.unset('constructor.prototype'), 'store.unset');
    // The legitimate value written first is untouched, which is what proves the
    // refusal is narrow rather than a general failure to write.
    expect(JSON.parse(readFileSync(store.path, 'utf8')).config).toMatchObject({ logLevel: 'debug' });
  });

  it('still stores an ordinary value, so the guard is not refusing everything', () => {
    const result = store.set('database.host', 'db.internal');
    expect(getAt(result.config, ['database', 'host'])).toBe('db.internal');
  });
});
