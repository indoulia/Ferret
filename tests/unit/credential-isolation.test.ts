import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CREDENTIAL_CONFIG_PATHS,
  ConfigStore,
  credentialsFor,
  describeConfigProtection,
  isSecretRef,
  parseConfig,
  registerSecretResolver,
  resolveSecretRef,
  secretResolverSources,
  withoutCredentialFields,
} from '../../src/config/index.js';
import { CREDENTIAL_ENV, withoutCredentials } from '../../src/security/credentials.js';
import { GIT_STRIPPED_ENV, scrubEnvironment } from '../../src/git/index.js';

/**
 * EPIC-081 — what Ferret keeps, and what it hands on.
 *
 * The disclosure half was already strong when this Epic began: redaction at the
 * render boundary, in errors, in the audit journal. What did not exist was any
 * *possession* control, and the three measurements that opened the
 * specification are the three things asserted here — a provider receiving a
 * password it has no use for, a Git subprocess inheriting one, and the command
 * that documents the `$secret` mitigation destroying it.
 */

const COMPLETE = {
  database: { host: 'db.example', database: 'ferret', user: 'ferret', password: 'hunter2' },
};

describe('a credential has one holder — AC-1', () => {
  it('removes the password from what a provider sees', () => {
    const projected = withoutCredentialFields(parseConfig(COMPLETE));

    // Absent, not redacted. A placeholder is a string, and a string in a
    // password field is something a caller eventually hands to `pg`.
    expect('password' in projected.database).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('hunter2');
  });

  it('changes nothing else', () => {
    const config = parseConfig(COMPLETE);
    const projected = withoutCredentialFields(config);

    expect(projected.database.host).toBe('db.example');
    expect(projected.database.user).toBe('ferret');
    expect(projected.database.port).toBe(config.database.port);
    expect(projected.logLevel).toBe(config.logLevel);
    expect(projected.exclude).toStrictEqual(config.exclude);
  });

  it('grants a declared credential, and only a declared one', () => {
    const config = parseConfig(COMPLETE);

    expect(credentialsFor(config, ['database.password'])).toStrictEqual({ 'database.password': 'hunter2' });
    expect(credentialsFor(config, [])).toStrictEqual({});
  });

  it('ignores a declaration for something that is not a known credential', () => {
    // A grant, not a definition. A provider cannot invent a credential path and
    // have the registry hand it whatever is at it.
    expect(credentialsFor(parseConfig(COMPLETE), ['database.user'])).toStrictEqual({});
  });

  it('grants nothing when nothing is configured, rather than an empty string', () => {
    // The empty-password failure `secret-ref.ts` has refused to produce since it
    // was written: a misconfiguration must not become an authentication failure
    // far from its cause.
    expect(credentialsFor(parseConfig({}), ['database.password'])).toStrictEqual({});
  });

  it('enumerates the credential paths, so adding one is a visible change', () => {
    expect(CREDENTIAL_CONFIG_PATHS).toStrictEqual(['database.password']);
  });
});

describe('the subprocess environment is a boundary — AC-8', () => {
  it('removes every credential-carrying variable', () => {
    const scrubbed = withoutCredentials({
      FERRET_DATABASE_PASSWORD: 'hunter2',
      PGPASSWORD: 'hunter2',
      PGPASSFILE: '/home/u/.pgpass',
      PATH: '/usr/bin',
    });

    expect(scrubbed).toStrictEqual({ PATH: '/usr/bin' });
  });

  it('removes them from a Git subprocess too — the measurement that opened §2', () => {
    // `scrubEnvironment` stripped nineteen variables and not one was a
    // credential, so `FERRET_DATABASE_PASSWORD` was in every `git log` Ferret
    // ran on any machine that used it.
    const scrubbed = scrubEnvironment({ FERRET_DATABASE_PASSWORD: 'hunter2', GIT_DIR: '/tmp/x', PATH: '/usr/bin' });

    expect(scrubbed['FERRET_DATABASE_PASSWORD']).toBeUndefined();
    expect(scrubbed['GIT_DIR']).toBeUndefined();
    expect(scrubbed['PATH']).toBe('/usr/bin');
  });

  it('keeps removing every Git-redirect variable it already removed', () => {
    // The regression this Epic could most easily cause: a new list replacing an
    // old one rather than joining it.
    const source: NodeJS.ProcessEnv = Object.fromEntries(GIT_STRIPPED_ENV.map((name) => [name, 'set']));
    const scrubbed = scrubEnvironment(source);

    for (const name of GIT_STRIPPED_ENV) expect(scrubbed[name], name).toBeUndefined();
  });

  it('names the credential variables, so adding one is a visible change', () => {
    // It did its job. This list read `FERRET_DATABASE_PASSWORD`, `PGPASSFILE`,
    // `PGPASSWORD` until F-71, which is the finding that `FERRET_DATABASE_URL`
    // carries the same password and two other modules already treated it as a
    // credential. `PGSERVICEFILE` and `PGSSLKEY` came with it: each names a file
    // holding the same secret, and each was missing for the same reason.
    //
    // The list is no longer the whole policy — `tests/security/credential-surface.test.ts`
    // asserts the three derived rules that cover the variables no list can name.
    // It stays because a change to *this* set should be visible in a diff.
    expect([...CREDENTIAL_ENV].sort()).toStrictEqual([
      'FERRET_DATABASE_PASSWORD',
      'FERRET_DATABASE_URL',
      'PGPASSFILE',
      'PGPASSWORD',
      'PGSERVICEFILE',
      'PGSSLKEY',
    ]);
  });
});

