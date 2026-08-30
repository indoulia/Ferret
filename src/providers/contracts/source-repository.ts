import type { Page, ProviderOperationContext } from '../sdk/operation.js';

/**
 * The `source.repository` capability interface.
 *
 * EPIC-011 named the capability; EPIC-012 built the operation protocol but
 * deliberately left each capability's own signature to the Epic that first needs
 * it (EPIC-012 §8, decision D2). This is that Epic — EPIC-017 — pinning the
 * first one.
 *
 * It lives in the core, alongside the contract it belongs to, because the core
 * has to be able to *ask* for a capability. What stays out of the core is any
 * implementation: `boundaries.test.ts` proves that nothing reachable from the
 * package root names Git.
 */

/** A remote a repository is configured with. */
export interface RepositoryRemote {
  /** Git's name for it — `origin`, `upstream`. */
  readonly name: string;
  /**
   * The URL, with any credentials masked.
   *
   * Never the raw value. A URL read from a repository's configuration carries a
   * personal access token far more often than anyone expects, and this field is
   * stored, logged and shown.
   */
  readonly url: string;
  /** `host/path`, the form two clones of this remote share. */
  readonly canonical: string | undefined;
}

/** Where a repository's identity came from. */
export const RepositoryIdentityKind = {
  /** From the origin remote: shared by every clone of it, on any machine. */
  REMOTE: 'remote',
  /** From the Git directory's real path: local to this machine. */
  PATH: 'path',
} as const;

export type RepositoryIdentityKind =
  (typeof RepositoryIdentityKind)[keyof typeof RepositoryIdentityKind];

export interface DiscoveredRepository {
  /**
   * The value the canonical entity id is derived from.
   *
   * Equal for two clones of one remote at two paths; different for two
   * repositories that merely share a directory name.
   */
  readonly identityKey: string;
  /**
   * How that identity was reached.
   *
   * Reported rather than hidden: a repository identified by path cannot be
   * unified with the same repository on another machine, and an operator asking
   * why two clones did not merge deserves to see the reason rather than deduce
   * it.
   */
  readonly identityKind: RepositoryIdentityKind;
  /** Absolute path of the working tree, or of the repository itself when bare. */
  readonly root: string;
  /** Absolute path of this checkout's Git directory. */
  readonly gitDir: string;
  /**
   * Absolute path of the Git directory shared by every worktree of this clone.
   *
   * Differs from `gitDir` for a linked worktree, and is what makes five
   * worktrees one repository rather than five — Governance §9's distinction
   * between a repository, a worktree and a branch.
   */
  readonly commonGitDir: string;
  readonly bare: boolean;
  readonly linkedWorktree: boolean;
  readonly remotes: readonly RepositoryRemote[];
  /** The remote identity was taken from, when one was. */
  readonly originUrl: string | undefined;
}

/** Why a path was not descended into or not reported. */
export const SkipReason = {
  EXCLUDED: 'excluded',
  UNREADABLE: 'unreadable',
  SYMLINK: 'symlink',
  DEPTH_LIMIT: 'depth-limit',
  OUTSIDE_ROOT: 'outside-root',
  ALREADY_VISITED: 'already-visited',
  NOT_A_REPOSITORY: 'not-a-repository',
} as const;

export type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

export interface SkippedPath {
  readonly path: string;
  readonly reason: SkipReason;
  readonly detail: string | undefined;
}

export interface RepositoryDiscoveryRequest {
  /** Absolute paths to search. */
  readonly roots: readonly string[];
  /** Directories below a root to descend. Default 8. */
  readonly maxDepth?: number;
  /** Repositories to return in one page. */
  readonly limit?: number;
  /** Resume token from a previous page. */
  readonly cursor?: string;
  /**
   * Whether to follow symbolic links.
   *
   * Off by default. A link is the easy way out of a declared root, and a
   * developer's home directory is full of them. When on, every candidate is
   * resolved and refused if it leaves the root.
   */
  readonly followSymlinks?: boolean;
  /**
   * Whether to keep descending inside a repository, to find nested ones.
   *
   * Off by default: a submodule is reachable from its parent, and descending
   * into every `node_modules` looking for a stray `.git` is how a walk that
   * should take a second takes a minute.
   */
  readonly includeNested?: boolean;
}

export interface RepositoryDiscoveryResult extends Page<DiscoveredRepository> {
  /**
   * Everything the walk did not look at, and why.
   *
   * A discovery that stopped at a permission error and reported success is the
   * worst outcome available: Ferret would then answer questions about a codebase
   * it had only half seen, confidently. Governance §6.
   */
  readonly skipped: readonly SkippedPath[];
  readonly directoriesVisited: number;
}

/** Operation names, for a provider declaring partial support (EPIC-011 AC-4). */
export const RepositoryOperation = {
  DISCOVER: 'discoverRepositories',
  DESCRIBE: 'describeRepository',
} as const;

export type RepositoryOperation =
  (typeof RepositoryOperation)[keyof typeof RepositoryOperation];

/**
 * What a `source.repository` provider implements.
 *
 * Two operations, separately declarable: a provider that can describe a
 * repository it is pointed at, but cannot search a filesystem for one — a hosted
 * provider, for instance — declares only `describeRepository`, and a caller
 * asks before calling rather than discovering by exception.
 */
export interface RepositorySource {
  discoverRepositories(
    request: RepositoryDiscoveryRequest,
    context: ProviderOperationContext,
  ): Promise<RepositoryDiscoveryResult>;

  describeRepository(
    root: string,
    context: ProviderOperationContext,
  ): Promise<DiscoveredRepository>;
}
