// Syntactic, not model-based: routing must be deterministic and must not depend
// on a provider that may not exist.

export const QueryShape = {
  OBJECT_ID: 'object-id',
  PATH: 'path',
  ENTITY_ID: 'entity-id',
  PROSE: 'prose',
} as const;

export type QueryShape = (typeof QueryShape)[keyof typeof QueryShape];

export interface Classification {
  readonly shape: QueryShape;
  readonly reason: string;
  readonly term: string;
  /** Single right answer, so ranking would be a lie. */
  readonly exact: boolean;
}

/** Bounded: a question is untrusted input and every pattern below runs on it. */
const MAX_CLASSIFIED = 1024;

// Anchored with no backtracking: these run on untrusted input. Seven is Git's
// own abbreviation floor.
const OBJECT_ID = /^[0-9a-f]{7,40}$/i;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Narrow on purpose: "src/main.ts" is a key, "changes in src/main.ts" is a
// question about one, and an exact lookup on the second returns nothing.
const PATH = /^[^\s]*[/\\][^\s]*$/;

/** Order matters: an entity id is also hex, so the most specific shape wins. */
export function classify(question: string): Classification {
  const term = question.trim().slice(0, MAX_CLASSIFIED);

  if (ENTITY_ID.test(term)) {
    return {
      shape: QueryShape.ENTITY_ID,
      reason: 'The question is a Ferret entity id, which identifies exactly one thing.',
      term: term.toLowerCase(),
      exact: true,
    };
  }

  if (OBJECT_ID.test(term)) {
    return {
      shape: QueryShape.OBJECT_ID,
      reason:
        'The question is a Git object id or an abbreviation of one. Full-text search ' +
        'matches whole words, so it cannot match an abbreviation against a full id.',
      term: term.toLowerCase(),
      exact: true,
    };
  }

  if (PATH.test(term)) {
    return {
      shape: QueryShape.PATH,
      reason: 'The question is a path, which names one file rather than describing one.',
      term: term.replace(/\\/g, '/'),
      exact: true,
    };
  }

  return {
    shape: QueryShape.PROSE,
    reason: 'The question is prose, which is what ranked retrieval is for.',
    term,
    exact: false,
  };
}
