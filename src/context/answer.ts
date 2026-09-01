import type {
  CanonicalEntity,
  EvidenceLocator,
  EvidenceMethod,
  EvidenceState,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import {
  QueryShape,
  classify,
  type Classification,
  type QueryPlan,
  type QueryPlanner,
  type RetrievalPort,
} from '../retrieval/index.js';
import { ContentSafety, containAttributes, type ContentSafetyReport } from '../security/index.js';
import { VERSION } from '../version.js';

import { estimateJsonTokens } from './budget.js';
import { EVIDENCE_CANDIDATE_WINDOW, type EvidenceReader } from './evidence-port.js';
import { selectEvidence, type SelectedEvidence } from './evidence-selection.js';
import { CONTENT_NOTICE } from './pack.js';

/**
 * Answering a question Ferret can answer exactly — EPIC-060.
 *
 * A context pack hands a model *material*: the most relevant things Ferret
 * holds, ranked, bounded, with what it left out. That is the right shape for
 * "where did we discuss timeouts" and the wrong shape for `src/parser.ts`.
 *
 * `classify` already says why, in its own words: for a question with an exact
 * shape there is a **single right answer, so ranking would be a lie**. Ferret
 * recognises three such shapes — an entity id, a Git object id or abbreviation,
 * and a path — and before this answered all three with a ranking of one, an
 * unstated assumption that it was the right one, and no account of what Ferret
 * did not hold about it.
 *
 * So an answer pack states **claims with citations**, and states what it does
 * not know.
 *
 * **It never writes the sentence.** Ferret has no model, and prose synthesised
 * from evidence is indistinguishable from prose invented from it. The claims are
 * structured; composing them into English is the client's job. That boundary is
 * Governance §6 — never manufacture certainty — and it is why there is no
 * `summary` field here however useful one would look.
 *
 * **It never guesses which subject.** Two candidates for a question with one
 * right answer produce `ambiguous` and both candidates, not the higher-scoring
 * one. Once an arbitrary pick reaches an answer it is indistinguishable from a
 * considered one.
 */

export const ANSWER_FORMAT_VERSION = 1;

/** What Ferret is willing to say about how well it answered. */
export const AnswerCompleteness = {
  /** One subject, evidence cited, nothing known to be missing. */
  ANSWERED: 'answered',
  /**
   * Answered, and something is missing or unresolved.
   *
   * A strategy did not run, the evidence window was truncated, a claim or a
   * citation was dropped, a claim is uncited, current observations disagree, or
   * Ferret holds the subject and no evidence about it. `unknowns` says which.
   *
   * A dispute belongs here even though nothing is *missing*: Ferret holds both
   * sides and cannot say which holds, and `answered` on a fact it cannot settle
   * is certainty manufactured at the level a client is least likely to look past.
   */
  PARTIAL: 'partial',
  /** More than one subject matched a question with one right answer. */
  AMBIGUOUS: 'ambiguous',
  /** Ferret holds nothing matching the question. */
  NOT_INDEXED: 'not-indexed',
  /**
   * The question has no single right answer, so this is the wrong surface.
   *
   * Not a failure and not an error: prose is what a context pack is for, and
   * saying so is a better answer than a structured guess.
   */
  NOT_ANSWERABLE: 'not-answerable',
} as const;

export type AnswerCompleteness = (typeof AnswerCompleteness)[keyof typeof AnswerCompleteness];

/** One observation a claim rests on, with the EPIC-062 reason it was chosen. */
export interface AnswerCitation {
  readonly evidenceId: string;
  readonly method: EvidenceMethod;
  readonly producer: string;
  readonly producerVersion: string;
  readonly sourceSystem: string;
  readonly sourceId: string | undefined;
  readonly sourceUrl: string | undefined;
  readonly locator: EvidenceLocator | undefined;
  readonly authority: number;
  /** So a caller can verify the citation is untampered — EPIC-044. */
  readonly integrityHash: string;
  /** Ferret's own sentence, from evidence selection. Not repository content. */
  readonly reason: string;
}

export interface AnswerClaim {
  /** The fact this claim is about. `undefined` means the subject as a whole. */
  readonly field: string | undefined;
  /** What the best-supported observation says. Contained: it is source content. */
  readonly statement: unknown;
  /** Ferret's reading of whether the claim still holds. */
  readonly state: EvidenceState | undefined;
  /**
   * True when current observations disagree about this fact.
   *
   * Reported, never resolved — EPIC-047 owns that, and Governance §15 forbids
   * discarding either side.
   */
  readonly disputed: boolean;
  readonly citations: readonly AnswerCitation[];
}

/** A subject that matched, when more than one did. */
export interface AnswerCandidate {
  readonly id: string;
  readonly kind: string;
  readonly sourceSystem: string;
  readonly sourceId: string | undefined;
}

export interface AnswerPack {
  readonly formatVersion: number;
  readonly producer: string;
  readonly producerVersion: string;
  readonly builtAt: string;
  readonly question: string;
  /** How the question was read — an entity id, an object id, a path, or prose. */
  readonly shape: QueryShape;
  readonly completeness: AnswerCompleteness;
  /** Why this verdict, in a form a person can check. Ferret's own sentence. */
  readonly reason: string;
  /** The subject answered about, when exactly one was identified. */
  readonly subject: CanonicalEntity | undefined;
  readonly claims: readonly AnswerClaim[];
  /** Populated only for `ambiguous`, and then with every candidate. */
  readonly candidates: readonly AnswerCandidate[];
  /**
   * What Ferret does not know, stated.
   *
   * Empty means nothing was found to be missing. Non-empty is the difference
   * between an answer a client can weight and one it has to trust.
   */
  readonly unknowns: readonly string[];
  /** EPIC-055's plan, verbatim, or `undefined` when no planner is wired. */
  readonly plan: QueryPlan | undefined;
  readonly estimatedTokens: number;
  readonly budget: number;
  readonly contentNotice: string;
  readonly contentSafety: ContentSafetyReport;
}

export interface AnswerRequest {
  readonly question: string;
  /** Estimated tokens the answer may occupy. */
  readonly budget?: number;
}

/** Tokens an answer occupies when the caller does not say. */
export const DEFAULT_ANSWER_BUDGET = 4000;

/** The most an answer may occupy however large a budget is requested. */
export const MAX_ANSWER_BUDGET = 100_000;

/**
 * The most claims an answer states.
 *
 * A file with two hundred observed facts is not better answered by two hundred
 * claims; the bound is reported rather than applied silently.
 */
export const MAX_ANSWER_CLAIMS = 20;

/**
 * The most observations one claim cites.
 *
 * Three rather than one because a claim's second and third records are where a
 * disagreement or a corroboration shows, and rather than five because a claim is
 * one fact and five citations for one fact is a wall, not an explanation.
 */
export const MAX_CITATIONS_PER_CLAIM = 3;

/** Candidates listed for an ambiguous question before the list itself is cut. */
export const MAX_ANSWER_CANDIDATES = 20;

export interface AnswerDependencies {
  readonly retrieval: RetrievalPort;
  readonly evidence: EvidenceReader;
  /**
   * EPIC-055's planner, when one is wired.
   *
   * Optional, and its absence is *reported* rather than worked around: without
   * it an object-id abbreviation cannot be resolved exactly — full-text matches
   * whole words, which `classify` says outright — so the honest answer for that
   * shape is `not-indexed` with an unknown naming the missing strategy, never a
   * ranked approximation.
   */
  readonly planner?: QueryPlanner;
}

export class AnswerPackBuilder {
  readonly #retrieval: RetrievalPort;
  readonly #evidence: EvidenceReader;
  readonly #planner: QueryPlanner | undefined;

  constructor(dependencies: AnswerDependencies) {
    this.#retrieval = dependencies.retrieval;
    this.#evidence = dependencies.evidence;
    this.#planner = dependencies.planner;
  }

  async answer(request: AnswerRequest): Promise<AnswerPack> {
    const question = request.question.trim();
    if (question.length === 0) {
      throw new FerretError(ErrorCode.USAGE, 'An answer needs a question', {
        details: {},
        remediation: 'Pass the question to answer.',
      });
    }

    const budget = Math.min(request.budget ?? DEFAULT_ANSWER_BUDGET, MAX_ANSWER_BUDGET);
    const classification = classify(question);
    const safety = new ContentSafety();

    // Prose first, and refused rather than attempted. `classify` owns this
    // decision; a second heuristic here would be a second place for it to drift.
    if (!classification.exact) {
      return this.#finish({
        question,
        classification,
        completeness: AnswerCompleteness.NOT_ANSWERABLE,
        reason:
          `${classification.reason} An answer pack states claims about one subject, so it ` +
          'cannot answer a question with no single right answer. Use a context pack for this.',
        subject: undefined,
        claims: [],
        candidates: [],
        unknowns: [
          'This question was not answered: it describes rather than identifies, and an ' +
            'answer pack does not rank.',
        ],
        plan: undefined,
        budget,
        safety,
      });
    }

    const { subjects, plan, unknowns: routingUnknowns } = await this.#resolve(question, classification);

    if (subjects.length === 0) {
      return this.#finish({
        question,
        classification,
        completeness: AnswerCompleteness.NOT_INDEXED,
        reason: `Ferret holds nothing identified by ${JSON.stringify(classification.term)}.`,
        subject: undefined,
        claims: [],
        candidates: [],
        unknowns: [
          'Nothing matched. This is an absence in the index, not an empty answer about ' +
            'something Ferret holds.',
          ...routingUnknowns,
        ],
        plan,
        budget,
        safety,
      });
    }

    if (subjects.length > 1) {
      // No claim, deliberately. Answering about the first would be
      // indistinguishable from having decided which one is meant.
      return this.#finish({
        question,
        classification,
        completeness: AnswerCompleteness.AMBIGUOUS,
        reason:
          `${String(subjects.length)} subjects are identified by ` +
          `${JSON.stringify(classification.term)}, and the question has one right answer. ` +
          'Ferret has not chosen between them.',
        subject: undefined,
        claims: [],
        candidates: subjects.slice(0, MAX_ANSWER_CANDIDATES).map(toCandidate),
        unknowns: [
          'No claim is made: which subject the question means is unresolved. Ask again with ' +
            'one of the candidate ids.',
          ...(subjects.length > MAX_ANSWER_CANDIDATES
            ? [
                `${String(subjects.length - MAX_ANSWER_CANDIDATES)} further candidate(s) are not ` +
                  'listed.',
              ]
            : []),
          ...routingUnknowns,
        ],
        plan,
        budget,
        safety,
      });
    }

    const subject = subjects[0];
    if (subject === undefined) throw new Error('unreachable: one subject');

    return await this.#answerAbout(subject, {
      question,
      classification,
      plan,
      routingUnknowns,
      budget,
      safety,
    });
  }

  /**
   * Finds the subject a question identifies, and reports what was not tried.
   *
   * Candidates come from the planner when one is wired, because it owns exact
   * routing and reports each strategy's outcome. Either way every candidate is
   * checked against the identifier — a prefix match on an object id can return
   * several, and a full-text hit can be a *document mentioning* a path rather
   * than the file. `classify` names that trap: "`src/main.ts` is a key, `changes
   * in src/main.ts` is a question about one".
   */
  async #resolve(
    question: string,
    classification: Classification,
  ): Promise<{
    readonly subjects: readonly CanonicalEntity[];
    readonly plan: QueryPlan | undefined;
    readonly unknowns: readonly string[];
  }> {
    // An entity id is Ferret's own key, so it is looked up directly rather than
    // searched: exactly one thing can carry it, and a search would be a slower
    // way to learn the same fact.
    if (classification.shape === QueryShape.ENTITY_ID) {
      const found = await this.#retrieval.getEntity(classification.term);
      return { subjects: found === undefined ? [] : [found], plan: undefined, unknowns: [] };
    }

    if (this.#planner === undefined) {
      const hits = await this.#retrieval.search({ text: classification.term, limit: MAX_ANSWER_CANDIDATES });
      return {
        subjects: identified(hits.map((hit) => hit.entity), classification),
        plan: undefined,
        unknowns: [
          'No query planner is wired, so exact identifier routing did not run. An ' +
            'abbreviated object id cannot be resolved this way.',
        ],
      };
    }

    const planned = await this.#planner.search({ question, limit: MAX_ANSWER_CANDIDATES });
    const unknowns = planned.plan.strategies
      .filter((outcome) => outcome.skipped !== undefined)
      .map((outcome) => `Strategy ${outcome.strategy} did not contribute: ${outcome.skipped ?? ''}`);

    return {
      subjects: identified(planned.hits.map((hit) => hit.entity), classification),
      plan: planned.plan,
      unknowns,
    };
  }

  /**
   * Builds the claims about one subject.
   *
   * One evidence query, ranked once by {@link selectEvidence}, then split into
   * claims by field. Ranking the whole window in one call rather than per field
   * is what makes the *claims* ordered — the best-supported fact first — and it
   * is what makes the `not-current` exclusions real: a superseded observation is
   * set aside against the current record for its own field, which is a judgement
   * only a whole-window view can make.
   */
  async #answerAbout(
    subject: CanonicalEntity,
    context: {
      readonly question: string;
      readonly classification: Classification;
      readonly plan: QueryPlan | undefined;
      readonly routingUnknowns: readonly string[];
      readonly budget: number;
      readonly safety: ContentSafety;
    },
  ): Promise<AnswerPack> {
    const held = await this.#evidence.forSubjectWithState(subject.id, {
      limit: EVIDENCE_CANDIDATE_WINDOW + 1,
    });
    const windowTruncated = held.length > EVIDENCE_CANDIDATE_WINDOW;
    const candidates = held.slice(0, EVIDENCE_CANDIDATE_WINDOW);

    // Limit and per-field cap both set to the window: this call is being used to
    // *rank and judge*, not to bound. The bound belongs to the claim, which is
    // one fact, and applying a pack's bound here would silently drop facts an
    // answer is specifically about.
    const selection = selectEvidence(candidates, {
      limit: candidates.length,
      perField: candidates.length,
      windowTruncated,
    });

    const unknowns: string[] = [];
    const claims = groupIntoClaims(selection.selected, selection.disputedFields, context.safety, unknowns);

    for (const excluded of selection.excluded) {
      unknowns.push(
        `An observation of ${excluded.field === undefined ? 'this subject' : `\`${excluded.field}\``} ` +
          `is not cited: ${excluded.reason}.`,
      );
    }
    if (windowTruncated) {
      unknowns.push(
        `More than ${String(EVIDENCE_CANDIDATE_WINDOW)} observations are held about this subject, so ` +
          'these claims rest on the best of a sample rather than on everything held.',
      );
    }
    for (const field of selection.disputedFields) {
      unknowns.push(
        `Current observations disagree about ${field === '' ? 'this subject' : `\`${field}\``}; ` +
          'Ferret reports both and resolves neither.',
      );
    }

    let stated = claims;
    if (stated.length > MAX_ANSWER_CLAIMS) {
      unknowns.push(
        `${String(stated.length - MAX_ANSWER_CLAIMS)} further claim(s) are not stated: an answer ` +
          `states at most ${String(MAX_ANSWER_CLAIMS)}.`,
      );
      stated = stated.slice(0, MAX_ANSWER_CLAIMS);
    }

    // Cheapest honest budget rule: drop the lowest-ranked claims until it fits,
    // and say how many. Trimming a *statement* is not available here for the
    // reason the pack gives — a half-quoted observation is a misquotation.
    const contained = containAttributes(subject.attributes, context.safety);
    const subjectView: CanonicalEntity = { ...subject, attributes: contained };
    let dropped = 0;
    while (stated.length > 0 && estimateJsonTokens({ subject: subjectView, claims: stated }) > context.budget) {
      stated = stated.slice(0, -1);
      dropped += 1;
    }
    if (dropped > 0) {
      unknowns.push(
        `${String(dropped)} claim(s) did not fit in ${String(context.budget)} estimated tokens.`,
      );
    }

    if (candidates.length === 0) {
      unknowns.push(
        'Ferret holds this subject but no evidence about it, so nothing here is cited.',
      );
    }
    // A claim nothing supports is the one a reader most needs warning about, and
    // it is the one least likely to look different from a supported one.
    for (const claim of stated) {
      if (claim.citations.length > 0) continue;
      unknowns.push(
        `The claim about ${claim.field === undefined ? 'this subject' : `\`${claim.field}\``} is ` +
          'unsupported: no observation is cited for it.',
      );
    }

    const partial =
      context.plan?.partial === true ||
      windowTruncated ||
      dropped > 0 ||
      claims.length > MAX_ANSWER_CLAIMS ||
      candidates.length === 0 ||
      context.routingUnknowns.length > 0 ||
      // A dispute makes the verdict partial even though nothing is missing.
      // Ferret holds both sides and cannot say which holds, and `answered` on a
      // fact it cannot settle is certainty manufactured at the verdict — the
      // level a client is least likely to look past. Governance §6.
      selection.disputedFields.length > 0 ||
      stated.some((claim) => claim.citations.length === 0);

    return this.#finish({
      question: context.question,
      classification: context.classification,
      completeness: partial ? AnswerCompleteness.PARTIAL : AnswerCompleteness.ANSWERED,
      reason:
        `${JSON.stringify(context.classification.term)} identifies exactly one ${subject.kind}, and ` +
        `${String(stated.length)} claim(s) about it are supported by recorded observations` +
        (partial ? '. Something is missing or unresolved — see `unknowns`.' : '.'),
      subject: subjectView,
      claims: stated,
      candidates: [],
      unknowns: [...unknowns, ...context.routingUnknowns],
      plan: context.plan,
      budget: context.budget,
      safety: context.safety,
    });
  }

  #finish(parts: {
    readonly question: string;
    readonly classification: Classification;
    readonly completeness: AnswerCompleteness;
    readonly reason: string;
    readonly subject: CanonicalEntity | undefined;
    readonly claims: readonly AnswerClaim[];
    readonly candidates: readonly AnswerCandidate[];
    readonly unknowns: readonly string[];
    readonly plan: QueryPlan | undefined;
    readonly budget: number;
    readonly safety: ContentSafety;
  }): AnswerPack {
    return Object.freeze({
      formatVersion: ANSWER_FORMAT_VERSION,
      producer: 'ferret.context.answer',
      producerVersion: VERSION,
      builtAt: new Date().toISOString(),
      question: parts.question,
      shape: parts.classification.shape,
      completeness: parts.completeness,
      reason: parts.reason,
      subject: parts.subject,
      claims: Object.freeze([...parts.claims]),
      candidates: Object.freeze([...parts.candidates]),
      unknowns: Object.freeze([...parts.unknowns]),
      plan: parts.plan,
      estimatedTokens: estimateJsonTokens({
        subject: parts.subject,
        claims: parts.claims,
        candidates: parts.candidates,
        unknowns: parts.unknowns,
      }),
      budget: parts.budget,
      contentNotice: CONTENT_NOTICE,
      contentSafety: parts.safety.report,
    });
  }
}

/**
 * Keeps only entities the identifier actually names.
 *
 * The guard that separates an answer from a coincidence. `byIdentifier` matches
 * an object id by *prefix* and a full-text fallback matches anything mentioning
 * the term, so without this a question about `src/parser.ts` could be answered
 * with a commit message that discusses it. The fields checked are the same four
 * `storage/retrieval.ts` matches on, so the rule is one rule rather than two
 * that can disagree.
 */
function identified(
  entities: readonly CanonicalEntity[],
  classification: Classification,
): readonly CanonicalEntity[] {
  const term = classification.term.toLowerCase();
  const seen = new Set<string>();
  const kept: CanonicalEntity[] = [];

  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    if (!namesIt(entity, classification, term)) continue;
    seen.add(entity.id);
    kept.push(entity);
  }

  // Narrowed to the candidates the term *is the identity of*, when there are
  // any, rather than the ones that merely carry it.
  //
  // Found by dogfooding: `src/context/pack.ts` came back `ambiguous` with three
  // candidates — the `file`, and two `file_version` rows for blobs of it. All
  // three carry that path as an attribute, so all three were "identified by" it,
  // and the answer was technically true and useless. Nobody asking about a file
  // means "choose between this file and two of its historical blobs".
  //
  // The distinction is in the data rather than in a list of kinds: the file's own
  // source identity *is* the path, while a version's is `git-blob:<sha>`. So this
  // narrows by identity, not by kind — which also settles the object-id case,
  // where a full sha names the commit itself and should not be made ambiguous by
  // anything whose `sha` attribute merely starts with it. An abbreviation matches
  // nothing exactly, so it stays ambiguous, which is correct.
  const identity = kept.filter(
    (entity) => entity.id.toLowerCase() === term || entity.source.id.toLowerCase() === term,
  );
  return identity.length > 0 ? identity : kept;
}

function namesIt(entity: CanonicalEntity, classification: Classification, term: string): boolean {
  if (entity.id.toLowerCase() === term) return true;

  if (classification.shape === QueryShape.PATH) {
    // Exact, not prefix: `src/` would otherwise name every file beneath it,
    // which is a different question with a different answer.
    return attribute(entity, 'path')?.toLowerCase() === term;
  }

  if (classification.shape === QueryShape.OBJECT_ID) {
    const sha = attribute(entity, 'sha')?.toLowerCase();
    return (
      entity.source.id.toLowerCase().startsWith(term) || (sha !== undefined && sha.startsWith(term))
    );
  }

  return false;
}

function attribute(entity: CanonicalEntity, key: string): string | undefined {
  const value = entity.attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function toCandidate(entity: CanonicalEntity): AnswerCandidate {
  return Object.freeze({
    id: entity.id,
    kind: entity.kind,
    sourceSystem: entity.source.system,
    sourceId: entity.source.id,
  });
}

/**
 * Splits ranked evidence into one claim per fact.
 *
 * Order is inherited rather than recomputed: the records arrive ranked, so the
 * field of the first record is the best-supported fact and becomes the first
 * claim. The claim's statement is its top record's — the most believed, most
 * authoritative observation of that fact — and the rest of its records are its
 * citations, up to the bound.
 */
function groupIntoClaims(
  selected: readonly SelectedEvidence[],
  disputedFields: readonly string[],
  safety: ContentSafety,
  unknowns: string[],
): readonly AnswerClaim[] {
  const byField = new Map<string, SelectedEvidence[]>();
  for (const entry of selected) {
    const key = entry.evidence.field ?? '';
    const list = byField.get(key) ?? [];
    list.push(entry);
    byField.set(key, list);
  }

  const disputed = new Set(disputedFields);
  const claims: AnswerClaim[] = [];

  for (const [key, entries] of byField) {
    const best = entries[0];
    if (best === undefined) continue;

    if (entries.length > MAX_CITATIONS_PER_CLAIM) {
      unknowns.push(
        `${String(entries.length - MAX_CITATIONS_PER_CLAIM)} further observation(s) of ` +
          `${key === '' ? 'this subject' : `\`${key}\``} are held and not cited: a claim cites at ` +
          `most ${String(MAX_CITATIONS_PER_CLAIM)}.`,
      );
    }

    claims.push(
      Object.freeze({
        field: best.evidence.field,
        statement: containStatement(best.evidence.statement, safety),
        state: best.state,
        disputed: disputed.has(key),
        citations: Object.freeze(entries.slice(0, MAX_CITATIONS_PER_CLAIM).map(toCitation)),
      }),
    );
  }

  return claims;
}

/**
 * Wraps a claim's statement, unconditionally when it is a string.
 *
 * **Not** `containAttributes`. That draws its line at *prose* — wrapping by key
 * name or by length — and the reasoning it gives is sound where it is applied: "a
 * client that compares `attributes.path` to a file it knows about would find
 * every comparison fail", and a symbol name is a token rather than a sentence.
 *
 * A claim statement is neither of those things. It is repository-authored content
 * in the most trusted position Ferret has — the *answer*, handed to a model as
 * Ferret's own finding — and nothing compares a claim statement to a known value,
 * so the matchability cost that justifies the attribute heuristic does not exist
 * here. Found by the integration test: a 110-character injection attempt was
 * marked and not wrapped, because it was short and `statement` is not a prose
 * attribute name.
 *
 * A non-string statement is classified rather than wrapped: wrapping would change
 * its type, and a number or a boolean cannot carry an instruction. A structured
 * statement has its top-level strings wrapped, which is what `containAttributes`
 * is for.
 */
function containStatement(statement: unknown, safety: ContentSafety): unknown {
  if (typeof statement === 'string') return safety.contain(statement);
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
    return statement;
  }
  return containAttributes(statement as Readonly<Record<string, unknown>>, safety);
}

function toCitation(entry: SelectedEvidence): AnswerCitation {
  const record = entry.evidence;
  return Object.freeze({
    evidenceId: record.id,
    method: record.method,
    producer: record.producer,
    producerVersion: record.producerVersion,
    sourceSystem: record.sourceSystem,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    locator: record.locator,
    authority: record.authority,
    integrityHash: record.integrityHash,
    reason: entry.reason,
  });
}

/**
 * Renders an answer for a client that wants text rather than structure.
 *
 * The notice comes first, before any indexed content, because a model reads in
 * order and an instruction that arrives after the content it governs has already
 * lost. Statements stay quoted by `JSON.stringify`, as they are in a pack.
 */
export function renderAnswer(pack: AnswerPack): string {
  const lines = [
    `# Ferret answer`,
    `question: ${JSON.stringify(pack.question)}`,
    `read as: ${pack.shape}`,
    `verdict: ${pack.completeness} — ${pack.reason}`,
    `built: ${pack.builtAt} by ${pack.producer}@${pack.producerVersion}`,
    ``,
    `> ${pack.contentNotice}`,
    ``,
  ];

  if (pack.subject !== undefined) {
    lines.push(`## subject`);
    lines.push(`${pack.subject.kind} ${pack.subject.id}`);
    lines.push(`source: ${pack.subject.source.system}:${JSON.stringify(pack.subject.source.id)}`);
    lines.push('');
  }

  if (pack.claims.length > 0) lines.push(`## claims`);
  for (const [index, claim] of pack.claims.entries()) {
    lines.push(
      `${String(index + 1)}. ${claim.field ?? '(the subject)'} = ${JSON.stringify(claim.statement)}` +
        ` [${claim.state ?? 'state not assessed'}${claim.disputed ? ', DISPUTED' : ''}]`,
    );
    for (const citation of claim.citations) {
      lines.push(
        `   cited: ${citation.method} by ${citation.producer}@${citation.producerVersion} ` +
          `from ${citation.sourceSystem} — ${citation.reason}`,
      );
    }
    if (claim.citations.length === 0) lines.push(`   cited: nothing — this claim is unsupported`);
  }
  if (pack.claims.length > 0) lines.push('');

  if (pack.candidates.length > 0) {
    lines.push(`## candidates`);
    for (const candidate of pack.candidates) {
      lines.push(`- ${candidate.kind} ${candidate.id} (${candidate.sourceSystem}:${candidate.sourceId ?? '?'})`);
    }
    lines.push('');
  }

  if (pack.plan !== undefined) {
    lines.push(`## how this was routed`);
    lines.push(`shape ${pack.plan.shape}; ${pack.plan.reason}`);
    for (const outcome of pack.plan.strategies) {
      lines.push(
        `- ${outcome.strategy}: ${outcome.ran ? `returned ${String(outcome.returned)}` : 'did not run'}` +
          `${outcome.skipped === undefined ? '' : ` — ${outcome.skipped}`}`,
      );
    }
    lines.push('');
  }

  lines.push(`## what Ferret does not know`);
  if (pack.unknowns.length === 0) lines.push('- nothing was found to be missing');
  for (const unknown of pack.unknowns) lines.push(`- ${unknown}`);
  lines.push('');
  lines.push(`estimated ${String(pack.estimatedTokens)} of ${String(pack.budget)} tokens`);

  return lines.join('\n');
}
