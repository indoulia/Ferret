import {
  EvidenceState,
  SourceAuthority,
  detectConflicts,
  isUnknownAuthority,
  type CanonicalEvidence,
  type StatedEvidence,
} from '../domain/index.js';

/**
 * Which evidence a pack item cites, and why — EPIC-062.
 *
 * Governance §18 asks Ferret to explain "why evidence was included, excluded,
 * considered authoritative, considered stale, or considered conflicting". Before
 * this, a pack item's evidence was the first five rows the store returned, and
 * the store returns them newest-first. So the answer to "why these five" was
 * *they were recent*, and the answer to "why not the others" was an integer.
 *
 * Two things make that worse than it sounds. EPIC-045 built an authority scale
 * and nothing on the answer path consulted it, so a model's own `ASSERTED`
 * output observed today outranked a `SYSTEM_OF_RECORD` observation from last
 * week. And `forSubject` was called without a `state` filter, so `superseded`
 * and `stale` records were cited exactly as `current` ones were.
 *
 * The selection here is **pure**: candidates in, decision out, no clock and no
 * database. That is not tidiness — an explanation that cannot be reproduced from
 * its inputs is not an explanation, and a selection that reached for a clock
 * would explain a different thing on every run.
 */

/** Why a candidate was not cited. */
export const EvidenceExclusion = {
  /** Nothing more fits: the per-item bound was already spent. */
  BOUND: 'per-item-bound',
  /** The per-field cap kept it out so another field could be represented. */
  FIELD_COVERED: 'field-already-covered',
  /** Ferret does not believe it still holds, and a current record covers the same fact. */
  NOT_CURRENT: 'not-current',
  /**
   * The item carrying it was trimmed to fit the token budget.
   *
   * Distinct from the bound: the selection chose this record and the budget took
   * it away afterwards. Collapsing the two would report a ranking decision Ferret
   * never made.
   */
  TOKEN_BUDGET: 'token-budget',
} as const;

export type EvidenceExclusion = (typeof EvidenceExclusion)[keyof typeof EvidenceExclusion];

export interface SelectedEvidence {
  readonly evidence: CanonicalEvidence;
  /** Undefined when the caller did not read Ferret's interpretation. */
  readonly state: EvidenceState | undefined;
  /** Why this record is cited, naming its authority and its state. */
  readonly reason: string;
}

export interface ExcludedEvidence {
  readonly id: string;
  readonly field: string | undefined;
  readonly cause: EvidenceExclusion;
  /** Why this record is not cited, in a form a person can check. */
  readonly reason: string;
}

export interface EvidenceSelection {
  /** The records to cite, in cited order. */
  readonly selected: readonly SelectedEvidence[];
  /** Every candidate not cited, each with its cause. */
  readonly excluded: readonly ExcludedEvidence[];
  /**
   * True when more evidence exists than was offered as a candidate.
   *
   * "The best five of nine" and "the best five of some unknown number" are
   * different claims, and a surface that cannot tell them apart makes the
   * stronger one by accident.
   */
  readonly windowTruncated: boolean;
  /**
   * Facts more than one current candidate disagrees about.
   *
   * Reported, never resolved: EPIC-047 owns resolution and Governance §15
   * forbids discarding a conflicting record. `''` names a disagreement about the
   * subject as a whole rather than about a named field.
   */
  readonly disputedFields: readonly string[];
}

export interface SelectionOptions {
  /** The most records to cite. */
  readonly limit: number;
  /** The most records to cite for any one field. */
  readonly perField?: number;
  /** True when the candidate list was cut short by a query bound. */
  readonly windowTruncated?: boolean;
}

/**
 * The most records one field may contribute to an item.
 *
 * A commit whose message was re-observed nine times has nine records on one
 * field, and without a cap they are the whole citation — while the file the
 * commit touched, the author it names and the ticket it references go uncited.
 * Two rather than one because a field's second-best record is often the one that
 * disagrees, and hiding it would report a settled fact that is not settled.
 */
export const MAX_EVIDENCE_PER_FIELD = 2;

/**
 * How believable each state is, spaced by tens.
 *
 * Spaced for the reason {@link SourceAuthority} is: a rank can be inserted later
 * without renumbering. Ordered by what the state says about whether the fact
 * still holds — `conflicting` is a *current* record that something disagrees
 * with, so it outranks `unavailable` (unverified at the last attempt), which
 * outranks `stale` (the source has changed since), which outranks `superseded`
 * (definitively replaced).
 */
const BELIEVABILITY: Readonly<Record<string, number | undefined>> = Object.freeze({
  [EvidenceState.CURRENT]: 0,
  [EvidenceState.CONFLICTING]: 10,
  [EvidenceState.UNAVAILABLE]: 30,
  [EvidenceState.STALE]: 40,
  [EvidenceState.SUPERSEDED]: 50,
});

