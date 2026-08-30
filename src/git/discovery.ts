import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ExclusionRule } from '../config/index.js';
import { evaluateExclusion } from '../config/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { SkipReason, type SkippedPath } from '../providers/contracts/source-repository.js';
import { throwIfAborted } from '../providers/sdk/index.js';

/**
 * Walking a filesystem for Git repositories.
 *
 * Three properties matter more than speed, and each of them is a way the naive
 * version is wrong.
 *
 * **It ends.** A symbolic link back up its own tree makes a recursive walk run
 * until the process dies. Depth, directory count and a set of already-visited
 * real paths are all bounded, and the bounds are stated rather than assumed.
 *
 * **It stays inside its root.** A link in a developer's home directory pointing
 * at `/` is not unusual, and following it turns "index my projects" into
 * "index this machine". Links are not followed by default; when they are, every
 * candidate is resolved and refused if it leaves the root.
 *
 * **It says what it did not do.** A walk that hit a permission error, stopped,
 * and reported success is the worst outcome available — Ferret would then answer
 * questions about a codebase it had only half seen, with no sign that anything
 * was missing. Every skip is reported with its reason (Governance §6).
 */

/** Directories descended below a root, unless the caller says otherwise. */
export const DEFAULT_MAX_DEPTH = 8;

/**
 * Directories a single walk will visit.
 *
 * A backstop rather than a tuning knob: depth alone does not bound a walk, since
 * a wide tree is unbounded at depth one. A walk that hits this reports it as a
 * skip rather than pretending it finished.
 */
export const MAX_DIRECTORIES = 250_000;

export interface RepositoryCandidate {
  /** Absolute path of the directory holding `.git`, or of a bare repository. */
  readonly path: string;
  /** True when `.git` is a file — a linked worktree or a submodule. */
  readonly gitLink: boolean;
  /** True when the directory itself looks like a bare repository. */
  readonly bareCandidate: boolean;
}

export interface WalkResult {
  readonly candidates: readonly RepositoryCandidate[];
  readonly skipped: readonly SkippedPath[];
  readonly directoriesVisited: number;
  /** True when the walk stopped early because it reached `limit`. */
  readonly truncated: boolean;
  /** The last candidate emitted, for a caller building a resume cursor. */
  readonly lastPath: string | undefined;
}

export interface WalkOptions {
  readonly roots: readonly string[];
  readonly exclusions: readonly ExclusionRule[];
  readonly signal: AbortSignal;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly followSymlinks?: boolean;
  readonly includeNested?: boolean;
  /**
   * Resume immediately after this path.
   *
   * The walk is deterministic — entries are sorted — so re-walking and skipping
   * to a known position yields the same sequence. Paging this way costs a repeat
   * of the directory traversal rather than carrying a frontier in the cursor,
   * which would be unbounded in size and stale the moment the tree changed.
   */
  readonly resumeAfter?: string;
}

/**
 * Finds candidate repositories under `roots`.
 *
 * Candidates, not repositories: this function decides that a directory *looks
 * like* a repository. Confirming it, and learning anything about it, means
 * asking Git — which is a different module, because it is a different trust
 * boundary.
 */