describe('a credential source is a resolver — AC-5, AC-6, AC-7', () => {
  it('resolves through a third source without touching the schema', () => {
    registerSecretResolver({
      source: 'test-vault',
      describe: (target) => `test vault entry ${target}`,
      resolve: (target) => (target === 'db' ? 'hunter2' : ''),
    });

    expect(secretResolverSources()).toContain('test-vault');
    expect(resolveSecretRef({ $secret: { 'test-vault': 'db' } })).toBe('hunter2');
  });

  it('treats a body naming an unregistered source as a reference, and fails on it', () => {
    // Rather than as a literal. Writing `{ "$secret": { "keychain": … } }` into
    // a password field because nothing claimed `keychain` is the silent-wrong
    // -value failure the object form exists to prevent.
    expect(isSecretRef({ $secret: { nowhere: 'x' } })).toBe(true);
    expect(() => resolveSecretRef({ $secret: { nowhere: 'x' } })).toThrow(/unknown source/i);
  });

  it('reports an unavailable source as unavailable, never as an empty password — AC-7', () => {
    registerSecretResolver({
      source: 'test-absent',
      describe: (target) => `absent store ${target}`,
      unavailableReason: () => 'no credential store on this platform',
      resolve: () => 'never reached',
    });

    expect(() => resolveSecretRef({ $secret: { 'test-absent': 'db' } })).toThrow(
      /not available here: no credential store/i,
    );
  });

  it('names the source in a failure and never the value', () => {
    try {
      resolveSecretRef({ $secret: { env: 'FERRET_TEST_ABSENT_VARIABLE' } }, {});
      expect.unreachable('resolution should have failed');
    } catch (error) {
      expect(String(error)).toContain('FERRET_TEST_ABSENT_VARIABLE');
    }
  });

  it('still resolves the two sources that existed before the seam', () => {
    expect(resolveSecretRef({ $secret: { env: 'PW' } }, { PW: 'hunter2' })).toBe('hunter2');
    expect(resolveSecretRef({ $secret: { file: '/run/s' } }, {}, () => 'hunter2\n')).toBe('hunter2');
  });
});

describe('indirection survives a round trip — AC-3, AC-4', () => {
  let directory: string;
  let configPath: string;
  let auditPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ferret-cred-'));
    configPath = join(directory, 'config.json');
    auditPath = join(directory, 'audit.log');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const store = (): ConfigStore => new ConfigStore({ path: configPath, auditPath, env: { PW: 'hunter2' } });

  const stored = (): Record<string, unknown> =>
    (JSON.parse(readFileSync(configPath, 'utf8')) as { config: Record<string, unknown> }).config;

  it('leaves a stored $secret reference alone — AC-3', () => {
    store().set('database.password', { $secret: { env: 'PW' } });

    // What `ferret init --save` does: write the *resolved* connection back.
    store().setMany(
      {
        'database.host': 'db.example',
        'database.user': 'ferret',
        'database.password': 'hunter2',
      },
      { preserveSecretRefs: true },
    );

    const database = stored()['database'] as Record<string, unknown>;
    expect(database['password']).toStrictEqual({ $secret: { env: 'PW' } });
    expect(readFileSync(configPath, 'utf8')).not.toContain('hunter2');
    // The rest of the connection is still written.
    expect(database['host']).toBe('db.example');
  });

  it('still writes a literal password as a literal — AC-4', () => {
    // D-011 is preserved, not reversed. Governance §3 has an AI client spawn
    // Ferret with an environment Ferret does not control, so a password
    // reachable only through the environment makes normal operation impossible.
    store().setMany(
      { 'database.host': 'db.example', 'database.password': 'hunter2' },
      { preserveSecretRefs: true },
    );

    expect((stored()['database'] as Record<string, unknown>)['password']).toBe('hunter2');
  });

  it('overwrites a stored literal, because a literal is not an indirection', () => {
    store().set('database.password', 'old-password');
    store().setMany({ 'database.password': 'hunter2' }, { preserveSecretRefs: true });

    expect((stored()['database'] as Record<string, unknown>)['password']).toBe('hunter2');
  });

  it('writes the value when nothing is stored yet', () => {
    store().setMany({ 'database.password': 'hunter2' }, { preserveSecretRefs: true });

    expect((stored()['database'] as Record<string, unknown>)['password']).toBe('hunter2');
  });
});

describe('an unenforceable guarantee is reported — AC-10', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ferret-atrest-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('says so when no configuration file exists', () => {
    const report = describeConfigProtection(join(directory, 'absent.json'));

    expect(report.exists).toBe(false);
    expect(report.enforced).toBe(false);
    expect(report.detail).toMatch(/nothing is stored at rest/i);
  });

  it('reports the mode as unenforced on Windows, and does not invent one', () => {
    const path = join(directory, 'config.json');
    new ConfigStore({ path, auditPath: join(directory, 'a.log'), env: {} }).set('logLevel', 'debug');

    const report = describeConfigProtection(path, 'win32');

    expect(report.exists).toBe(true);
    expect(report.enforced).toBe(false);
    // Node synthesises a mode on Windows and it describes nothing an ACL does.
    // Printing it would look like a measurement.
    expect(report.mode).toBeUndefined();
    expect(report.detail).toMatch(/Windows ignores the 0600 mode/);
  });

  it('reports the real mode on a platform that enforces one', () => {
    const path = join(directory, 'config.json');
    new ConfigStore({ path, auditPath: join(directory, 'a.log'), env: {} }).set('logLevel', 'debug');

    const report = describeConfigProtection(path, 'linux');

    expect(report.exists).toBe(true);
    expect(report.mode).toMatch(/^\d{4}$/);
    // The verdict is whatever the filesystem actually says. On Windows the mode
    // Node reports is world-readable, so asserting `enforced` here would assert
    // a property of the CI runner rather than of Ferret.
    expect(typeof report.enforced).toBe('boolean');
    expect(report.detail).toContain(report.mode ?? '');
  });
});
