import type { ProviderOperationContext } from '../sdk/operation.js';

/**
 * The `embedding` capability — EPIC-054.
 *
 * Ferret ships no implementation: TECHNOLOGY-DECISIONS §6 mandates no vendor.
 * It must also never fill the gap with something that looks like an embedding —
 * a hash has the right length and type and encodes no meaning, so semantic
 * search built on it returns confident noise.
 */

export interface EmbeddingModel {
  /** Part of an embedding's identity: vectors from two models are not comparable. */
  readonly id: string;
  /** Changes when the same model id starts producing different vectors. */
  readonly version: string;
  /** Length of every vector this model produces. */
  readonly dimensions: number;
  /** Recorded, not assumed: cosine-trained vectors queried by L2 rank wrongly
   * in a way nothing detects. */
  readonly metric: 'cosine' | 'l2' | 'inner-product';
}

export interface EmbeddingRequest {
  /** Texts to embed, in order. The response must preserve that order. */
  readonly texts: readonly string[];
  /** Several models embed documents and queries asymmetrically. */
  readonly purpose: 'document' | 'query';
}

export interface EmbeddingResult {
  readonly model: EmbeddingModel;
  /** One vector per input text, in the same order. */
  readonly vectors: readonly (readonly number[])[];
}


export interface EmbeddingSource {
  /** The model this provider will use. Read before anything is stored. */
  describeModel(context: ProviderOperationContext): Promise<EmbeddingModel>;
  embed(request: EmbeddingRequest, context: ProviderOperationContext): Promise<EmbeddingResult>;
}

/**
 * Checks a provider's response before any of it reaches storage.
 *
 * A count mismatch misaligns vectors with their subjects, and every subsequent
 * answer is then confidently about the wrong thing.
 *
 * @throws {RangeError}
 */
export function assertUsable(request: EmbeddingRequest, result: EmbeddingResult): void {
  if (result.vectors.length !== request.texts.length) {
    throw new RangeError(
      `The embedding provider returned ${String(result.vectors.length)} vectors for ` +
        `${String(request.texts.length)} texts. Storing them would attach vectors to the wrong subjects.`,
    );
  }

  const { dimensions } = result.model;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(`The embedding provider declared ${String(dimensions)} dimensions.`);
  }

  for (const [index, vector] of result.vectors.entries()) {
    if (vector.length !== dimensions) {
      throw new RangeError(
        `Vector ${String(index)} has ${String(vector.length)} dimensions, but the model ` +
          `declares ${String(dimensions)}.`,
      );
    }
    // One NaN makes every distance NaN, and NaN sorts unpredictably — the
    // vector would disorder results rather than merely being wrong.
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`Vector ${String(index)} contains a value that is not finite.`);
      }
    }
  }
}
