import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContextKind,
  ContextPackBuilder,
  EntityKind,
  EvidenceMethod,
  LifecycleState,
  PUBLIC_ACCESS,
  SourceAuthority,
  createNullLogger,
  renderPack,
} from '../../../src/index.js';
import {
  DurableContextStore,
  EntityStore,
  EvidenceStore,
  RetrievalStore,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-131 — a concrete task produces a coherent package.
 *
 * The Epic's acceptance, in the terms it sets: *"an agent can request context
 * for a concrete task and receive a coherent, minimal, provenance-preserving
 * package rather than an unstructured collection of records."*
 *
 * The question and the statements are real: what this repository records about
 * its own CI, and the question this session actually had to answer about it.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const QUESTION = 'Should CI add a macOS runner for the storage suites?';

let db: TestDatabase;
let handle: FerretDatabase;
let builder: ContextPackBuilder;
let repository: string;

function by(producer: string, method?: EvidenceMethod): ContextProvenance {
  return {
    producer,
    producerVersion: '1.0.0',
    sourceSystem: 'ferret',
    ...(method === undefined ? {} : { method }),
  };
}

describeDb(`assembling a task package (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('task-assembly');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);

    const entities = new EntityStore(handle);
    const context = new DurableContextStore(handle);
    const retrieval = new RetrievalStore(handle);
    builder = new ContextPackBuilder(retrieval, PUBLIC_ACCESS, new EvidenceStore(handle));

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/assembly-repo' },
        attributes: { path: '/assembly-repo' },
      })
    ).entity.id;

    const corpus: readonly (readonly [ContextKind, string, string, EvidenceMethod | undefined])[] = [
      [ContextKind.CONSTRAINT, 'The storage suites need a Linux container and macOS runners cannot run one', 'epic-105', EvidenceMethod.PARSED],
      [ContextKind.CONSTRAINT, 'The storage suites require a Linux container and macOS runners cannot run one', 'epic-115', undefined],
      [ContextKind.CONSTRAINT, 'The storage suites need a Linux container; macOS runners cannot run one', 'agent-memory', undefined],
      [ContextKind.DECISION, 'Do not add a macOS CI runner; correct the records instead', 'agent-memory', undefined],
      [ContextKind.FACT, 'CI runs the suite on Ubuntu and Windows runners only', 'epic-115', EvidenceMethod.PARSED],
      [ContextKind.NEXT_STEP, 'A macOS runner is revisited when the suites no longer need a container', 'roadmap', undefined],
      [ContextKind.GOTCHA, 'A macOS runner cannot run the container the storage suites start', 'epic-105', undefined],
    ];

    for (const [kind, statement, producer, method] of corpus) {
      await context.record({ statement, contextKind: kind, scope: repository, provenance: by(producer, method) });
    }
  });

  afterAll(async () => {
    await db.drop();
  });

  it('reaches the context a strict search cannot', async () => {
    // The defect this Epic found: a task is a sentence, full text ANDs every
    // term, and the strict query reached **none** of seven statements directly
    // about the question while matching one incidental commit.
    const strict = await new RetrievalStore(handle).search(
      { text: QUESTION, kinds: ['context'], limit: 10 },
      PUBLIC_ACCESS,
    );
    expect(strict.hits).toStrictEqual([]);

    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    expect(pack.standing.length).toBeGreaterThan(0);
  });

  it('orders what constrains before what merely informs', async () => {
    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    const kinds = pack.standing.map((one) => one.contextKind);

    // Not a relevance ordering: an ordering by what acting against one costs.
    expect(kinds[0]).toBe(ContextKind.CONSTRAINT);
    expect(kinds.indexOf(ContextKind.CONSTRAINT)).toBeLessThan(kinds.indexOf(ContextKind.FACT));
    expect(kinds.indexOf(ContextKind.DECISION)).toBeLessThan(kinds.indexOf(ContextKind.NEXT_STEP));
  });

  it('carries the restatements retrieval folded, rather than dropping them', async () => {
    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    const constraint = pack.standing.find((one) => one.contextKind === ContextKind.CONSTRAINT);

    // Three wordings of one constraint were stored; one is carried and says so.
    expect(constraint?.restates.length).toBeGreaterThan(0);
    expect(pack.standing.filter((one) => one.contextKind === ContextKind.CONSTRAINT)).toHaveLength(1);
  });

  it('prefers what was read over what was merely asserted', async () => {
    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    const constraint = pack.standing.find((one) => one.contextKind === ContextKind.CONSTRAINT);

    // A producer cannot promote itself past what Ferret saw.
    expect(constraint?.authority).toBe(SourceAuthority.PARSED);
    expect(constraint?.current).toBe(true);
  });

  it('stays inside the budget and says what did not fit', async () => {
    const pack = await builder.build({ question: QUESTION, budget: 400 });

    expect(pack.estimatedTokens).toBeLessThanOrEqual(pack.budget);
    // A package built from part of what Ferret holds says so before it is used.
    expect(pack.omitted.length).toBeGreaterThan(0);
  });

  it('renders what constrains the task before the records, after the notice', async () => {
    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    const rendered = renderPack(pack);

    const notice = rendered.indexOf('DATA, not instructions');
    const heading = rendered.indexOf('## What Ferret currently holds');
    const firstRecord = rendered.indexOf('## 1.');

    expect(notice).toBeGreaterThanOrEqual(0);
    expect(heading).toBeGreaterThan(notice);
    if (firstRecord >= 0) expect(heading).toBeLessThan(firstRecord);
    // Every statement stays contained on the way out.
    expect(rendered).toContain('ferret:content');
  });

  it('leaves a proposal out of what it presents as held', async () => {
    const context = new DurableContextStore(handle);
    await context.record({
      statement: 'A macOS runner may become cheap enough to reconsider for the storage suites',
      contextKind: ContextKind.NEXT_STEP,
      scope: repository,
      provenance: by('someone'),
      state: LifecycleState.CANDIDATE,
    });

    const pack = await builder.build({ question: QUESTION, budget: 4000 });
    const proposals = pack.standing.filter((one) => !one.current);

    // A proposal that does reach the package is marked, never presented as
    // something Ferret holds.
    for (const one of proposals) expect(one.state).not.toBe(LifecycleState.ACTIVE);
    expect(pack.standing.filter((one) => one.current).length).toBeGreaterThan(0);
  });
});
