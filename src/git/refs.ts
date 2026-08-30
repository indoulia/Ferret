import { ErrorCode, FerretError } from '../errors/index.js';
import type {
  DiscoveredBranch,
  DiscoveredWorktree,
} from '../providers/contracts/source-repository.js';

import { runGit, type GitRunOptions } from './runner.js';

/**
 * Reading a repository's worktrees and branches.
 *
 * Governance §9 makes the distinction this module exists to preserve: a
 * repository, a worktree and a branch are three different things, and Ferret's
 * ability to answer *"what was I working on"* rather than *"what is checked
 * out"* depends on never collapsing them. A developer with four worktrees of one
 * clone is working on four branches simultaneously; a model that stores "the
 * current branch" against the repository can represent one of them.
 *
 * Both readers use **plumbing** commands with explicit formats, for two reasons.
 * Porcelain output is written for humans and has changed shape between Git
 * versions. And a ref name is repository-controlled content: parsing it out of
 * prose is how a branch named `-> HEAD` becomes a parse error a year from now.
 */

/** Longest ref name Ferret will accept. Git's own limit is far larger; nothing legitimate is near it. */
const MAX_REF_LENGTH = 512;

/**
 * Refs read in one call, before Ferret refuses.
 *
 * A repository with a million refs is either a mirror of something enormous or
 * an attempt to exhaust memory, and both want the same answer: read a bounded
 * number, say the result is partial, and let the caller page.
 */
export const MAX_REFS_PER_READ = 10_000;

/**
 * Removes control characters from repository-controlled text.
 *
 * Git forbids control characters in ref names, so for a `refname` this is
 * belt-and-braces. It is not belt-and-braces for a lock reason or an upstream
 * name, which are free-form: those reach a terminal, and an ANSI escape sequence
 * in a branch listing can rewrite what an operator believes they are looking at.
 * Governance §12 — repository content is data, never instructions.
 */
export function sanitizeRefText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, MAX_REF_LENGTH);
}

/**
 * Lists the worktrees attached to a repository.
 *
 * `--porcelain` here is Git's *machine* format despite the name, and it is
 * explicitly documented as stable. Blocks are separated by a blank line, and
 * every block begins with `worktree <path>`.
 *
 * The first block is the primary worktree. That matters: a linked worktree can
 * be removed, and the primary one cannot, so "which checkout is the real one"
 * is a question Ferret can answer only because Git orders the output.
 */
interface MutableWorktree {
  path?: string;
  headCommit?: string | undefined;
  ref?: string | undefined;
  detached?: boolean;
  bare?: boolean;
  locked?: boolean;
  lockReason?: string | undefined;
  prunable?: boolean;
  prunableReason?: string | undefined;
}

export async function listWorktrees(options: GitRunOptions): Promise<readonly DiscoveredWorktree[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'], { ...options, allowFailure: true });
  if (result.exitCode !== 0) {
    // A repository too old to know the command, or one Git refuses to read.
    // Neither is a reason to fail the whole enumeration — Governance §13.
    return [];
  }

  const worktrees: DiscoveredWorktree[] = [];
  // Mutable while a block is being assembled; frozen into the readonly shape by
  // `flush`, so nothing downstream can edit what Git reported.
  let current: MutableWorktree = {};
  let first = true;

  const flush = (): void => {
    if (current.path === undefined) return;
    worktrees.push({
      path: current.path,
      headCommit: current.headCommit,
      ref: current.ref,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      primary: first,
      locked: current.locked ?? false,
      lockReason: current.lockReason,
      prunable: current.prunable ?? false,
      prunableReason: current.prunableReason,
    });
    first = false;
    current = {};
  };

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed === '') {
      flush();
      continue;
    }
    const space = trimmed.indexOf(' ');
    const key = space === -1 ? trimmed : trimmed.slice(0, space);
    const value = space === -1 ? '' : trimmed.slice(space + 1);

    switch (key) {
      case 'worktree':
        flush();
        current = { path: value };
        break;
      case 'HEAD':
        current.headCommit = /^[0-9a-f]{7,64}$/i.test(value) ? value : undefined;
        break;
      case 'branch':
        current.ref = sanitizeRefText(value);
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = true;
        current.lockReason = value === '' ? undefined : sanitizeRefText(value);
        break;
      case 'prunable':
        current.prunable = true;
        current.prunableReason = value === '' ? undefined : sanitizeRefText(value);
        break;
      default:
        // An unknown key from a newer Git. Ignored rather than fatal: a field
        // Ferret does not model is not a reason to stop reading the ones it does.
        break;
    }
  }
  flush();

  return worktrees;
}

