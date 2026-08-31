import { ErrorCode, FerretError } from '../errors/index.js';
import { extensionOf } from '../files/index.js';

import { assertSafeRevision } from './history.js';
import { runGit, runGitBytes, type GitRunOptions } from './runner.js';

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
 * Reading the bytes a revision holds at a path — EPIC-108 §8.3.
 *
 * Against the **object store**, never the working tree. The indexer indexes a
 * *revision*; reading the working copy would answer a different question, and
 * would be wrong on any run with `--revision`, on a bare repository, and on a
 * checkout with uncommitted edits. `git cat-file blob <oid>` reads exactly the
 * object `listFiles` reported, which is also why no path is passed to Git here:
 * the object id is the address, and it cannot be made to name a different file.
 */

/**
 * The largest blob Ferret will read in one call.
 *
 * 8 MiB, deliberately above EPIC-024's 4 MiB parse bound rather than equal to
 * it. The two bounds answer different questions and the order matters: this one
 * says "Ferret will not hold this much of a repository in memory", and
 * EPIC-024's says "this is too big to extract from". Setting them equal would
 * make the second unreachable, and `too-large` would stop appearing as an
 * unparsed reason for the files it was written for.
 */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Why a blob could not be produced. */
export const BlobUnavailable = {
  /** Over {@link MAX_BLOB_BYTES}. The bytes were never fully materialised. */
  TOO_LARGE: 'too-large',
  /**
   * Git has no blob for this object id.
   *
   * Covers a pruned or absent object *and* an object that is not a blob, and
   * the two are deliberately not separated: `git cat-file blob` answers both
   * with the same `bad file`, and inventing a distinction its output does not
   * support would be manufacturing certainty. The detail carries Git's own
   * words.
   */
  NOT_FOUND: 'not-found',
  /** Git failed for some other reason, which the detail names. */
  UNREADABLE: 'unreadable',
} as const;

export type BlobUnavailable = (typeof BlobUnavailable)[keyof typeof BlobUnavailable];

export type BlobContent =
  | { readonly read: true; readonly bytes: Uint8Array; readonly sizeBytes: number }
  | { readonly read: false; readonly reason: BlobUnavailable; readonly detail: string };

export interface ReadBlobOptions extends Omit<GitRunOptions, 'maxBufferBytes' | 'allowFailure'> {
  /** The object id `listFiles` returned for this entry. */
  readonly oid: string;
  /** Bytes accepted. Default {@link MAX_BLOB_BYTES}. */
  readonly maxBytes?: number;
}

/** A Git object id, and nothing that could be read as an option or a revision. */
const OID = /^[0-9a-f]{7,64}$/;

/**
 * Reads one blob's bytes.
 *
 * Returns a verdict rather than throwing for the two outcomes that are facts
 * about the repository — the object is missing, or it is larger than Ferret
 * will hold. Cancellation and a timeout still throw, because a run that was
 * interrupted must fail rather than report a short read as success.
 */
export async function readBlob(options: ReadBlobOptions): Promise<BlobContent> {
  const maxBytes = options.maxBytes ?? MAX_BLOB_BYTES;
  if (!OID.test(options.oid)) {
    // Never interpolated into a revision expression and never passed as a path.
    // An id that is not an id is refused here rather than handed to Git, where
    // `--upload-pack=...` would be an option rather than an object.
    return {
      read: false,
      reason: BlobUnavailable.NOT_FOUND,
      detail: 'The object id is not a Git object id',
    };
  }

  const result = await runGitBytes(['cat-file', 'blob', options.oid], {
    ...options,
    maxOutputBytes: maxBytes,
  });

  if (result.truncated) {
    return {
      read: false,
      reason: BlobUnavailable.TOO_LARGE,
      detail: `The blob is larger than the ${String(maxBytes)}-byte read bound`,
    };
  }
  if (result.exitCode !== 0) {
    const detail = firstStderrLine(result.stderr);
    // "No such object" and "that object is not a blob" are one message in
    // Git — `fatal: git cat-file <oid>: bad file` for both — so they are one
    // reason here. Anything else is a fault rather than a fact about the
    // repository, and is reported as such.
    if (/bad file|not a valid object|could not get object info|bad object/i.test(detail)) {
      return { read: false, reason: BlobUnavailable.NOT_FOUND, detail };
    }
    return { read: false, reason: BlobUnavailable.UNREADABLE, detail };
  }

  return { read: true, bytes: result.stdout, sizeBytes: result.stdout.length };
}

function firstStderrLine(stderr: string): string {
  const line = stderr.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 0 ? line.slice(0, 500) : 'git reported no detail';
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

/**
 * Lowercase extension without the dot, when the path has one.
 *
 * Re-exported rather than reimplemented: EPIC-030 needs the same answer from
 * the same paths, and a second copy would eventually disagree about a dotfile
 * or a trailing dot. The definition lives in the core, which providers may
 * depend on.
 */
export { extensionOf };
