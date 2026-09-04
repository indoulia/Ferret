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
  /**
   * Values examined at all — F-64.
   *
   * The count the report was missing, and the reason it could lie. Before this,
   * `marked: 0` meant either "nothing read as an instruction" or "nothing was
   * looked at", and a client had no way to tell which. An array element, a
   * nested object's field and an `unknownFields` value were all the second, and
   * the report affirmed safety about content it had never seen.
   *
   * `inspected >= contained + (values marked but not wrapped)` by construction,
   * so a client can check the report against itself.
   */
  readonly inspected: number;
  /**
   * Subtrees serialized whole because they were deeper than the walk goes.
   *
   * Contained, so they are still inert; counted, so a structure built to
   * outrun the traversal is visible rather than silently flattened.
   */
  readonly depthLimited: number;
  /** Which classifier signals fired anywhere in this response. */
  readonly signals: readonly string[];
}

export const NO_CONTENT_SAFETY: ContentSafetyReport = Object.freeze({
  contained: 0,
  marked: 0,
  neutralised: 0,
  inspected: 0,
  depthLimited: 0,
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
  #inspected = 0;
  #depthLimited = 0;
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
    this.#inspected += 1;
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
    this.#inspected += 1;
    const verdict = classifyInstructionShape(value);
    if (verdict.instructionShaped) {
      this.#marked += 1;
      for (const signal of verdict.signals) this.#signals.add(signal);
    }
    return verdict;
  }

  /**
   * Contains a subtree the walk will not descend into, and says so.
   *
   * Reached at {@link MAX_CONTAIN_DEPTH} or on a cycle. Serializing and
   * wrapping is the honest option of the three available: passing the subtree
   * through would leave untrusted values outside the boundary, which is the
   * defect F-64 names; dropping it would make Ferret's answer disagree with the
   * record, which Governance §6 forbids. This keeps every byte, inert.
   */
  containSubtree(value: unknown): string {
    this.#depthLimited += 1;
    return this.contain(serializeSafely(value));
  }

  get report(): ContentSafetyReport {
    return {
      contained: this.#contained,
      marked: this.#marked,
      neutralised: this.#neutralised,
      inspected: this.#inspected,
      depthLimited: this.#depthLimited,
      // Sorted so two runs over the same response compare equal.
      signals: [...this.#signals].sort(),
    };
  }
}

/** `JSON.stringify` that cannot throw, for a value of unknown provenance. */
function serializeSafely(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Attribute names always treated as prose, whatever their value looks like.
 *
 * Kept as a trigger rather than as *the* trigger. Since F-64 the decision is
 * made by shape (see {@link isProse}), and every real value of these keys is
 * prose-shaped anyway — but a one-word `title` or a `summary` with no space in
 * it is still a field a repository writes freely, and containing it costs
 * nothing a client wanted.
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
 * Length past which any string is treated as prose.
 *
 * The backstop for a single-token value too long to be an identifier anybody
 * compares — a base64 blob, a minified line, a stack trace with no spaces.
 */
const PROSE_LENGTH = 200;

/**
 * Whether a value can carry a sentence.
 *
 * **This is the instruction/data boundary, and it is drawn by shape.** EPIC-084
 * drew it by *key name*, which was right for the values it could see and wrong
 * the moment containment reached further: recursing into `emails`, into
 * `profile.bio`, into an edge's `metadata` and into `unknownFields` arrives at
 * leaves whose keys this file has never heard of, so a key-name test fails
 * exactly where the new reach was needed. F-64's array elements would have been
 * *visited* and still not wrapped.
 *
 * An injection needs sentences. A path, an object id, a symbol name, an email
 * address, a handle and a timestamp have no whitespace; a paragraph telling a
 * model to ignore its instructions cannot avoid it. So whitespace is the test,
 * and the cost EPIC-084 reasoned about is still paid only where it was worth
 * paying: `attributes.path` of `src/context/pack.ts` stays comparable to the
 * file a client knows about, and a *filename written as a sentence* — which
 * Governance §12 treats as untrusted like any other repository byte — does not.
 *
 * This is the same rule `containStatement` reached independently on the answer
 * surface, for the same reason. Two surfaces disagreeing about where content
 * starts is the same defect as having no boundary at all, so there is now one
 * rule rather than two.
 */
function isProse(value: string, key: string | undefined): boolean {
  if (key !== undefined && PROSE_ATTRIBUTES.has(key)) return true;
  if (value.length > PROSE_LENGTH) return true;
  return /\s/.test(value);
}

/**
 * How deep the walk descends before it contains a subtree whole.
 *
 * A bound rather than unbounded recursion, because the shape being walked came
 * from a source: `unknownFields` is provider JSON that nothing validates, and a
 * structure nested a thousand deep is a cheap way to spend a stack. Eight is
 * past anything the canonical model produces — the deepest real path is an
 * entity's attributes, an object, an array, a leaf.
 */
export const MAX_CONTAIN_DEPTH = 8;

/**
 * Contains every untrusted value reachable from `value`, at any depth.
 *
 * **F-64's fix, and the shape of the defect is worth keeping in view.** The old
 * traversal was one loop over `Object.entries` that did `continue` on anything
 * that was not a string. So `emails: ['<an injection>']` — an array populated
 * from a commit author field, which is to say by anyone who can push — went
 * through untouched *and uncounted*, and `contentSafety` then reported that
 * nothing had read as an instruction. A boundary with a hole in it plus a report
 * that affirms it is worse than no boundary, because the report is what a client
 * weights an answer on.
 *
 * Arrays inherit the key that named them, so `emails: [...]` polices each
 * element as an `emails` value; a nested object's fields are policed under their
 * own keys. Numbers, booleans and null pass through: containment wraps text, and
 * a boolean cannot carry an instruction.
 *
 * The input is never mutated — it came from a store that may be handing the same
 * frozen object to another caller.
 */
export function containUntrusted(value: unknown, safety: ContentSafety, key?: string): unknown {
  return walk(value, safety, key, 0, new Set<object>());
}

function walk(
  value: unknown,
  safety: ContentSafety,
  key: string | undefined,
  depth: number,
  seen: Set<object>,
): unknown {
  if (typeof value === 'string') {
    if (isProse(value, key)) return safety.contain(value);
    // Marked but not wrapped: a symbol named `ignorePreviousInstructions` is
    // worth reporting and is not worth making unmatchable.
    safety.mark(value);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;

  // A cycle cannot come out of JSONB, but it can come out of a provider holding
  // objects in memory, and a stack overflow inside the security boundary is the
  // boundary failing.
  if (seen.has(value)) return safety.containSubtree('[circular]');
  if (depth >= MAX_CONTAIN_DEPTH) return safety.containSubtree(value);

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((element) => walk(element, safety, key, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = walk(childValue, safety, childKey, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Contains one entity's attributes, at every depth.
 *
 * Kept as a named function because it is what the surfaces call, and because
 * the return type says what a caller may do with it.
 */
export function containAttributes(
  attributes: Readonly<Record<string, unknown>>,
  safety: ContentSafety,
): Record<string, unknown> {
  return containUntrusted(attributes, safety) as Record<string, unknown>;
}

/**
 * Contains **every** untrusted part of an entity, not only its attributes.
 *
 * The second half of F-64, found by re-auditing the first. Four surfaces
 * emitted an entity as `{ ...entity, attributes: containAttributes(...) }`,
 * which contains one field and hands over the other two: `unknownFields` is
 * source data retained verbatim and *never validated* — the widest untrusted
 * surface an entity has — and `externalIds` is source-supplied too. Both went
 * straight to a model outside the boundary, and neither was counted.
 *
 * So containment for an entity is one function rather than a line each surface
 * writes for itself. A surface cannot forget a field it does not name.
 */
export function containEntityContent<
  T extends {
    readonly attributes: Readonly<Record<string, unknown>>;
    readonly unknownFields?: Readonly<Record<string, unknown>>;
    readonly externalIds?: readonly unknown[];
  },
>(entity: T, safety: ContentSafety): T {
  return {
    ...entity,
    attributes: containAttributes(entity.attributes, safety),
    ...(entity.unknownFields === undefined
      ? {}
      : { unknownFields: containAttributes(entity.unknownFields, safety) }),
    ...(entity.externalIds === undefined
      ? {}
      : { externalIds: containUntrusted(entity.externalIds, safety) as readonly unknown[] }),
  };
}

/**
 * The fields of an observation whose text a *source* wrote.
 *
 * Found by re-auditing F-64's fix, and it is the wider half of the finding.
 * `statement` was the obvious one; `field`, `locator`, `sourceUrl` and the
 * producer identity are all `z.string()` on the evidence schema, which is to
 * say a provider supplies them and nothing constrains their shape. EPIC-074
 * just made writing a provider a supported thing to do, so "no provider does
 * this today" is a statement about the providers that exist rather than about
 * the boundary.
 *
 * Enumerated rather than "every field", because the rest of a record is
 * Ferret's own account of how it came to believe something — an authority
 * number, an observation instant, an integrity hash — and wrapping a hash would
 * break the one field whose entire purpose is to be compared.
 */
const SOURCE_AUTHORED_EVIDENCE_FIELDS = [
  'field',
  'statement',
  'locator',
  'sourceUrl',
  'sourceId',
  'sourceSystem',
  'producer',
  'producerVersion',
] as const;

/**
 * Contains the source-authored text of one observation, leaving Ferret's own
 * record of it alone.
 *
 * **Why a view and not the record.** `integrityHashOf` is computed over the
 * record as stored, and a surface that verifies integrity must do so against
 * the record rather than against what it is about to print — so containment
 * produces a *view* here, and every caller keeps the original to verify from.
 * That is the pattern `ferret_why` has used since EPIC-048; this makes it the
 * rule rather than one surface's habit.
 *
 * Token-shaped values pass through identical, which is what makes the
 * enumeration safe to widen: containing `producer` costs nothing when it is
 * `ferret.source.git` and matters when it is a sentence.
 */
export function containEvidenceContent<T extends object>(record: T, safety: ContentSafety): T {
  const out = { ...record } as Record<string, unknown>;
  for (const key of SOURCE_AUTHORED_EVIDENCE_FIELDS) {
    if (!(key in out)) continue;
    out[key] = containUntrusted(out[key], safety, key);
  }
  // The cast is sound for the fields walked: containment maps a string to a
  // string and an object to an object of the same shape. It never changes a
  // value's type, which is the property that makes a view substitutable for the
  // record everywhere but integrity.
  return out as T;
}

/**
 * Whether a string is a whole contained region.
 *
 * Used by the transformations that run *after* containment, which is where F-32
 * lived: they cannot tell a wrapped value from an ordinary one without asking.
 */
export function isContained(value: string): boolean {
  return (
    value.length >= CONTENT_OPEN.length + CONTENT_CLOSE.length &&
    value.startsWith(CONTENT_OPEN) &&
    value.endsWith(CONTENT_CLOSE)
  );
}

/**
 * Shortens a value without breaking its fence — F-32.
 *
 * The defect this replaces was one `slice`. `ContextPackBuilder` contained an
 * attribute and then, when the budget did not fit, sliced the already-wrapped
 * string: the opening delimiter survived at the front and the closing one was
 * cut off the end, so every field after the trimmed one — including Ferret's own
 * `reason` and `omitted` — fell inside a region the notice had told the model to
 * read as quoted repository data. `contentSafety.marked` still fired, so the
 * smell was reported while the mechanism was broken.
 *
 * The cut is made in the **payload**, and the fence is re-applied around what
 * remains. `marker` is Ferret's own sentence about the cut and is placed
 * *outside* the closing delimiter, because it is not part of the quotation: a
 * note from Ferret inside the fence would be the same category error in the
 * other direction.
 */
export function truncateContained(value: string, keep: number, marker: string): string {
  if (!isContained(value)) {
    return value.length <= keep ? value : `${value.slice(0, keep)}${marker}`;
  }
  const payload = value.slice(CONTENT_OPEN.length, value.length - CONTENT_CLOSE.length);
  if (payload.length <= keep) return value;
  return `${CONTENT_OPEN}${payload.slice(0, keep)}${CONTENT_CLOSE}${marker}`;
}

/**
 * Whether every region a text opens is also closed, in order.
 *
 * The invariant a fence *is*. `contain` guarantees it per value, but a response
 * is built by many transformations after that — trimming, rendering,
 * serialization — and F-32 was one of them slicing an already-wrapped string and
 * cutting the close off the end. The property survives none of those on trust,
 * so it is checkable over arbitrary emitted text: scan for either delimiter and
 * require strict alternation, opening first and closing last.
 *
 * Deliberately a predicate rather than an assertion. Turning a boundary defect
 * into a thrown error would replace a wrong answer with an outage; what this is
 * for is proving the boundary in a test, at the layer a client reads.
 */
export function delimitersBalanced(text: string): boolean {
  let at = 0;
  let open = false;
  for (;;) {
    const nextOpen = text.indexOf(CONTENT_OPEN, at);
    const nextClose = text.indexOf(CONTENT_CLOSE, at);
    if (nextOpen === -1 && nextClose === -1) return !open;
    const closeFirst = nextOpen === -1 || (nextClose !== -1 && nextClose < nextOpen);
    if (closeFirst) {
      if (!open) return false;
      open = false;
      at = nextClose + CONTENT_CLOSE.length;
      continue;
    }
    if (open) return false;
    open = true;
    at = nextOpen + CONTENT_OPEN.length;
  }
}

/**
 * How many occurrences of `needle` in `text` lie outside a content fence.
 *
 * The question F-64 asked and nothing could answer: not "was containment
 * called" but "did any untrusted byte escape it". Counting rather than
 * returning a boolean so a partial fix — three of four array elements wrapped —
 * reads as a number instead of as `true`.
 *
 * Zero is also the answer for text with no fences at all and no needle, so a
 * caller asserting on it should be sure the needle is present somewhere.
 */
export function outsideFences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let escaped = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    if (!insideFence(text, at)) escaped += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return escaped;
}

/** Whether an offset falls between an opening delimiter and its close. */
function insideFence(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const lastOpen = before.lastIndexOf(CONTENT_OPEN);
  if (lastOpen === -1) return false;
  return before.lastIndexOf(CONTENT_CLOSE) < lastOpen;
}
