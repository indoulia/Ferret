/**
 * The condition Ferret has to beat: an agent with a repository and `git`.
 *
 * This is the part of the benchmark most easily made dishonest, so the whole
 * algorithm is here and it is deliberately **generous**. A weak baseline is not
 * a result; it is a way of getting one. What an agent without a knowledge layer
 * actually does when handed an engineering question is grep the repository for
 * the words in it, weight a filename hit heavily, look at `git log --grep` for
 * the same words, and open the top few things it found. That is what this does,
 * with every parameter written down rather than tuned:
 *
 * - **Terms.** The question, lowercased, split on non-word characters, minus a
 *   fixed stop list and anything shorter than three characters.
 * - **Files.** `git grep -i -F` per term over the tracked tree at HEAD, plus a
 *   path match, which is `Glob` — the other half of what an agent does.
 * - **Commits.** The same terms against subject and body, which is
 *   `git log --grep`.
 * - **Score.** Per term: three for a path hit, plus `1 + ln(1 + lines)` for a
 *   content hit. Summed over terms. Breadth over depth, because a document
 *   mentioning six of the question's words is more likely to be about it than
 *   one mentioning a single word sixty times — and because the alternative,
 *   ranking on raw frequency, is a strictly worse baseline that would flatter
 *   Ferret.
 *
 * It has real strengths and the results should show them. It reads the *whole*
 * tracked tree including every file Ferret's exclusions drop, it matches
 * literally so an exact identifier is found exactly, and it has no index to go
 * stale. Where it loses, it should lose for a reason a reader can name.
 */

import { execFileSync } from 'node:child_process';

import { EXCLUDED_PREFIXES, commitArtefact, dedupe, fileArtefact } from './identity.mjs';

/**
 * Words carrying no retrieval signal in an engineering question.
 *
 * Fixed before any task was written and not revisited afterwards, which is the
 * only property that matters here: a stop list edited once results are in is a
 * way to tune the baseline, and §10 of the brief forbids exactly that. It is
 * ordinary English function words plus the interrogatives, and it contains no
 * term specific to Ferret, to a task, or to a document in this repository.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does',
  'doing', 'done', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'must', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
  'once', 'one', 'only', 'or', 'other', 'ought', 'our', 'ours', 'out', 'over',
  'own', 'same', 'should', 'so', 'some', 'still', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'use', 'used', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);

/** Fewest characters a term may have. Two-letter tokens match everywhere. */
const MIN_TERM = 3;

/** Weight of a term appearing in a path, relative to one content hit. */
const PATH_WEIGHT = 3;

/** How many commits `git log --grep` is modelled over. */
const COMMIT_WINDOW = 500;

/** Lines of context either side of a match, for the frugal read model. */
const CONTEXT_LINES = 20;

function git(root, args, { tolerateNoMatch = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // `git grep` exits 1 when nothing matched, which is an answer rather than
    // a failure. Anything else is a real error and is not swallowed.
    if (tolerateNoMatch && error.status === 1) return '';
    throw error;
  }
}

/** The question's content terms, deduplicated, order preserved. */
export function terms(question) {
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((token) => token.length >= MIN_TERM && !STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

/** Whether a repository path is corpus rather than this harness. */
function inCorpus(path) {
  return !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Files tracked at HEAD, as repository-relative forward-slash paths.
 *
 * Minus the benchmark's own, which hold the questions and the answer key. See
 * `EXCLUDED_PREFIXES` for what that cost before it was caught.
 */
export function trackedFiles(root) {
  return git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((path) => path.length > 0 && inCorpus(path));
}

/**
 * Matched-line counts per file for one literal term.
 *
 * `-I` skips binary files, which an agent also does not read, and `-c` reports
 * lines rather than occurrences — the same number a reader would see scrolling
 * the file.
 */
function grepCounts(root, term) {
  const output = git(root, ['grep', '-I', '-i', '-c', '-F', '-e', term, '--', '.'], {
    tolerateNoMatch: true,
  });
  const counts = new Map();
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.lastIndexOf(':');
    if (separator === -1) continue;
    const path = line.slice(0, separator).replace(/\\/g, '/');
    const count = Number.parseInt(line.slice(separator + 1), 10);
    if (Number.isFinite(count) && inCorpus(path)) counts.set(path, count);
  }
  return counts;
}

/** The commits in the window, as `{ sha, text }` with subject and body joined. */
function commitWindow(root) {
  // ASCII record and unit separators, because a commit message contains every
  // printable delimiter someone might otherwise reach for, newlines included.
  const RECORD = String.fromCharCode(30);
  const FIELD = String.fromCharCode(31);
  const output = git(root, [
    'log',
    `-n${COMMIT_WINDOW}`,
    '--format=%H%x1f%s%x1f%b%x1e',
    'HEAD',
  ]);
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, subject = '', body = ''] = record.split(FIELD);
      return { sha, text: `${subject}\n${body}`.toLowerCase() };
    });
}

