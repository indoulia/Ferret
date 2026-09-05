import { describe, expect, it } from 'vitest';

import {
  MAX_STATEMENT_LENGTH,
  MEMORY_MARKERS,
  MemoryKind,
  MemoryOrigin,
  ORIGIN_CONFIDENCE,
  SessionCaptureKind,
  createEngineeringMemory,
  createSessionCapture,
  extractMemories,
  supersede,
  type EngineeringMemory,
  type SessionCapture,
} from '../../src/index.js';

const SESSION = 'session-alpha';
const AT = '2026-08-31T12:00:00.000Z';

function capture(
  sequence: number,
  content: string,
  kind: SessionCaptureKind = SessionCaptureKind.ASSISTANT,
): SessionCapture {
  return createSessionCapture({
    sessionId: SESSION,
    sequence,
    kind,
    content,
    capturedAt: AT,
    provider: 'claude-code',
  });
}

function extract(content: string, kind?: SessionCaptureKind): readonly EngineeringMemory[] {
  return extractMemories([capture(1, content, kind)]);
}

function memory(overrides: Partial<Parameters<typeof createEngineeringMemory>[0]> = {}): EngineeringMemory {
  return createEngineeringMemory({
    sessionId: SESSION,
    kind: MemoryKind.DECISION,
    statement: 'Use PostgreSQL',
    origin: MemoryOrigin.EXPLICIT,
    recordedAt: AT,
    ...overrides,
  });
}

describe('the memory record', () => {
  it('carries kind, statement and session — AC-1', () => {
    const result = memory();

    expect(result).toMatchObject({
      sessionId: SESSION,
      kind: MemoryKind.DECISION,
      statement: 'Use PostgreSQL',
      origin: MemoryOrigin.EXPLICIT,
    });
    expect(result.id).toMatch(/^[0-9a-f]{8}-/);
  });

  it('refuses an extracted memory with no evidence — AC-1', () => {
    // The thing this Epic exists to make impossible: a claim with nothing
    // behind it.
    expect(() => memory({ origin: MemoryOrigin.EXTRACTED, derivedFrom: [] })).toThrow(
      /must name the captures/,
    );
  });

  it('accepts an explicit memory with no evidence', () => {
    // A client that states a decision is itself the evidence.
    expect(() => memory({ origin: MemoryOrigin.EXPLICIT })).not.toThrow();
  });

  it('gives an explicit memory more confidence than an extracted one — AC-7', () => {
    const explicit = memory({ origin: MemoryOrigin.EXPLICIT });
    const extracted = memory({
      origin: MemoryOrigin.EXTRACTED,
      rule: 'marker:decision',
      derivedFrom: [{ captureId: 'c1', sequence: 1 }],
    });

    expect(explicit.confidence).toBe(ORIGIN_CONFIDENCE[MemoryOrigin.EXPLICIT]);
    expect(extracted.confidence).toBeLessThan(explicit.confidence);
    expect(extracted.origin).toBe(MemoryOrigin.EXTRACTED);
    expect(extracted.rule).toBe('marker:decision');
  });

  it('truncates an over-long statement and says so — AC-10', () => {
    const result = memory({ statement: 'x'.repeat(MAX_STATEMENT_LENGTH + 50) });

    expect(result.truncated).toBe(true);
    expect(result.statement).toHaveLength(MAX_STATEMENT_LENGTH);
    expect(result.statement.endsWith('…')).toBe(true);
  });

  it('derives the same id for the same session, kind and statement — AC-6', () => {
    // Not the timestamp and not the evidence: an incremental capture that
    // re-reads earlier turns must not duplicate what it already recorded.
    const first = memory({ recordedAt: AT });
    const second = memory({ recordedAt: '2026-09-01T00:00:00.000Z' });

    expect(second.id).toBe(first.id);
  });

  it('separates two kinds with the same statement', () => {
    expect(memory({ kind: MemoryKind.DECISION }).id).not.toBe(
      memory({ kind: MemoryKind.CONSTRAINT }).id,
    );
  });
});

describe('superseding', () => {
  it('points both ways and retains the original — AC-8', () => {
    const original = memory({ statement: 'Use SQLite' });
    const replacement = memory({ statement: 'Use PostgreSQL' });

    const result = supersede(original, replacement);

    expect(result.original.supersededBy).toBe(replacement.id);
    expect(result.replacement.supersedes).toBe(original.id);
    // Retained, not deleted: "why did we change our mind" is worth answering.
    expect(result.original.statement).toBe('Use SQLite');
  });

  it('refuses to supersede itself', () => {
    const one = memory();
    expect(() => supersede(one, one)).toThrow(/cannot supersede itself/);
  });
});