export async function walkForRepositories(options: WalkOptions): Promise<WalkResult> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const candidates: RepositoryCandidate[] = [];
  const skipped: SkippedPath[] = [];
  const visited = new Set<string>();
  let directoriesVisited = 0;
  let truncated = false;
  let lastPath: string | undefined;
  let resuming = options.resumeAfter !== undefined;

  const skip = (path: string, reason: SkipReason, detail?: string): void => {
    skipped.push({ path, reason, detail });
  };

  for (const rawRoot of options.roots) {
    if (!isAbsolute(rawRoot)) {
      throw new FerretError(ErrorCode.USAGE, 'A discovery root must be an absolute path', {
        details: { root: rawRoot },
        remediation: 'Resolve the path before passing it to discovery.',
      });
    }

    const root = resolve(rawRoot);
    const rootReal = await realpath(root).catch(() => undefined);
    if (rootReal === undefined) {
      skip(root, SkipReason.UNREADABLE, 'The root does not exist or cannot be read');
      continue;
    }

    // Breadth-first, so a shallow repository is found before a deep one and a
    // truncated walk returns the most likely answers rather than the deepest.
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];

    while (queue.length > 0) {
      throwIfAborted(options.signal, 'repository discovery');

      const current = queue.shift();
      if (current === undefined) break;

      if (directoriesVisited >= MAX_DIRECTORIES) {
        skip(current.path, SkipReason.DEPTH_LIMIT, `Stopped after ${String(MAX_DIRECTORIES)} directories`);
        truncated = true;
        break;
      }

      const real = await realpath(current.path).catch(() => undefined);
      if (real === undefined) {
        skip(current.path, SkipReason.UNREADABLE, 'Path could not be resolved');
        continue;
      }
      if (visited.has(real)) {
        // A link back up the tree. Without this the walk never ends.
        skip(current.path, SkipReason.ALREADY_VISITED, real);
        continue;
      }
      visited.add(real);
      directoriesVisited += 1;

      let read: DirectoryRead;
      try {
        read = await readDirectory(current.path);
      } catch (error) {
        // Permission denied on one directory must not end a walk over a
        // thousand others. Governance §13.
        skip(current.path, SkipReason.UNREADABLE, describeFsError(error));
        continue;
      }
      const entries = read.directories;
      const hasGit = read.git;

      const bareCandidate = hasGit === undefined && looksBare(read);

      if (hasGit !== undefined || bareCandidate) {
        if (resuming) {
          if (current.path === options.resumeAfter) resuming = false;
        } else if (candidates.length >= limit) {
          truncated = true;
          break;
        } else {
          candidates.push({
            path: current.path,
            gitLink: hasGit === 'file',
            bareCandidate,
          });
          lastPath = current.path;
        }

        // Stop here: a submodule is reachable from its parent, and descending
        // through every repository looking for a stray nested one is how a walk
        // that should take a second takes a minute.
        if (options.includeNested !== true) continue;
      }

      if (current.depth >= maxDepth) {
        if (entries.length > 0) {
          skip(current.path, SkipReason.DEPTH_LIMIT, `Depth ${String(maxDepth)} reached`);
        }
        continue;
      }

      for (const name of entries) {
        const child = join(current.path, name);

        if (evaluateExclusion(relative(root, child) || name, options.exclusions).excluded) {
          skip(child, SkipReason.EXCLUDED);
          continue;
        }

        const link = await isSymbolicLink(child);
        if (link) {
          if (options.followSymlinks !== true) {
            skip(child, SkipReason.SYMLINK, 'Symbolic links are not followed by default');
            continue;
          }
          const target = await realpath(child).catch(() => undefined);
          if (target === undefined) {
            skip(child, SkipReason.UNREADABLE, 'Link target could not be resolved');
            continue;
          }
          if (!isWithin(rootReal, target)) {
            // The whole reason links are off by default. A link to `/` turns
            // "index my projects" into "index this machine".
            skip(child, SkipReason.OUTSIDE_ROOT, 'Link resolves outside the declared root');
            continue;
          }
        }

        queue.push({ path: child, depth: current.depth + 1 });
      }
    }

    if (truncated) break;
  }

  return { candidates, skipped, directoriesVisited, truncated, lastPath };
}

interface DirectoryRead {
  /** Subdirectory names, sorted, so the walk is deterministic and resumable. */
  readonly directories: string[];
  /** Whether `.git` is present, and as what. */
  readonly git: 'dir' | 'file' | undefined;
  /** Whether a `HEAD` file is present — the third half of Git's own bare test. */
  readonly head: boolean;
}

async function readDirectory(path: string): Promise<DirectoryRead> {
  const directories: string[] = [];
  let git: 'dir' | 'file' | undefined;
  let head = false;

  // `opendir` streams rather than materialising the whole listing, which matters
  // for the directories that hold ten thousand entries.
  const handle = await opendir(path);
  try {
    for await (const entry of handle) {
      if (entry.name === '.git') {
        git = entry.isDirectory() ? 'dir' : 'file';
        continue;
      }
      if (entry.name === 'HEAD' && entry.isFile()) {
        head = true;
        continue;
      }
      // `isDirectory()` is false for a symlink even when it points at one; the
      // walk resolves links separately and deliberately.
      if (entry.isDirectory() || entry.isSymbolicLink()) directories.push(entry.name);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  directories.sort();
  return { directories, git, head };
}

/**
 * Whether a directory looks like a bare repository.
 *
 * Git's own test, near enough: `objects/`, `refs/` and a `HEAD` file. A weak
 * signal on purpose — Git is asked to confirm it, so guessing wrong costs one
 * extra invocation, while missing a bare repository costs an entire mirror
 * never being indexed.
 *
 * The first version of this only fired when the directory *was* the scan root,
 * which meant `/srv/git` full of `*.git` mirrors — the layout every Git server
 * on earth uses — found nothing at all. Caught by the integration test, which is
 * why the bare fixture exists.
 */
function looksBare(read: DirectoryRead): boolean {
  return read.head && read.directories.includes('objects') && read.directories.includes('refs');
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether `candidate` is inside `root`.
 *
 * Path arithmetic rather than string prefix: `/home/user2` starts with
 * `/home/user` as a string and is not inside it.
 */
export function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

function describeFsError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied';
    case 'ENOENT':
      return 'Removed while the walk was running';
    case 'ELOOP':
      return 'Too many symbolic links';
    case 'ENOTDIR':
      return 'Not a directory';
    default:
      return typeof code === 'string' ? code : 'Could not be read';
  }
}

/** True when `path` exists and is a directory. Never throws. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
