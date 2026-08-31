/**
 * Making repository content structurally unable to act as instruction — EPIC-084.
 *
 * Governance §12 has always required that "prompt-injection content inside
 * indexed sources must not override Ferret configuration or security controls".
 * Until EPIC-108 that rule had almost nothing to govern: no repository content
 * reached production. It does now — a symbol's `documentation` is comment text
 * copied out of a file and handed to an AI client — so the rule needs a
 * mechanism rather than a sentence.
 *
 * Three things here, and the distinction between them is the design:
 *
 * **Containment** puts a boundary around content that the content cannot forge.
 * **Classification** says a value looks like an instruction. It never removes it.
 * **The notice** tells the model both, so it is given a mechanism and not only a
 * rule.
 *
 * What this does *not* do is make a client obey. Ferret cannot reach into a
 * model's reasoning; it can make the boundary unambiguous and the marking
 * machine-readable, and then say plainly that the rest is not in its gift.
 * Claiming more would be the same manufactured certainty Governance §6 forbids.
 */

/**
 * The boundary repository text is emitted inside.
 *
 * Long, unlikely, and — the part that matters — *neutralised when it occurs in
 * the content*, so a file cannot close its own container by containing this
 * string. A delimiter that could be forged is decoration.
 *
 * `U+2402 SYMBOL FOR START OF TEXT` rather than a bare ASCII run: it is
 * printable, so a person reading a response can see the boundary, and it does
 * not collide with any comment syntax a source file uses.
 */
export const CONTENT_OPEN = '␂ferret:content␂';
export const CONTENT_CLOSE = '␃ferret:content␃';

/** What is written in place of a delimiter found inside content. */
const NEUTRALISED = '[delimiter removed]';

/** Characters of a field examined when classifying. */
export const CLASSIFY_WINDOW = 4096;

export interface ContainedValue {
  /** The value, wrapped so its boundary cannot be forged. */
  readonly text: string;
  /** Delimiter occurrences neutralised. Reported rather than hidden. */
  readonly neutralised: number;
}

/**
 * Wraps repository text so a reader can tell exactly where it starts and stops.
 *
 * Any occurrence of either delimiter inside the value is replaced first, and the
 * count is returned. Replacing rather than escaping is deliberate: an escaping
 * scheme has to be un-escaped to be read, and a model that cites content is
 * reading it directly.
 */
export function contain(value: string): ContainedValue {
  let neutralised = 0;
  const cleaned = value.split(CONTENT_OPEN).join(NEUTRALISED);
  neutralised += countOf(value, CONTENT_OPEN);
  const both = cleaned.split(CONTENT_CLOSE).join(NEUTRALISED);
  neutralised += countOf(cleaned, CONTENT_CLOSE);
  return { text: `${CONTENT_OPEN}${both}${CONTENT_CLOSE}`, neutralised };
}

