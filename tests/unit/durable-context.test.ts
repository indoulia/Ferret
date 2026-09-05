import { describe, expect, it } from 'vitest';

import {
  CONTEXT_KINDS,
  ContextKind,
  DURABLE_CONTEXT_KIND,
  MEMORY_CONTEXT_KINDS,
  MEMORY_KINDS,
  MergeVerdict,
  NEAR_DUPLICATE_SIMILARITY,
  classifyPair,
  contradicts,
  createDurableContext,
  durableContextOf,
  durableContextSourceId,
  entityKindDefinition,
  isContextKind,
  normalizeStatement,
  registerDurableContextKind,
  similarity,
  statementTokens,
  type DurableContext,
} from '../../src/index.js';

/**
 * EPIC-126 — the merge rules, without a database.
 *
 * Everything the merger decides is decided here: identity, and therefore the
 * merge, is a pure function of what was said. The store adds persistence and
 * the bounded candidate query; it adds no judgement.
 */

registerDurableContextKind();

function record(statement: string, overrides: Partial<Parameters<typeof createDurableContext>[0]> = {}): DurableContext {
  return createDurableContext({ statement, contextKind: ContextKind.DECISION, ...overrides });
}

describe('the durable context kind', () => {
  it('is registered rather than added to the core model — EPIC-006 AC-4', () => {
    const definition = entityKindDefinition(DURABLE_CONTEXT_KIND);
    expect(definition?.builtIn).toBe(false);
  });

  it('carries every session memory kind, so promotion cannot lose one', () => {
    expect([...MEMORY_CONTEXT_KINDS].sort()).toStrictEqual([...MEMORY_KINDS].sort());
    for (const kind of MEMORY_KINDS) expect(isContextKind(kind)).toBe(true);
    expect(CONTEXT_KINDS).toContain(ContextKind.FACT);
  });
});

describe('normalization', () => {
  it('folds the differences that are not differences', () => {
    expect(normalizeStatement('  We chose  PostgreSQL.  ')).toBe('we chose postgresql');
    expect(normalizeStatement('We chose PostgreSQL')).toBe(normalizeStatement('we CHOSE postgresql!'));
  });

  it('keeps a difference that is one', () => {
    expect(normalizeStatement('we chose PostgreSQL')).not.toBe(normalizeStatement('we chose SQLite'));
  });

  it('drops a comma that separates, and keeps one that does not', () => {
    // Found by dogfooding: four wordings of one constraint left two records,
    // and the pair that stayed apart differed by a single comma.
    expect(normalizeStatement('use pg, not sqlite.')).toBe('use pg not sqlite');
    expect(normalizeStatement('the corpus holds 1,000 files')).toBe('the corpus holds 1,000 files');
    expect(normalizeStatement('run src:build first')).toBe('run src:build first');
  });
});

describe('identity is the merge', () => {
  it('gives two writers of one statement the same record', () => {
    const first = record('Do not add a macOS CI runner');
    const second = record('do not add a macos ci runner.');
    expect(second.entity.id).toBe(first.entity.id);
  });

  it('keeps two different statements apart', () => {
    expect(record('Use PostgreSQL').entity.id).not.toBe(record('Use SQLite').entity.id);
  });

  it('separates the same words said about different kinds of thing', () => {
    const decision = record('Windows CI is post-merge', { contextKind: ContextKind.DECISION });
    const constraint = record('Windows CI is post-merge', { contextKind: ContextKind.CONSTRAINT });
    expect(decision.entity.id).not.toBe(constraint.entity.id);
  });

  it('separates the same statement about different subjects', () => {
    const about = '00000000-0000-8000-8000-000000000001';
    const other = '00000000-0000-8000-8000-000000000002';
    expect(record('This is flaky', { subjectId: about }).entity.id).not.toBe(
      record('This is flaky', { subjectId: other }).entity.id,
    );
  });

  it('separates the same statement in different scopes', () => {
    expect(record('Tests need Docker', { scope: 'repo-a' }).entity.id).not.toBe(
      record('Tests need Docker', { scope: 'repo-b' }).entity.id,
    );
  });

  it('derives the id from what was said, never from who said it', () => {
    // The whole difference from evidence, which is keyed on the producer.
    const id = durableContextSourceId(ContextKind.DECISION, undefined, 'we chose postgresql');
    expect(record('We chose PostgreSQL.').entity.source.id).toBe(id);
  });

  it('stores the form the id was derived from, so the id is recomputable', () => {
    const built = record('We chose  PostgreSQL.');
    const read = durableContextOf(built.entity);
    expect(
      durableContextSourceId(read.contextKind, read.subjectId, read.normalized),
    ).toBe(built.entity.source.id);
  });

  it('keeps the first writer’s wording as the canonical statement', () => {
    const built = record('We chose PostgreSQL over SQLite');
    expect(built.entity.attributes['statement']).toBe('We chose PostgreSQL over SQLite');
    expect(built.entity.attributes['normalized']).toBe('we chose postgresql over sqlite');
  });
});

