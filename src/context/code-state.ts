import { HISTORICAL_LIFECYCLE_STATES, LifecycleState, type CanonicalEvidence } from '../domain/index.js';

/**
 * Whether a durable statement still describes the code it was observed against
 * — EPIC-137.
 *
 * A second axis, deliberately not a lifecycle state. `LifecycleState` refused a
 * sixth `historical` value because it would duplicate `superseded`, and the
 * same argument applies here: lifecycle answers *has anyone retired this*, and
 * this answers *does the observation still match the source*. Adding these to
 * that enum would conflate two questions and break `HISTORICAL_LIFECYCLE_STATES`.
 */
export const AnchorVerdict = {
  /** Every anchor matches, and the index corresponds to the state evaluated. */
  VERIFIED: 'verified',
  /** An anchored path's content moved. Not a claim that the statement is false. */
  STALE: 'stale',
  /** A replacement exists. Outranks every other verdict. */
  SUPERSEDED: 'superseded',
  /** Anchored, but correspondence or the anchor itself could not be established. */
  UNKNOWN: 'unknown',
  /**
   * No anchor recorded. Distinct from `unknown`: the correct action differs —
   * `unknown` means verify from source, `unanchored` means this may not be a
   * claim about code at all.
   */
  UNANCHORED: 'unanchored',
} as const;

export type AnchorVerdict = (typeof AnchorVerdict)[keyof typeof AnchorVerdict];

/** How many anchors one statement may carry. A finding resting on twenty files is not one finding. */
export const MAX_ANCHORS = 20;

/** Why Ferret could not decide. Category only — never a path a caller may not see. */
export const UnknownReason = {
  NOT_INDEXED: 'repository-not-indexed',
  /** Indexed head and the state being evaluated are not the same commit. */
  NO_CORRESPONDENCE: 'index-does-not-correspond',
  /** The anchored path has uncommitted changes. */
  PATH_DIRTY: 'anchored-path-modified',
  /** More paths changed than the sample holds, so the anchor cannot be excluded. */
  DIRT_UNKNOWN: 'working-tree-sample-truncated',
  /** The path is no longer an indexed file. */
  ANCHOR_UNRESOLVED: 'anchor-does-not-resolve',
  /** An exclusion rule covers the path — the operator's intent, not a denial. */
  EXCLUDED: 'anchor-excluded-by-rule',
  /** The caller does not hold a scope the anchor needs. */
  NOT_PERMITTED: 'anchor-not-permitted',
  /** The scope is not a repository Ferret can read locally. */
  NOT_LOCAL: 'scope-not-locally-readable',
} as const;

export type UnknownReason = (typeof UnknownReason)[keyof typeof UnknownReason];

/** An anchor as an agent supplies it: a path, never an entity id. */
export interface ContextAnchorInput {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /** Qualified name of the relevant symbol. Identifies the area, never verifies. */
  readonly symbol?: string | undefined;
  readonly lineRange?: { readonly start: number; readonly end: number } | undefined;
}

/** An anchor Ferret resolved to an indexed file version. */
export interface ResolvedAnchor extends ContextAnchorInput {
  readonly fileId: string;
  /** The content hash observed. The verification key. */
  readonly contentHash: string;
}

/** One anchor's resolution outcome. A failure is reported, never dropped. */
export interface AnchorResolution {
  readonly path: string;
  readonly resolved: ResolvedAnchor | undefined;
  /** Present when the anchor did not resolve. */
  readonly failure: UnknownReason | undefined;
  readonly detail: string | undefined;
}

/** What the anchored path currently holds, or why Ferret will not say. */
export interface CurrentContent {
  readonly contentHash: string | undefined;
  readonly withheld: UnknownReason | undefined;
}

/**
 * Whether the index corresponds to the repository state being evaluated —
 * EPIC-137 §8, the owner's locked contract.
 *
 * `established: false` is never upgraded to a match by any later comparison.
 */
export interface Correspondence {
  readonly established: boolean;
  readonly reason: UnknownReason | undefined;
  /** Paths with uncommitted changes, when the working tree could be read. */
  readonly dirtyPaths: ReadonlySet<string>;
  /** True when more paths changed than the sample holds. */
  readonly dirtySampleTruncated: boolean;
}