/**
 * Where an unread or unrecognised state ranks.
 *
 * Between the believed states and the disbelieved ones, which is the same
 * decision EPIC-045 made when it placed `UNKNOWN` authority between `ASSERTED`
 * and `DERIVED`. It cannot outrank a current record — that would be
 * manufacturing certainty — and it is not ranked below a record known to have
 * been replaced, because "nobody assessed this" is not worse than "assessed and
 * superseded". Governance §6 forbids inventing either claim.
 */
const UNASSESSED_BELIEVABILITY = 20;

/** The rank a record Ferret still believes carries. */
const CURRENT_BELIEVABILITY = 0;

/**
 * Where an unassessed authority ranks.
 *
 * `isUnknownAuthority` exists precisely because `UNKNOWN` is the lowest *number*
 * and not the lowest *meaning* — it says "unassessed" where `ASSERTED` says
 * "assessed, and weak" (EPIC-045). Sorting it as zero would rank every source
 * Ferret has not yet classified below a model's unverified claim.
 */
const UNASSESSED_AUTHORITY = (SourceAuthority.ASSERTED + SourceAuthority.DERIVED) / 2;

function believability(state: EvidenceState | undefined): number {
  if (state === undefined) return UNASSESSED_BELIEVABILITY;
  // An unrecognised state arrived from somewhere Ferret does not control. It is
  // unassessed rather than wrong, and it must not throw: evidence comes from
  // providers, and a selection that crashes on an unexpected value takes the
  // whole answer with it.
  return BELIEVABILITY[state] ?? UNASSESSED_BELIEVABILITY;
}

function effectiveAuthority(authority: number): number {
  return isUnknownAuthority(authority) ? UNASSESSED_AUTHORITY : authority;
}

/** `undefined` field means "about the subject as a whole", and groups as one. */
function fieldKey(record: CanonicalEvidence): string {
  return record.field ?? '';
}

function describeAuthority(authority: number): string {
  if (isUnknownAuthority(authority)) return 'unassessed authority';
  for (const [name, rank] of Object.entries(SourceAuthority)) {
    if (rank === authority) return `${name.toLowerCase().replace(/_/g, '-')} authority`;
  }
  // Off the scale rather than on it. Reported as the number it is instead of
  // being rounded to a name it does not have.
  return `authority ${String(authority)}`;
}

function describeState(state: EvidenceState | undefined): string {
  if (state === undefined) return 'state not assessed';
  return BELIEVABILITY[state] === undefined ? `unrecognised state ${JSON.stringify(state)}` : `state ${state}`;
}

/**
 * Orders candidates by how much weight a citation should give them.
 *
 * Precedence is deliberate and is the Epic's central claim: **state before
 * authority**. Authority says where a fact came from; state says whether it
 * still holds. A `system-of-record` observation that something replaced last
 * week is worse evidence than a `parsed` observation that still stands, and the
 * previous ordering — recency alone — got that backwards in both directions.
 *
 * `id` is the final key so the order is *total*. Without it two records
 * identical in every ranked field swap places between runs, and an explanation
 * that changes without its inputs changing explains nothing.
 */
function compare(a: StatedEvidence, b: StatedEvidence): number {
  const beliefA = believability(a.state);
  const beliefB = believability(b.state);
  if (beliefA !== beliefB) return beliefA - beliefB;

  const authorityA = effectiveAuthority(a.evidence.authority);
  const authorityB = effectiveAuthority(b.evidence.authority);
  if (authorityA !== authorityB) return authorityB - authorityA;

  // Omitted confidence is "not assessed", which EPIC-008 keeps distinct from
  // zero ("believed false"). `-1` orders an unassessed record below an assessed
  // one without claiming it is false.
  const confidenceA = a.evidence.confidence ?? -1;
  const confidenceB = b.evidence.confidence ?? -1;
  if (confidenceA !== confidenceB) return confidenceB - confidenceA;

  const observedA = a.evidence.observedAt ?? '';
  const observedB = b.evidence.observedAt ?? '';
  if (observedA !== observedB) return observedA < observedB ? 1 : -1;

  return a.evidence.id < b.evidence.id ? -1 : a.evidence.id > b.evidence.id ? 1 : 0;
}

/**
 * Chooses the evidence a pack item cites, and accounts for the rest.
 *
 * Ranks, then admits in three passes so each exclusion has a *true* cause rather
 * than whichever one the loop happened to reach:
 *
 * 1. A record Ferret no longer believes is set aside once a current record
 *    covers the same field — cause `not-current`. Per field, not per subject: a
 *    superseded observation of a field nothing else covers is still the best
 *    Ferret has, and dropping it would report absence where there is staleness.
 * 2. A record beyond the per-field cap is held in reserve — cause
 *    `field-already-covered`.
 * 3. If the bound is not spent once every field has had its turn, the reserve is
 *    admitted in rank order. The cap exists to stop one field crowding out the
 *    others, not to leave the bound unused.
 *
 * Every candidate ends in exactly one of `selected` or `excluded`. The two
 * partition the input, which is Governance §15 expressed as a postcondition:
 * nothing is discarded silently.
 */