describe('similarity', () => {
  it('is Jaccard over the vocabulary', () => {
    expect(similarity(statementTokens('a b c d'), statementTokens('a b c d'))).toBe(1);
    expect(similarity(statementTokens('a b'), statementTokens('c d'))).toBe(0);
    expect(similarity(statementTokens('a b c'), statementTokens('a b c d'))).toBeCloseTo(0.75);
  });

  it('reports nothing shared when a statement has no vocabulary', () => {
    // Not 1. Two contentless statements are not evidence of being one.
    expect(similarity(statementTokens(''), statementTokens(''))).toBe(0);
  });
});

describe('the merge verdict', () => {
  it('calls identical records the same, on identity alone', () => {
    const a = record('Windows CI runs after merge, not before');
    const b = record('windows ci runs after merge, not before');
    expect(classifyPair(a, b)).toStrictEqual({ verdict: MergeVerdict.SAME, similarity: 1 });
  });

  it('relates a restatement rather than merging it', () => {
    const a = record('Windows CI runs after the merge, not before it');
    const b = record('Windows CI runs after the merge and not before it');
    const verdict = classifyPair(a, b);
    expect(verdict.verdict).toBe(MergeVerdict.NEAR);
    expect(verdict.similarity).toBeGreaterThanOrEqual(NEAR_DUPLICATE_SIMILARITY);
    // The point of the Epic: near is never same.
    expect(a.entity.id).not.toBe(b.entity.id);
  });

  it('leaves two genuinely different statements distinct', () => {
    const a = record('We chose PostgreSQL because of pgvector');
    const b = record('The macOS runner was removed to save three minutes');
    expect(classifyPair(a, b).verdict).toBe(MergeVerdict.DISTINCT);
  });

  it('does not relate a negation to its affirmation on shared words alone', () => {
    // 'not' is one token in a short sentence, so this sits below the threshold —
    // which is the conservative direction. Consolidating these would be the
    // failure the Epic names.
    const a = record('Add a macOS runner');
    const b = record('Do not add a macOS runner ever again');
    expect(classifyPair(a, b).verdict).toBe(MergeVerdict.DISTINCT);
  });
});

describe('contradiction', () => {
  const subject = '00000000-0000-8000-8000-0000000000aa';

  it('needs a named subject before it will call two statements rivals', () => {
    const a = record('The default page limit is twenty records per pass');
    const b = record('The default page limit is fifty records per pass');
    expect(contradicts(a, b)).toBe(false);
  });

  it('reports two near-duplicate statements about one subject', () => {
    const a = record('The default page limit is twenty records per pass', { subjectId: subject });
    const b = record('The default page limit is fifty records per pass', { subjectId: subject });
    expect(classifyPair(a, b).verdict).toBe(MergeVerdict.NEAR);
    expect(contradicts(a, b)).toBe(true);
  });

  it('never reports a record as contradicting itself', () => {
    const a = record('The default page limit is twenty', { subjectId: subject });
    expect(contradicts(a, a)).toBe(false);
  });

  it('does not read two kinds of statement as rivals', () => {
    const a = record('Ship it on Friday', { subjectId: subject, contextKind: ContextKind.DECISION });
    const b = record('Ship it on Friday', { subjectId: subject, contextKind: ContextKind.PREFERENCE });
    expect(contradicts(a, b)).toBe(false);
  });
});

describe('what a statement may be', () => {
  it('refuses a statement that normalizes to nothing', () => {
    expect(() => record('   ...   ')).toThrow(/cannot be empty/);
  });

  it('refuses a transcript rather than truncating one', () => {
    // Truncating would change what the record says while keeping it
    // addressable, which is the worse of the two failures.
    expect(() => record('x'.repeat(1001))).toThrow(/at most 1000 characters/);
  });

  it('masks a credential before the id is derived', () => {
    const built = record('The dogfood database password is ghp_0123456789abcdefghijklmnopqrstuvwxyzA');
    expect(built.redactedSecrets).toBeGreaterThan(0);
    expect(built.statement).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzA');
    expect(built.entity.canonicalKey).not.toContain('ghp_');
  });

  it('refuses to read an entity of another kind as durable context', () => {
    const built = record('anything');
    expect(() => durableContextOf({ ...built.entity, kind: 'commit' })).toThrow(/not durable context/);
  });
});
