import { redactSecrets } from '../security/index.js';

import {
  MemoryKind,
  MemoryOrigin,
  createEngineeringMemory,
  type EngineeringMemory,
} from './engineering-memory.js';
import { SessionCaptureKind, type SessionCapture } from './session-capture.js';

/**
 * Finding the memories a session already stated.
 *
 * The central decision of EPIC-042, and it is deliberately unambitious: a
 * statement becomes a memory when it is **marked**, or when it matches one of a
 * small set of high-precision phrasings. Nothing else is extracted.
 *
 * A rule that fires on "I think we should probably use Postgres" records a
 * decision that was never made, and a knowledge base containing one such entry
 * cannot be trusted for any of them. A missed memory costs a re-derivation; a
 * fabricated one costs the credibility of the whole store. Where those two are
 * in tension this errs, every time, towards missing one.
 */

export interface MemoryMarker {
  /** The literal prefix, matched case-insensitively at the start of a line. */
  readonly marker: string;
  readonly kind: MemoryKind;
}

/** Markers a client or a person writes deliberately. */
export const MEMORY_MARKERS: readonly MemoryMarker[] = Object.freeze([
  { marker: 'DECISION:', kind: MemoryKind.DECISION },
  { marker: 'DECIDED:', kind: MemoryKind.DECISION },
  { marker: 'CONSTRAINT:', kind: MemoryKind.CONSTRAINT },
  { marker: 'REQUIREMENT:', kind: MemoryKind.CONSTRAINT },
  { marker: 'PREFERENCE:', kind: MemoryKind.PREFERENCE },
  { marker: 'CONVENTION:', kind: MemoryKind.PREFERENCE },
  { marker: 'GOTCHA:', kind: MemoryKind.GOTCHA },
  { marker: 'NOTE:', kind: MemoryKind.GOTCHA },
  { marker: 'TODO:', kind: MemoryKind.NEXT_STEP },
  { marker: 'NEXT:', kind: MemoryKind.NEXT_STEP },
]);

interface Phrasing {
  readonly rule: string;
  readonly kind: MemoryKind;
  readonly pattern: RegExp;
}

/**
 * Natural phrasings precise enough to trust.
 *
 * Every one is anchored at the start of a line and requires a *completed*
 * statement — "we decided to", not "we could decide to". The near-misses are
 * tested explicitly, because the value of this list is entirely in what it
 * refuses.
 *
 * No pattern here can backtrack: each is a literal prefix followed by a bounded
 * run to the end of the line, over text that came from a session Ferret does
 * not control.
 */
const PHRASINGS: readonly Phrasing[] = Object.freeze([
  {
    rule: 'we-decided',
    kind: MemoryKind.DECISION,
    pattern: /^(?:we|i)\s+(?:decided|have decided|chose|went with)\s+(?!to decide)([^\n]{3,})$/i,
  },
  {
    rule: 'chosen-over',
    kind: MemoryKind.DECISION,
    pattern: /^(?:we|i)\s+(?:are|am)?\s*using\s+([^\n]{2,}?\s+(?:over|instead of)\s+[^\n]{2,})$/i,
  },
  {
    rule: 'never-because',
    kind: MemoryKind.CONSTRAINT,
    pattern: /^(?:never|always|do not|don't)\s+([^\n]{3,}?\s+because\s+[^\n]{3,})$/i,
  },
]);

export interface ExtractOptions {
  readonly recordedAt?: string;
  /**
   * Capture kinds read.
   *
   * Assistant and user turns by default. A `tool_result` is output from a
   * program — a build log saying `TODO:` is not a decision anyone made — and a
   * `tool_call` is Ferret's own machinery.
   */
  readonly kinds?: readonly SessionCaptureKind[];
}

const DEFAULT_KINDS: readonly SessionCaptureKind[] = Object.freeze([
  SessionCaptureKind.USER,
  SessionCaptureKind.ASSISTANT,
]);

/**
 * Splits content into lines outside fenced code blocks.
 *
 * A marker inside a code fence is a code sample, an example in documentation,
 * or this file's own tests being quoted back. Extracting it records a decision
 * nobody made.
 */
function narrativeLines(content: string): readonly { text: string; }[] {
  const lines: { text: string }[] = [];
  let fenced = false;
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    lines.push({ text: trimmed });
  }
  return lines;
}

interface Match {
  readonly kind: MemoryKind;
  readonly rule: string;
  readonly statement: string;
}

function matchLine(line: string): Match | undefined {
  for (const { marker, kind } of MEMORY_MARKERS) {
    if (line.length <= marker.length) continue;
    if (line.slice(0, marker.length).toUpperCase() !== marker) continue;
    const statement = line.slice(marker.length).trim();
    if (statement.length === 0) continue;
    return { kind, rule: `marker:${marker.slice(0, -1).toLowerCase()}`, statement };
  }

  for (const { rule, kind, pattern } of PHRASINGS) {
    const found = pattern.exec(line);
    if (found === null) continue;
    // The whole line, not the capture group: "we decided to use Postgres" reads
    // as a decision and "use Postgres" reads as an instruction.
    return { kind, rule, statement: line };
  }
  return undefined;
}

/**
 * Extracts the memories a set of captures states.
 *
 * Deterministic and ordered by capture sequence: the same captures produce the
 * same memories with the same ids, so re-reading earlier turns of a session
 * that is still running does not duplicate anything.
 */
export function extractMemories(
  captures: readonly SessionCapture[],
  options: ExtractOptions = {},
): readonly EngineeringMemory[] {
  const kinds = new Set(options.kinds ?? DEFAULT_KINDS);
  const ordered = [...captures].sort((a, b) => a.sequence - b.sequence);
  const byId = new Map<string, EngineeringMemory>();

  for (const capture of ordered) {
    if (!kinds.has(capture.kind)) continue;

    for (const { text } of narrativeLines(capture.content)) {
      const match = matchLine(text);
      if (match === undefined) continue;

      // A transcript contains whatever anyone pasted into it, so the statement
      // is redacted before it becomes a memory rather than after.
      const redacted = redactSecrets(match.statement);

      const memory = createEngineeringMemory({
        sessionId: capture.sessionId,
        kind: match.kind,
        statement: redacted.text,
        origin: MemoryOrigin.EXTRACTED,
        rule: match.rule,
        derivedFrom: [{ captureId: capture.id, sequence: capture.sequence }],
        recordedAt: options.recordedAt ?? capture.capturedAt,
        redactedSecrets: redacted.redacted,
      });

      // The same statement twice in one session is one memory, evidenced by
      // both captures — deduplicated on the derived id, which is what makes
      // re-extraction idempotent.
      const existing = byId.get(memory.id);
      byId.set(
        memory.id,
        existing === undefined
          ? memory
          : {
              ...existing,
              derivedFrom: [...existing.derivedFrom, ...memory.derivedFrom].sort(
                (a, b) => a.sequence - b.sequence,
              ),
            },
      );
    }
  }

  return [...byId.values()].sort(
    (a, b) => (a.derivedFrom[0]?.sequence ?? 0) - (b.derivedFrom[0]?.sequence ?? 0),
  );
}
