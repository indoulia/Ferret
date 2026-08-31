import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Real repositories, created by real `git`.
 *
 * EPIC-017 is about what Git actually reports, and a fake `git` would only ever
 * confirm what the test author already believed. A linked worktree's `.git`
 * being a *file* whose contents point elsewhere, a bare repository having no top
 * level, `rev-parse` printing four lines in a fixed order — none of that is
 * knowledge worth asserting against a stub.
 *
 * The cost is that these tests need `git` on PATH. They skip when it is absent,
 * and they say so loudly rather than passing quietly.
 */

let cachedAvailability: Promise<string | undefined> | undefined;

/** The installed Git version, or `undefined` when Git is not usable. */
export function gitVersion(): Promise<string | undefined> {
  cachedAvailability ??= run('git', ['--version'], { windowsHide: true, shell: false })
    .then(({ stdout }) => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? 'unknown')
    .catch(() => undefined);
  return cachedAvailability;
}

/**
 * Environment for fixture creation.
 *
 * Hermetic on purpose: the developer running these tests has a global Git
 * configuration, and a fixture whose default branch or user name depends on it
 * is a test that passes on one machine.
 */
function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Ferret Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Ferret Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Runs `git` in a fixture repository.
 *
 * `env` exists for the tests that must pin a commit's instant. Git timestamps
 * have one-second resolution, so whether two commits share an instant otherwise
 * depends on how fast the machine is — which is not a property a test should be
 * measuring.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<string> {
  const { stdout } = await run('git', [...args], {
    cwd,
    env: { ...fixtureEnv(), ...env },
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
  });
  return stdout;
}

/** A temporary directory removed when the returned disposer is called. */
export async function createWorkspace(prefix = 'ferret-git-'): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    },
  };
}

export interface RepositoryOptions {
  /** Remote URL written as `origin`. */
  readonly origin?: string;
  /** Further remotes, by name. */
  readonly remotes?: Readonly<Record<string, string>>;
  /** Whether to make an initial commit. Default true. */
  readonly commit?: boolean;
  /** Extra `.git/config` entries, as `key=value` — used to build hostile fixtures. */
  readonly config?: readonly string[];
}

/** Creates a working repository at `<parent>/<name>` and returns its path. */
export async function createRepository(
  parent: string,
  name: string,
  options: RepositoryOptions = {},
): Promise<string> {
  const path = join(parent, name);
  await run('git', ['init', '-b', 'main', path], {
    env: fixtureEnv(),
    windowsHide: true,
    shell: false,
  });

  if (options.origin !== undefined) {
    await git(path, ['remote', 'add', 'origin', options.origin]);
  }
  for (const [remote, url] of Object.entries(options.remotes ?? {})) {
    await git(path, ['remote', 'add', remote, url]);
  }
  if (options.commit !== false) {
    await writeFile(join(path, 'README.md'), `# ${name}\n`, 'utf8');
    await git(path, ['add', 'README.md']);
    await git(path, ['commit', '-m', 'initial']);
  }

  // Last, deliberately. `config` is how the hostile fixtures are built, and an
  // earlier version of this function applied it *before* the first commit — so
  // the fixture's own `git add` ran the file-system monitor it had just
  // installed, and the security test read that as Ferret having executed the
  // program. It passed on Windows (where a `#!/bin/sh` script will not run) and
  // failed on Linux, which is the worst possible way round.
  for (const entry of options.config ?? []) {
    const index = entry.indexOf('=');
    await git(path, ['config', entry.slice(0, index), entry.slice(index + 1)]);
  }
  return path;
}

/** Creates a bare repository at `<parent>/<name>` and returns its path. */
export async function createBareRepository(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await run('git', ['init', '--bare', '-b', 'main', path], {
    env: fixtureEnv(),
    windowsHide: true,
    shell: false,
  });
  return path;
}

/**
 * Adds a linked worktree to `repository`, returning its path.
 *
 * The interesting fixture: a linked worktree's `.git` is a *file* holding a
 * pointer, and its `--git-dir` differs from its `--git-common-dir`. That
 * difference is what makes five worktrees one repository rather than five.
 */
export async function addWorktree(
  repository: string,
  parent: string,
  name: string,
  branch = `wt-${name}`,
): Promise<string> {
  const path = join(parent, name);
  await git(repository, ['worktree', 'add', '-b', branch, path]);
  return path;
}
