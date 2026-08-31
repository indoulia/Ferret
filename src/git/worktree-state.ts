import { ErrorCode, FerretError } from '../errors/index.js';

import { runGit, type GitRunOptions } from './runner.js';

/**
 * What the working tree looks like right now — EPIC-038.
 *
 * The one part of a repository that is *not* history. Everything else Ferret
 * knows is a record of something that already happened; this is the present
 * state, and it changes between one question and the next.
 *
 * Counts and paths, never a diff. A diff is unbounded, is the most sensitive
 * thing in a working tree, and is not what "am I on a clean tree" asks.
 */

/** Paths listed before the sample is cut. Counts stay exact. */
export const MAX_SAMPLED_PATHS = 50;

export interface WorkingTreeState {
  /** True when nothing is staged, modified or untracked. */
  readonly clean: boolean;
  readonly stagedCount: number;
  readonly unstagedCount: number;
  readonly untrackedCount: number;
  /** True when the merge, rebase or cherry-pick left conflicts. */
  readonly conflictedCount: number;
  /** Up to {@link MAX_SAMPLED_PATHS} paths, in Git's order. */
  readonly sample: readonly string[];
  /** True when more paths changed than the sample holds. */
  readonly sampleTruncated: boolean;
}

export interface UpstreamState {
  /** The tracked ref, e.g. `origin/main`. */
  readonly ref: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface WorktreeStateResult {
  readonly state: WorkingTreeState;
  /** Absent when the branch tracks nothing, or when HEAD is detached. */
  readonly upstream: UpstreamState | undefined;
  /** The commit HEAD resolves to. Absent in a repository with no commits. */
  readonly headCommit: string | undefined;
  /** The checked-out branch. Absent when HEAD is detached. */
  readonly branch: string | undefined;
  readonly detached: boolean;
}

const EMPTY_STATE: WorkingTreeState = Object.freeze({
  clean: true,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  sample: Object.freeze([]),
  sampleTruncated: false,
});

/**
 * Reads working-tree state.
 *
 * `--porcelain=v2 --branch -z` in one call: it reports the branch, the upstream
 * and the ahead/behind counts in its header lines and every change category in
 * its body, so what would otherwise be four processes is one. `-z` because a
 * path may contain anything but NUL, and the line-based format quotes such
 * paths in a way that has to be unescaped — a step that is easy to get subtly
 * wrong and unnecessary here.
 *
 * Every invocation is a read. Nothing fetches, nothing writes an index, nothing
 * touches a ref, so calling this on a machine mid-rebase is safe.
 */
export async function readWorktreeState(options: GitRunOptions): Promise<WorktreeStateResult> {
  const result = await runGit(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    { ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) {
    throw new FerretError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Git could not report working-tree state', {
      details: { cwd: options.cwd, exitCode: result.exitCode },
      remediation: 'Check that the directory is inside a Git repository Ferret can read.',
    });
  }
  return parseStatus(result.stdout);
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * Exported for the same reason `parseTree` and `parseLog` are: a parser that can
 * only be exercised by arranging a working tree is a parser whose edge cases
 * never get tested.
 *
 * The format, per `git-status(1)`:
 *
 * ```text
 * # branch.oid <sha>|(initial)
 * # branch.head <branch>|(detached)
 * # branch.upstream <ref>
 * # branch.ab +<ahead> -<behind>
 * 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 * 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
 * u <XY> ...  <path>
 * ? <path>
 * ```
 */
export function parseStatus(stdout: string): WorktreeStateResult {
  let headCommit: string | undefined;
  let branch: string | undefined;
  let detached = false;
  let upstreamRef: string | undefined;
  let ahead = 0;
  let behind = 0;

  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;
  const sample: string[] = [];
  let totalPaths = 0;

  const collect = (path: string): void => {
    totalPaths += 1;
    if (sample.length < MAX_SAMPLED_PATHS) sample.push(path);
  };

  const records = stdout.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;

    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length).trim();
      // A repository with no commits reports the literal `(initial)`.
      headCommit = oid === '(initial)' ? undefined : oid;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length).trim();
      detached = head === '(detached)';
      branch = detached ? undefined : head;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      upstreamRef = record.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const counts = /\+(\d+)\s+-(\d+)/.exec(record);
      ahead = Number(counts?.[1] ?? 0);
      behind = Number(counts?.[2] ?? 0);
      continue;
    }
    if (record.startsWith('#')) continue;

    const kind = record[0];
    if (kind === '?') {
      untrackedCount += 1;
      collect(record.slice(2));
      continue;
    }
    if (kind === 'u') {
      // Unmerged. Counted on its own: a conflicted path is neither staged nor
      // simply modified, and reporting it as either would make "is this tree
      // ready to commit" answer wrongly.
      conflictedCount += 1;
      collect(fieldsAfter(record, 10));
      continue;
    }
    if (kind === '1' || kind === '2') {
      // `XY`: X is the index status, Y the working-tree status. A file staged
      // and then modified again is both, and is counted in both — which is the
      // honest answer and the one `git status` itself shows.
      const xy = record.slice(2, 4);
      if (xy[0] !== undefined && xy[0] !== '.') stagedCount += 1;
      if (xy[1] !== undefined && xy[1] !== '.') unstagedCount += 1;

      if (kind === '2') {
        // A rename: the path is followed by its original, NUL-separated, so the
        // next record belongs to this entry rather than being a new one.
        collect(fieldsAfter(record, 9));
        index += 1;
      } else {
        collect(fieldsAfter(record, 8));
      }
      continue;
    }
  }

  const state: WorkingTreeState = {
    clean: stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0 && conflictedCount === 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    sample,
    sampleTruncated: totalPaths > sample.length,
  };

  return {
    state: state.clean ? { ...EMPTY_STATE, sample: [], sampleTruncated: false } : state,
    upstream:
      upstreamRef === undefined ? undefined : { ref: upstreamRef, ahead, behind },
    headCommit,
    branch,
    detached,
  };
}

/**
 * The remainder of a record after `count` space-separated fields.
 *
 * A path may contain spaces, so it cannot be split off — only the fields before
 * it can be counted past. `-z` guarantees the path is the rest of the record.
 */
function fieldsAfter(record: string, count: number): string {
  let cursor = 0;
  for (let field = 0; field < count; field += 1) {
    const space = record.indexOf(' ', cursor);
    if (space === -1) return '';
    cursor = space + 1;
  }
  return record.slice(cursor);
}
