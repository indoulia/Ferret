import { ErrorCode, FerretError, redactString } from '../errors/index.js';

import { firstLine, runGit, type GitRunOptions } from './runner.js';

/**
 * Reading commit history.
 *
 * Two properties dominate everything else here.
 *
 * **The output is unbounded.** A repository with a million commits produces
 * hundreds of megabytes from one `git log`, and EPIC-017's runner caps output at
 * 16 MiB precisely so that a naive read fails loudly instead of exhausting
 * memory. That cap is a feature, and the correct response to hitting it is to
 * page — never to raise it.
 *
 * **Every field is untrusted.** A commit message, an author name and a file path
 * all come from a repository Ferret did not write. They are length-bounded and
 * stripped of the control characters that would otherwise let a commit message
 * rewrite a terminal, and a path is never handed back to Git as an argument.
 *
 * The format is field-separated by NUL and record-separated by NUL, using
 * `git log -z`. Not because it is elegant, but because a commit message
 * contains newlines and a file path may contain almost any byte: any format
 * delimited by something a human would type is a parser waiting to be wrong.
 */

/** Longest single field Ferret keeps from a commit. */
const MAX_FIELD = 8192;

/** Longest commit message body kept. Beyond this a message is documentation. */
const MAX_BODY = 65_536;

/** Commits read in one call. */
export const MAX_COMMITS_PER_READ = 1_000;

/** A file path is bounded well below any filesystem's limit. */
const MAX_PATH = 4096;

/** How a commit touched a path. */
export const ChangeKind = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  COPIED: 'copied',
  TYPE_CHANGED: 'type-changed',
  UNMERGED: 'unmerged',
  UNKNOWN: 'unknown',
} as const;

export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export interface CommitChange {
  readonly kind: ChangeKind;
  /** The path after the change. For a delete, the path that was removed. */
  readonly path: string;
  /** The path before a rename or copy. */
  readonly previousPath: string | undefined;
  /** Similarity score Git reported for a rename or copy, 0–100. */
  readonly similarity: number | undefined;
}

export interface CommitRecord {
  readonly sha: string;
  readonly tree: string | undefined;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /**
   * When the commit says it was authored, when Git could say.
   *
   * Absent rather than wrong. Git emits the literal `%aI` for a date it cannot
   * parse and `+999:99` for an out-of-range timezone, and storing either would
   * put a string that is not an instant into a field every consumer reads as
   * one — which is how `"%aI"` reached the graph as a file path.
   */
  readonly authoredAt: string | undefined;
  readonly committerName: string;
  readonly committerEmail: string;
  /** When the commit says it was committed, when Git could say. */
  readonly committedAt: string | undefined;
  readonly subject: string;
  readonly body: string;
  /**
   * Paths this commit changed.
   *
   * Empty for a merge commit unless the caller asked for merge diffs: Git shows
   * no name-status for a merge by default, because "what did this merge change"
   * has no single answer — it depends which parent you compare against.
   */
  readonly changes: readonly CommitChange[];
}

export interface HistoryPage {
  readonly commits: readonly CommitRecord[];
  /** True when the range holds more commits than were read. */
  readonly truncated: boolean;
  /**
   * Why this read stopped early, when it did.
   *
   * Distinct from `truncated`, which means "ask for the next page". This means
   * "Git could not finish, and these are the commits it managed" — a corrupt or
   * missing object part-way through a traversal being the case that matters.
   * Git streams what it has already walked to stdout and *then* exits non-zero,
   * and that output used to be discarded: the result was an empty, untruncated
   * page, which a caller cannot tell from a repository with no history at all.
   */
  readonly incomplete?: { readonly reason: string };
}

