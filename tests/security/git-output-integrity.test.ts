import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';


import { parseHistoryOutput, parseLog, readHistory, type CommitRecord } from '../../src/git/history.js';
import { GIT_SAFETY_CONFIG, GIT_STRIPPED_ENV } from '../../src/git/index.js';
import { createRepository, createWorkspace, git, gitVersion } from '../support/git-fixtures.js';

/**
 * **A repository cannot change the shape of what Ferret reads from it — F-94.**
 *
 * `SAFETY_CONFIG` was written against one property: a configuration key whose
 * value *names a program*. That is half the threat. The other half is a key that
 * changes the *shape of Git's output*, and under it a repository does not need
 * to run anything — it rewrites the stream Ferret's parser is reading, and the
 * parser reports whatever it makes of the result as fact.
 *
 * `i18n.logOutputEncoding=UTF-16` is the proven case: Git re-encodes the
 * `--format` region and Ferret decodes it as UTF-8, so the record separators are
 * not where the parser looks for them. In the version this finding was raised
 * against that produced a *fabricated* commit under a SHA the repository chose;
 * with the record marker Batch 3 introduced it produces **silence** — nine
 * commits in, zero out, no error, an empty page indistinguishable from a
 * repository with no history. Both are the same defect: the repository decided
 * what Ferret would report.
 *
 * The tests below are written against the boundary itself — a real repository,
 * a real `git`, and `readHistory`'s actual return value — and every hostile case
 * carries a **control** that proves the vector works when Ferret's overrides are
 * not applied. Without the control a test like this passes on a machine where
 * the attack was never possible and concludes a protection it never observed.
 */

const version = await gitVersion();
const describeGit = version === undefined ? describe.skip : describe;

function signal(): AbortSignal {
  return new AbortController().signal;
}

let workspace: { path: string; cleanup: () => Promise<void> };
let repository: string;
let baseline: readonly CommitRecord[];
let realShas: ReadonlySet<string>;
let realPaths: ReadonlySet<string>;

/** Sets repository configuration, the way an attacker with `.git/config` would. */
async function configure(...entries: readonly string[]): Promise<void> {
  for (const entry of entries) {
    const at = entry.indexOf('=');
    await git(repository, ['config', entry.slice(0, at), entry.slice(at + 1)]);
  }
}

async function unconfigure(...keys: readonly string[]): Promise<void> {
  for (const key of keys) await git(repository, ['config', '--unset-all', key]).catch(() => '');
}

/** What Ferret reports, through the whole real path. */
async function read(): Promise<readonly CommitRecord[]> {
  const page = await readHistory({ cwd: repository, signal: signal(), withChanges: true });
  return page.commits;
}

/**
 * Git's own output for the same query, with none of Ferret's overrides.
 *
 * The control. A UTF-16 stream decoded as UTF-8 carries NUL bytes between every
 * character, so "the vector worked" is observable without asserting on Ferret.
 */
async function unprotected(env: NodeJS.ProcessEnv = {}): Promise<string> {
  // A format with no NUL of its own, so a NUL in the result can only have come
  // from a re-encoded stream.
  return git(repository, ['log', '--format=%H', '-1'], env);
}

beforeAll(async () => {
  workspace = await createWorkspace('ferret-git-integrity-');
  repository = await createRepository(workspace.path, 'target', { commit: false });

  // Three commits, distinct in every field the parser reads, so a reshaped
  // stream cannot coincidentally produce the same answer.
  await writeFile(join(repository, 'alpha.txt'), 'a\n', 'utf8');
  await git(repository, ['add', 'alpha.txt']);
  await git(repository, ['commit', '-m', 'first commit']);

  await mkdir(join(repository, 'nested'), { recursive: true });
  await writeFile(join(repository, 'nested', 'beta.txt'), 'b\n', 'utf8');
  await git(repository, ['add', join('nested', 'beta.txt')]);
  await git(repository, ['commit', '-m', 'second commit']);

  await writeFile(join(repository, 'gamma.txt'), 'g\n', 'utf8');
  await git(repository, ['add', 'gamma.txt']);
  await git(repository, ['commit', '-m', 'third commit']);

  baseline = await read();
  realShas = new Set(baseline.map((commit) => commit.sha));
  realPaths = new Set(baseline.flatMap((commit) => commit.changes.map((change) => change.path)));
}, 60_000);

afterAll(async () => {
  await workspace?.cleanup();
});

