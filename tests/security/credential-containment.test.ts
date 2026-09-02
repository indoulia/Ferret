import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CREDENTIAL_CONFIG_PATHS, ConfigStore, credentialsFor, parseConfig, withoutCredentialFields } from '../../src/config/index.js';
import { CREDENTIAL_ENV, withoutCredentials } from '../../src/security/index.js';

/**
 * **A credential does not leave the one place that needs it.**
 *
 * Three of the four defects that prompted EPIC-100 were failures of this
 * sentence, and each had a correct, passing test of its own halves:
 *
 * - Every provider received the database password on `context.config`. EPIC-015
 *   tested that a provider gets only its *own* settings; nothing tested that it
 *   gets no credential at all.
 * - `detectGit` started `git --version` with the whole parent environment, and
 *   had since EPIC-001. The Git runner's scrub was tested and correct; nothing
 *   tested that *every* spawner scrubs.
 * - `ferret init --save` replaced a stored `$secret` reference with the
 *   cleartext it resolved to. `ConfigStore` was tested; `resolveSecrets` was
 *   tested; the round trip was not.
 *
 * Each invariant below enumerates its subjects from the source, so the next
 * provider context, the next spawner and the next mutating method are covered
 * on the commit that adds them rather than on the commit that notices.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

function sourceFiles(directory: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(relativeToSrc(full));
  }
  return found;
}

function relativeToSrc(full: string): string {
  return full.slice(SRC.length + 1).split(sep).join('/');
}

function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no provider context carries a credential — AC-4', () => {
  /**
   * Every place in `src/` that builds a `ProviderContext`.
   *
   * Enumerated, because the defect was a *second* construction site nobody
   * remembered: the registry projected correctly and `src/cli/health.ts` passed
   * the whole configuration, so the narrowing was true by type and false at
   * runtime on one of the two paths that mattered.
   */
  const constructors = (): string[] =>
    sourceFiles().filter((file) => {
      const source = stripComments(read(file));
      // A construction site assigns `settings:` alongside a `config:` — the
      // shape of `ProviderContext` and of nothing else.
      return /settings:/.test(source) && /config:/.test(source) && !file.endsWith('contract.ts');
    });

  it('finds the construction sites at all', () => {
    // Failing closed. A rename that made this list empty would turn every
    // assertion below into a no-op that still reports green.
    const found = constructors();

    expect(found.length).toBeGreaterThan(0);
    process.stderr.write(`[EPIC-100] provider-context construction sites: ${found.join(', ')}\n`);
  });

  it('projects the configuration at every one of them', () => {
    for (const file of constructors()) {
      const source = stripComments(read(file));

      expect(source, `${file} builds a provider context without projecting the configuration`).toMatch(
        /withoutCredentialFields\(|config: (?:overrides\.)?config\b(?!\s*,)/,
      );
    }
  });

  it('removes every declared credential path from what a provider sees', () => {
    const projected = withoutCredentialFields(
      parseConfig({ database: { host: 'h', database: 'd', user: 'u', password: 'hunter2' } }),
    );

    expect(CREDENTIAL_CONFIG_PATHS.length).toBeGreaterThan(0);
    expect(JSON.stringify(projected)).not.toContain('hunter2');
    // Absent, not redacted: a placeholder is a string, and a string in a
    // password field is something a caller eventually hands to `pg`.
    expect('password' in projected.database).toBe(false);
  });

  it('grants a credential only to a provider that declared it', () => {
    const config = parseConfig({ database: { host: 'h', database: 'd', user: 'u', password: 'hunter2' } });

    expect(credentialsFor(config, [])).toStrictEqual({});
    expect(credentialsFor(config, ['database.password'])).toStrictEqual({ 'database.password': 'hunter2' });
  });
});

describe('no child process inherits a credential — AC-5', () => {
  const spawners = (): string[] =>
    sourceFiles().filter((file) => stripComments(read(file)).includes('node:child_process'));

  it('finds the spawners at all', () => {
    const found = spawners();

    expect(found.length).toBeGreaterThan(0);
    process.stderr.write(`[EPIC-100] process spawners: ${found.join(', ')}\n`);
  });

  it('reaches the credential scrub from every spawner', () => {
    // The import graph is the checkable half; `boundaries.test.ts` asserts the
    // same property from the other direction, and `withoutCredentials` below
    // asserts the behaviour. Three angles because the failure — an omission —
    // is invisible in a diff.
    for (const file of spawners()) {
      const graph = importsOf(file);

      expect([...graph], `${file} starts a child process without reaching the credential scrub`).toContain(
        'security/credentials.ts',
      );
    }
  });

  it('removes every credential-carrying variable', () => {
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const name of CREDENTIAL_ENV) source[name] = 'hunter2';

    const scrubbed = withoutCredentials(source);

    expect(CREDENTIAL_ENV.length).toBeGreaterThan(0);
    for (const name of CREDENTIAL_ENV) expect(scrubbed[name], name).toBeUndefined();
    expect(scrubbed['PATH']).toBe('/usr/bin');
  });
});

/** Every module reachable from `entry` by a relative import. */
function importsOf(entry: string): Set<string> {
  const files = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    const key = relativeToSrc(current);
    if (files.has(key)) continue;
    files.add(key);
    let source: string;
    try {
      source = stripComments(readFileSync(current, 'utf8'));
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"\n]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      queue.push(resolve(dirname(current), specifier.replace(/\.js$/, '.ts')));
    }
  }
  return files;
}

describe('a secret reference survives every rewrite — AC-6', () => {
  /**
   * `ConfigStore`'s mutating methods, enumerated.
   *
   * The defect was one caller passing a *resolved* value into one of them. A
   * hand-written list of methods to check would have covered `set` and missed
   * `setMany`, which is the one the defect was in.
   */
  const mutators = (): string[] => {
    const source = stripComments(read('config/store.ts'));
    const body = source.slice(source.indexOf('export class ConfigStore'));
    return [...body.matchAll(/^ {2}(?:async )?([a-z][A-Za-z]*)\(/gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => ['set', 'setMany', 'unset', 'replace'].includes(name));
  };

  it('finds the mutating methods at all', () => {
    const found = mutators();

    expect(found).toContain('set');
    expect(found).toContain('setMany');
    process.stderr.write(`[EPIC-100] configuration mutators: ${found.join(', ')}\n`);
  });

  it('keeps a stored reference through a resolved write', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ferret-sec-cfg-'));
    try {
      const path = join(directory, 'config.json');
      const auditPath = join(directory, 'audit.log');
      const store = (): ConfigStore => new ConfigStore({ path, auditPath, env: { PW: 'hunter2' } });

      store().set('database.password', { $secret: { env: 'PW' } });
      // What `ferret init --save` does: write back the *resolved* connection.
      store().setMany({ 'database.host': 'db', 'database.password': 'hunter2' }, { preserveSecretRefs: true });

      const written = readFileSync(path, 'utf8');
      expect(written).toContain('$secret');
      expect(written).not.toContain('hunter2');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('still writes a literal as a literal, so D-011 is not reversed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ferret-sec-cfg-'));
    try {
      const path = join(directory, 'config.json');
      new ConfigStore({ path, auditPath: join(directory, 'a.log'), env: {} }).setMany(
        { 'database.password': 'hunter2' },
        { preserveSecretRefs: true },
      );

      expect(readFileSync(path, 'utf8')).toContain('hunter2');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
