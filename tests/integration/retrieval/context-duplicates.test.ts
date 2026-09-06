import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContextKind,
  EntityKind,
  LifecycleState,
  PUBLIC_ACCESS,
  createNullLogger,
} from '../../../src/index.js';
import {
  DurableContextStore,
  EntityStore,
  RetrievalStore,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-130 — retrieval returns the smallest useful set, not the largest.
 *
 * The measured problem, on Ferret's own index before this Epic: one question
 * returned **four** durable context records saying **two** things, while the
 * merger had already recorded five `context_relates_to_context` edges naming
 * them as restatements of one another. The knowledge was in the graph and the
 * answer did not use it.
 *
 * Against a real database because the edges are what carry the equivalence, and
 * a fake would be asserting the fixture rather than the join.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let context: DurableContextStore;
let retrieval: RetrievalStore;
let repository: string;

function by(producer: string): ContextProvenance {
  return { producer, producerVersion: '1.0.0', sourceSystem: 'ferret' };
}

/** Durable context hits for a question, in ranked order. */
async function contextHits(text: string) {
  const result = await retrieval.search({ text, limit: 10 }, PUBLIC_ACCESS);
  return result.hits.filter((hit) => hit.entity.kind === 'context');
}

describeDb(`durable context in retrieval (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('context-duplicates');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    context = new DurableContextStore(handle);
    retrieval = new RetrievalStore(handle);

    repository = (
      await new EntityStore(handle).upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/dupes-repo' },
        attributes: { path: '/dupes-repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('returns one hit where four records say one thing', async () => {
    // The four real wordings, from four files of this repository.
    const wordings = [
      ['epic-105', 'The storage suites need a Linux container and macOS runners cannot run one'],
      ['epic-115', 'The storage suites require a Linux container and macOS runners cannot run one'],
      ['roadmap', 'The storage suites need a Linux container, which macOS runners cannot run'],
      ['agent-memory', 'The storage suites need a Linux container; macOS runners cannot run one'],
    ] as const;

    const ids: string[] = [];
    for (const [producer, statement] of wordings) {
      const recorded = await context.record({
        statement,
        contextKind: ContextKind.CONSTRAINT,
        scope: repository,
        provenance: by(producer),
      });
      ids.push(recorded.context.entity.id);
    }

    // Non-vacuous: four distinct records really are stored.
    expect(new Set(ids).size).toBe(4);

    const hits = await contextHits('macOS runners linux container');

    expect(hits).toHaveLength(1);
    // Nothing is hidden — the other three are named, so a caller can ask for
    // what was collapsed.
    expect(hits[0]?.ranking?.subsumed).toHaveLength(3);
    expect([hits[0]?.entity.id, ...(hits[0]?.ranking?.subsumed ?? [])].sort()).toStrictEqual([...ids].sort());
  });

  it('keeps two statements that genuinely differ', async () => {
    await context.record({
      statement: 'A migration lock is held on a dedicated session so a killed process is detected',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-002'),
    });
    await context.record({
      statement: 'A migration checksum refuses one that was edited after it was applied',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-002'),
    });

    // One term both carry, so both are retrieved and the fold is what decides.
    const hits = await contextHits('migration');

    // Two answers, because they are two answers.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const hit of hits) expect(hit.ranking?.subsumed).toStrictEqual([]);
  });

  it('returns the current record, not the better-matching retired one', async () => {
    const retired = await context.record({
      statement: 'The ingestion page limit is twenty pages per bounded pass in every case',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-119'),
    });
    const current = await context.record({
      statement: 'The ingestion page limit is twenty pages per bounded pass in each case',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-125'),
      supersedes: retired.context.entity.id,
    });

    const hits = await contextHits('ingestion page limit bounded pass');
    const found = hits.find((hit) => hit.entity.lifecycle === LifecycleState.ACTIVE);

    expect(found?.entity.id).toBe(current.context.entity.id);
    // The retired wording is folded into the live one rather than returned
    // beside it — and it is named, so history stays reachable.
    expect(found?.ranking?.subsumed).toContain(retired.context.entity.id);
  });

  it('never folds a contradiction, because two answers are two answers', async () => {
    const subject = (
      await new EntityStore(handle).upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/contested.ts', scope: repository },
        attributes: { path: 'src/contested.ts' },
      })
    ).entity.id;

    const twenty = await context.record({
      statement: 'The retry budget is twenty attempts for each provider recovery',
      contextKind: ContextKind.FACT,
      subjectId: subject,
      scope: repository,
      provenance: by('reader-a'),
    });
    const three = await context.record({
      statement: 'The retry budget is three attempts for each provider recovery',
      contextKind: ContextKind.FACT,
      subjectId: subject,
      scope: repository,
      provenance: by('reader-b'),
    });

    // Non-vacuous: the merger really did record this as a contradiction.
    expect(three.related.some((one) => one.contradiction)).toBe(true);

    const hits = await contextHits('retry budget attempts provider recovery');
    const returned = hits.map((hit) => hit.entity.id);

    // Both. Folding one into the other would be Ferret picking a winner it has
    // already said it cannot pick.
    expect(returned).toContain(twenty.context.entity.id);
    expect(returned).toContain(three.context.entity.id);
  });
});
