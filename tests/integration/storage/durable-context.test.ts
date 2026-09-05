import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONTEXT_CONTRADICTS_CONTEXT,
  CONTEXT_RELATES_TO_CONTEXT,
  ContextKind,
  DURABLE_CONTEXT_KIND,
  EntityKind,
  EvidenceMethod,
  EvidenceState,
  LifecycleState,
  RelationshipType,
  SourceAuthority,
  createNullLogger,
} from '../../../src/index.js';
import {
  DurableContextStore,
  EntityStore,
  EvidenceStore,
  IntegrityService,
  RelationshipStore,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-126 — the merger, against a real PostgreSQL.
 *
 * The pure rules are covered by `tests/unit/durable-context.test.ts`. What only
 * a real database can prove is the part the Epic's acceptance criterion is
 * about: that repeated, fragmented and superseded context *converges* to one
 * record while every observation that produced it survives, and that a reader
 * asking what Ferret currently holds is not handed the replaced ones.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let context: DurableContextStore;
let entities: EntityStore;
let evidence: EvidenceStore;
let relationships: RelationshipStore;
let repository: string;

function by(producer: string, overrides: Partial<ContextProvenance> = {}): ContextProvenance {
  return { producer, producerVersion: '1.0.0', sourceSystem: 'ferret', ...overrides };
}

async function edgesBetween(fromId: string, toId: string, type: string): Promise<number> {
  const rows = await handle.execute<{ [column: string]: unknown; count: string }>(sql`
    SELECT count(*)::text AS count FROM ferret.relationship
     WHERE from_id = ${fromId} AND to_id = ${toId} AND type = ${type}
  `);
  return Number(rows.rows[0]?.count ?? '0');
}

describeDb(`durable context merger (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('durable-context');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    context = new DurableContextStore(handle);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);
    relationships = new RelationshipStore(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/merger-repo' },
        attributes: { path: '/merger-repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('converges four writers of one decision onto one record, keeping four observations', async () => {
    // The measured example from this repository: "do not add a macOS CI runner"
    // written down in four places, none of them aware of the others.
    const statement = 'Do not add a macOS CI runner';
    const wordings = [
      { text: statement, producer: 'epic-105' },
      { text: 'do not add a macos ci runner', producer: 'epic-105-validation' },
      { text: 'Do not add a macOS CI runner.', producer: 'epic-115-validation' },
      { text: '  Do  not  add  a  macOS  CI  runner  ', producer: 'agent-memory' },
    ];

    const results = [];
    for (const wording of wordings) {
      results.push(
        await context.record({
          statement: wording.text,
          contextKind: ContextKind.DECISION,
          scope: repository,
          provenance: by(wording.producer),
        }),
      );
    }

    const ids = new Set(results.map((result) => result.context.entity.id));
    expect(ids.size).toBe(1);
    expect(results.map((result) => result.outcome)).toStrictEqual([
      'created',
      'merged',
      'merged',
      'merged',
    ]);

    const id = results[0]?.context.entity.id ?? '';

    // Every observation survives, and every one of them stays *current*: four
    // producers agreeing is corroboration, not three supersessions.
    const support = await evidence.forSubjectWithState(id, { permittedScopes: [] });
    expect(support).toHaveLength(4);
    expect(support.every((held) => held.state === EvidenceState.CURRENT)).toBe(true);
    expect(new Set(support.map((held) => held.evidence.producer)).size).toBe(4);

    // The first writer's wording is what the record says; the variants are kept
    // verbatim on the evidence rather than overwriting it.
    const stored = await context.get(id);
    expect(stored?.statement).toBe(statement);
    expect(support.map((held) => held.evidence.statement)).toContain('do not add a macos ci runner');
    expect(support.map((held) => held.evidence.statement)).toContain('Do not add a macOS CI runner.');

    // One record, not four.
    expect(await context.count({ scope: repository })).toBe(1);
  });

  it('deduplicates one producer restating itself without adding evidence', async () => {
    const write = async (): Promise<string> =>
      (
        await context.record({
          statement: 'The dogfood database is separate from the test database',
          contextKind: ContextKind.FACT,
          scope: repository,
          provenance: by('dogfood-notes'),
        })
      ).context.entity.id;

    const id = await write();
    await write();
    await write();

    const support = await evidence.forSubject(id, { permittedScopes: [] });
    expect(support).toHaveLength(1);
  });

  it('ranks an asserted statement as asserted, never as an observation', async () => {
    const recorded = await context.record({
      statement: 'Prefer a single reasoning path over spawning subagents',
      contextKind: ContextKind.PREFERENCE,
      scope: repository,
      provenance: by('agent-memory'),
    });
    const support = await evidence.forSubject(recorded.context.entity.id, { permittedScopes: [] });
    expect(support[0]?.method).toBe(EvidenceMethod.ASSERTED);
    expect(support[0]?.authority).toBe(SourceAuthority.ASSERTED);
  });

  it('relates a restatement rather than merging it', async () => {
    const first = await context.record({
      statement: 'Re-index the dogfood database after every merge to main',
      contextKind: ContextKind.CONSTRAINT,
      scope: repository,
      provenance: by('agent-memory'),
    });
    const second = await context.record({
      statement: 'Re-index the dogfood database after every merge into main',
      contextKind: ContextKind.CONSTRAINT,
      scope: repository,
      provenance: by('agent-memory'),
    });

    expect(second.context.entity.id).not.toBe(first.context.entity.id);
    expect(second.related.map((related) => related.id)).toContain(first.context.entity.id);
    expect(second.related[0]?.contradiction).toBe(false);
    expect(
      await edgesBetween(second.context.entity.id, first.context.entity.id, CONTEXT_RELATES_TO_CONTEXT),
    ).toBe(1);

    // Both remain readable, and the relation is what lets a reader collapse
    // them — Ferret did not decide they were one thing.
    const related = await context.relatedTo(first.context.entity.id);
    expect(related.map((entry) => entry.id)).toContain(second.context.entity.id);
    expect(related[0]?.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('preserves both sides of a contradiction and picks no winner', async () => {
    const subject = (
      await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/connectors/ingest.ts', scope: repository },
        attributes: { path: 'src/connectors/ingest.ts' },
      })
    ).entity.id;

    const twenty = await context.record({
      statement: 'The default ingestion page limit is twenty pages per pass',
      contextKind: ContextKind.FACT,
      subjectId: subject,
      scope: repository,
      provenance: by('reader-a'),
    });
    const fifty = await context.record({
      statement: 'The default ingestion page limit is fifty pages per pass',
      contextKind: ContextKind.FACT,
      subjectId: subject,
      scope: repository,
      provenance: by('reader-b'),
    });

    expect(fifty.related.some((related) => related.contradiction)).toBe(true);
    expect(await edgesBetween(fifty.context.entity.id, twenty.context.entity.id, CONTEXT_CONTRADICTS_CONTEXT)).toBe(1);

    // Neither is retired. Ferret reports the disagreement; a producer resolves
    // it, and until one does both stay answerable.
    const current = await context.current({ scope: repository, subjectId: subject });
    expect(current.map((held) => held.entity.id).sort()).toStrictEqual(
      [twenty.context.entity.id, fifty.context.entity.id].sort(),
    );

    // The statement is about the file, and the edge says so.
    const concerns = await relationships.outgoing(twenty.context.entity.id);
    expect(concerns.map((edge) => edge.toId)).toContain(subject);
  });

  it('supersedes without deleting, and keeps the replaced record out of current reads', async () => {
    const old = await context.record({
      statement: 'CI runs on Ubuntu, Windows and macOS runners',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-105'),
    });
    const replacement = await context.record({
      statement: 'CI runs on Ubuntu and Windows runners only',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('epic-115'),
      supersedes: old.context.entity.id,
    });

    expect(replacement.superseded).toBe(old.context.entity.id);

    const current = await context.current({ scope: repository, contextKind: ContextKind.FACT });
    expect(current.map((held) => held.entity.id)).not.toContain(old.context.entity.id);
    expect(current.map((held) => held.entity.id)).toContain(replacement.context.entity.id);

    // Asked for, history is there — and so is every observation that supported
    // the record that lost.
    const withHistory = await context.current({
      scope: repository,
      contextKind: ContextKind.FACT,
      includeSuperseded: true,
    });
    expect(withHistory.map((held) => held.entity.id)).toContain(old.context.entity.id);
    expect(await evidence.forSubject(old.context.entity.id, { permittedScopes: [] })).toHaveLength(1);

    const edges = await relationships.outgoing(replacement.context.entity.id, {
      type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
    });
    expect(edges.map((edge) => edge.toId)).toContain(old.context.entity.id);
  });

  it('leaves a superseded record verifying — issue #118 applies here too', async () => {
    const integrity = new IntegrityService(handle);
    const sweep = await integrity.sweep({ logger });
    const contextFindings = sweep.findings.filter((finding) => finding.kind === 'content-hash-mismatch');
    expect(contextFindings).toStrictEqual([]);
  });

  it('never relates across scopes, because a scope is part of identity', async () => {
    const other = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/other-repo' },
        attributes: { path: '/other-repo' },
      })
    ).entity.id;

    const here = await context.record({
      statement: 'The integration suite needs Docker running locally to start',
      contextKind: ContextKind.CONSTRAINT,
      scope: repository,
      provenance: by('agent-memory'),
    });
    const there = await context.record({
      statement: 'The integration suite needs Docker running locally to start',
      contextKind: ContextKind.CONSTRAINT,
      scope: other,
      provenance: by('agent-memory'),
    });

    expect(there.context.entity.id).not.toBe(here.context.entity.id);
    expect(there.related).toStrictEqual([]);
  });

  it('finds durable context through full-text retrieval — migration 0016', async () => {
    const recorded = await context.record({
      statement: 'Heredocs collapse backslashes, so regex literals are written with the file tool',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('agent-memory'),
    });

    const rows = await handle.execute<{ [column: string]: unknown; id: string }>(sql`
      SELECT id FROM ferret.entity
       WHERE kind = ${DURABLE_CONTEXT_KIND}
         AND search_vector @@ websearch_to_tsquery('english', 'heredoc backslash')
    `);
    expect(rows.rows.map((row) => row.id)).toContain(recorded.context.entity.id);
  });

  it('refuses a supersession that names an unknown or self record', async () => {
    const held = await context.record({
      statement: 'Stage the agent configuration directory with every commit',
      contextKind: ContextKind.PREFERENCE,
      scope: repository,
      provenance: by('agent-memory'),
    });
    const id = held.context.entity.id;

    await expect(context.supersede(id, id, 'ferret')).rejects.toThrow(/cannot supersede itself/);
    await expect(
      context.supersede(id, '00000000-0000-8000-8000-00000000dead', 'ferret'),
    ).rejects.toThrow(/No durable context/);

    // The refusal left it alone.
    expect((await context.get(id))?.entity.lifecycle).toBe(LifecycleState.ACTIVE);
  });
});
