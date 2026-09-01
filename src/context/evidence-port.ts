import type { CanonicalEvidence, ConflictGroup, StatedEvidence } from '../domain/index.js';

/**
 * What answer traceability needs from the evidence store — EPIC-048 §8.
 *
 * A port for the reason the indexer's ports are ports: deciding what to cite has
 * nothing to do with PostgreSQL, and an import here would give the core a
 * database dependency at the first place it mattered. `EvidenceStore` satisfies
 * this structurally without knowing the file exists, and the architecture test
 * keeps proving the core reaches no `storage/` module.
 *
 * Deliberately the store's own shapes rather than idealised ones. An adapter
 * layer would be a second place for the lineage and integrity rules to live, and
 * a second place for them to drift.
 */
export interface EvidenceReader {
  /**
   * Evidence held about one subject.
   *
   * `permittedScopes` is threaded from the first version rather than added later
   * — EPIC-058 makes supplying it mandatory on the retrieval path, and the query
   * already filters on it. One parameter now; a rewrite afterwards.
   */
  forSubject(
    subjectId: string,
    query?: {
      readonly field?: string;
      /**
       * Which observations to return. Unfiltered means every state, including
       * ones a newer observation has replaced — so a citation surface must ask
       * for what it means rather than take the default.
       */
      readonly state?: string;
      readonly permittedScopes?: readonly string[];
      readonly limit?: number;
    },
  ): Promise<readonly CanonicalEvidence[]>;

  /**
   * The same query, with Ferret's interpretation of each record — EPIC-062.
   *
   * `CanonicalEvidence` carries no `state`: the observation is append-only and
   * immutable, while state is Ferret's revisable reading of it. That separation
   * is right, and it left a citation surface unable to tell a superseded record
   * from a current one — so evidence selection could only order by recency,
   * which is how a model's own claim from today outranked a system-of-record
   * observation from last week.
   *
   * A projection rather than a second query: the store's `select()` already
   * fetches `state` and `superseded_by` and discards them.
   */
  forSubjectWithState(
    subjectId: string,
    query?: {
      readonly field?: string;
      readonly state?: string;
      readonly permittedScopes?: readonly string[];
      readonly limit?: number;
    },
  ): Promise<readonly StatedEvidence[]>;

  /** "Why does Ferret believe this" — EPIC-008 D-006, walked backwards, bounded. */
  provenanceOf(id: string, maxDepth?: number): Promise<readonly CanonicalEvidence[]>;

  /** Recomputes the integrity hash, so a citation can be shown to be untampered. */
  verify(id: string): Promise<CanonicalEvidence>;

  /** Disagreement about a subject, reported and never resolved here. */
  conflictsFor(subjectId: string): Promise<readonly ConflictGroup[]>;
}

/**
 * Evidence records attached to one pack item.
 *
 * Bounded because a pack is bounded: an entity with two hundred observations
 * must not spend the whole budget proving one item. What is left out is reported
 * rather than dropped silently, which is the same rule the pack applies to
 * everything else.
 */
export const MAX_EVIDENCE_PER_ITEM = 5;

/** Lineage depth a traceability answer will walk before saying it stopped. */
export const MAX_LINEAGE_DEPTH = 10;

/**
 * How many records evidence selection considers per item — EPIC-062 §13.
 *
 * Wider than {@link MAX_EVIDENCE_PER_ITEM} because a choice needs alternatives:
 * asking for five and citing five is not a selection, and the exclusion account
 * a pack now carries would have nothing to account for. Bounded by a constant
 * so an entity with two thousand observations costs what one with thirty costs —
 * the fetch stays one query either way.
 */
export const EVIDENCE_CANDIDATE_WINDOW = 25;
