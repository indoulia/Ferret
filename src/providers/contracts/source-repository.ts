import type { Page, PageRequest, ProviderOperationContext } from '../sdk/operation.js';

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

/**
 * One checkout of a repository.
 *
 * Governance §9 keeps this separate from both the repository and the branch. A
 * developer with four worktrees of one clone is working on four branches at
 * once, and a model that stores "the current branch" against the repository can
 * represent exactly one of them — which is the difference between answering
 * *"what was I working on"* and *"what is checked out right now"*.
 */
export interface DiscoveredWorktree {
  /** Absolute path of the checkout, as Git records it. */
  readonly path: string;
  /** Commit `HEAD` resolves to here, when the worktree has one. */
  readonly headCommit: string | undefined;
  /** The ref checked out here, absent when detached or bare. */
  readonly ref: string | undefined;
  readonly detached: boolean;
  readonly bare: boolean;
  /**
   * The repository's original working directory.
   *
   * A linked worktree can be removed; the primary one cannot. Git reports it
   * first, which is the only reason Ferret can tell them apart.
   */
  readonly primary: boolean;
  readonly locked: boolean;
  readonly lockReason: string | undefined;
  /** Git considers this worktree removable — usually its directory is gone. */
  readonly prunable: boolean;
  readonly prunableReason: string | undefined;
}

/** A local branch. */
export interface DiscoveredBranch {
  /** Full ref name, e.g. `refs/heads/main`. */
  readonly ref: string;
  /** The part after `refs/heads/`. */
  readonly shortName: string;
  /** Commit the ref currently points at. */
  readonly headCommit: string;
  /** The ref it tracks, e.g. `refs/remotes/origin/main`. */
  readonly upstream: string | undefined;
  /** Checked out in the worktree that was read. */
  readonly isHead: boolean;
  /**
   * The ref a fresh clone would check out.
   *
   * From `refs/remotes/origin/HEAD`, which is what a clone records — not from
   * the local `HEAD`, which only says what this checkout happens to be on.
   * Frequently unknown, and reported as unknown rather than guessed: assuming
   * `main` is wrong for every repository that predates 2020.
   */
  readonly isDefault: boolean;
}

export interface BranchPage extends Page<DiscoveredBranch> {
  /** The default ref, when the repository records one. */
  readonly defaultRef: string | undefined;
}

/**
 * Why a file's content could not be produced.
 *
 * A verdict, not an exception. "This blob is bigger than Ferret will hold" and
 * "the tree named an object the store does not have" are *facts about the
 * repository*, and a caller indexing ten thousand files needs to count them
 * rather than catch them. What still throws is everything that means the run
 * itself is in trouble: cancellation, a timeout, a provider that is not there.
 */
export const ContentUnavailable = {
  /** Over the requested byte bound. The bytes were never fully materialised. */
  TOO_LARGE: 'too-large',
  /**
   * The source has no content for that object.
   *
   * A pruned object, a listing that has gone stale, or an object that exists
   * and is not a file's content. Providers are not required to tell those
   * apart — Git cannot — so the detail carries whatever the source said.
   */
  NOT_FOUND: 'not-found',
  /** The source failed for some other reason, which the detail names. */
  UNREADABLE: 'unreadable',
} as const;

export type ContentUnavailable = (typeof ContentUnavailable)[keyof typeof ContentUnavailable];

/**
 * A request for one file's bytes, addressed the way `listFiles` answered.
 *
 * The **object id is the address**. A path is carried for diagnostics and for
 * the parser's benefit, but it is not what is looked up: resolving a path again
 * would re-ask a question `listFiles` already answered, and would answer it
 * against whatever the source holds *now* rather than at the revision being
 * indexed.
 */
export interface FileContentRequest {
  /** Repository-relative path, as `listFiles` reported it. */
  readonly path: string;
  /** The content's object id, as `listFiles` reported it. */
  readonly oid: string;
  /** The revision the entry was listed at. Default `HEAD`. */
  readonly revision?: string;
  /**
   * Bytes the caller will accept.
   *
   * A ceiling the caller may lower, never raise: a provider applies its own
   * bound as well, and the smaller of the two wins. The bound is enforced
   * *before the bytes are materialised* — a provider that returns 400 MB in
   * order to let the caller reject it has already paid the cost the bound
   * exists to avoid.
   */
  readonly maxBytes?: number;
}