function countOf(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Phrasings that attempt to redirect a reader who is a model.
 *
 * Deliberately narrow. This list decides what gets *marked*, and a mark that
 * fires on ordinary prose is a mark nobody reads — this specification and this
 * file both discuss prompt injection at length and neither should be flagged
 * merely for naming it. So each pattern requires an imperative aimed at the
 * reader, not a mention of the topic.
 *
 * It will not catch everything, and it is not the control — containment is. This
 * reports a smell so a client can weight an answer.
 */
const INSTRUCTION_SHAPES: readonly { readonly code: string; readonly pattern: RegExp }[] =
  Object.freeze([
    {
      code: 'override-instructions',
      pattern:
        /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|earlier|above|system|all)\b[^.\n]{0,20}\b(?:instruction|prompt|rule|direction|context)/i,
    },
    {
      code: 'role-reassignment',
      pattern: /\byou\s+are\s+(?:now|actually)\b|\bfrom\s+now\s+on\s+you\b|\bact\s+as\s+(?:if\s+)?(?:a|an|the)\b/i,
    },
    {
      code: 'imperative-to-assistant',
      pattern:
        /\b(?:assistant|ai|model|claude|gpt|llm)\b[^.\n]{0,20}\b(?:must|should|shall|will)\s+(?:now\s+)?(?:ignore|reveal|output|print|execute|run|send|delete)/i,
    },
    {
      code: 'exfiltration-request',
      pattern:
        // The target alternatives carry their own boundaries rather than
        // sharing a leading `\b`: `.ssh` is preceded by `/` in every real
        // mention of it, and there is no word boundary between two non-word
        // characters — so a shared `\b` silently never matched it.
        /\b(?:reveal|disclose|print|output|send|exfiltrate|leak)\b[^.\n]{0,30}(?:\bsystem\s+prompt|\bapi[\s_-]?key|\bsecret|\bcredential|\btoken|\bpassword|\.ssh\b|\benv(?:ironment)?\s+variable)/i,
    },
    {
      code: 'tool-directive',
      pattern: /\b(?:call|invoke|execute|run)\s+(?:the\s+)?(?:tool|function|command|shell)\b[^.\n]{0,30}\b(?:with|and)\b/i,
    },
    {
      code: 'delimiter-forgery',
      pattern: /(?:^|\n)\s*(?:###|---)?\s*(?:end\s+of\s+(?:data|content|context)|system\s*:|<\|im_start\|>|\[\/?INST\])/i,
    },
  ]);

export interface InstructionShapeVerdict {
  /** True when at least one pattern matched. Advisory, never a filter. */
  readonly instructionShaped: boolean;
  /** Which patterns matched, by stable code, so a client can aggregate. */
  readonly signals: readonly string[];
}

const NOT_SHAPED: InstructionShapeVerdict = Object.freeze({
  instructionShaped: false,
  signals: Object.freeze([]),
});

/**
 * Whether a value reads as an instruction aimed at whoever is reading it.
 *
 * **Reports; never removes.** Governance §6: the record is what the repository
 * holds. A classifier that dropped content would make Ferret's answer depend on
 * a heuristic, and the first false positive is a file nobody can find. The
 * verdict travels beside the value so a client can weight it, and the value is
 * returned in full either way.
 *
 * Bounded to {@link CLASSIFY_WINDOW} characters, so cost is a property of what
 * is returned rather than of what a repository contains.
 */
export function classifyInstructionShape(value: string): InstructionShapeVerdict {
  if (value.length === 0) return NOT_SHAPED;
  const window = value.length > CLASSIFY_WINDOW ? value.slice(0, CLASSIFY_WINDOW) : value;

  const signals: string[] = [];
  for (const shape of INSTRUCTION_SHAPES) {
    if (shape.pattern.test(window)) signals.push(shape.code);
  }
  if (signals.length === 0) return NOT_SHAPED;
  return { instructionShaped: true, signals };
}

/** What containment and classification did to one response. */
export interface ContentSafetyReport {
  /** Fields wrapped in the content delimiter. */
  readonly contained: number;
  /** Fields whose text reads as an instruction. Reported, never filtered. */
  readonly marked: number;
  /** Delimiter occurrences neutralised inside content. */
  readonly neutralised: number;
  /** Which classifier signals fired anywhere in this response. */
  readonly signals: readonly string[];
}

export const NO_CONTENT_SAFETY: ContentSafetyReport = Object.freeze({
  contained: 0,
  marked: 0,
  neutralised: 0,
  signals: Object.freeze([]),
});

/**
 * Accumulates a {@link ContentSafetyReport} while a response is built.
 *
 * A builder rather than a pure function because containment happens field by
 * field as a response is assembled, and the report has to describe all of it.
 */
export class ContentSafety {
  #contained = 0;
  #marked = 0;
  #neutralised = 0;
  readonly #signals = new Set<string>();

  /**
   * Contains one repository-authored value and records what that took.
   *
   * Returns the wrapped text. The caller substitutes it for the raw value; the
   * value's *meaning* is unchanged, which is what makes a quote still a quote.
   */
  contain(value: string): string {
    const result = contain(value);
    this.#contained += 1;
    this.#neutralised += result.neutralised;

    const verdict = classifyInstructionShape(value);
    if (verdict.instructionShaped) {
      this.#marked += 1;
      for (const signal of verdict.signals) this.#signals.add(signal);
    }
    return result.text;
  }

  /** Classifies without containing, for a value emitted somewhere structural. */
  mark(value: string): InstructionShapeVerdict {
    const verdict = classifyInstructionShape(value);
    if (verdict.instructionShaped) {
      this.#marked += 1;
      for (const signal of verdict.signals) this.#signals.add(signal);
    }
    return verdict;
  }

  get report(): ContentSafetyReport {
    return {
      contained: this.#contained,
      marked: this.#marked,
      neutralised: this.#neutralised,
      // Sorted so two runs over the same response compare equal.
      signals: [...this.#signals].sort(),
    };
  }
}

/**
 * Attribute names whose values are free prose written in a repository.
 *
 * Containment is applied here and not to every string, and the line is drawn at
 * *prose*. An injection needs sentences; a path and a symbol name are tokens. And
 * wrapping them has a real cost — a client that compares `attributes.path` to a
 * file it knows about would find every comparison fail, which is a defect
 * introduced in the name of a control that was never protecting anything there.
 *
 * Classification still runs over every string, because marking is free and
 * changes nothing about the value.
 */
const PROSE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'documentation',
  'signature',
  'message',
  'body',
  'subject',
  'summary',
  'title',
  'text',
  'description',
  'highlight',
  'classificationReason',
]);

/**
 * Length past which any string attribute is treated as prose.
 *
 * A backstop for a field this file has never heard of. A new entity kind with a
 * new free-text attribute should be contained by default rather than wait for
 * someone to remember to add it here — failing towards containment is the safe
 * direction, and the only cost is a wrapped value that did not need it.
 */
const PROSE_LENGTH = 200;

/**
 * Contains the prose in one entity's attributes and marks the rest.
 *
 * Returns a new attribute record; the input is never mutated, because it came
 * from a store that may be handing the same frozen object to another caller.
 */
export function containAttributes(
  attributes: Readonly<Record<string, unknown>>,
  safety: ContentSafety,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (PROSE_ATTRIBUTES.has(key) || value.length > PROSE_LENGTH) {
      out[key] = safety.contain(value);
      continue;
    }
    // Marked but not wrapped: a symbol named `ignorePreviousInstructions` is
    // worth reporting and is not worth making unmatchable.
    safety.mark(value);
    out[key] = value;
  }
  return out;
}