export interface ReadHistoryOptions extends GitRunOptions {
  /** Ref or revision range. Default `HEAD`. */
  readonly revision?: string;
  /** Commits to read. Default {@link MAX_COMMITS_PER_READ}. */
  readonly limit?: number;
  /** Commits to skip, for paging. */
  readonly skip?: number;
  /** Only commits after this instant, for an incremental read. */
  readonly since?: string;
  /**
   * Commits already read, and everything they reach, excluded from the walk.
   *
   * This is what an incremental read should be, and `since` is not. A date is a
   * value the repository chooses and it does not order the commit graph: a
   * branch merged after being written, a rebase, an imported history and a
   * wrong clock are all commits Ferret has never seen whose dates say
   * otherwise. Reachability has none of those cases — a commit is either
   * reachable from something already read, or it is new — and it is the
   * question Git is built to answer.
   *
   * Every value must be an object id, and each is passed as `^<oid>`. A `^`
   * prefix cannot be read as an option, which `--not` before a caller-supplied
   * list could be.
   */
  readonly exclude?: readonly string[];
  /** Include per-commit file changes. Costs Git a diff per commit. */
  readonly withChanges?: boolean;
}

/**
 * What every record begins with, so a boundary is not a guess.
 *
 * Records used to be found by recognising their *contents* — a token that looks
 * like a hash, followed by fields that look like dates. That works until Git
 * hands back something its own format does not promise: a commit whose date it
 * cannot parse emits the literal `%aI`, and one with an out-of-range timezone
 * emits `+999:99`. Neither is a date, so the boundary was not recognised, the
 * header was consumed as file-change entries, and the reader walked out of step
 * for the rest of the page — losing every commit after it and inventing files
 * named after the header fields it had misread.
 *
 * A marker Git writes and content cannot forge removes the guess. `%x01` is a
 * byte no path and no commit message a repository can hold will place here, and
 * the check is equality rather than inference.
 */
const RECORD_MARKER = '\u0001ferret\u0001';

/** Field order in the format string. Kept adjacent to the parser that reads it. */
const FORMAT = [
  '%x01ferret%x01', // record marker, not a field
  '%H', // 0 commit
  '%T', // 1 tree
  '%P', // 2 parents, space-separated
  '%an', // 3 author name
  '%ae', // 4 author email
  '%aI', // 5 author date, strict ISO 8601
  '%cn', // 6 committer name
  '%ce', // 7 committer email
  '%cI', // 8 committer date
  '%s', // 9 subject
  '%b', // 10 body
].join('%x00');

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Reads a page of commit history.
 *
 * A revision is passed to Git as an argument, so it is validated first: a
 * revision is a caller-supplied string, and `--upload-pack=…` in that position
 * would be read as an option rather than a ref.
 */