export type FileContent =
  | {
      readonly read: true;
      /** The source's bytes, unchanged. Never decoded and re-encoded. */
      readonly bytes: Uint8Array;
      readonly sizeBytes: number;
    }
  | {
      readonly read: false;
      readonly reason: ContentUnavailable;
      /** The source's own words, for a log line an operator can act on. */
      readonly detail: string;
    };

/** Operation names, for a provider declaring partial support (EPIC-011 AC-4). */
export const RepositoryOperation = {
  DISCOVER: 'discoverRepositories',
  DESCRIBE: 'describeRepository',
  LIST_WORKTREES: 'listWorktrees',
  LIST_BRANCHES: 'listBranches',
  READ_HISTORY: 'readHistory',
  LIST_FILES: 'listFiles',
  /**
   * Read one file's bytes at a revision — EPIC-108, introduced at capability
   * version 2.
   *
   * A provider declaring version 1 never supports this, whatever its
   * `operations` field says or omits. `CAPABILITY_OPERATION_VERSIONS` in
   * `capabilities.ts` is what enforces it.
   */
  READ_CONTENT: 'readFileContent',
} as const;

export type RepositoryOperation =
  (typeof RepositoryOperation)[keyof typeof RepositoryOperation];

/**
 * What a `source.repository` provider implements.
 *
 * Separately declarable operations: a provider that can describe a repository it
 * is pointed at, but cannot search a filesystem for one — a hosted provider, for
 * instance — declares only `describeRepository`, and a caller asks before
 * calling rather than discovering by exception.
 *
 * The optional members are the ones a provider may genuinely not have. A
 * required method cannot express "this source has no content to read"; an
 * optional one paired with `supports()` can, and that is the difference between
 * a metadata-only index and a missing-method crash.
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

  /**
   * Every checkout of a repository, primary first.
   *
   * Takes the repository rather than a path because a linked worktree and its
   * primary share one repository, and asking either of them the question must
   * give the same answer.
   */
  listWorktrees(
    repository: DiscoveredRepository,
    context: ProviderOperationContext,
  ): Promise<readonly DiscoveredWorktree[]>;

  listBranches(
    repository: DiscoveredRepository,
    request: PageRequest,
    context: ProviderOperationContext,
  ): Promise<BranchPage>;

  /**
   * One file's bytes, at the revision it was listed at — EPIC-108 §8.3.
   *
   * **Optional, and it must stay optional.** The capability version went to 2
   * when this was added and the minimum stayed at 1, so a provider built against
   * version 1 remains valid; making this required would break that provider at
   * compile time and make the version span a fiction. A caller asks
   * `supports(capability, RepositoryOperation.READ_CONTENT)` and takes the
   * metadata-only path when the answer is no, in the same shape as the indexer's
   * optional lifecycle port — a source that cannot do something must not be made
   * to pretend.
   *
   * Three obligations on an implementation:
   *
   * - **Read the revision, not the working tree.** Content is read for the
   *   revision being indexed. Reading a working copy answers a different
   *   question and is wrong on a bare repository, on `--revision`, and on any
   *   checkout with uncommitted edits.
   * - **Bound before materialising.** `maxBytes` is a ceiling on what is ever
   *   held, not a length to check afterwards.
   * - **Return bytes, never text.** A repository holds files that are not UTF-8.
   *   Decoding and re-encoding hands a parser bytes the repository does not
   *   contain and changes what a content hash covers.
   *
   * Cancellation propagates through `context.signal` and throws; the outcomes
   * that are facts about the repository come back as {@link FileContent}.
   */
  readFileContent?(
    repository: DiscoveredRepository,
    request: FileContentRequest,
    context: ProviderOperationContext,
  ): Promise<FileContent>;
}