export function selectEvidence(
  candidates: readonly StatedEvidence[],
  options: SelectionOptions,
): EvidenceSelection {
  const limit = Math.max(0, Math.trunc(options.limit));
  const perField = Math.max(1, Math.trunc(options.perField ?? MAX_EVIDENCE_PER_FIELD));
  const windowTruncated = options.windowTruncated === true;

  if (candidates.length === 0 || limit === 0) {
    return Object.freeze({
      selected: Object.freeze([]),
      excluded: Object.freeze(
        candidates.map((candidate) =>
          Object.freeze({
            id: candidate.evidence.id,
            field: candidate.evidence.field,
            cause: EvidenceExclusion.BOUND,
            reason: 'no evidence may be cited on this item',
          }),
        ),
      ),
      windowTruncated,
      disputedFields: Object.freeze([]),
    });
  }

  const ranked = [...candidates].sort(compare);

  // Which fields a believed record covers. Computed up front because pass 1's
  // question — "does a current record cover this field?" — must not depend on
  // whether that record happened to fit.
  const believedFields = new Set<string>();
  for (const candidate of ranked) {
    if (believability(candidate.state) === CURRENT_BELIEVABILITY) {
      believedFields.add(fieldKey(candidate.evidence));
    }
  }

  const selected: SelectedEvidence[] = [];
  const excluded: ExcludedEvidence[] = [];
  const reserve: StatedEvidence[] = [];
  const perFieldCount = new Map<string, number>();

  for (const candidate of ranked) {
    const key = fieldKey(candidate.evidence);
    const record = candidate.evidence;

    const believed = believability(candidate.state) === CURRENT_BELIEVABILITY;
    if (!believed && believedFields.has(key)) {
      excluded.push(
        Object.freeze({
          id: record.id,
          field: record.field,
          cause: EvidenceExclusion.NOT_CURRENT,
          reason:
            `${describeState(candidate.state)}${
              candidate.supersededBy === undefined ? '' : ', replaced by a newer observation'
            }; a current record covers ${key === '' ? 'this subject' : `\`${key}\``}`,
        }),
      );
      continue;
    }

    if (selected.length >= limit) {
      excluded.push(
        Object.freeze({
          id: record.id,
          field: record.field,
          cause: EvidenceExclusion.BOUND,
          reason: `ranked below the ${String(limit)} record(s) cited on this item`,
        }),
      );
      continue;
    }

    const used = perFieldCount.get(key) ?? 0;
    if (used >= perField) {
      reserve.push(candidate);
      continue;
    }

    perFieldCount.set(key, used + 1);
    selected.push(toSelected(candidate));
  }

  // Pass 3. The cap is a fairness rule between fields, not a reason to send less
  // than the bound allows.
  for (const candidate of reserve) {
    const record = candidate.evidence;
    if (selected.length < limit) {
      selected.push(toSelected(candidate));
      continue;
    }
    excluded.push(
      Object.freeze({
        id: record.id,
        field: record.field,
        cause: EvidenceExclusion.FIELD_COVERED,
        reason:
          `${String(perField)} record(s) for ${record.field === undefined ? 'this subject' : `\`${record.field}\``} ` +
          'are already cited, and the remaining room went to other facts',
      }),
    );
  }

  return Object.freeze({
    selected: Object.freeze(selected),
    excluded: Object.freeze(excluded),
    windowTruncated,
    disputedFields: disputedFieldsOf(candidates),
  });
}

function toSelected(candidate: StatedEvidence): SelectedEvidence {
  const record = candidate.evidence;
  return Object.freeze({
    evidence: record,
    state: candidate.state,
    reason:
      `${record.method} by ${record.producer}, ${describeAuthority(record.authority)}, ` +
      `${describeState(candidate.state)}` +
      (record.confidence === undefined ? '' : `, confidence ${record.confidence.toFixed(2)}`),
  });
}

/**
 * Which facts the candidates disagree about.
 *
 * Reuses EPIC-008's `detectConflicts` rather than re-deriving grouping: it is
 * built for exactly this question and is already tested. Restricted to believed
 * records, because a superseded record "disagreeing" with the record that
 * replaced it is not a conflict — it is history.
 *
 * Found in the candidate window rather than by a second query, so an item costs
 * one round trip. A disagreement wholly outside the window is not reported, and
 * `windowTruncated` is what tells a reader that is possible.
 */
function disputedFieldsOf(candidates: readonly StatedEvidence[]): readonly string[] {
  const believed = candidates
    .filter((candidate) => believability(candidate.state) === CURRENT_BELIEVABILITY)
    .map((candidate) => candidate.evidence);

  const fields = new Set<string>();
  for (const group of detectConflicts(believed)) fields.add(group.field ?? '');
  // Conflicting is a state as well as a shape: a record the store already marked
  // `conflicting` names a dispute whose other side may be outside the window.
  for (const candidate of candidates) {
    if (candidate.state === EvidenceState.CONFLICTING) fields.add(fieldKey(candidate.evidence));
  }
  return Object.freeze([...fields].sort());
}
