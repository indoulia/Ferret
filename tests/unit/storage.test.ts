import { describe, expect, it } from 'vitest';

import { REDACTED, parseConfig } from '../../src/index.js';
import {
  DEFAULT_POOL_SIZE,
  MINIMUM_POSTGRES_MAJOR,
  allMigrations,
  checksumOf,
  classifyDatabaseError,
  describeConnection,
  isMissingRelation,
  poolConfigFor,
  targetSchemaVersion,
} from '../../src/storage/index.js';

const COMPLETE = {
  database: { host: 'db.example', port: 5433, database: 'ferret', user: 'ferret', password: 'hunter2' },
};

describe('connection configuration', () => {
  it('names every missing field rather than failing at the socket', () => {
    let thrown: unknown;
    try {
      poolConfigFor(parseConfig({ database: { host: 'db.example' } }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CONFIG_MISSING' });
    expect((thrown as { details: { missing: string[] } }).details.missing).toStrictEqual([
      'database',
      'user',
      'password',
    ]);
    expect((thrown as { remediation: string }).remediation).toContain('FERRET_DATABASE_HOST');
  });

  it('builds pool options with Ferret\'s ceilings and a recognizable application name', () => {
    const options = poolConfigFor(parseConfig(COMPLETE));
    expect(options).toMatchObject({
      host: 'db.example',
      port: 5433,
      database: 'ferret',
      user: 'ferret',
      max: DEFAULT_POOL_SIZE,
    });
    expect(options.application_name).toMatch(/^@indoulia\/ferret@/);
  });

  it('describes a connection without its password', () => {
    const described = describeConnection(parseConfig(COMPLETE));
    expect(described).toStrictEqual({
      host: 'db.example',
      port: 5433,
      database: 'ferret',
      user: 'ferret',
    });
    expect(JSON.stringify(described)).not.toContain('hunter2');
  });

  it('reports unset connection fields as unset rather than as empty strings', () => {
    expect(describeConnection(parseConfig({}))).toStrictEqual({
      host: '(unset)',
      port: 5432,
      database: '(unset)',
      user: '(unset)',
    });
  });

  it('defaults the migration policy to auto so a normal install provisions itself', () => {
    expect(parseConfig({}).database.migrate).toBe('auto');
    expect(parseConfig({ database: { migrate: 'off' } }).database.migrate).toBe('off');
  });

  it('rejects an unknown migration policy instead of silently ignoring it', () => {
    expect(() => parseConfig({ database: { migrate: 'sometimes' } })).toThrow(/E_CONFIG_INVALID|invalid/i);
  });
});

describe('database error classification', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['28P01', 'E_STORAGE_PERMISSION_DENIED', 'wrong password'],
    ['28000', 'E_STORAGE_PERMISSION_DENIED', 'bad authorization'],
    ['42501', 'E_STORAGE_PERMISSION_DENIED', 'insufficient privilege'],
    ['3D000', 'E_STORAGE_UNAVAILABLE', 'missing database'],
    ['53300', 'E_STORAGE_UNAVAILABLE', 'too many connections'],
    ['57P03', 'E_STORAGE_UNAVAILABLE', 'starting up'],
    ['ECONNREFUSED', 'E_STORAGE_UNAVAILABLE', 'refused'],
    ['ENOTFOUND', 'E_STORAGE_UNAVAILABLE', 'unknown host'],
  ];

  it.each(cases)('maps %s to %s', (code, expected) => {
    const error = Object.assign(new Error('boom'), { code });
    expect(classifyDatabaseError(error, 'test')).toMatchObject({ code: expected });
  });

  it('marks transient conditions retryable and permanent ones not', () => {
    const transient = classifyDatabaseError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), 'test');
    const permanent = classifyDatabaseError(Object.assign(new Error('x'), { code: '42501' }), 'test');
    expect(transient.retryable).toBe(true);
    expect(permanent.retryable).toBe(false);
  });

  it('does not invent a classification for an error it does not recognize', () => {
    const classified = classifyDatabaseError(new Error('something new'), 'test');
    expect(classified.code).toBe('E_STORAGE_UNAVAILABLE');
    expect(classified.remediation).toBeUndefined();
  });

  it('passes a FerretError through unchanged so remediation is not overwritten', () => {
    const original = classifyDatabaseError(Object.assign(new Error('x'), { code: '42501' }), 'first');
    expect(classifyDatabaseError(original, 'second')).toBe(original);
  });

  it('redacts credentials that PostgreSQL echoes back in its message', () => {
    const error = new Error('could not connect to postgres://ferret:hunter2@db.example:5432/ferret');
    const classified = classifyDatabaseError(error, 'test');
    expect(classified.message).not.toContain('hunter2');
    expect(classified.message).toContain(REDACTED);
    // The useful parts survive, or the message stops being diagnosable.
    expect(classified.message).toContain('db.example');
  });

  it('recognizes a missing relation, which is how an untouched database presents', () => {
    expect(isMissingRelation(Object.assign(new Error('x'), { code: '42P01' }))).toBe(true);
    expect(isMissingRelation(Object.assign(new Error('x'), { code: '3F000' }))).toBe(true);
    expect(isMissingRelation(Object.assign(new Error('x'), { code: '42501' }))).toBe(false);
    expect(isMissingRelation(undefined)).toBe(false);
  });

  it('supports PostgreSQL 14 and newer', () => {
    expect(MINIMUM_POSTGRES_MAJOR).toBe(14);
  });
});

describe('the shipped migration set', () => {
  it('is non-empty, gap-free from 1, and ordered', () => {
    const migrations = allMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.version)).toStrictEqual(
      migrations.map((_, index) => index + 1),
    );
    expect(targetSchemaVersion()).toBe(migrations.length);
  });

  it('gives every migration a stable checksum over its normalized text', () => {
    for (const migration of allMigrations()) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.checksum).toBe(checksumOf(migration.sql));
    }
  });

  it('hashes identically whichever line endings the checkout used', () => {
    // Git may rewrite line endings between platforms. Hashing raw bytes would
    // make a database migrated on Linux look tampered with from Windows.
    expect(checksumOf('CREATE TABLE a();\nSELECT 1;\n')).toBe(
      checksumOf('CREATE TABLE a();\r\nSELECT 1;\r\n'),
    );
  });

  it('has a distinct checksum per migration, so drift is attributable', () => {
    const checksums = new Set(allMigrations().map((migration) => migration.checksum));
    expect(checksums.size).toBe(allMigrations().length);
  });

  it('creates its first real schema object under the ferret schema', () => {
    const first = allMigrations()[0];
    expect(first?.name).toBe('bootstrap');
    expect(first?.sql).toContain('ferret.instance');
  });
});
