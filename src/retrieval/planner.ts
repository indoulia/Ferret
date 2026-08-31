import type { Logger } from '../logging/index.js';

import { classify, type Classification, type QueryShape } from './classify.js';
import { fuse, type FusedHit, type RankedList } from './fuse.js';
import { boundedLimit, type SearchHit } from './query.js';

/**
 * Choosing how to answer a question, and reporting what was not tried.
 *
 * Must be good with exact and full-text alone: TECHNOLOGY-DECISIONS §6 makes
 * embeddings optional, so that is the default configuration. Two rules —
 * never degrade silently, and never let one failing strategy fail the query.
 *
 * Core logic; the strategies are structural interfaces the stores satisfy, so
 * nothing here imports `storage/`.
 */

export interface ExactStrategy {
  /** Entities whose object id or path begins with this. */
  byIdentifier(term: string, limit: number): Promise<readonly SearchHit[]>;
}

export interface TextStrategy {
  search(query: {
    text: string;
    kinds?: readonly string[];
    limit?: number;
    relax?: boolean;
  }): Promise<readonly SearchHit[]>;
}

export interface SemanticStrategy {
  /**
   * `undefined`, not `[]`, when it cannot run. An empty array says "nothing is
   * similar", which is a finding; `undefined` says "nobody looked".
   */
  nearest(question: string, limit: number): Promise<readonly SearchHit[] | undefined>;
  /** Why it is unavailable, when it is. Shown to the caller verbatim. */
  unavailableReason(): Promise<string | undefined>;
}

/** What a strategy did, or did not do. */
export interface StrategyOutcome {
  readonly strategy: string;
  readonly ran: boolean;
  readonly returned: number;
  /** Present when the strategy did not run, or ran and failed. */
  readonly skipped: string | undefined;
}

export interface QueryPlan {
  readonly shape: QueryShape;
  readonly reason: string;
  /** True when the question had a right answer and ranking was not applied. */
  readonly exact: boolean;
  readonly strategies: readonly StrategyOutcome[];
  /** The one field a caller checks to know the answer may be incomplete. */
  readonly partial: boolean;
}

export interface PlannedResults {
  readonly plan: QueryPlan;
  readonly hits: readonly FusedHit[];
}

export interface PlannerDependencies {
  readonly exact: ExactStrategy;
  readonly text: TextStrategy;
  /** Absent when no embedding provider is registered, which is the default. */
  readonly semantic?: SemanticStrategy;
  readonly logger?: Logger;
}

export interface PlannedQuery {
  readonly question: string;
  readonly kinds?: readonly string[];
  readonly limit?: number;
  /** For a caller needing reproducibility: a provider can change its model. */
  readonly deterministicOnly?: boolean;
}

export class QueryPlanner {
  readonly #exact: ExactStrategy;
  readonly #text: TextStrategy;
  readonly #semantic: SemanticStrategy | undefined;
  readonly #logger: Logger | undefined;

  constructor(dependencies: PlannerDependencies) {
    this.#exact = dependencies.exact;
    this.#text = dependencies.text;
    this.#semantic = dependencies.semantic;
    this.#logger = dependencies.logger;
  }

  async search(query: PlannedQuery): Promise<PlannedResults> {
    const limit = boundedLimit(query.limit);
    const classification = classify(query.question);
    const outcomes: StrategyOutcome[] = [];

    // Not blended with ranked results: someone asking for `b9559ab` is not
    // helped by the commit ranked above three documents mentioning it.
    if (classification.exact) {
      const exact = await this.#attempt('exact', outcomes, () =>
        this.#exact.byIdentifier(classification.term, limit),
      );

      if (exact !== undefined && exact.length > 0) {
        return this.#finish(classification, outcomes, [{ strategy: 'exact', hits: exact }], limit);
      }

      // A path that no longer exists is still discussed in commit messages, so
      // falling through is right — but the caller must not read the ranked
      // results as the exact answer.
      annotate(outcomes, 'exact', 'Nothing matched exactly; ranked retrieval was used instead.');
    }

