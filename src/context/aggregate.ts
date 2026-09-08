import { containUntrusted, type ContentSafety } from '../security/index.js';

/**
 * What Ferret already recorded between the statements in one pack — EPIC-139A.
 *
 * **Not clustering, and the distinction is the whole design.** An earlier
 * specification computed connected components over five relations. It was
 * rejected on measurement: three of the five assert *sameness of subject
 * matter* (one statement replaced another, two are rivals, two are wordings)
 * and two assert only *association* (about one entity, resting on one file). A
 * component over the union answers "are these one belief?" using edges that
 * only ever meant "these are related" — and composing association is worse
 * still, because a statement may carry up to `MAX_ANCHORS` anchors, so anchor
 * overlap is set *intersection*: X on {A,B}, Y on {B,C}, Z on {C,D} lands X and
 * Z in one component sharing **nothing**, and the composed link names no record.
 *
 * So this reports what was recorded, as it was recorded. A **link** is one
 * relationship row. A **group** is keyed on the one record its members share.
 * Nothing here is composed, which is what makes every entry checkable:
 *
 * > A safe bridge is one Ferret can name in full — the statement ids, the
 * > relation, and the single record that carries it — so a reader can check it
 * > without Ferret having composed anything.
 *
 * Pure, and deliberately: no store handle, no clock, no similarity, no model.
 * `boundaries.test.ts` keeps proving it reaches no `storage/` module.
 */

/** The recorded relations that assert two statements occupy one slot. */
export const ContextRelation = {
  /** `from` replaced `to` — `ENTITY_SUPERSEDES_ENTITY`, producer-stated. */
  SUPERSEDES: 'supersedes',
  /** Rivals about one subject — `context_contradicts_context`. */
  CONTRADICTS: 'contradicts',
} as const;

export type ContextRelation = (typeof ContextRelation)[keyof typeof ContextRelation];

/**
 * Every signal the index can carry, whether or not it fired.
 *
 * A closed set, and it is closed for a reason recorded in the Epic: a list that
 * grows quietly invites an implementation that reads five signals and measures
 * none. `restates` is deliberately **not** here — EPIC-130's fold elects one
 * survivor per `context_relates_to_context` component before assembly runs, so
 * both endpoints of a relate edge are never both in `standing`, and reading it
 * here would be the same query and the same union-find a second time.
 */
export const IndexSignal = {
  SUPERSEDES: 'supersedes',
  CONTRADICTS: 'contradicts',
  SHARED_ANCHOR: 'shared-anchor',
  SAME_SUBJECT: 'same-subject',
} as const;

export type IndexSignal = (typeof IndexSignal)[keyof typeof IndexSignal];

const SIGNALS: readonly IndexSignal[] = Object.freeze([
  IndexSignal.SUPERSEDES,
  IndexSignal.CONTRADICTS,
  IndexSignal.SHARED_ANCHOR,
  IndexSignal.SAME_SUBJECT,
]);

/** One relationship row, as the port read it. */
export interface RecordedContextRelation {
  /** The row that carries it, so a link can name what justifies it. */
  readonly relationshipId: string;
  readonly relation: ContextRelation;
  readonly from: string;
  readonly to: string;
}

/** One anchor, as the observation recorded it. */
export interface MemberAnchor {
  /** `locator.start` — the only anchor component resolved against the index. */
  readonly path: string;
  /**
   * `locator.detail` — producer free text, shown and never keyed.
   *
   * It concatenates a symbol with a line range and passes through
   * `redactSecrets` at write time, so keying on it would mean parsing a
   * producer's sentence back into a symbol — the inference EPIC-137 decision 7
   * refuses — and would separate two statements naming one symbol at different
   * lines.
   */
  readonly detail: string | undefined;
}

/** A statement on the page, with the signals it carries. */
export interface IndexMember {
  readonly id: string;
  readonly scope: string | undefined;
  /** The entity a producer declared the statement to be *about*. */
  readonly subject: string | undefined;
  readonly anchors: readonly MemberAnchor[];
}

/** One recorded edge, naming the row that carries it. */
export interface ContextLink {
  readonly from: string;
  readonly to: string;
  readonly relation: ContextRelation;
  /** The relationship row id. Never a derivation. */
  readonly via: string;
}

/**
 * Statements resting on one file.
 *
 * Keyed on the shared path rather than paired between statements: the group
 * *is* the shared record, so there is nothing to compose, and a hub path is
 * visible as a hub instead of being smeared over pairwise edges.
 */
export interface AnchorGroup {
  readonly scope: string | undefined;
  readonly path: string;
  readonly statements: readonly string[];
  /** Per statement, aligned with `statements`; absent detail is an empty string. */
  readonly details: readonly string[];
}

/** Statements a producer declared to be about one entity. */
export interface SubjectGroup {
  readonly subject: string;
  readonly statements: readonly string[];
}

export interface RelationIndex {
  readonly links: readonly ContextLink[];
  readonly anchors: readonly AnchorGroup[];
  readonly subjects: readonly SubjectGroup[];
  /**
   * Signals read and not present on this page.
   *
   * Reported rather than omitted, so a dead signal cannot be quietly
   * reclassified as unavailable — EPIC-139A §26.6's reporting clause.
   */
  readonly absent: readonly IndexSignal[];
  readonly estimatedTokens: number;
}