export const CORRESPONDENCE_UNAVAILABLE: Correspondence = Object.freeze({
  established: false,
  reason: UnknownReason.NOT_LOCAL,
  dirtyPaths: new Set<string>(),
  dirtySampleTruncated: false,
});

/**
 * Reading the current code state for one repository scope.
 *
 * A port for the reason `durable-port.ts` is one: comparing two hashes has
 * nothing to do with PostgreSQL or Git, and importing either here would give
 * the core a dependency `boundaries.test.ts` refuses.
 */
export interface CodeStatePort {
  /** Resolves anchors at record time, reporting each failure separately. */
  resolveAnchors(
    scope: string | undefined,
    anchors: readonly ContextAnchorInput[],
  ): Promise<readonly AnchorResolution[]>;
  /**
   * What the anchored paths hold now.
   *
   * The caller's access policy belongs to the adapter, which is built per
   * request at the composition root — the same object retrieval filters with.
   */
  currentContent(scope: string | undefined, paths: readonly string[]): Promise<ReadonlyMap<string, CurrentContent>>;
  correspondence(scope: string | undefined): Promise<Correspondence>;
}

/** One anchor, as reported to a reader: what was observed against what is there. */
export interface AnchorReport {
  readonly path: string;
  readonly symbol: string | undefined;
  readonly observedHash: string;
  readonly currentHash: string | undefined;
  readonly matches: boolean;
  readonly reason: UnknownReason | undefined;
}

export interface Verification {
  readonly verdict: AnchorVerdict;
  readonly anchors: readonly AnchorReport[];
  /** Category, never a path. Absent when the verdict needs no qualification. */
  readonly reason: UnknownReason | undefined;
  readonly detail: string;
}

/** One observation's anchors, newest first as `verifyAnchors` expects. */
export interface AnchoredObservation {
  readonly evidenceId: string;
  readonly observedAt: string | undefined;
  readonly anchors: readonly ResolvedAnchor[];
}

export interface VerifyInput {
  readonly lifecycle: LifecycleState;
  readonly supersededBy: string | undefined;
  /** Anchored supporting observations visible to the caller. */
  readonly observations: readonly AnchoredObservation[];
  readonly current: ReadonlyMap<string, CurrentContent>;
  readonly correspondence: Correspondence;
}

const UNANCHORED_DETAIL =
  'no code-state anchor was recorded, so nothing about the repository is being claimed';

/**
 * The verdict, from recorded anchors and current content — EPIC-137 §8.
 *
 * Pure, and the whole decision. Six conditions must hold for `verified`; any
 * one unestablished is `unknown`, never a match. The failure direction is
 * chosen: over-reporting costs a re-verification, under-reporting costs a
 * confident wrong answer.
 */
export function verifyAnchors(input: VerifyInput): Verification {
  // Lifecycle first. A matching anchor must never make a retired statement
  // look trustworthy, and `superseded` names a replacement to go to instead.
  if (input.supersededBy !== undefined || input.lifecycle === LifecycleState.SUPERSEDED) {
    return frozen(AnchorVerdict.SUPERSEDED, [], undefined, 'replaced by a later statement, which is the answer instead');
  }
  if ((HISTORICAL_LIFECYCLE_STATES as readonly string[]).includes(input.lifecycle)) {
    return frozen(AnchorVerdict.UNANCHORED, [], undefined, 'not current context, so no code state is claimed');
  }
  if (input.observations.length === 0) {
    return frozen(AnchorVerdict.UNANCHORED, [], undefined, UNANCHORED_DETAIL);
  }

  const candidates = input.observations.map((observation) => ({
    observation,
    reports: observation.anchors.map((anchor) => report(anchor, input.current)),
  }));

  if (input.correspondence.established) {
    for (const candidate of candidates) {
      const dirty = candidate.reports.find((one) => one.reason !== undefined);
      if (dirty !== undefined) continue;
      if (candidate.reports.length > 0 && candidate.reports.every((one) => one.matches)) {
        return frozen(
          AnchorVerdict.VERIFIED,
          candidate.reports,
          undefined,
          'every anchored file is byte-identical to what Ferret has indexed for the state evaluated',
        );
      }
    }
  }

  // Nothing verified. Report over the newest anchored observation, so a reader
  // sees the most recent claim rather than an arbitrary one.
  const newest = candidates[candidates.length - 1] ?? candidates[0];
  const reports = newest?.reports ?? [];

  if (!input.correspondence.established) {
    return frozen(
      AnchorVerdict.UNKNOWN,
      reports,
      input.correspondence.reason ?? UnknownReason.NO_CORRESPONDENCE,
      'the indexed repository state could not be shown to correspond to the state evaluated, so nothing is verified',
    );
  }

  const blocked = reports.find((one) => one.reason !== undefined);
  if (blocked?.reason !== undefined) {
    return frozen(AnchorVerdict.UNKNOWN, reports, blocked.reason, unknownDetail(blocked.reason));
  }

  return frozen(
    AnchorVerdict.STALE,
    reports,
    undefined,
    'an anchored file has changed since this was observed, so it needs re-verification — not that it is false',
  );
}