/**
 * The whole assertion, in one place.
 *
 * Not `toStrictEqual(baseline)` alone: the interesting failures are the ones
 * that produce *something* rather than nothing, so identity, timestamps, paths
 * and the absence of invention are each stated, and each names what it caught.
 */
function expectUnchanged(commits: readonly CommitRecord[], label: string): void {
  expect(commits.map((commit) => commit.sha), `${label}: commit identity`).toStrictEqual(
    baseline.map((commit) => commit.sha),
  );
  expect(commits, `${label}: every field`).toStrictEqual(baseline);

  for (const commit of commits) {
    expect(realShas.has(commit.sha), `${label}: fabricated commit ${commit.sha}`).toBe(true);
    for (const parent of commit.parents) {
      expect(realShas.has(parent), `${label}: fabricated parent ${parent}`).toBe(true);
    }
    for (const change of commit.changes) {
      expect(realPaths.has(change.path), `${label}: fabricated path ${change.path}`).toBe(true);
    }
  }
}

describeGit('the baseline is worth comparing against', () => {
  it('reads the three commits, with their changes', () => {
    expect(baseline.map((commit) => commit.subject)).toStrictEqual([
      'third commit',
      'second commit',
      'first commit',
    ]);
    expect([...realPaths].sort()).toStrictEqual(['alpha.txt', 'gamma.txt', 'nested/beta.txt']);
    for (const commit of baseline) expect(commit.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

describeGit('a repository cannot re-encode the stream Ferret parses — F-94', () => {
  it('reports the same history with i18n.logOutputEncoding=UTF-16 set', async () => {
    await configure('i18n.logOutputEncoding=UTF-16');
    try {
      // Control first: the vector is real on this machine.
      expect(await unprotected(), 'control: the hostile encoding did not take effect').toContain('\u0000');

      expectUnchanged(await read(), 'i18n.logOutputEncoding');
    } finally {
      await unconfigure('i18n.logOutputEncoding');
    }
  });

  it('reports the same history with i18n.commitEncoding=UTF-16 set', async () => {
    // A second key with the same effect, which is the point: the first was
    // found by reading the report, and a list that stops at what a report
    // named is the enumeration this batch exists to stop trusting.
    await configure('i18n.commitEncoding=UTF-16');
    try {
      expect(await unprotected(), 'control: commitEncoding did not take effect').toContain('\u0000');

      expectUnchanged(await read(), 'i18n.commitEncoding');
    } finally {
      await unconfigure('i18n.commitEncoding');
    }
  });

  it('reports the same history when the hostile key arrives through include.path', async () => {
    // An alternate reachable configuration path: `.git/config` includes another
    // file, and the value is applied exactly as though it were written inline.
    await writeFile(join(repository, '.git', 'included.cfg'), '[i18n]\n\tlogOutputEncoding = UTF-16\n', 'utf8');
    await configure('include.path=included.cfg');
    try {
      expect(await unprotected(), 'control: include.path did not take effect').toContain('\u0000');

      expectUnchanged(await read(), 'include.path');
    } finally {
      await unconfigure('include.path');
      await rm(join(repository, '.git', 'included.cfg'), { force: true });
    }
  });

  it('reports the same history when the hostile key arrives through config.worktree', async () => {
    // The third reachable path inside the repository: `extensions.worktreeConfig`
    // turns on a per-worktree configuration file that is not `.git/config` at
    // all, so anything that inspects only `.git/config` sees a clean repository.
    await configure('extensions.worktreeConfig=true');
    await writeFile(join(repository, '.git', 'config.worktree'), '[i18n]\n\tlogOutputEncoding = UTF-16\n', 'utf8');
    try {
      expect(await unprotected(), 'control: config.worktree did not take effect').toContain('\u0000');

      expectUnchanged(await read(), 'config.worktree');
    } finally {
      await rm(join(repository, '.git', 'config.worktree'), { force: true });
      await unconfigure('extensions.worktreeConfig');
    }
  });
});

describeGit('the environment Ferret was started in cannot reshape the stream either', () => {
  /**
   * Governance §3: an AI client spawns Ferret with an environment Ferret does
   * not control. `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT`
   * are already stripped for exactly that reason; `GIT_CONFIG_GLOBAL` and
   * `GIT_CONFIG_SYSTEM` are the same mechanism under names added later, and
   * they were not.
   */
  let hostileConfig: string;

  beforeAll(async () => {
    hostileConfig = join(workspace.path, 'hostile-global.cfg');
    await writeFile(hostileConfig, '[i18n]\n\tlogOutputEncoding = UTF-16\n', 'utf8');
  });

  async function withEnvironment(
    variables: Readonly<Record<string, string>>,
    body: () => Promise<void>,
  ): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(variables)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      await body();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it('ignores GIT_CONFIG_GLOBAL', async () => {
    expect(await unprotected({ GIT_CONFIG_GLOBAL: hostileConfig }), 'control').toContain('\u0000');

    await withEnvironment({ GIT_CONFIG_GLOBAL: hostileConfig }, async () => {
      expectUnchanged(await read(), 'GIT_CONFIG_GLOBAL');
    });
  });

  it('ignores GIT_CONFIG_SYSTEM', async () => {
    expect(await unprotected({ GIT_CONFIG_SYSTEM: hostileConfig }), 'control').toContain('\u0000');

    await withEnvironment({ GIT_CONFIG_SYSTEM: hostileConfig }, async () => {
      expectUnchanged(await read(), 'GIT_CONFIG_SYSTEM');
    });
  });

  it('ignores the GIT_CONFIG_COUNT triple, as it already did', async () => {
    const injected = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'i18n.logOutputEncoding',
      GIT_CONFIG_VALUE_0: 'UTF-16',
    };
    expect(await unprotected(injected), 'control').toContain('\u0000');

    await withEnvironment(injected, async () => {
      expectUnchanged(await read(), 'GIT_CONFIG_COUNT');
    });
  });

  it('strips every GIT_CONFIG variable by prefix, not by name', () => {
    // The rule, rather than the three instances of it. `GIT_CONFIG_GLOBAL` was
    // missing because the list was written before that name existed; a list
    // written by name is always one Git release behind.
    const scrubbed = [
      'GIT_CONFIG',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_SOMETHING_GIT_HAS_NOT_SHIPPED_YET',
    ];
    for (const name of scrubbed) {
      expect(GIT_STRIPPED_ENV.includes(name) || /^GIT_CONFIG(?:_|$)/u.test(name), name).toBe(true);
    }
  });
});

describeGit('a repository cannot make git log run a program through signature verification', () => {
  /**
   * `log.showSignature=true` plus `gpg.program` is a configuration-borne
   * *execution* vector that `SAFETY_CONFIG`'s eleven entries did not cover, and
   * it is reachable from the one command Ferret runs most. Found by re-auditing
   * F-94's output-shape claim rather than by the report, which named only the
   * encoding half.
   */
  let marker: string;
  let program: string;
  let signed: string;

  beforeAll(async () => {
    marker = join(workspace.path, 'gpg-ran.txt');
    program = join(workspace.path, 'fake-gpg.sh');
    await writeFile(program, `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`, { mode: 0o755 });

    // A commit carrying a `gpgsig` header, written literally. Nothing here has
    // to be a valid signature — Git runs the program to find that out, which is
    // the whole point.
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim();
    const parent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const object =
      `tree ${tree}\nparent ${parent}\n` +
      'author Fixture <fixture@example.com> 1700000000 +0000\n' +
      'committer Fixture <fixture@example.com> 1700000000 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n not a signature\n -----END PGP SIGNATURE-----\n' +
      '\nsigned commit\n';
    signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
      cwd: repository,
      input: object,
      encoding: 'utf8',
    }).trim();
  });

  it('does not run gpg.program, and still reads the commit', async () => {
    await git(repository, ['update-ref', 'refs/heads/signed', signed]);
    await configure('log.showSignature=true', `gpg.program=${program}`);
    try {
      // Control: without Ferret's overrides the program runs.
      await rm(marker, { force: true });
      await git(repository, ['log', '--format=%H', '-1', 'refs/heads/signed']).catch(() => '');
      const vectorWorks = await readFile(marker, 'utf8').then(
        () => true,
        () => false,
      );
      if (!vectorWorks) {
        process.stderr.write(
          '[F-94] this platform did not execute the hostile gpg.program even without Ferret’s overrides;\n' +
            '       the signature-verification execution vector is NOT demonstrated here.\n',
        );
      }
      await rm(marker, { force: true });

      const page = await readHistory({
        cwd: repository,
        signal: signal(),
        revision: 'refs/heads/signed',
        withChanges: true,
      });

      const ran = await readFile(marker, 'utf8').then(
        () => true,
        () => false,
      );
      expect(ran, 'Ferret executed a program the repository nominated').toBe(false);
      // And the commit is still read: the fix is a pin, not a refusal.
      expect(page.commits[0]?.sha).toBe(signed);
      expect(page.commits[0]?.subject).toBe('signed commit');
      expect(page.incomplete).toBeUndefined();
    } finally {
      await unconfigure('log.showSignature', 'gpg.program');
      await git(repository, ['update-ref', '-d', 'refs/heads/signed']).catch(() => '');
    }
  });
});

describeGit('the safety configuration covers output shape, not only execution', () => {
  it('pins every key that decides what git log looks like', () => {
    const pinned = new Map(GIT_SAFETY_CONFIG.map((entry) => entry.split('=') as [string, string]));

    // Proven vectors, each with a case above or a measurement in the evidence
    // report. Named individually because a missing one is silent.
    expect(pinned.get('i18n.logOutputEncoding')).toBe('UTF-8');
    expect(pinned.get('i18n.commitEncoding')).toBe('UTF-8');
    expect(pinned.get('log.showSignature')).toBe('false');
    expect(pinned.get('core.quotePath')).toBe('false');
    expect(pinned.get('diff.relative')).toBe('false');
  });

  it('keeps every program-naming key it already pinned', () => {
    const keys = GIT_SAFETY_CONFIG.map((entry) => entry.split('=')[0]);
    for (const key of [
      'core.hooksPath',
      'core.fsmonitor',
      'core.pager',
      'credential.helper',
      'core.sshCommand',
      'protocol.ext.allow',
      'diff.external',
    ]) {
      expect(keys, key).toContain(key);
    }
  });
});

describe('output Ferret cannot read is reported, never silently dropped', () => {
  /**
   * The control that does not depend on knowing the key.
   *
   * Pinning `i18n.logOutputEncoding` closes the vector that was found. It cannot
   * close the vector that has not been found, because the pin is an enumeration
   * and enumerations of this kind have now failed three times in this audit. So
   * the parser stops treating a region it cannot read as *absence*: it counts
   * it, and `readHistory` reports the page as incomplete, which is what stops
   * the watermark advancing over a gap.
   */
  const record = (sha: string, subject: string): string =>
    ['ferret', sha, '', '', 'A', 'a@example.com', '2024-01-01T00:00:00+00:00', 'A', 'a@example.com', '2024-01-01T00:00:00+00:00', subject, ''].join(
      '\0',
    );

  it('counts nothing on output that is entirely records', () => {
    const stdout = `${record('a'.repeat(40), 'one')}\0${record('b'.repeat(40), 'two')}\0`;
    const parsed = parseHistoryOutput(stdout, false);

    expect(parsed.commits.map((commit) => commit.subject)).toStrictEqual(['one', 'two']);
    expect(parsed.unreadable).toBe(0);
  });

  it('counts a region between records rather than skipping it', () => {
    const stdout = `${record('a'.repeat(40), 'one')}\0gpg: Signature made yesterday\0${record('b'.repeat(40), 'two')}\0`;
    const parsed = parseHistoryOutput(stdout, false);

    // Both real commits are still returned — a malformed region costs the
    // commits it touches, not the page.
    expect(parsed.commits.map((commit) => commit.subject)).toStrictEqual(['one', 'two']);
    expect(parsed.unreadable).toBeGreaterThan(0);
  });

  it('counts a wholly re-encoded stream instead of reporting an empty history', () => {
    // What `i18n.logOutputEncoding=UTF-16` looks like by the time it reaches the
    // parser: every character preceded by a NUL, so nothing is where the record
    // separator should be.
    const utf16 = Buffer.from(record('c'.repeat(40), 'three'), 'utf16le').toString('utf8');
    const parsed = parseHistoryOutput(utf16, false);

    expect(parsed.commits).toStrictEqual([]);
    // The defect this replaces: `[]` with nothing said, which a caller cannot
    // tell from a repository that has no commits.
    expect(parsed.unreadable).toBeGreaterThan(0);
  });

  it('leaves parseLog’s contract as it was, for the callers that only want commits', () => {
    const stdout = `${record('a'.repeat(40), 'one')}\0`;
    expect(parseLog(stdout, false).map((commit) => commit.subject)).toStrictEqual(['one']);
    expect(parseLog('', false)).toStrictEqual([]);
  });
});

describeGit('a healthy repository is not reported as incomplete', () => {
  it('reads clean history with nothing unreadable in it', async () => {
    const page = await readHistory({ cwd: repository, signal: signal(), withChanges: true });

    // The control for the control. A deny-by-default counter that fires on
    // ordinary output would be worse than the defect it replaces.
    expect(page.incomplete).toBeUndefined();
    expect(page.commits).toHaveLength(baseline.length);
  });
});
