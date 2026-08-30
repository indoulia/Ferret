import { describe, expect, it } from 'vitest';

import { REDACTED } from '../../src/index.js';
import {
  GIT_SAFETY_CONFIG,
  GIT_STRIPPED_ENV,
  isWithin,
  maskRemote,
  normalizeRemote,
  repositoryIdentity,
  scrubEnvironment,
} from '../../src/git/index.js';

/**
 * Repository identity and the Git runner's safety construction.
 *
 * These are the parts of EPIC-017 that need no filesystem and no `git`
 * executable, and they are the parts where a mistake is quietest: an identity
 * that fails to unify two clones does not fail here, it fails in EPIC-051 as two
 * entities that should have been one.
 */

describe('remote URL normalization', () => {
  it.each([
    ['https://github.com/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['https://github.com/Indoulia/Ferret', 'github.com/Indoulia/Ferret'],
    ['https://github.com/Indoulia/Ferret/', 'github.com/Indoulia/Ferret'],
    ['http://github.com/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['git://github.com/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['ssh://git@github.com/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['ssh://git@github.com:22/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['git@github.com:Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
    ['git@github.com:Indoulia/Ferret', 'github.com/Indoulia/Ferret'],
    ['https://GITHUB.COM/Indoulia/Ferret.git', 'github.com/Indoulia/Ferret'],
  ])('reduces %s to the identity two clones share', (url, expected) => {
    expect(normalizeRemote(url)?.canonical).toBe(expected);
  });

  it('unifies every form of the same repository', () => {
    // The entire point. If these ever disagree, one repository becomes several
    // and nothing downstream can tell that it happened.
    const forms = [
      'https://github.com/Indoulia/Ferret.git',
      'git@github.com:Indoulia/Ferret.git',
      'ssh://git@github.com/Indoulia/Ferret',
      'git://github.com/Indoulia/Ferret.git',
    ];
    const canonical = new Set(forms.map((url) => normalizeRemote(url)?.canonical));
    expect(canonical.size).toBe(1);
  });

  it('keeps a non-default port, because it names a different server', () => {
    expect(normalizeRemote('ssh://git@git.example.com:2222/team/repo.git')?.canonical).toBe(
      'git.example.com:2222/team/repo',
    );
  });

  it('preserves path case rather than merging repositories that may differ', () => {
    // GitHub treats these as one; a self-hosted server on a case-sensitive
    // filesystem does not. Failing to merge is correctable with evidence
    // (EPIC-051); merging wrongly is not correctable by anything.
    expect(normalizeRemote('https://git.example.com/Team/Repo.git')?.canonical).toBe(
      'git.example.com/Team/Repo',
    );
    expect(normalizeRemote('https://git.example.com/team/repo.git')?.canonical).toBe(
      'git.example.com/team/repo',
    );
  });

  it.each([
    ['', undefined],
    ['   ', undefined],
    ['not a url at all', undefined],
    ['https://github.com', undefined],
  ])('returns nothing rather than guessing for %s', (url, expected) => {
    expect(normalizeRemote(url)?.canonical).toBe(expected);
  });
});

describe('credentials in remote URLs', () => {
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwx';

  it('strips a token from the identity', () => {
    // `git clone` with a personal access token writes it straight into
    // .git/config, where it stays. Ferret reads that config.
    const normalized = normalizeRemote(`https://user:${TOKEN}@github.com/Indoulia/Ferret.git`);
    expect(normalized?.canonical).toBe('github.com/Indoulia/Ferret');
    expect(normalized?.canonical).not.toContain(TOKEN);
  });

  it('masks the token in the value that gets stored and shown', () => {
    const normalized = normalizeRemote(`https://user:${TOKEN}@github.com/Indoulia/Ferret.git`);
    expect(normalized?.hadCredentials).toBe(true);
    expect(normalized?.display).not.toContain(TOKEN);
    expect(normalized?.display).toContain(REDACTED);
  });

  it('gives a credentialled and a clean URL the same identity', () => {
    // Two people clone the same repository, one with a token in the URL. They
    // are looking at one repository, and Ferret must agree.
    expect(normalizeRemote(`https://x-access-token:${TOKEN}@github.com/a/b.git`)?.canonical).toBe(
      normalizeRemote('https://github.com/a/b.git')?.canonical,
    );
  });

  it('does not treat the conventional git@ SSH user as a credential', () => {
    const normalized = normalizeRemote('git@github.com:Indoulia/Ferret.git');
    expect(normalized?.hadCredentials).toBe(false);
    expect(normalized?.display).toBe('git@github.com:Indoulia/Ferret.git');
  });

  it('masks any other SSH username, which is not conventional', () => {
    const normalized = normalizeRemote('deploy-key-7f3a@git.example.com:team/repo.git');
    expect(normalized?.hadCredentials).toBe(true);
    expect(normalized?.display).not.toContain('deploy-key-7f3a');
  });

  it('masks a URL it cannot otherwise parse', () => {
    expect(maskRemote(`weird://user:${TOKEN}@host/x`)).not.toContain(TOKEN);
  });
});

describe('repository identity', () => {
  it('prefers the remote, so two clones at two paths are one repository', () => {
    const a = repositoryIdentity('https://github.com/Indoulia/Ferret.git', '/home/alice/ferret/.git');
    const b = repositoryIdentity('git@github.com:Indoulia/Ferret.git', '/opt/build/ferret/.git');
    expect(a.key).toBe(b.key);
    expect(a.source).toBe('remote');
  });

  it('falls back to the path, and says so', () => {
    // Reported rather than hidden: an operator wondering why two clones did not
    // merge should be able to see the reason instead of deducing it.
    const identity = repositoryIdentity(undefined, '/home/alice/scratch/.git');
    expect(identity.source).toBe('path');
    expect(identity.key).toBe('/home/alice/scratch/.git');
  });

  it('keeps two remoteless repositories apart', () => {
    expect(repositoryIdentity(undefined, '/a/.git').key).not.toBe(
      repositoryIdentity(undefined, '/b/.git').key,
    );
  });

  it('treats a Windows path consistently however it was spelled', () => {
    const lower = repositoryIdentity(undefined, 'c:\\repos\\ferret\\.git');
    const upper = repositoryIdentity(undefined, 'C:/repos/ferret/.git');
    expect(lower.key).toBe(upper.key);
  });

  it('does not use a file:// remote as a shared identity', () => {
    // Two people's `/home/x/repo` are different repositories. Treating a local
    // path as a shared remote would merge them.
    const identity = repositoryIdentity('file:///home/alice/upstream', '/home/bob/clone/.git');
    expect(identity.source).toBe('path');
  });
});

describe('containment', () => {
  it.each([
    ['/home/user', '/home/user', true],
    ['/home/user', '/home/user/projects', true],
    ['/home/user', '/home/user2', false],
    ['/home/user', '/home', false],
    ['/home/user', '/home/user/../other', false],
  ])('%s contains %s → %s', (root, candidate, expected) => {
    // String prefix would say `/home/user2` is inside `/home/user`, which is how
    // a symlink check that looks correct lets a walk out of its root.
    expect(isWithin(root, candidate)).toBe(expected);
  });
});

describe('the Git runner’s safety construction', () => {
  it('overrides every configuration key that names a program', () => {
    // Running git inside a repository consults that repository's own config,
    // and each of these keys names something to execute. A repository Ferret
    // cloned for indexing could otherwise run code by being looked at.
    const keys = GIT_SAFETY_CONFIG.map((entry) => entry.split('=')[0]);
    expect(keys).toContain('core.hooksPath');
    expect(keys).toContain('core.fsmonitor');
    expect(keys).toContain('core.pager');
    expect(keys).toContain('credential.helper');
    expect(keys).toContain('core.sshCommand');
    expect(keys).toContain('protocol.ext.allow');
  });

  it('does not disable Git’s own ownership check', () => {
    // `safe.directory` exists to protect against precisely this class of attack.
    // Setting it to `*` would make an inconvenient error go away by removing the
    // protection, which is the wrong trade every time.
    expect(GIT_SAFETY_CONFIG.some((entry) => entry.startsWith('safe.directory'))).toBe(false);
  });

  it('removes the variables that redirect Git at another repository', () => {
    const scrubbed = scrubEnvironment({
      PATH: '/usr/bin',
      GIT_DIR: '/somewhere/else/.git',
      GIT_WORK_TREE: '/somewhere/else',
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/evil'",
      GIT_SSH_COMMAND: '/tmp/evil',
    });

    // Any one of these silently points Git at a different repository, which
    // would make every fact Ferret reports attach to the wrong entity.
    expect(scrubbed['GIT_DIR']).toBeUndefined();
    expect(scrubbed['GIT_WORK_TREE']).toBeUndefined();
    expect(scrubbed['GIT_CONFIG_PARAMETERS']).toBeUndefined();
    expect(scrubbed['GIT_SSH_COMMAND']).toBeUndefined();
    expect(scrubbed['PATH']).toBe('/usr/bin');
  });

  it('keeps the environment Git legitimately needs', () => {
    // Removing rather than rebuilding: a hand-built environment breaks in ways
    // that are tedious to discover one platform at a time.
    const scrubbed = scrubEnvironment({ PATH: '/usr/bin', HOME: '/home/alice', SystemRoot: 'C:\\Windows' });
    expect(scrubbed['HOME']).toBe('/home/alice');
    expect(scrubbed['SystemRoot']).toBe('C:\\Windows');
  });

  it('never lets Git block on a credential prompt', () => {
    // A background index waiting on a prompt nobody is watching is
    // indistinguishable from a hang.
    const scrubbed = scrubEnvironment({});
    expect(scrubbed['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(scrubbed['GIT_ASKPASS']).toBeUndefined();
  });

  it('never takes a repository lock, because Ferret only reads', () => {
    // A background index must not compete with the developer working in the
    // same repository.
    expect(scrubEnvironment({})['GIT_OPTIONAL_LOCKS']).toBe('0');
  });

  it('names every stripped variable, so adding one is a decision', () => {
    expect(GIT_STRIPPED_ENV.length).toBeGreaterThan(10);
    expect(new Set(GIT_STRIPPED_ENV).size).toBe(GIT_STRIPPED_ENV.length);
  });
});
