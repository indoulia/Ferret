/**
 * Estimating how much of a context window something will occupy.
 *
 * **This is an estimate, and the name says so everywhere.** Ferret does not
 * tokenize: a real count needs the tokenizer of the specific model, which
 * differs between vendors and between versions of one vendor, and pulling in a
 * tokenizer would tie Ferret to a model family — exactly what Governance §4
 * forbids, since the AI client is a provider like any other.
 *
 * So the estimate is deliberately **conservative**: it is designed to
 * over-count, because the failure modes are not symmetric. Over-counting means
 * Ferret sends a little less than it could. Under-counting means the client
 * truncates the pack itself, silently, from whichever end it happens to
 * truncate — and the thing that gets cut is not the thing Ferret would have
 * chosen to cut.
 *
 * The heuristic is roughly four characters per token for prose, with corrections
 * for the two cases where that is badly wrong: identifiers and paths (which
 * split into many tokens) and long runs of whitespace (which collapse into few).
 * A caller that needs certainty asks the model, and EPIC-070 is where a client
 * that can report its own tokenizer would be used.
 */

/** Characters per token for ordinary prose, before corrections. */
const PROSE_CHARS_PER_TOKEN = 4;

/**
 * Safety margin applied to every estimate.
 *
 * Ten per cent. Not tuned — chosen because the cost of being wrong is
 * asymmetric, and because a margin small enough to argue about is a margin that
 * does not do its job.
 */
export const ESTIMATE_MARGIN = 1.1;

/**
 * Estimated tokens for a piece of text.
 *
 * Never returns zero for non-empty input: a caller subtracting an estimate from
 * a budget in a loop must always make progress, and an item that "costs
 * nothing" is how that loop stops terminating.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  // Whitespace runs collapse into roughly one token each rather than one per
  // four characters, so counting them as prose badly over-estimates indented
  // code and formatted output.
  const whitespace = text.match(/\s+/g) ?? [];
  const whitespaceChars = whitespace.reduce((total, run) => total + run.length, 0);
  const whitespaceTokens = whitespace.length;

  // Identifiers and paths split at case changes, digits and separators, so they
  // cost far more tokens per character than prose. Counting the separators is a
  // cheap proxy for that split.
  const separators = (text.match(/[/\\._\-:@#]/g) ?? []).length;

  const prose = Math.ceil((text.length - whitespaceChars) / PROSE_CHARS_PER_TOKEN);
  const estimate = Math.ceil((prose + whitespaceTokens + separators) * ESTIMATE_MARGIN);
  return Math.max(1, estimate);
}

/** Estimated tokens for anything Ferret would serialize as JSON. */
export function estimateJsonTokens(value: unknown): number {
  const json = JSON.stringify(value);
  // `undefined`, a function or a symbol serializes to nothing. Charging one
  // token keeps the caller's loop making progress.
  return json === undefined ? 1 : estimateTokens(json);
}

/**
 * A budget being spent down.
 *
 * Tracks what was admitted and, more importantly, **what was not**. A pack that
 * silently dropped half its evidence is worse than one that says it did:
 * Governance §6 forbids manufacturing certainty, and an answer assembled from a
 * quietly truncated pack is exactly that.
 */
export class TokenBudget {
  readonly #total: number;
  #spent = 0;
  #admitted = 0;
  #rejected = 0;

  constructor(total: number) {
    if (!Number.isInteger(total) || total < 1) {
      throw new RangeError('A token budget must be a positive whole number');
    }
    this.#total = total;
  }

  get total(): number {
    return this.#total;
  }

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.#total - this.#spent);
  }

  get admitted(): number {
    return this.#admitted;
  }

  /** Items the budget refused. Non-zero means the pack is partial. */
  get rejected(): number {
    return this.#rejected;
  }

  get exhausted(): boolean {
    return this.#spent >= this.#total;
  }

  /**
   * Spends if it fits, and reports whether it did.
   *
   * Deliberately not throwing: running out of budget is the *expected* outcome
   * of assembling a pack, not an error, and a caller that has to catch an
   * exception per item will eventually catch it in the wrong place.
   */
  admit(cost: number): boolean {
    if (cost <= 0 || this.#spent + cost > this.#total) {
      this.#rejected += 1;
      return false;
    }
    this.#spent += cost;
    this.#admitted += 1;
    return true;
  }
}
