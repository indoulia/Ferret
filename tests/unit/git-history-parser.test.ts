import { describe, expect, it } from 'vitest';

import { ErrorCode, FerretError } from '../../src/index.js';
import { ChangeKind, assertSafeRevision, parseLog } from '../../src/git/index.js';

/**
 * The `git log -z` parser, tested without a repository.
 *
 * This is the part of EPIC-019 that can be wrong in ways nothing else notices.
 * A rename entry is three tokens where everything else is two, so mishandling
 * one shifts every subsequent entry in the page — and the result is not a crash,
 * it is a hundred commits attributed to the wrong files.
 *
 * The fixtures below are the real shape, taken from actual `git log -z
 * --name-status` output rather than from the documentation.
 */

const NUL = '\0';

/**
 * The marker Git writes at the head of every record.
 *
 * The parser finds boundaries by this rather than by recognising a hash
 * followed by fields that look like dates: Git does not always emit a date
 * where a date belongs, and a boundary test that reads content walks out of
 * step the moment the content is not what it expected.
 */
const MARKER = '\u0001ferret\u0001';

interface CommitFields {
  sha?: string;
  tree?: string;
  parents?: string;
  authorName?: string;
  authorEmail?: string;
  authoredAt?: string;
  committerName?: string;
  committerEmail?: string;
  committedAt?: string;
  subject?: string;
  body?: string;
}

/** Builds one commit record in the exact field order Git emits. */
function commit(fields: CommitFields = {}): string {
  return [
    MARKER,
    fields.sha ?? 'a'.repeat(40),
    fields.tree ?? 'b'.repeat(40),
    fields.parents ?? '',
    fields.authorName ?? 'Ada Lovelace',
    fields.authorEmail ?? 'ada@example.invalid',
    fields.authoredAt ?? '2026-08-30T12:00:00+00:00',
    fields.committerName ?? 'Ada Lovelace',
    fields.committerEmail ?? 'ada@example.invalid',
    fields.committedAt ?? '2026-08-30T12:00:00+00:00',
    fields.subject ?? 'a subject',
    fields.body ?? '',
  ].join(NUL);
}

describe('parsing git log output', () => {
  it('reads a single commit', () => {
    const [parsed] = parseLog(commit() + NUL, false);

    expect(parsed?.sha).toBe('a'.repeat(40));
    expect(parsed?.authorEmail).toBe('ada@example.invalid');
    expect(parsed?.subject).toBe('a subject');
    expect(parsed?.parents).toStrictEqual([]);
  });

  it('reads several commits', () => {
    const stdout =
      commit({ sha: '1'.repeat(40) }) + NUL + commit({ sha: '2'.repeat(40) }) + NUL;
    expect(parseLog(stdout, false).map((c) => c.sha)).toStrictEqual(['1'.repeat(40), '2'.repeat(40)]);
  });

  it('reads a multi-line body without treating a newline as a boundary', () => {
    // The reason for `-z`. A commit message contains newlines, and any
    // line-delimited format would split one commit into several.
    const body = 'first line\nsecond line\n\nfourth line';
    const [parsed] = parseLog(commit({ body }) + NUL, false);
    expect(parsed?.body).toBe('first line\nsecond line\n\nfourth line');
  });

  it('reads a merge commit’s two parents', () => {
    const parents = `${'c'.repeat(40)} ${'d'.repeat(40)}`;
    const [parsed] = parseLog(commit({ parents }) + NUL, false);
    expect(parsed?.parents).toStrictEqual(['c'.repeat(40), 'd'.repeat(40)]);
  });

  it('reads a root commit, which has no parents', () => {
    const [parsed] = parseLog(commit({ parents: '' }) + NUL, false);
    expect(parsed?.parents).toStrictEqual([]);
  });
});