export async function readHistory(options: ReadHistoryOptions): Promise<HistoryPage> {
  const limit = Math.min(options.limit ?? MAX_COMMITS_PER_READ, MAX_COMMITS_PER_READ);
  const skip = options.skip ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(skip) || skip < 0) {
    throw new FerretError(ErrorCode.USAGE, 'History paging needs a positive limit and a non-negative skip', {
      details: { limit, skip },
      remediation: 'Pass a positive integer limit.',
    });
  }

  const revision = options.revision ?? 'HEAD';
  assertSafeRevision(revision);

  // Validated for the same reason `revision` is, and with the same result when
  // it is not: Git does not refuse an unparseable `--since`, it *ignores* it —
  // so a malformed position silently turned an incremental read into a full one
  // and nothing said so. Refusing names the caller's mistake instead.
  if (options.since !== undefined && !isInstantInput(options.since)) {
    throw new FerretError(ErrorCode.USAGE, 'A history "since" must be an ISO-8601 instant', {
      details: { since: options.since },
      remediation: 'Pass the instant a previous read reported, or omit it for a full read.',
    });
  }

  const exclude = options.exclude ?? [];
  for (const oid of exclude) {
    if (!SHA.test(oid)) {
      throw new FerretError(ErrorCode.USAGE, 'An excluded commit must be an object id', {
        details: { exclude: oid },
        remediation: 'Pass the commit ids a previous read returned.',
      });
    }
  }

  const args = [
    'log',
    '-z',
    '--no-color',
    `--format=${FORMAT}`,
    // Read one more than asked, so "is there another page" costs nothing extra.
    `--max-count=${String(limit + 1)}`,
    ...(skip > 0 ? [`--skip=${String(skip)}`] : []),
    ...(options.since === undefined ? [] : [`--since=${options.since}`]),
    ...(options.withChanges === true ? ['--name-status', '--find-renames'] : []),
    revision,
    ...exclude.map((oid) => `^${oid}`),
    // Everything after this is a path, never an option. Nothing follows, which
    // is the point: it closes the argument list.
    '--',
  ];

  const result = await runGit(args, { ...options, allowFailure: true });
  if (result.exitCode !== 0) {
    // One exit code, three different answers, and they must not be collapsed.
    //
    // With **no output**, Git got nowhere: an empty repository has no HEAD and a
    // ref that does not exist is a question whose answer is "nothing" rather
    // than a failure. That stays as it was.
    //
    // With output, Git walked part of the history and then hit something it
    // could not read — a corrupt or missing object. Those commits are real and
    // were being thrown away, leaving a result identical to an empty repository.
    // They are returned, and the page says it is incomplete, because the one
    // thing a caller must not do is treat this as "there is nothing more".
    if (result.stdout.length === 0) return { commits: [], truncated: false };
    return {
      commits: parseHistoryOutput(result.stdout, options.withChanges === true).commits,
      truncated: false,
      // Git's stderr is text from a repository Ferret does not trust, and it is
      // about to be stored on a page, logged, and reported as a skipped path.
      // Through the same redaction as every other string that leaves the
      // process — F-71. Redaction preserves the diagnostic; a reason that says
      // nothing would be its own defect.
      incomplete: { reason: redactString(firstLine(result.stderr)) },
    };
  }

  const parsed = parseHistoryOutput(result.stdout, options.withChanges === true);
  const commits = parsed.commits;
  if (parsed.unreadable > 0) {
    // F-94's general case. Git exited zero, so nothing failed — but part of its
    // output was not the record format Ferret asked for, which means something
    // reshaped the stream. The commits that *were* read are returned, and the
    // page says it is incomplete so the watermark does not advance over the gap.
    return {
      commits: commits.slice(0, limit),
      truncated: commits.length > limit,
      incomplete: {
        reason:
          `Git produced ${String(parsed.unreadable)} region(s) of output Ferret could not read; ` +
          'the repository or the environment may be overriding how Git formats its output.',
      },
    };
  }
  return {
    commits: commits.slice(0, limit),
    truncated: commits.length > limit,
  };
}

/**
 * The commit a revision names, or `undefined` when it names none.
 *
 * The position an incremental read resumes from. An empty repository, a ref
 * that was deleted and a revision that never existed all answer `undefined`
 * rather than failing: none of them is an error, and each means the same thing
 * to a caller — there is no tip here to remember.
 */