/**
 * The index over one page of standing statements.
 *
 * `members` must be the statements actually delivered, in delivery order, and
 * already permission-filtered — which is what makes the security property
 * structural rather than asserted: a link needs **both** endpoints in
 * `members`, and nothing traverses, so a withheld record cannot bridge two
 * visible ones and no field says a bridge existed.
 *
 * Returns `undefined` when there is nothing recorded between these statements.
 * A pack then carries no index rather than paying for four empty arrays.
 */
export function relationIndex(
  members: readonly IndexMember[],
  relations: readonly RecordedContextRelation[],
  estimate: (value: unknown) => number,
  safety: ContentSafety,
): RelationIndex | undefined {
  // Delivery order, so a group lists its statements the way the pack does.
  const rank = new Map(members.map((member, at) => [member.id, at]));

  const links = relations
    // Both endpoints, and this single condition is the bridge rule: B withheld
    // means A–B and B–C are both absent, so A and C are simply not connected.
    .filter((edge) => rank.has(edge.from) && rank.has(edge.to) && edge.from !== edge.to)
    .map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation, via: edge.relationshipId }))
    .sort(byLink);

  const anchors = groupAnchors(members, rank, safety);
  const subjects = groupSubjects(members, rank);

  if (links.length === 0 && anchors.length === 0 && subjects.length === 0) return undefined;

  const present = new Set<IndexSignal>();
  for (const link of links) present.add(link.relation);
  if (anchors.length > 0) present.add(IndexSignal.SHARED_ANCHOR);
  if (subjects.length > 0) present.add(IndexSignal.SAME_SUBJECT);

  const index = {
    links,
    anchors,
    subjects,
    absent: SIGNALS.filter((signal) => !present.has(signal)),
    estimatedTokens: 0,
  };
  // The estimate is a field of the thing estimated, so it is measured against
  // the widest number that field can hold — the trick `#toItem` already uses.
  return Object.freeze({
    ...index,
    estimatedTokens: estimate({ ...index, estimatedTokens: Number.MAX_SAFE_INTEGER }),
  });
}

/**
 * Anchors grouped by `(scope, path)`.
 *
 * **Scope is part of the key, never a signal on its own.** Every statement
 * recorded against a repository shares its scope, so scope alone would make one
 * group of the store — the unbounded traversal this design exists to prevent,
 * arriving by another door. Two repositories holding a file at the same path
 * therefore do not group, which is EPIC-137 §5's cross-repo rule read from the
 * other side.
 *
 * A path carrying one statement is dropped: it is an anchor, not an
 * association, and `standing` already reports it.
 */
function groupAnchors(
  members: readonly IndexMember[],
  rank: ReadonlyMap<string, number>,
  safety: ContentSafety,
): readonly AnchorGroup[] {
  const groups = new Map<string, { scope: string | undefined; path: string; found: Map<string, string> }>();
  for (const member of members) {
    for (const anchor of member.anchors) {
      // Unambiguous, not concatenated: a scope of `a b` with path `c` and a
      // scope of `a` with path `b c` would share a space-joined key and merge
      // two different files into one group — the false association this design
      // refuses. Written as a pair rather than with a separator byte, so the
      // file stays text and the key assumes nothing about either value.
      const key = JSON.stringify([member.scope ?? null, anchor.path]);
      const group = groups.get(key) ?? { scope: member.scope, path: anchor.path, found: new Map() };
      // One entry per statement even when a statement anchors the same path
      // twice across two observations: the group counts statements, not rows.
      if (!group.found.has(member.id)) group.found.set(member.id, anchor.detail ?? '');
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .filter((group) => group.found.size > 1)
    .map((group) => {
      const statements = [...group.found.keys()].sort(
        (left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0),
      );
      return {
        scope: group.scope,
        // A path is repository-derived text reaching a model, so it is
        // contained the way `locator.detail` already is. A path is not prose,
        // so containment marks it and returns it unchanged — which it must,
        // because a wrapped path resolves to nothing.
        path: String(containUntrusted(group.path, safety)),
        statements,
        details: statements.map((id) => String(containUntrusted(group.found.get(id) ?? '', safety))),
      };
    })
    .sort(byAnchor);
}

/**
 * Statements grouped by the subject a producer named.
 *
 * A group, never a link. `subjectId` was measured at zero natural adoption over
 * ten record calls across two sessions, and where it did appear leave-one-out
 * showed it joining members a shared anchor had already joined. So it asserts
 * no sameness here; it reports which entity a producer declared the statement to
 * be about, which no other signal reports, and it remains the precondition
 * `contradicts()` requires.
 */
function groupSubjects(
  members: readonly IndexMember[],
  rank: ReadonlyMap<string, number>,
): readonly SubjectGroup[] {
  const groups = new Map<string, string[]>();
  for (const member of members) {
    if (member.subject === undefined) continue;
    const held = groups.get(member.subject) ?? [];
    if (!held.includes(member.id)) held.push(member.id);
    groups.set(member.subject, held);
  }

  return [...groups.entries()]
    .filter(([, statements]) => statements.length > 1)
    .map(([subject, statements]) => ({
      subject,
      statements: [...statements].sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0)),
    }))
    .sort((left, right) => left.subject.localeCompare(right.subject));
}

/** Total, so two builds of one pack against a fixed store agree. */
function byLink(left: ContextLink, right: ContextLink): number {
  return (
    left.relation.localeCompare(right.relation) ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to)
  );
}

function byAnchor(left: AnchorGroup, right: AnchorGroup): number {
  return (left.scope ?? '').localeCompare(right.scope ?? '') || left.path.localeCompare(right.path);
}