describe('parsing file changes', () => {
  it('reads an add and a modify', () => {
    // Only the first status token carries the newline that separates the format
    // from the diff; the rest do not. Both shapes appear here deliberately.
    const stdout = commit() + NUL + '\nA' + NUL + 'a.txt' + NUL + 'M' + NUL + 'b.txt' + NUL;
    const [parsed] = parseLog(stdout, true);

    expect(parsed?.changes).toStrictEqual([
      { kind: ChangeKind.ADDED, path: 'a.txt', previousPath: undefined, similarity: undefined },
      { kind: ChangeKind.MODIFIED, path: 'b.txt', previousPath: undefined, similarity: undefined },
    ]);
  });

  it('reads a rename, which is three tokens where everything else is two', () => {
    // The entry that shifts the whole page when it is read as two.
    const stdout =
      commit() + NUL + '\nR100' + NUL + 'sub/old.txt' + NUL + 'sub/new.txt' + NUL + 'M' + NUL + 'after.txt' + NUL;
    const [parsed] = parseLog(stdout, true);

    expect(parsed?.changes).toStrictEqual([
      {
        kind: ChangeKind.RENAMED,
        path: 'sub/new.txt',
        previousPath: 'sub/old.txt',
        similarity: 100,
      },
      { kind: ChangeKind.MODIFIED, path: 'after.txt', previousPath: undefined, similarity: undefined },
    ]);
  });

  it('reads a copy the same way, with its similarity', () => {
    const stdout = commit() + NUL + '\nC85' + NUL + 'from.txt' + NUL + 'to.txt' + NUL;
    expect(parseLog(stdout, true)[0]?.changes[0]).toStrictEqual({
      kind: ChangeKind.COPIED,
      path: 'to.txt',
      previousPath: 'from.txt',
      similarity: 85,
    });
  });

  it.each([
    ['D', ChangeKind.DELETED],
    ['T', ChangeKind.TYPE_CHANGED],
    ['U', ChangeKind.UNMERGED],
    ['X', ChangeKind.UNKNOWN],
  ])('reads status %s as %s', (letter, kind) => {
    const stdout = commit() + NUL + '\n' + letter + NUL + 'p.txt' + NUL;
    expect(parseLog(stdout, true)[0]?.changes[0]?.kind).toBe(kind);
  });

  it('gives a merge commit no changes, because Git reports none', () => {
    // Not an omission. "What did this merge change" has no single answer — it
    // depends which parent you compare against — so Git prints nothing, and
    // inventing something would be manufacturing certainty.
    const parents = `${'c'.repeat(40)} ${'d'.repeat(40)}`;
    const stdout =
      commit({ sha: '1'.repeat(40), parents }) +
      NUL +
      commit({ sha: '2'.repeat(40) }) +
      NUL +
      '\nA' +
      NUL +
      'later.txt' +
      NUL;

    const parsed = parseLog(stdout, true);
    expect(parsed[0]?.changes).toStrictEqual([]);
    expect(parsed[1]?.changes.map((change) => change.path)).toStrictEqual(['later.txt']);
  });

  it('does not mistake a file named like a commit hash for the next commit', () => {
    // A path can legitimately be forty hex characters. Checking the hash alone
    // would end the commit there and attribute everything after it to nothing.
    const hashLikePath = 'f'.repeat(40);
    const stdout =
      commit({ sha: '1'.repeat(40) }) +
      NUL +
      '\nA' +
      NUL +
      hashLikePath +
      NUL +
      'M' +
      NUL +
      'real.txt' +
      NUL;

    const parsed = parseLog(stdout, true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.changes.map((change) => change.path)).toStrictEqual([hashLikePath, 'real.txt']);
  });

  it('recovers from a malformed region instead of abandoning the page', () => {
    // A damaged commit should cost the commits it touches, not the ninety-nine
    // thousand after it.
    const stdout = 'not-a-commit' + NUL + commit({ sha: '9'.repeat(40) }) + NUL;
    expect(parseLog(stdout, false).map((c) => c.sha)).toStrictEqual(['9'.repeat(40)]);
  });

  it('returns nothing for empty output', () => {
    expect(parseLog('', false)).toStrictEqual([]);
    expect(parseLog('', true)).toStrictEqual([]);
  });
});

describe('untrusted commit content', () => {
  it('strips control characters from a subject that reaches a terminal', () => {
    // A commit message is written by whoever wrote the commit, and it is printed
    // to an operator and handed to an AI client. Governance §12.
    const hostile = 'fix: thing\u001b[2K\u001b[1Grm -rf /\u0007';
    const [parsed] = parseLog(commit({ subject: hostile }) + NUL, false);

    expect(parsed?.subject).not.toContain('\u001b');
    expect(parsed?.subject).not.toContain('\u0007');
    expect(parsed?.subject).toContain('fix: thing');
  });

  it('keeps the newlines and tabs a commit body legitimately contains', () => {
    const [parsed] = parseLog(commit({ body: 'line\n\tindented' }) + NUL, false);
    expect(parsed?.body).toBe('line\n\tindented');
  });

  it('bounds a field taken from a commit', () => {
    const [parsed] = parseLog(commit({ subject: 'x'.repeat(100_000) }) + NUL, false);
    expect(parsed?.subject.length).toBeLessThanOrEqual(8192);
  });

  it('bounds a path taken from a commit', () => {
    const stdout = commit() + NUL + '\nA' + NUL + 'p'.repeat(100_000) + NUL;
    expect(parseLog(stdout, true)[0]?.changes[0]?.path.length).toBeLessThanOrEqual(4096);
  });

  it('normalizes a path to forward slashes', () => {
    const stdout = commit() + NUL + '\nA' + NUL + 'src\\win\\file.ts' + NUL;
    expect(parseLog(stdout, true)[0]?.changes[0]?.path).toBe('src/win/file.ts');
  });
});

describe('revisions reaching Git as arguments', () => {
  const code = (revision: string): string => {
    try {
      assertSafeRevision(revision);
    } catch (error) {
      return error instanceof FerretError ? error.code : 'other';
    }
    return 'accepted';
  };

  it.each(['HEAD', 'main', 'refs/heads/main', 'main..feature', 'abc123', 'v1.0.0^{commit}'])(
    'accepts %s',
    (revision) => {
      expect(code(revision)).toBe('accepted');
    },
  );

  it('refuses a revision that would be read as an option', () => {
    // Not a shell problem — a Git one. `--upload-pack=…` in argument position is
    // an option, and a ref cannot begin with `-`, so anything that does is
    // either a mistake or an attempt.
    expect(code('--upload-pack=evil')).toBe(ErrorCode.USAGE);
    expect(code('-x')).toBe(ErrorCode.USAGE);
  });

  it('refuses an empty or oversized revision', () => {
    expect(code('')).toBe(ErrorCode.USAGE);
    expect(code('x'.repeat(1000))).toBe(ErrorCode.USAGE);
  });

  it('refuses a revision containing control characters', () => {
    // A NUL truncates the argument at the OS boundary, so what Git receives is
    // not what was inspected; an escape sequence reaches a terminal.
    expect(code('main\u0000--evil')).toBe(ErrorCode.USAGE);
    expect(code('main\u001b[2K')).toBe(ErrorCode.USAGE);
  });
});