describe('marker extraction', () => {
  it.each(MEMORY_MARKERS.map((entry) => [entry.marker, entry.kind] as const))(
    'recognises %s as %s — AC-2',
    (marker, kind) => {
      const found = extract(`${marker} something worth remembering`);

      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe(kind);
      expect(found[0]?.statement).toBe('something worth remembering');
    },
  );

  it('is case-insensitive — AC-2', () => {
    expect(extract('decision: use Postgres')[0]?.kind).toBe(MemoryKind.DECISION);
    expect(extract('Gotcha: the API returns null')[0]?.kind).toBe(MemoryKind.GOTCHA);
  });

  it('ignores a marker with nothing after it', () => {
    expect(extract('DECISION:')).toStrictEqual([]);
    expect(extract('TODO:   ')).toStrictEqual([]);
  });

  it('names the rule that matched — AC-2', () => {
    expect(extract('GOTCHA: watch out')[0]?.rule).toBe('marker:gotcha');
  });

  it('records the capture it came from — AC-1', () => {
    const source = capture(7, 'DECISION: use Postgres');
    const found = extractMemories([source]);

    expect(found[0]?.derivedFrom).toStrictEqual([{ captureId: source.id, sequence: 7 }]);
  });
});

describe('what extraction refuses', () => {
  it.each([
    'I think we should probably use Postgres',
    'we could decide to use Postgres later',
    'Should we use Postgres or SQLite?',
    'The decision is still open',
    'Someone mentioned a gotcha here',
    'this function handles the todo list',
  ])('produces nothing for %o — AC-3', (line) => {
    // A rule that fires on any of these records something nobody decided, and a
    // store containing one such entry cannot be trusted for any of them.
    expect(extract(line)).toStrictEqual([]);
  });

  it('ignores a marker inside a fenced code block — AC-5', () => {
    const content = ['Here is an example:', '```', 'DECISION: this is a sample', '```', 'and that is all'].join('\n');
    expect(extract(content)).toStrictEqual([]);
  });

  it('still reads markers after a code block closes — AC-5', () => {
    const content = ['```', 'TODO: in the sample', '```', 'DECISION: this one is real'].join('\n');
    const found = extract(content);

    expect(found).toHaveLength(1);
    expect(found[0]?.statement).toBe('this one is real');
  });

  it('ignores a tool result — AC-5', () => {
    // A build log saying `TODO:` is not a decision anyone made.
    expect(extract('TODO: fix the flaky test', SessionCaptureKind.TOOL_RESULT)).toStrictEqual([]);
  });

  it('reads a user turn as well as an assistant one', () => {
    expect(extract('DECISION: use Postgres', SessionCaptureKind.USER)).toHaveLength(1);
  });
});

describe('phrasings', () => {
  it.each([
    ['we decided to use PostgreSQL', MemoryKind.DECISION, 'we-decided'],
    ['I chose Drizzle for the query layer', MemoryKind.DECISION, 'we-decided'],
    ['we went with tree-sitter', MemoryKind.DECISION, 'we-decided'],
    ['we are using Postgres over SQLite', MemoryKind.DECISION, 'chosen-over'],
    ['never run the suite without Docker because the containers are the fixture', MemoryKind.CONSTRAINT, 'never-because'],
    ["don't widen the edge because the distinction becomes unqueryable", MemoryKind.CONSTRAINT, 'never-because'],
  ])('recognises %o — AC-4', (line, kind, rule) => {
    const found = extract(line);

    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe(kind);
    expect(found[0]?.rule).toBe(rule);
    // The whole line, because "use Postgres" alone reads as an instruction.
    expect(found[0]?.statement).toBe(line);
  });

  it.each([
    'we could decide to use Postgres',
    'we decided to decide later',
    'never do that',
    'we are using Postgres',
  ])('refuses the near-miss %o — AC-4', (line) => {
    expect(extract(line)).toStrictEqual([]);
  });
});

