import { ErrorCode, FerretError } from '../errors/index.js';

import { assertSafeRevision } from './history.js';
import { runGit, type GitRunOptions } from './runner.js';

/**
 * Listing the files a repository holds at a revision.
 *
 * `git ls-tree -r --long`, not a filesystem walk. Three reasons, and the third
 * is the one that matters:
 *
 * - It answers for a **revision**, so it works on a bare repository and on a
 *   commit nobody has checked out — which is most of them.
 * - It gives the blob's **object id and size** in the same call, so Ferret does
 *   not have to open a single file to know what it holds and how big it is.
 * - The object id **is a content hash**, computed by Git, over exactly the bytes
 *   Git stored. Ferret hashing the working copy itself would produce a different
 *   number for the same content on a machine with different line-ending
 *   settings, and two developers' identical files would look like two versions.
 *
 * What it does not answer is "what is on disk right now", including untracked
 * files. That is a different question, asked by a different Epic.
 */

/** Entries read in one call. */
export const MAX_FILES_PER_READ = 50_000;

const MAX_PATH = 4096;

/** What a tree entry actually is, which the mode says and the type does not. */
export const TreeEntryKind = {
  FILE: 'file',
  EXECUTABLE: 'executable',
  /** A symbolic link. Its "content" is the target path, not a file's bytes. */
  SYMLINK: 'symlink',
  /** A submodule: a commit id recorded in another repository's tree. */
  SUBMODULE: 'submodule',
  UNKNOWN: 'unknown',
} as const;

export type TreeEntryKind = (typeof TreeEntryKind)[keyof typeof TreeEntryKind];

export interface TreeEntry {
  readonly path: string;
  readonly kind: TreeEntryKind;
  /**
   * Git's object id for the content.
   *
   * A content hash, so two identical files anywhere in any repository share it.
   * For a submodule this is a *commit* id in another repository, not a blob.
   */
  readonly oid: string;
  /** Bytes, as Git recorded them. Absent for a submodule, which has no blob. */
  readonly sizeBytes: number | undefined;
  /** The raw mode, kept because it distinguishes cases the kind flattens. */
  readonly mode: string;
}

export interface FileListing {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

export interface ListFilesOptions extends GitRunOptions {
  /** Revision to list. Default `HEAD`. */
  readonly revision?: string;
  /** Entries to return. Default {@link MAX_FILES_PER_READ}. */
  readonly limit?: number;
  /** Entries to skip, for paging. */
  readonly offset?: number;
}

/**
 * `<mode> SP <type> SP <oid> SP+ <size> TAB <path>`
 *
 * The size is right-aligned with variable padding, and the tab before the path
 * is the only reliable boundary — a path may contain spaces, and with `-z` it
 * may contain anything else except NUL.
 */
const ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{7,64})\s+(\d+|-)\t([\s\S]+)$/;

export async function listFiles(options: ListFilesOptions): Promise<FileListing> {
  const limit = Math.min(options.limit ?? MAX_FILES_PER_READ, MAX_FILES_PER_READ);
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    throw new FerretError(ErrorCode.USAGE, 'File paging needs a positive limit and a non-negative offset', {
      details: { limit, offset },
      remediation: 'Pass a positive integer limit.',
    });
  }

  const revision = options.revision ?? 'HEAD';
  assertSafeRevision(revision);

  const result = await runGit(['ls-tree', '-r', '-z', '--long', revision, '--'], {
    ...options,
    allowFailure: true,
  });
  // An empty repository has no HEAD; a ref that does not exist holds no files.
  // Both are questions with the answer "nothing".
  if (result.exitCode !== 0) return { entries: [], truncated: false };

  const all = parseTree(result.stdout);
  return {
    entries: all.slice(offset, offset + limit),
    truncated: all.length > offset + limit,
  };
}

/**
 * Parses `git ls-tree -r -z --long` output.
 *
 * Exported for the same reason `parseLog` is: a parser that can only be exercised
 * through a repository is a parser whose edge cases never get tested.
 */
export function parseTree(stdout: string): readonly TreeEntry[] {
  if (stdout.length === 0) return [];

  const entries: TreeEntry[] = [];
  for (const token of stdout.split('\0')) {
    if (token.length === 0) continue;
    const match = ENTRY.exec(token);
    if (match === null) continue;

    const [, mode, type, oid, size, rawPath] = match;
    if (mode === undefined || oid === undefined || rawPath === undefined) continue;

    const path = boundedPath(rawPath);
    if (path.length === 0) continue;

    entries.push({
      path,
      kind: kindOf(mode, type ?? ''),
      oid,
      sizeBytes: size === undefined || size === '-' ? undefined : Number.parseInt(size, 10),
      mode,
    });
  }
  return entries;
}

/**
 * What an entry is, from its mode.
 *
 * The `type` column says `blob` for a regular file, an executable *and* a
 * symbolic link — three things Ferret must not treat alike. A symlink's blob
 * holds a path, not content, and reading it as source would index the string
 * `../../etc/passwd` as though it were a file. Only the mode distinguishes them.
 */
function kindOf(mode: string, type: string): TreeEntryKind {
  if (mode === '160000' || type === 'commit') return TreeEntryKind.SUBMODULE;
  if (mode === '120000') return TreeEntryKind.SYMLINK;
  if (mode === '100755') return TreeEntryKind.EXECUTABLE;
  if (mode === '100644') return TreeEntryKind.FILE;
  return TreeEntryKind.UNKNOWN;
}

function boundedPath(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, MAX_PATH).replace(/\\/g, '/');
}

/**
 * How Ferret writes a content hash it did not compute.
 *
 * Prefixed with the algorithm, always. A Git object id is
 * `sha1("blob <length>\0" + bytes)`, which is *not* the SHA-1 of the bytes and
 * is not comparable with anything else called a hash. Two values that mean
 * different things must not share a column without saying which they are, or a
 * later Epic will compare them and find them different for the wrong reason.
 */
export function gitContentHash(oid: string): string {
  return `git-blob:${oid}`;
}

/** Lowercase extension without the dot, when the path has one. */
export function extensionOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}
