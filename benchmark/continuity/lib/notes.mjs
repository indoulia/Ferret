/**
 * The condition Ferret has to beat: an agent that writes its knowledge down.
 *
 * This is the part of a continuity benchmark most easily made dishonest, so it
 * is written out here in full. Comparing a populated Ferret against an agent
 * that remembers nothing would not be a measurement, it would be a demonstration
 * — the second session would lose by having been given nothing. What an agent
 * without a knowledge layer actually does is keep notes: `CLAUDE.md`,
 * `.ai/knowledge/`, a `NOTES.md` in the repository, the eleven markdown files
 * this project's own agent was maintaining outside the product before EPIC-128.
 * That is the baseline, and it is given **exactly** the same statements Ferret
 * is given, at the same moment in the same order, with the same rationale and
 * the same provenance. Nothing is withheld from it.
 *
 * Three habits, because picking one would decide the result:
 *
 * - **append** — every statement is appended and nothing is ever revisited.
 *   The common case, and the one that accumulates reversed decisions.
 * - **curated** — when a statement supersedes another, the superseded one is
 *   removed and the replacement takes its place. The disciplined ideal, and it
 *   is handed for free the one thing Ferret's mechanism exists to supply: the
 *   knowledge of *what supersedes what*. A curated file therefore cannot fail
 *   the supersession measurement, by construction. That is the point of
 *   including it — if Ferret merely matches a perfectly disciplined agent, the
 *   honest result is that it costs nothing to be disciplined for free.
 * - **full** — the whole curated file is read into context with no retrieval at
 *   all. Perfect recall by definition; the question is what it costs, and that
 *   is the question a growing knowledge base decides.
 *
 * Retrieval over the notes is the *same* ranking benchmark/lib/baseline.mjs
 * uses — the same term extraction, the same stop list, the same damping, the
 * same weight for a name hit — so no result here comes from having written a
 * weaker grep. The unit ranked is the note rather than the file, because a
 * notes file is one file and ranking files would rank one thing.
 */

import { PATH_WEIGHT, damp, terms } from '../../lib/baseline.mjs';

/** Lines of context either side of a match, for the frugal read model. */
const CONTEXT_LINES = 2;

/**
 * One statement as an agent would write it down.
 *
 * Carries what Ferret carries and no more: the statement, what kind of thing it
 * is, why, and which session recorded it. A format that dropped the rationale
 * would make the baseline cheaper by making it less useful, which is a way of
 * winning rather than a measurement.
 */
function blockFor(statement, session) {
  const lines = [`## ${statement.kind} — ${statement.statement}`];
  if (statement.rationale !== undefined) lines.push(`Why: ${statement.rationale}`);
  lines.push(`Recorded in session ${session.id} by ${session.agent}.`);
  return lines;
}

/**
 * The notes file for one habit, and where each note sits in it.
 *
 * Returns the text and a `blocks` array carrying, per note, the statement key
 * and the line range it occupies. The key is **not** written into the file: a
 * key in the text would be a token the baseline pays for and a string a
 * question could match, and neither belongs in a notes file a person would
 * actually keep. The harness knows which block is which because it wrote them.
 */
export function compose(statements, sessionsById, { curated }) {
  const kept = [];
  for (const statement of statements) {
    // The curated agent removes what this statement replaces, in the order the
    // sessions happened, exactly as `supersedes` describes it. Mechanical: it
    // is the scenario's own link, not a judgement made here.
    if (curated && statement.supersedes !== undefined) {
      const at = kept.findIndex((entry) => entry.key === statement.supersedes);
      if (at !== -1) kept.splice(at, 1);
    }
    kept.push(statement);
  }

  const header = ['# Engineering notes', ''];
  const lines = [...header];
  const blocks = [];
  for (const statement of kept) {
    const session = sessionsById.get(statement.session);
    const body = blockFor(statement, session);
    blocks.push({ key: statement.key, from: lines.length, to: lines.length + body.length - 1 });
    lines.push(...body, '');
  }
  return { text: lines.join('\n'), lines, blocks };
}

/**
 * Rank the notes against a question, the way an agent with a notes file does.
 *
 * It greps, it looks at what matched, and it reads the notes that matched most
 * of what it asked. Per note and per term: {@link PATH_WEIGHT} if the term is in
 * the note's own heading — the analogue of baseline.mjs weighting a filename hit
 * — plus `damp(matching lines)` for the body. Breadth over depth, the same
 * choice and for the same reason.
 */
export function retrieve(notes, question, { limit = 10 } = {}) {
  const questionTerms = terms(question);
  const scored = [];

  for (const block of notes.blocks) {
    const heading = (notes.lines[block.from] ?? '').toLowerCase();
    let score = 0;
    const matchedTerms = [];
    for (const term of questionTerms) {
      if (heading.includes(term)) score += PATH_WEIGHT;
      let matchingLines = 0;
      for (let at = block.from; at <= block.to; at += 1) {
        if ((notes.lines[at] ?? '').toLowerCase().includes(term)) matchingLines += 1;
      }
      if (matchingLines > 0) {
        score += damp(matchingLines);
        matchedTerms.push(term);
      }
    }
    if (score > 0) scored.push({ ...block, score, matchedTerms });
  }

  // Ties break on the earlier note, then on the key, so a run is reproducible
  // rather than dependent on insertion order changing under it.
  scored.sort((a, b) => b.score - a.score || a.from - b.from || (a.key < b.key ? -1 : 1));
  const window = scored.slice(0, limit);
  return { terms: questionTerms, artefacts: window.map((entry) => entry.key), results: window };
}

/**
 * What the agent puts in its context window, under the two reading habits.
 *
 * The same two habits benchmark/lib/baseline.mjs charges, narrowed to what a
 * note is: an agent that opens the note reads all of it, and an agent reading
 * around its grep hits reads the matched lines and their neighbours. A note is
 * small, so the two are close together — which is itself a fair advantage of
 * keeping short notes rather than long documents, and it is not taken away.
 */
export function readCost(notes, results, { reads, estimate }) {
  let full = 0;
  let frugal = 0;
  for (const entry of results.slice(0, reads)) {
    const body = notes.lines.slice(entry.from, entry.to + 1);
    full += estimate(body.join('\n'));

    const keep = new Set();
    for (const [offset, line] of body.entries()) {
      const lower = line.toLowerCase();
      if (!entry.matchedTerms.some((term) => lower.includes(term))) continue;
      for (let at = offset - CONTEXT_LINES; at <= offset + CONTEXT_LINES; at += 1) {
        if (at >= 0 && at < body.length) keep.add(at);
      }
    }
    frugal += estimate([...keep].sort((a, b) => a - b).map((at) => body[at]).join('\n'));
  }
  return { full, frugal };
}

/**
 * The whole file, which is what the third habit costs.
 *
 * There is no frugal way to read a file you have decided to read, so both
 * numbers are the same one. Reported rather than hidden: this condition sources
 * everything it holds, and the measurement it exists for is the price.
 */
export function wholeFileCost(notes, { estimate }) {
  const tokens = estimate(notes.text);
  return { full: tokens, frugal: tokens };
}
