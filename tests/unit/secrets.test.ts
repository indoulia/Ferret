import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { containsSecret, isSecretPath, redactSecrets } from '../../src/security/index.js';

/**
 * EPIC-082. Fixtures use documented example credentials and syntactically valid
 * but never-issued tokens; no real credential is in this tree.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('detecting credentials', () => {
  const cases: [string, string, string][] = [
    ['aws-access-key-id', 'key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws-access-key-id', 'temp ASIAIOSFODNN7EXAMPLE here', 'ASIAIOSFODNN7EXAMPLE'],
    ['github-token', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github-fine-grained-token', 'github_pat_11ABCDEFG0abcdefghijklmnop', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['slack-token', 'xoxb-1234567890-abcdefghijkl posted', 'xoxb-1234567890-abcdefghijkl'],
    ['google-api-key', 'AIzaSyA0123456789abcdefghijklmnopqrstuv done', 'AIzaSyA0123456789abcdefghijklmnopqrstuv'],
    ['openai-api-key', 'sk-abcdefghijklmnopqrstuvwx now', 'sk-abcdefghijklmnopqrstuvwx'],
    ['stripe-key', 'sk_live_abcdefghij0123456789', 'sk_live_abcdefghij0123456789'],
    ['npm-token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJ'],
  ];

  for (const [kind, text, secret] of cases) {
    it(`redacts a ${kind}`, () => {
      const result = redactSecrets(text);
      expect(result.found[kind], text).toBe(1);
      expect(result.text).not.toContain(secret);
      expect(result.text).toContain(`[redacted: ${kind}]`);
    });
  }

  it('redacts a private key block whole, not piecewise', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\nAAAA\n-----END RSA PRIVATE KEY-----';
    const result = redactSecrets(`before\n${key}\nafter`);
    expect(result.found['private-key']).toBe(1);
    expect(result.text).toBe('before\n[redacted: private-key]\nafter');
  });

  it('redacts a password in a URL but keeps the host', () => {
    const result = redactSecrets('cloned https://ferret:hunter2@github.com/x/y.git');
    expect(result.text).toContain('github.com/x/y.git');
    expect(result.text).not.toContain('hunter2');
  });

  it('redacts an assigned secret but keeps its name', () => {
    const result = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE');
    expect(result.text).toContain('AWS_SECRET_ACCESS_KEY=');
    expect(result.text).not.toContain('wJalrXUtnFEMI');
  });

  it('keeps everything around the credential', () => {
    const result = redactSecrets('rotate AKIAIOSFODNN7EXAMPLE before Friday');
    expect(result.text).toBe('rotate [redacted: aws-access-key-id] before Friday');
  });

  it('counts by kind and never carries the value', () => {
    const result = redactSecrets('AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLB');
    expect(result.found['aws-access-key-id']).toBe(2);
    expect(JSON.stringify(result.found)).not.toContain('AKIA');
  });

  it('leaves ordinary prose alone', () => {
    for (const text of [
      'reset the password flow',
      'add a token bucket rate limiter',
      'the secret sauce is caching',
      'sk-ip this test',
      'AKIA is a prefix',
      'ghp_short',
      'see docs/security/README.md',
    ]) {
      expect(containsSecret(text), text).toBe(false);
    }
  });

  it('fails closed on text too large to scan', () => {
    const result = redactSecrets('a'.repeat(1_000_001));
    expect(result.redacted).toBe(1);
    expect(result.text).toContain('too large to scan');
  });

  it('does not carry match state between calls', () => {
    // A `g` regex keeps `lastIndex`; without a reset the second call would
    // start mid-string and miss the match.
    const first = redactSecrets('AKIAIOSFODNN7EXAMPLE');
    const second = redactSecrets('AKIAIOSFODNN7EXAMPLE');
    expect(first.text).toBe(second.text);
  });
});

describe('false positives, against the real corpus', () => {
  it('fires on no provider credential format in this repository’s commit messages', () => {
    // AC-9, on real text rather than a fixture: this repository is full of prose
    // about tokens, secrets and keys, and a detector that fires on engineering
    // prose destroys content silently.
    //
    // `assigned-secret` is expected and correct — the history quotes
    // `DATABASE_PASSWORD=hunter2` from a test fixture in an EPIC-008 checkpoint
    // commit. That is a genuine match, not a false positive.
    const log = execFileSync('git', ['log', '--format=%B', '-n', '400'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });

    const found = Object.keys(redactSecrets(log).found);
    expect(found.filter((kind) => kind !== 'assigned-secret'), found.join(', ')).toStrictEqual([]);
  });

  it('redacts nothing in this repository’s own file paths', () => {
    const paths = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.length > 0);

    const excluded = paths.filter((path) => isSecretPath(path));
    expect(excluded, excluded.join(', ')).toStrictEqual([]);
  });
});

describe('excluding secret-bearing paths', () => {
  it('excludes the files that hold credentials', () => {
    for (const path of [
      '.env',
      'app/.env',
      '.env.production',
      'certs/server.pem',
      'certs/server.key',
      'store.p12',
      'keys/id_rsa',
      'keys/id_ed25519',
      '.npmrc',
      '.pgpass',
      '.netrc',
      '.aws/credentials',
      'home/.ssh/known_hosts',
      'service-account-prod.json',
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it('keeps the example files that document what a project needs', () => {
    // Excluding these costs real value for no gain, and exclusions are additive
    // so a person cannot put them back.
    for (const path of ['.env.example', '.env.sample', 'app/.env.template', '.env.defaults']) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  it('keeps ordinary source that merely sounds sensitive', () => {
    for (const path of [
      'src/security/secrets.ts',
      'src/auth/password-reset.ts',
      'docs/credentials-guide.md',
      'tests/unit/secrets.test.ts',
      'keys.ts',
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });

  it('normalises a Windows separator', () => {
    expect(isSecretPath('app\\.env')).toBe(true);
  });
});
