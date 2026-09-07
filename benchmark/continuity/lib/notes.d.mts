/**
 * Types for the notes baseline, so its guard test can import it.
 *
 * `tests/unit/continuity-tasks.test.ts` pins what the curated file drops, that
 * the baseline is given the rationale, and how a note is ranked — the three
 * properties that decide whether the baseline is strong or has been quietly
 * weakened. Asserting those against an implicit `any` would prove nothing.
 */

/** A statement as `scenario.json` writes one, plus what padding adds. */
export interface NoteStatement {
  readonly key: string;
  readonly session: string | undefined;
  readonly kind: string;
  readonly statement: string;
  readonly rationale?: string | undefined;
  readonly supersedes?: string | undefined;
  readonly restatementOf?: string | undefined;
}

/** The session a note was recorded in, as composing one needs it. */
export interface NoteSession {
  readonly id: string;
  readonly agent: string;
}

/** Where one note sits in the composed file. */
export interface NoteBlock {
  readonly key: string;
  /** Index of the note's heading line. */
  readonly from: number;
  /** Index of its last line, inclusive. */
  readonly to: number;
}

/** A composed notes file: its text, its lines, and where each note is. */
export interface ComposedNotes {
  readonly text: string;
  readonly lines: readonly string[];
  readonly blocks: readonly NoteBlock[];
}

/** One ranked note, with the terms that matched it. */
export interface RankedNote extends NoteBlock {
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface NoteRetrieval {
  readonly terms: readonly string[];
  /** Statement keys, best first. */
  readonly artefacts: readonly string[];
  readonly results: readonly RankedNote[];
}

/** Tokens under the two reading habits. */
export interface NoteReadCost {
  readonly full: number;
  readonly frugal: number;
}

export declare function compose(
  statements: readonly NoteStatement[],
  sessionsById: ReadonlyMap<string, NoteSession>,
  options: { readonly curated: boolean },
): ComposedNotes;

export declare function retrieve(
  notes: ComposedNotes,
  question: string,
  options?: { readonly limit?: number },
): NoteRetrieval;

export declare function readCost(
  notes: ComposedNotes,
  results: readonly RankedNote[],
  options: { readonly reads: number; readonly estimate: (value: string) => number },
): NoteReadCost;

export declare function wholeFileCost(
  notes: ComposedNotes,
  options: { readonly estimate: (value: string) => number },
): NoteReadCost;
