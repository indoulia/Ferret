/**
 * The local Git source provider.
 *
 * Published as `@indoulia/ferret/git` rather than from the package root, for the
 * same reason storage is: the core gains the ability to read a repository by
 * being handed a provider, never by importing one. `boundaries.test.ts` proves
 * that nothing reachable from `@indoulia/ferret` names Git.
 */

export { walkForRepositories, isWithin, DEFAULT_MAX_DEPTH, MAX_DIRECTORIES, type RepositoryCandidate, type WalkOptions, type WalkResult } from './discovery.js';
export {
  RepositoryIdentitySource,
  maskRemote,
  normalizeRemote,
  repositoryIdentity,
  type NormalizedRemote,
  type RepositoryIdentity,
} from './identity.js';
export {
  BlobUnavailable,
  MAX_BLOB_BYTES,
  MAX_FILES_PER_READ,
  TreeEntryKind,
  extensionOf,
  gitContentHash,
  listFiles,
  parseTree,
  readBlob,
  type BlobContent,
  type FileListing,
  type ListFilesOptions,
  type ReadBlobOptions,
  type TreeEntry,
} from './files.js';
export {
  ChangeKind,
  MAX_COMMITS_PER_READ,
  assertSafeRevision,
  parseHistoryOutput,
  parseLog,
  readHistory,
  type CommitChange,
  type CommitRecord,
  type HistoryPage,
  type ParsedHistory,
  type ReadHistoryOptions,
} from './history.js';
export {
  MAX_REFS_PER_READ,
  listBranches,
  listWorktrees,
  sanitizeRefText,
  type BranchListing,
  type ListBranchesOptions,
} from './refs.js';
export {
  GIT_PROVIDER_ID,
  GIT_SOURCE_SYSTEM,
  GitSourceProvider,
  createGitSourceProvider,
  type GitProviderOptions,
} from './provider.js';
export {
  GIT_SAFETY_CONFIG,
  GIT_STRIPPED_ENV,
  runGit,
  runGitBytes,
  scrubEnvironment,
  type GitBytesOptions,
  type GitBytesResult,
  type GitResult,
  type GitRunOptions,
} from './runner.js';

export {
  MAX_SAMPLED_PATHS,
  parseStatus,
  readWorktreeState,
  type UpstreamState,
  type WorkingTreeState,
  type WorktreeStateResult,
} from './worktree-state.js';

export {
  describeEngineeringContext,
  localIdentityOf,
  repositoryRootOf,
  type EngineeringContext,
  type EngineeringContextOptions,
  type LocalIdentityContext,
  type WorktreeContext,
} from './engineering-context.js';