/** `1 + ln(1 + lines)`, the damped contribution of one term's content hits. */
function damp(lines) {
  return 1 + Math.log(1 + lines);
}

/**
 * Rank the repository against a question, the way an agent without Ferret does.
 *
 * Returns the ranked artefact names and enough per-file detail for the read-cost
 * model to charge for what the agent would actually have opened.
 */
export function retrieve(root, question, { limit = 10 } = {}) {
  const questionTerms = terms(question);
  const paths = trackedFiles(root);

  const fileScores = new Map();
  const fileMatches = new Map();
  const bump = (path, amount) => fileScores.set(path, (fileScores.get(path) ?? 0) + amount);

  for (const term of questionTerms) {
    for (const path of paths) {
      if (path.toLowerCase().includes(term)) bump(path, PATH_WEIGHT);
    }
    for (const [path, lines] of grepCounts(root, term)) {
      bump(path, damp(lines));
      const matched = fileMatches.get(path) ?? new Set();
      matched.add(term);
      fileMatches.set(path, matched);
    }
  }

  const commitScores = new Map();
  for (const { sha, text } of commitWindow(root)) {
    let score = 0;
    for (const term of questionTerms) {
      const occurrences = text.split(term).length - 1;
      if (occurrences > 0) score += damp(occurrences);
    }
    if (score > 0) commitScores.set(sha, score);
  }

  // Files and commits rank in one list because an agent reads one list: it
  // greps, it looks at the log, and it opens whatever looked most promising
  // out of both. Ties break on the shorter name, then lexically, so a run is
  // reproducible rather than dependent on map ordering.
  const ranked = [
    ...[...fileScores].map(([path, score]) => ({ artefact: fileArtefact(path), path, score })),
    ...[...commitScores].map(([sha, score]) => ({ artefact: commitArtefact(sha), score })),
  ].sort((a, b) => b.score - a.score || a.artefact.length - b.artefact.length || (a.artefact < b.artefact ? -1 : 1));

  const window = ranked.slice(0, limit);
  return {
    terms: questionTerms,
    artefacts: dedupe(window.map((entry) => entry.artefact)),
    /** Per-result detail the cost model needs; same order as `artefacts`. */
    results: window.map((entry) => ({
      ...entry,
      matchedTerms: entry.path === undefined ? questionTerms : [...(fileMatches.get(entry.path) ?? [])],
    })),
  };
}

/**
 * What the agent would put in its context window, under two reading habits.
 *
 * Charging for one of them alone would decide the result by assumption. An
 * agent that opens the file pays for all of it — the usual habit, and the one
 * that makes a 40 kB Epic document expensive. An agent that greps with context
 * lines pays only for the neighbourhood of each hit, which is cheaper and
 * strictly less informative. Both are real, so both are reported and neither is
 * called *the* cost.
 */
export function readCost(root, results, { reads, estimate }) {
  let full = 0;
  let frugal = 0;
  for (const entry of results.slice(0, reads)) {
    if (entry.path === undefined) {
      // A commit: the agent reads the message and the name-status diff.
      const shown = git(root, ['show', '--stat', '--format=%B', entry.sha]);
      full += estimate(shown);
      frugal += estimate(shown);
      continue;
    }
    let content;
    try {
      content = git(root, ['show', `HEAD:${entry.path}`]);
    } catch {
      continue;
    }
    full += estimate(content);

    const lines = content.split('\n');
    const keep = new Set();
    for (const [index, line] of lines.entries()) {
      const lower = line.toLowerCase();
      if (!entry.matchedTerms.some((term) => lower.includes(term))) continue;
      for (let at = index - CONTEXT_LINES; at <= index + CONTEXT_LINES; at += 1) {
        if (at >= 0 && at < lines.length) keep.add(at);
      }
    }
    frugal += estimate([...keep].sort((a, b) => a - b).map((at) => lines[at]).join('\n'));
  }
  return { full, frugal };
}