export async function resolveCommit(
  options: GitRunOptions & { readonly revision?: string },
): Promise<string | undefined> {
  const revision = options.revision ?? 'HEAD';
  assertSafeRevision(revision);

  const result = await runGit(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    ...options,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return undefined;
  const oid = result.stdout.trim();
  return SHA.test(oid) ? oid : undefined;
}

/**
 * The subset of `oids` this repository still holds as commits.
 *
 * A stored position can name a commit that is no longer here — a rewritten
 * history, a deleted branch, a pruned object. Excluding it would make `git log`
 * fail, and a failed read here returns "no commits" (an empty repository and a
 * broken argument are the same exit code), so a stale position would look
 * exactly like a repository with nothing new in it. Dropping what is gone
 * degrades to reading more, which is the safe direction.
 */
export async function knownCommits(
  options: GitRunOptions,
  oids: readonly string[],
): Promise<readonly string[]> {
  const known: string[] = [];
  for (const oid of oids) {
    if (!SHA.test(oid)) continue;
    const resolved = await resolveCommit({ ...options, revision: oid });
    if (resolved !== undefined) known.push(oid);
  }
  return known;
}

/**
 * Parses `git log -z` output.
 *
 * Exported because it is the part that can be wrong in ways nothing else
 * notices, and it deserves tests that do not need a repository.
 *
 * The shape, with `--name-status`: each commit is eleven NUL-separated fields,
 * and when changes were requested the eleventh (the body) is followed by
 * NUL-separated status/path entries until the next commit begins. A record
 * starts wherever a token is a commit hash **and** the ten fields after it have
 * the shape of commit fields — checking the hash alone would misread a file
 * named like a hash.
 */
export function parseLog(stdout: string, withChanges: boolean): readonly CommitRecord[] {
  return parseHistoryOutput(stdout, withChanges).commits;
}

/** What {@link parseHistoryOutput} made of Git's output, and what it could not. */
export interface ParsedHistory {
  readonly commits: readonly CommitRecord[];
  /**
   * Tokens outside any record.
   *
   * Zero for every healthy `git log`, because the format Ferret asks for is
   * entirely marker-delimited records. Anything else is Git having produced
   * output Ferret did not ask for and cannot read — a re-encoded stream, a
   * signature block, a key nobody has found yet — and {@link readHistory} turns
   * it into an incomplete page rather than silently reporting fewer commits.
   *
   * This is the half of F-94 that does not depend on knowing the key. The
   * `-c` pins in the runner close the two encodings that were measured; this
   * closes the class, by *effect* rather than by name.
   */
  readonly unreadable: number;
}

/**
 * {@link parseLog}, with what it could not read reported rather than dropped.
 *
 * Separate entry point rather than a changed return type, because several
 * callers want only the commits and a tuple at each of them would be noise. The
 * counting happens once, here.
 */
export function parseHistoryOutput(stdout: string, withChanges: boolean): ParsedHistory {
  if (stdout.length === 0) return { commits: [], unreadable: 0 };

  // `git log -z` terminates each *record*, so a trailing NUL is expected. With
  // `--name-status` the last change entry is terminated too.
  const tokens = stdout.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();

  const commits: CommitRecord[] = [];
  let index = 0;
  let unreadable = 0;

  while (index < tokens.length) {
    if (!isRecordStart(tokens, index)) {
      // Not a record boundary. Skip one token rather than abandoning the read:
      // a malformed region should cost the commits it touches, not the
      // ninety-nine thousand after it — and count it, so "cost" is a fact the
      // caller is told rather than one it has to infer from a short page.
      index += 1;
      unreadable += 1;
      continue;
    }
    // The marker is not a field; the eleven that follow it are.
    const header = tokens.slice(index + 1, index + 12);
    if (header.length < 11) {
      // A record that begins and then stops: the output was cut, which is a
      // thing to report and not a page that simply ends here.
      unreadable += tokens.length - index;
      break;
    }
    index += 12;

    const changes: CommitChange[] = [];
    if (withChanges) {
      // `%b` and the first status entry are separated by a newline rather than a
      // NUL, because `git log -z` NUL-terminates the *format*, then emits the
      // diff. The leading newline belongs to neither.
      while (index < tokens.length) {
        if (isRecordStart(tokens, index)) break;
        const trimmed = (tokens[index] ?? '').replace(/^\n+/, '');
        index += 1;
        const change = readChange(trimmed, tokens, () => index, (next) => (index = next));
        if (change !== undefined) changes.push(change);
      }
    }

    commits.push(buildCommit(header, changes));
  }

  return { commits, unreadable };
}

/**
 * Whether the token at `at` is the marker that begins a record.
 *
 * Equality against a marker Git wrote, not inference from what the fields look
 * like. The hash that follows is checked too — cheap, and it means a lone
 * marker byte inside content cannot start a record on its own — but nothing
 * here depends on a *date* being well formed, which is what previously decided
 * whether the reader stayed in step with the stream.
 */
function isRecordStart(tokens: readonly string[], at: number): boolean {
  const marker = (tokens[at] ?? '').replace(/^\n+/, '');
  if (marker !== RECORD_MARKER) return false;
  const sha = (tokens[at + 1] ?? '').replace(/^\n+/, '');
  return SHA.test(sha);
}

/** A field kept only when it is actually an instant. */
function instantOrAbsent(value: string): string | undefined {
  return isInstant(value) ? value : undefined;
}

/**
 * An instant, as a caller supplies one.
 *
 * Wider than {@link isInstant} by exactly one thing: fractional seconds.
 * `Date.prototype.toISOString` emits them and Git's `%aI` does not, so a
 * validator written for Git's output refuses the value every JavaScript caller
 * naturally produces — which is a rule that fails the honest caller and stops
 * no dishonest one.
 */
function isInstantInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)$/.test(value.trim());
}