    // `all` is safe only because `#attempt` turns every rejection into a
    // recorded skip, so no branch here can reject.
    const [strict, semantic] = await Promise.all([
      this.#attempt('text', outcomes, () =>
        this.#text.search({
          text: classification.term,
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
          limit,
        }),
      ),
      this.#runSemantic(query, classification, outcomes, limit),
    ]);

    // DEFECT: full-text ANDs every term, so more context gave worse answers —
    // `tombstone` found a result, "how are deleted files tombstoned" found
    // nothing. Retry for any term, but only as a fallback: a strict match is
    // the better answer and starting loose would bury it.
    let text = strict;
    if (strict !== undefined && strict.length === 0 && !classification.exact) {
      const relaxed = await this.#attempt('text-relaxed', outcomes, () =>
        this.#text.search({
          text: classification.term,
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
          limit,
          relax: true,
        }),
      );
      if (relaxed !== undefined && relaxed.length > 0) {
        annotate(
          outcomes,
          'text',
          'No document contained every term, so the search was widened to any of them.',
        );
        text = relaxed;
      }
    }

    const lists: RankedList[] = [];
    if (text !== undefined) lists.push({ strategy: 'text', hits: text });
    if (semantic !== undefined) lists.push({ strategy: 'semantic', hits: semantic });

    return this.#finish(classification, outcomes, lists, limit);
  }

  /** A thrown strategy is a skip, not a failed query. */
  async #attempt(
    name: string,
    outcomes: StrategyOutcome[],
    run: () => Promise<readonly SearchHit[]>,
  ): Promise<readonly SearchHit[] | undefined> {
    try {
      const hits = await run();
      outcomes.push({ strategy: name, ran: true, returned: hits.length, skipped: undefined });
      return hits;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'the strategy failed';
      this.#logger?.warn(
        { operation: 'retrieval.plan.strategy', strategy: name, reason },
        `Retrieval strategy ${name} failed; continuing without it`,
      );
      outcomes.push({ strategy: name, ran: false, returned: 0, skipped: reason });
      return undefined;
    }
  }

  async #runSemantic(
    query: PlannedQuery,
    classification: Classification,
    outcomes: StrategyOutcome[],
    limit: number,
  ): Promise<readonly SearchHit[] | undefined> {
    if (query.deterministicOnly === true) {
      outcomes.push({
        strategy: 'semantic',
        ran: false,
        returned: 0,
        skipped: 'A deterministic answer was requested, and embeddings depend on a model that can change.',
      });
      return undefined;
    }

    if (this.#semantic === undefined) {
      outcomes.push({
        strategy: 'semantic',
        ran: false,
        returned: 0,
        skipped:
          'No embedding provider is registered. Ferret ships none by design — ' +
          'semantic retrieval is optional augmentation, not the basis of retrieval.',
      });
      return undefined;
    }

    const unavailable = await this.#semantic.unavailableReason().catch(() => 'the provider could not be reached');
    if (unavailable !== undefined) {
      outcomes.push({ strategy: 'semantic', ran: false, returned: 0, skipped: unavailable });
      return undefined;
    }

    const found = await this.#attempt('semantic', outcomes, async () => {
      const hits = await this.#semantic?.nearest(classification.term, limit);
      // Declining to answer is not finding nothing; collapsing the two here
      // would erase the distinction the interface exists for.
      if (hits === undefined) throw new Error('The embedding provider declined to answer.');
      return hits;
    });

    return found;
  }

  #finish(
    classification: Classification,
    outcomes: readonly StrategyOutcome[],
    lists: readonly RankedList[],
    limit: number,
  ): PlannedResults {
    const plan: QueryPlan = {
      shape: classification.shape,
      reason: classification.reason,
      exact: classification.exact,
      strategies: outcomes,
      partial: outcomes.some((outcome) => outcome.skipped !== undefined),
    };

    this.#logger?.debug(
      {
        operation: 'retrieval.plan',
        shape: plan.shape,
        partial: plan.partial,
        strategies: outcomes.map((outcome) => ({
          strategy: outcome.strategy,
          ran: outcome.ran,
          returned: outcome.returned,
        })),
      },
      `Planned a ${plan.shape} query`,
    );

    return { plan, hits: fuse(lists, limit) };
  }
}

/** Amends rather than appends: two rows for one strategy read as two attempts. */
function annotate(outcomes: StrategyOutcome[], strategy: string, note: string): void {
  const index = outcomes.findIndex((outcome) => outcome.strategy === strategy);
  if (index === -1) return;
  const existing = outcomes[index];
  if (existing === undefined) return;
  outcomes[index] = { ...existing, skipped: note };
}
