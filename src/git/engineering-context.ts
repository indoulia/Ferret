import { isAbsolute } from 'node:path';

import { ErrorCode, FerretError } from '../errors/index.js';
import { classifyIdentity, normalizeGitIdentity, type NormalizedIdentity } from '../identity/index.js';
import type { ActorClass } from '../domain/index.js';
import type { DiscoveredRepository } from '../providers/contracts/source-repository.js';

import { runGit, type GitRunOptions } from './runner.js';
import { readWorktreeState, type UpstreamState, type WorkingTreeState } from './worktree-state.js';

/**
 * Where the work is happening — EPIC-037 and EPIC-038.
 *
 * Everything else Ferret knows is history. Nothing answered *where am I*, and
 * that is the first thing any answer has to be relative to: an AI client
 * starting in `C:\work\ferret` had no way to ask which repository that is,
 * which branch is checked out, or whether the tree is clean, so every question
 * had to carry its own context and every client built it differently.
 *
 * A **repository** and a **worktree** stay separate fields, not one flattened
 * record. Governance §9 forbids conflating them, and the shape of the answer is
 * where that either holds or quietly stops holding: one repository has several
 * worktrees, and a worktree can be detached from any branch.
 */

export interface WorktreeContext {
  /** Absolute path of the checkout. */
  readonly path: string;
  /** The commit HEAD resolves to. Absent in a repository with no commits. */
  readonly headCommit: string | undefined;
  /** The checked-out branch. Absent when HEAD is detached. */
  readonly branch: string | undefined;
  readonly detached: boolean;
  readonly state: WorkingTreeState;
  /** Absent when the branch tracks nothing. */
  readonly upstream: UpstreamState | undefined;
}

/** Who Git is configured to commit as, here. */
export interface LocalIdentityContext {
  readonly identity: NormalizedIdentity;
  readonly actorClass: ActorClass;
  /** Why it was classified that way. */
  readonly reason: string;
}

export interface EngineeringContext {
  readonly repository: DiscoveredRepository;
  readonly worktree: WorktreeContext;
  /** Absent when Git has no `user.email` configured here. */
  readonly localIdentity: LocalIdentityContext | undefined;
}

export interface EngineeringContextOptions extends Omit<GitRunOptions, 'cwd' | 'signal'> {
  /**
   * Cancellation, when the caller has any.
   *
   * Optional here alone among the Git operations: "where am I" is four local
   * reads that finish in milliseconds, and an AI client asking it at the start
   * of a session has no signal to thread through. Every other entry point keeps
   * it required, because every other one can run for a long time.
   */
  readonly signal?: AbortSignal;
  /**
   * Describes the repository the directory belongs to.
   *
   * Injected rather than imported so this module does not depend on the
   * provider that depends on it. EPIC-017 already answers this question and
   * re-deriving identity here would be a second answer to it.
   */
  readonly describeRepository: (root: string) => Promise<DiscoveredRepository>;
}

/**
 * The repository root containing a directory.
 *
 * `--show-toplevel` rather than walking up looking for `.git`: it is correct
 * for a linked worktree, where `.git` is a file, and for a submodule, where the
 * naive walk finds the parent.
 */
export async function repositoryRootOf(options: GitRunOptions): Promise<string | undefined> {
  const result = await runGit(['rev-parse', '--show-toplevel'], { ...options, allowFailure: true });
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.trim();
  return root.length === 0 ? undefined : root;
}

/** The configured commit identity, classified through EPIC-036. */
export async function localIdentityOf(
  options: GitRunOptions,
): Promise<LocalIdentityContext | undefined> {
  const [email, name] = await Promise.all([
    runGit(['config', '--get', 'user.email'], { ...options, allowFailure: true }),
    runGit(['config', '--get', 'user.name'], { ...options, allowFailure: true }),
  ]);
  // `git config --get` exits non-zero when the key is unset, which is a normal
  // state and not a failure.
  const identity = normalizeGitIdentity(name.stdout.trim(), email.stdout.trim());
  if (identity === undefined) return undefined;

  // Classified like any other identity: `user.email` is whatever the user set,
  // so a machine account running CI is reported as an agent rather than as the
  // person at the keyboard.
  const { actorClass, reason } = classifyIdentity(identity);
  return { identity, actorClass, reason };
}

/**
 * Describes where work is happening.
 *
 * Returns `undefined` when the directory is not inside a repository — a normal
 * answer, not a failure, and the one an AI client gets when a user opens a
 * folder that is not a checkout.
 */
export async function describeEngineeringContext(
  cwd: string,
  options: EngineeringContextOptions,
): Promise<EngineeringContext | undefined> {
  if (!isAbsolute(cwd)) {
    throw new FerretError(ErrorCode.USAGE, 'Engineering context needs an absolute directory', {
      details: { cwd },
      remediation: 'Resolve the path before asking about it.',
    });
  }

  const runOptions: GitRunOptions = {
    ...options,
    cwd,
    signal: options.signal ?? new AbortController().signal,
  };
  const root = await repositoryRootOf(runOptions);
  if (root === undefined) return undefined;

  const [repository, worktree, localIdentity] = await Promise.all([
    options.describeRepository(root),
    readWorktreeState(runOptions),
    localIdentityOf(runOptions),
  ]);

  return {
    repository,
    worktree: {
      path: root,
      headCommit: worktree.headCommit,
      branch: worktree.branch,
      detached: worktree.detached,
      state: worktree.state,
      upstream: worktree.upstream,
    },
    localIdentity,
  };
}