function report(anchor: ResolvedAnchor, current: ReadonlyMap<string, CurrentContent>): AnchorReport {
  const held = current.get(anchor.path);
  // Absent from the map is not "unchanged". A path Ferret was not asked about,
  // or would not answer for, is unresolved rather than matching.
  const withheld = held?.withheld ?? (held === undefined ? UnknownReason.ANCHOR_UNRESOLVED : undefined);
  return Object.freeze({
    path: anchor.path,
    symbol: anchor.symbol,
    observedHash: anchor.contentHash,
    currentHash: withheld === undefined ? held?.contentHash : undefined,
    matches: withheld === undefined && held?.contentHash === anchor.contentHash,
    reason: withheld ?? (held?.contentHash === undefined ? UnknownReason.ANCHOR_UNRESOLVED : undefined),
  });
}

function unknownDetail(reason: UnknownReason): string {
  switch (reason) {
    case UnknownReason.PATH_DIRTY:
      return 'an anchored file has uncommitted changes, so the indexed content is not what you have';
    case UnknownReason.DIRT_UNKNOWN:
      return 'more paths changed than the working-tree sample holds, so the anchor could not be excluded';
    case UnknownReason.EXCLUDED:
      return 'an exclusion rule covers an anchored path, so its current content was not read';
    case UnknownReason.NOT_PERMITTED:
      return 'an anchored path needs a scope this caller does not hold';
    case UnknownReason.ANCHOR_UNRESOLVED:
      return 'an anchored path is no longer an indexed file';
    case UnknownReason.NOT_INDEXED:
      return 'the anchored repository is not indexed';
    case UnknownReason.NOT_LOCAL:
      return 'the anchored scope is not a repository Ferret can read locally';
    case UnknownReason.NO_CORRESPONDENCE:
      return 'the indexed repository state could not be shown to correspond to the state evaluated';
    default:
      return 'the anchor could not be established';
  }
}

function frozen(
  verdict: AnchorVerdict,
  anchors: readonly AnchorReport[],
  reason: UnknownReason | undefined,
  detail: string,
): Verification {
  return Object.freeze({ verdict, anchors: Object.freeze([...anchors]), reason, detail });
}

/**
 * Regroups evidence rows into the observations they were written as.
 *
 * Rows sharing `sourceId` came from one `record` call and are one observation;
 * oldest first, because `verifyAnchors` reports over the last when none matches.
 */
export function anchoredObservations(support: readonly CanonicalEvidence[]): readonly AnchoredObservation[] {
  const groups = new Map<string, { observedAt: string | undefined; anchors: ResolvedAnchor[]; id: string }>();
  for (const row of support) {
    const locator = row.locator;
    if (locator === undefined || locator.kind !== 'path' || typeof locator.start !== 'string') continue;
    if (row.sourceContentHash === undefined || row.sourceId === undefined) continue;
    const group = groups.get(row.sourceId) ?? {
      observedAt: row.observedAt,
      anchors: [] as ResolvedAnchor[],
      id: row.id,
    };
    group.anchors.push({
      path: locator.start,
      symbol: locator.detail,
      lineRange: undefined,
      fileId: '',
      contentHash: row.sourceContentHash,
    });
    groups.set(row.sourceId, group);
  }
  return [...groups.values()]
    // Oldest first. `observedAt` when the producer gave one, else the
    // evidence id — stable, and the only other total order available here.
    .sort((left, right) => (left.observedAt ?? left.id).localeCompare(right.observedAt ?? right.id))
    .map((group) =>
      Object.freeze({ evidenceId: group.id, observedAt: group.observedAt, anchors: Object.freeze([...group.anchors]) }),
    );
}