export interface ListBranchesOptions extends GitRunOptions {
  /** Refs to read. Default {@link MAX_REFS_PER_READ}. */
  readonly limit?: number;
  /** Skip this many, for paging. */
  readonly offset?: number;
}

export interface BranchListing {
  readonly branches: readonly DiscoveredBranch[];
  /** True when the repository has more refs than were read. */
  readonly truncated: boolean;
  /** The ref a fresh clone would check out, when the repository records one. */
  readonly defaultRef: string | undefined;
}

/**
 * Lists local branches.
 *
 * `for-each-ref` with an explicit `%00`-separated format, rather than
 * `git branch`. Branch names may contain almost any byte Git has not
 * specifically forbidden — including spaces — so a space-separated format is a
 * parser waiting to be wrong, and a NUL cannot appear in a ref name by
 * definition.
 *
 * Records are newline-separated, which is safe for the same reason: Git refuses
 * a ref name containing a newline.
 */
export async function listBranches(options: ListBranchesOptions): Promise<BranchListing> {
  const limit = Math.min(options.limit ?? MAX_REFS_PER_READ, MAX_REFS_PER_READ);
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) {
    throw new FerretError(ErrorCode.USAGE, 'Branch paging needs a positive limit and a non-negative offset', {
      details: { limit, offset },
      remediation: 'Pass a positive integer limit.',
    });
  }

  const defaultRef = await readDefaultRef(options);

  // One more than asked for, so "is there another page" is answered by the read
  // rather than by a second round trip.
  const result = await runGit(
    [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)',
      `--count=${String(offset + limit + 1)}`,
      '--sort=refname',
      'refs/heads/',
    ],
    { ...options, allowFailure: true },
  );
  if (result.exitCode !== 0) return { branches: [], truncated: false, defaultRef };

  const rows = result.stdout.split('\n').filter((line) => line.length > 0);
  const windowed = rows.slice(offset, offset + limit);
  const truncated = rows.length > offset + limit;

  const branches: DiscoveredBranch[] = [];
  for (const row of windowed) {
    const [refname, objectname, upstream, head] = row.split('\0');
    if (refname === undefined || objectname === undefined) continue;

    const ref = sanitizeRefText(refname);
    if (!ref.startsWith('refs/heads/')) continue;
    const shortName = ref.slice('refs/heads/'.length);
    if (shortName.length === 0) continue;

    branches.push({
      ref,
      shortName,
      headCommit: /^[0-9a-f]{7,64}$/i.test(objectname) ? objectname : '',
      upstream: upstream === undefined || upstream === '' ? undefined : sanitizeRefText(upstream),
      // `%(HEAD)` is `*` for the ref checked out here, a space otherwise.
      isHead: head === '*',
      isDefault: defaultRef !== undefined && ref === defaultRef,
    });
  }

  return { branches: branches.filter((branch) => branch.headCommit !== ''), truncated, defaultRef };
}

/**
 * The ref a fresh clone of this repository would check out.
 *
 * `refs/remotes/origin/HEAD` is what a clone records, and it is the honest
 * answer to "what is the default branch" — the *local* `HEAD` merely says what
 * this checkout happens to be on, which is a different question and the one
 * Ferret exists to stop people confusing.
 *
 * Frequently absent: it is only written by `git clone` and by
 * `git remote set-head`. Absent is reported as absent rather than guessed at,
 * because guessing `main` is wrong for every repository that predates 2020.
 */
async function readDefaultRef(options: GitRunOptions): Promise<string | undefined> {
  const result = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;

  const remoteRef = sanitizeRefText(result.stdout.trim());
  const prefix = 'refs/remotes/origin/';
  if (!remoteRef.startsWith(prefix)) return undefined;
  const shortName = remoteRef.slice(prefix.length);
  return shortName.length === 0 ? undefined : `refs/heads/${shortName}`;
}
