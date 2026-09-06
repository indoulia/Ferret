/**
 * What a condition's answer is worth, kept as ten numbers rather than one.
 *
 * The brief is explicit that a single score is not the deliverable, and the
 * reason is visible in the results: a condition can find every document and
 * still put a reversed decision above the one that reversed it, and a composite
 * would average that away. So each measurement stays separate, and the one
 * derived figure — `sourced` — is defined here rather than left implicit.
 *
 * The rank-order metrics are `src/evaluation/metrics.ts`, imported from the
 * build rather than reimplemented. They are already tested, they already return
 * `undefined` where a number would be a fabrication, and a second copy would be
 * a second thing to keep correct.
 */

import {
  meanOf,
  ndcgAtK,
  precisionAtK,
  recallOf,
} from '../../dist/evaluation/metrics.js';

/** Grade at which an artefact is the answer rather than support for it. */
const PRIMARY = 3;

/** The window a condition's answer is read in. */
export const K = 10;

/** How many of its own results the agent is modelled as opening. */
export const READS = 3;

/** `Map<artefact, relevance>` for a task. */
export function gradesOf(task) {
  return new Map(task.expected.map((entry) => [entry.artefact, entry.relevance]));
}

/** The artefacts a correct answer has to rest on. */
export function primaryOf(task) {
  return task.expected.filter((entry) => entry.relevance === PRIMARY).map((entry) => entry.artefact);
}

/** The artefacts that were true once and are not the current answer. */
export function supersededOf(task) {
  return (task.superseded ?? []).map((entry) => entry.artefact);
}

/**
 * Score one ranked list against one task.
 *
 * `ranked` is artefact names, best first, already deduplicated.
 */
export function score(task, ranked, cost) {
  const grades = gradesOf(task);
  const primary = primaryOf(task);
  const superseded = new Set(supersededOf(task));
  const window = ranked.slice(0, K);

  const firstPrimaryAt = window.findIndex((artefact) => primary.includes(artefact));
  const firstSupersededAt = window.findIndex((artefact) => superseded.has(artefact));

  return {
    /** How much of what should have been found was, inside the window. */
    recall: recallOf(window, grades),
    precision5: precisionAtK(window, grades, 5),
    precision10: precisionAtK(window, grades, K),
    ndcg10: ndcgAtK(window, grades, K),

    /**
     * Whether the answer is *sourced*: every artefact a correct answer rests on
     * came back inside the window.
     *
     * The nearest thing to correctness this benchmark can honestly report.
     * Ferret retrieves and assembles; it does not answer, and no measurement
     * here observes a model reasoning over what it was handed. What is
     * observable is whether the evidence an answer needs was in front of the
     * agent, and an answer given without it is unsourced whatever it happens to
     * say. Reported as a rate over tasks, never blended into another number.
     */
    sourced: primary.every((artefact) => window.includes(artefact)),
    primaryFound: primary.filter((artefact) => window.includes(artefact)).length,
    primaryTotal: primary.length,

    /** 1 / rank of the first artefact the answer must rest on, else 0. */
    reciprocalRankPrimary: firstPrimaryAt === -1 ? 0 : 1 / (firstPrimaryAt + 1),

    /**
     * A superseded artefact ranked above everything that supersedes it.
     *
     * The failure this benchmark exists to catch. An agent that reads top-down
     * and stops when it has an answer gets the reversed decision, and the
     * answer it gives is confident and wrong. Counted only where the task
     * labels something as superseded — `undefined`, not `false`, elsewhere, so
     * tasks with no trap cannot dilute the rate.
     */
    staleAboveCurrent:
      superseded.size === 0
        ? undefined
        : firstSupersededAt !== -1 && (firstPrimaryAt === -1 || firstSupersededAt < firstPrimaryAt),
    supersededInWindow: superseded.size === 0 ? undefined : window.filter((a) => superseded.has(a)).length,

    /** Results in the top five that are neither expected nor a labelled trap. */
    irrelevant5: window.slice(0, 5).filter((a) => !grades.has(a) && !superseded.has(a)).length,

    ...cost,
  };
}

/** Aggregate a condition's per-task scores. Means skip what is undefined. */
export function summarize(scores) {
  const defined = (key) => scores.map((s) => s[key]);
  const rate = (key) => {
    const present = defined(key).filter((v) => v !== undefined);
    if (present.length === 0) return undefined;
    return { rate: present.filter(Boolean).length / present.length, of: present.length };
  };
  const total = (key) => defined(key).reduce((sum, v) => sum + (v ?? 0), 0);

  // Cost alone rewards a condition for answering nothing. Two of the three
  // conditions in the first run were cheapest exactly where they returned an
  // empty list, and a table reporting only tokens would have read that as a
  // win. Dividing by the tasks actually sourced is what makes the number mean
  // "context spent per question answerable", which is the quantity anyone cares
  // about. `undefined` rather than infinity when nothing was sourced: a
  // division by zero is not a very large cost, it is an absent measurement.
  const sourcedCount = scores.filter((s) => s.sourced).length;
  const perSourced = (value) => (sourcedCount === 0 ? undefined : Math.round(value / sourcedCount));

  return {
    tasks: scores.length,
    recall: meanOf(defined('recall')),
    precision5: meanOf(defined('precision5')),
    precision10: meanOf(defined('precision10')),
    ndcg10: meanOf(defined('ndcg10')),
    mrrPrimary: meanOf(defined('reciprocalRankPrimary')),
    sourced: rate('sourced'),
    staleAboveCurrent: rate('staleAboveCurrent'),
    irrelevant5PerTask: total('irrelevant5') / scores.length,
    retrievalTokens: total('retrievalTokens'),
    readTokensFull: total('readTokensFull'),
    readTokensFrugal: total('readTokensFrugal'),
    totalTokensFull: total('retrievalTokens') + total('readTokensFull'),
    totalTokensFrugal: total('retrievalTokens') + total('readTokensFrugal'),
    tokensPerSourcedTask: perSourced(total('retrievalTokens') + total('readTokensFull')),
    medianMs: median(defined('ms')),
  };
}

function median(values) {
  const present = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (present.length === 0) return undefined;
  const middle = Math.floor(present.length / 2);
  return present.length % 2 === 0 ? (present[middle - 1] + present[middle]) / 2 : present[middle];
}