function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.test(value.replace(/^\n+/, ''));
}

/**
 * Reads one `--name-status` entry.
 *
 * A rename or copy is three tokens — `R100`, the old path, the new path — and
 * everything else is two. Getting that wrong shifts every subsequent entry,
 * which is why renames have their own test.
 */
function readChange(
  status: string,
  tokens: readonly string[],
  get: () => number,
  set: (next: number) => void,
): CommitChange | undefined {
  if (status.length === 0) return undefined;

  const letter = status[0] ?? '';
  const score = Number.parseInt(status.slice(1), 10);
  const similarity = Number.isFinite(score) ? score : undefined;
  let index = get();

  const take = (): string | undefined => {
    const value = tokens[index];
    index += 1;
    return value;
  };

  if (letter === 'R' || letter === 'C') {
    const from = take();
    const to = take();
    set(index);
    if (from === undefined || to === undefined) return undefined;
    return {
      kind: letter === 'R' ? ChangeKind.RENAMED : ChangeKind.COPIED,
      path: boundedPath(to),
      previousPath: boundedPath(from),
      ...(similarity === undefined ? {} : { similarity }),
    } as CommitChange;
  }

  const path = take();
  set(index);
  if (path === undefined || path.length === 0) return undefined;

  return {
    kind: kindOf(letter),
    path: boundedPath(path),
    previousPath: undefined,
    similarity: undefined,
  };
}

function kindOf(letter: string): ChangeKind {
  switch (letter) {
    case 'A':
      return ChangeKind.ADDED;
    case 'M':
      return ChangeKind.MODIFIED;
    case 'D':
      return ChangeKind.DELETED;
    case 'T':
      return ChangeKind.TYPE_CHANGED;
    case 'U':
      return ChangeKind.UNMERGED;
    default:
      // A status Git added after this was written. Recording it as unknown keeps
      // the change rather than dropping it, which is the honest half-answer.
      return ChangeKind.UNKNOWN;
  }
}

function buildCommit(header: readonly string[], changes: readonly CommitChange[]): CommitRecord {
  const field = (at: number): string => bounded(header[at] ?? '');
  const parents = (header[2] ?? '')
    .trim()
    .split(/\s+/)
    .filter((parent) => SHA.test(parent));

  return {
    sha: field(0).replace(/^\n+/, ''),
    tree: SHA.test(header[1] ?? '') ? field(1) : undefined,
    parents,
    authorName: field(3),
    authorEmail: field(4),
    authoredAt: instantOrAbsent(field(5)),
    committerName: field(6),
    committerEmail: field(7),
    committedAt: instantOrAbsent(field(8)),
    subject: field(9),
    body: bounded(header[10] ?? '', MAX_BODY).replace(/\n+$/, ''),
    changes,
  };
}

/**
 * Bounds and cleans a field taken from a commit.
 *
 * A commit message reaches a terminal and an AI client. Control characters are
 * removed for the same reason ref names are (Governance §12): an escape sequence
 * in a commit subject can rewrite what an operator believes they are reading.
 * Newlines and tabs survive, because a commit body legitimately contains them.
 */
function bounded(value: string, max = MAX_FIELD): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function boundedPath(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, MAX_PATH).replace(/\\/g, '/');
}

/**
 * Refuses a revision that would be read as an option.
 *
 * The revision is caller-supplied and reaches Git's argument vector. A ref
 * cannot begin with `-`, so anything that does is either a mistake or an
 * attempt, and both want the same answer.
 */
export function assertSafeRevision(revision: string): void {
  if (revision.length === 0 || revision.length > 512 || revision.startsWith('-')) {
    throw new FerretError(ErrorCode.USAGE, 'That is not a revision Ferret will pass to Git', {
      details: { length: revision.length },
      remediation: 'Pass a ref name, a commit id, or a range such as `main..feature`.',
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(revision)) {
    throw new FerretError(ErrorCode.USAGE, 'A revision must not contain control characters', {
      details: {},
      remediation: 'Pass a ref name or a commit id.',
    });
  }
}