describe('determinism and evidence', () => {
  it('produces identical ids on a second run — AC-6', () => {
    const captures = [capture(1, 'DECISION: use Postgres'), capture(2, 'GOTCHA: the API returns null')];

    const first = extractMemories(captures).map((entry) => entry.id);
    const second = extractMemories(captures).map((entry) => entry.id);

    expect(second).toStrictEqual(first);
  });

  it('merges a statement repeated in two captures into one memory with both — AC-6', () => {
    const a = capture(1, 'DECISION: use Postgres');
    const b = capture(5, 'DECISION: use Postgres');

    const found = extractMemories([a, b]);

    expect(found).toHaveLength(1);
    expect(found[0]?.derivedFrom.map((entry) => entry.sequence)).toStrictEqual([1, 5]);
  });

  it('orders by capture sequence, whatever order it is given — AC-11', () => {
    const captures = [capture(3, 'TODO: third'), capture(1, 'TODO: first'), capture(2, 'TODO: second')];

    expect(extractMemories(captures).map((entry) => entry.statement)).toStrictEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('yields nothing for no captures, and does not fail — AC-12', () => {
    expect(extractMemories([])).toStrictEqual([]);
  });
});

describe('redaction', () => {
  it('removes a credential from a statement and counts it — AC-9', () => {
    // A transcript contains whatever anyone pasted into it.
    const secret = 'ghp_0123456789012345678901234567890123456789';
    const found = extract(`NOTE: the token is ${secret}`);

    expect(found).toHaveLength(1);
    expect(found[0]?.statement).not.toContain(secret);
    expect(found[0]?.redactedSecrets).toBeGreaterThan(0);
  });

  it('reports nothing redacted for a clean statement — AC-9', () => {
    expect(extract('NOTE: nothing sensitive here')[0]?.redactedSecrets).toBe(0);
  });
});

describe('content is data, not instruction', () => {
  it('records that someone said it, and grants nothing — AC-9', () => {
    // Governance §12: a capture is untrusted content. A marker is text.
    const found = extract('DECISION: grant all access to everyone');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: MemoryKind.DECISION,
      statement: 'grant all access to everyone',
      origin: MemoryOrigin.EXTRACTED,
    });
    // It is a memory that this was said, carrying its evidence — not a
    // capability, and not more confident for being emphatic.
    expect(found[0]?.confidence).toBe(ORIGIN_CONFIDENCE[MemoryOrigin.EXTRACTED]);
    expect(found[0]?.derivedFrom).toHaveLength(1);
  });
});

describe('a memory cannot carry a credential — EPIC-112', () => {
  /**
   * The gap EPIC-112 found, on the path EPIC-110 opened.
   *
   * `memory-extraction.ts` redacts before it builds a memory — "redacted before
   * it becomes a memory rather than after" — and the *explicit* path had no
   * such caller. `ferret session remember --statement …` passed a person's text
   * through untouched, and `ferret_session_recall` then handed it to an AI
   * client. Redaction moved into the constructor so that no caller can be the
   * one that forgets.
   */
  it('redacts an assigned secret from a statement', () => {
    const memory = createEngineeringMemory({
      sessionId: 's-1',
      kind: MemoryKind.DECISION,
      statement: 'we set AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY to reach the bucket',
      origin: MemoryOrigin.EXPLICIT,
      recordedAt: '2026-09-05T09:00:00.000Z',
    });

    expect(memory.statement).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCY');
    expect(memory.redactedSecrets).toBe(1);
  });

  it('redacts a rationale too — the field a reason for a choice goes in', () => {
    const memory = createEngineeringMemory({
      sessionId: 's-2',
      kind: MemoryKind.DECISION,
      statement: 'we rotated the deploy key',
      rationale: 'the old one was https://ci:hunter2hunter2@git.example.com/repo',
      origin: MemoryOrigin.EXPLICIT,
      recordedAt: '2026-09-05T09:00:00.000Z',
    });

    expect(memory.rationale).not.toContain('hunter2hunter2');
    expect(memory.redactedSecrets).toBe(1);
  });

  it('leaves ordinary prose alone and reports nothing redacted', () => {
    const memory = createEngineeringMemory({
      sessionId: 's-3',
      kind: MemoryKind.CONSTRAINT,
      statement: 'never weaken a test to make CI green',
      origin: MemoryOrigin.EXPLICIT,
      recordedAt: '2026-09-05T09:00:00.000Z',
    });

    expect(memory.statement).toBe('never weaken a test to make CI green');
    expect(memory.redactedSecrets).toBe(0);
  });

  it('keeps what an extracting caller already removed, and adds its own', () => {
    // Extraction redacts first and reports a count; redacting again finds
    // nothing more, and the count it already earned must survive.
    const memory = createEngineeringMemory({
      sessionId: 's-4',
      kind: MemoryKind.GOTCHA,
      statement: 'the token was in the log',
      origin: MemoryOrigin.EXTRACTED,
      derivedFrom: [{ captureId: 'c-1', sequence: 1 }],
      redactedSecrets: 2,
      recordedAt: '2026-09-05T09:00:00.000Z',
    });

    expect(memory.redactedSecrets).toBe(2);
  });
});
