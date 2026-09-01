import type {
  CanonicalEvidence,
  ConflictGroup,
  EvidenceState,
  StatedEvidence,
} from '../domain/index.js';

/**
 * What every read through this port must state — EPIC-083 AC-1.
 *
 * Required, and required *everywhere*, which is the whole of the change. EPIC-058
 * already made it mandatory in prose — "supplying it is mandatory on the retrieval
 * path" — and prose was enforced by whoever reviewed the call site. It was missed
 * twice: `ferret_why`'s subject read (#85) and, ten lines below it, the conflict
 * report (#87). Both were one line, both were on the path nobody tested, and both
 * were possible only because the parameter defaulted to *unrestricted*.
 *
 * There is deliberately no way to say "everything" here. A caller-facing read has
 * no legitimate use for one, and the store — which does, for the indexer reading
 * back what it wrote — names that decision with `UNRESTRICTED_READ` instead.
 */
export interface ScopedQuery {
  /**
   * Permission scopes the caller holds, taken from the `AccessContext`.
   *
   * An empty array is the caller who holds nothing and is a complete answer:
   * unscoped records only. It is not the same as forgetting to pass one, and
   * after this Epic there is no way to spell the second.
   */
  readonly permittedScopes: readonly string[];
}

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
   */
  forSubject(
    subjectId: string,
    query: ScopedQuery & {
      readonly field?: string;
      /**
       * Which observations to return. Unfiltered means every state, including
       * ones a newer observation has replaced — so a citation surface must ask
       * for what it means rather than take the default.
       */
      readonly state?: EvidenceState;
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
    query: ScopedQuery & {
      readonly field?: string;
      readonly state?: EvidenceState;
      readonly limit?: number;
    },
  ): Promise<readonly StatedEvidence[]>;

  /**
   * "Why does Ferret believe this" — EPIC-008 D-006, walked backwards, bounded.
   *
   * A lineage is the most revealing answer Ferret gives: the chain is walked
   * *because* the caller asked why, so an unfiltered walk is where a protected
   * observation surfaces after every other path has been closed.
   */
  provenanceOf(
    id: string,
    options: ScopedQuery & { readonly maxDepth?: number },
  ): Promise<readonly CanonicalEvidence[]>;

  /** Recomputes the integrity hash, so a citation can be shown to be untampered. */
  verify(id: string, options: ScopedQuery): Promise<CanonicalEvidence>;

  /**
   * Disagreement about a subject, reported and never resolved here.
   *
   * Scoped like every other read: a group carries no statement, but it names the
   * field and the record ids, which was #87.
   */
  conflictsFor(subjectId: string, options: ScopedQuery): Promise<readonly ConflictGroup[]>;
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
