import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContextKind,
  EntityKind,
  EvidenceMethod,
  HISTORICAL_LIFECYCLE_STATES,
  IntegrityFindingKind,
  LifecycleState,
  SourceAuthority,
  createNullLogger,
} from '../../../src/index.js';
import {
  DurableContextStore,
  EntityStore,
  EvidenceStore,
  IntegrityService,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-127 — lifecycle and authority, against real PostgreSQL.
 *
 * The Epic is accepted on one question: *for a question, can Ferret distinguish
 * current authoritative context from superseded history, and explain the
 * evidence behind that distinction?* Everything here asks a form of it.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const READ = { permittedScopes: [] as readonly string[] };

let db: TestDatabase;
let handle: FerretDatabase;
let context: DurableContextStore;
let entities: EntityStore;
let evidence: EvidenceStore;
let repository: string;

function by(producer: string, overrides: Partial<ContextProvenance> = {}): ContextProvenance {
  return { producer, producerVersion: '1.0.0', sourceSystem: 'ferret', ...overrides };
}

let counter = 0;
async function record(
  statement: string,
  extra: Partial<Parameters<DurableContextStore['record']>[0]> = {},
): Promise<string> {
  counter += 1;
  const recorded = await context.record({
    statement,
    contextKind: ContextKind.FACT,
    scope: repository,
    provenance: by(`producer-${String(counter)}`),
    ...extra,
  });
  return recorded.context.entity.id;
}

describeDb(`durable context lifecycle and authority (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('context-lifecycle');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    context = new DurableContextStore(handle);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/lifecycle-repo' },
        attributes: { path: '/lifecycle-repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('a proposal is not current context', () => {
    it('records a candidate and keeps it out of current reads', async () => {
      const id = await record('Retrieval should prefer the smallest useful context', {
        state: LifecycleState.CANDIDATE,
      });

      expect((await context.get(id))?.entity.lifecycle).toBe(LifecycleState.CANDIDATE);
      expect((await context.current({ scope: repository })).map((held) => held.entity.id)).not.toContain(id);
      // Asked for, it is there. Nothing was hidden, only not believed.
      expect(
        (await context.current({ scope: repository, states: [LifecycleState.CANDIDATE] })).map(
          (held) => held.entity.id,
        ),
      ).toContain(id);
    });

    it('does not promote a candidate just because someone restates it', async () => {
      const statement = 'A restatement is support, not a decision';
      const id = await record(statement, { state: LifecycleState.CANDIDATE });

      // A second producer says the same thing — and again as `active`.
      const again = await context.record({
        statement,
        contextKind: ContextKind.FACT,
        scope: repository,
        provenance: by('someone-else'),
      });

      expect(again.context.entity.id).toBe(id);
      expect(again.outcome).toBe('merged');
      // Still a candidate. Promotion is a decision, not a side effect of writing.
      expect((await context.get(id))?.entity.lifecycle).toBe(LifecycleState.CANDIDATE);
      // And the support accumulated regardless.
      expect(await evidence.forSubject(id, READ)).toHaveLength(2);
    });

    it('accepts a candidate into current context, keeping its support', async () => {
      const id = await record('Accepted proposals keep the evidence that earned them', {
        state: LifecycleState.CANDIDATE,
      });
      const before = await evidence.forSubject(id, READ);

      const accepted = await context.accept(id);

      expect(accepted.entity.lifecycle).toBe(LifecycleState.ACTIVE);
      expect((await context.current({ scope: repository })).map((held) => held.entity.id)).toContain(id);
      expect(await evidence.forSubject(id, READ)).toStrictEqual(before);
    });

    it('refuses a transition that is not one', async () => {
      const id = await record('Only a candidate may be accepted');

      await expect(context.accept(id)).rejects.toThrow(/is active and cannot be active/);
      await expect(context.reinstate(id)).rejects.toThrow(/cannot be active/);
      // The refusal changed nothing.
      expect((await context.get(id))?.entity.lifecycle).toBe(LifecycleState.ACTIVE);
    });
  });

  describe('archiving retires without deleting', () => {
    it('leaves current reads and keeps every observation', async () => {
      const id = await record('The spikes directory is excluded from linting');
      const before = await evidence.forSubject(id, READ);

      await context.archive(id);

      expect((await context.get(id))?.entity.lifecycle).toBe(LifecycleState.ARCHIVED);
      expect((await context.current({ scope: repository })).map((held) => held.entity.id)).not.toContain(id);
      expect(await evidence.forSubject(id, READ)).toStrictEqual(before);

      // Historical is a category, not a state: asking for it finds this.
      const history = await context.current({
        scope: repository,
        states: HISTORICAL_LIFECYCLE_STATES,
      });
      expect(history.map((held) => held.entity.id)).toContain(id);
    });

    it('is reversible, which is what stops it being a delete', async () => {
      const id = await record('An archive with no way back is a delete under another name');
      await context.archive(id);

      const restored = await context.reinstate(id);

      expect(restored.entity.lifecycle).toBe(LifecycleState.ACTIVE);
      expect((await context.current({ scope: repository })).map((held) => held.entity.id)).toContain(id);
    });

    it('leaves every transitioned record verifying — issue #118', async () => {
      const integrity = new IntegrityService(handle);
      const sweep = await integrity.sweep({ logger });

      expect(
        sweep.findings.filter(
          (finding) =>
            finding.kind === IntegrityFindingKind.CONTENT_HASH_MISMATCH ||
            finding.kind === IntegrityFindingKind.SCHEMA_INVALID,
        ),
      ).toStrictEqual([]);

      // Non-vacuous: there really are records in the new states to get wrong.
      const rows = await handle.execute<{ [column: string]: unknown; n: string }>(sql`
        SELECT count(*)::text AS n FROM ferret.entity
         WHERE kind = 'context' AND lifecycle IN ('candidate', 'archived')
      `);
      expect(Number(rows.rows[0]?.n ?? '0')).toBeGreaterThan(0);
    });
  });

  describe('which record should be believed, and why', () => {
    it('reports a current record with the evidence behind it', async () => {
      const id = await record('The dogfood database is published on localhost only', {
        provenance: by('docs/EPICs/EPIC-107.md', { method: EvidenceMethod.PARSED }),
      });

      const trust = await context.trust(id, READ);

      expect(trust?.current).toBe(true);
      expect(trust?.state).toBe(LifecycleState.ACTIVE);
      expect(trust?.supportCount).toBe(1);
      expect(trust?.authority).toBe(SourceAuthority.PARSED);
      expect(trust?.method).toBe(EvidenceMethod.PARSED);
      expect(trust?.undecided).toBe(false);
      expect(trust?.reason).toMatch(/^current on 1 observation/);
    });

    it('says a superseded record is not the answer, and names the one that is', async () => {
      const old = await record('CI runs on three runners');
      const replacement = await context.record({
        statement: 'CI runs on two runners',
        contextKind: ContextKind.FACT,
        scope: repository,
        provenance: by('docs/EPICs/EPIC-115.md'),
        supersedes: old,
      });

      const before = await context.trust(old, READ);
      const after = await context.trust(replacement.context.entity.id, READ);

      expect(before?.current).toBe(false);
      expect(before?.state).toBe(LifecycleState.SUPERSEDED);
      expect(before?.supersededBy).toBe(replacement.context.entity.id);
      expect(before?.reason).toMatch(/replaced by a later statement/);

      expect(after?.current).toBe(true);
      expect(after?.supersedes).toContain(old);

      // The superseded record kept its own evidence — history is not erased.
      expect(await evidence.forSubject(old, READ)).toHaveLength(1);
    });

    it('declines to choose between two sources that nothing separates', async () => {
      const subject = (
        await entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'src/undecided.ts', scope: repository },
          attributes: { path: 'src/undecided.ts' },
        })
      ).entity.id;

      const id = await record('The retry budget is five attempts per provider', { subjectId: subject });
      // A second source of equal authority and no observation time, saying the
      // same thing in different words — so `preferredEvidence` has nothing to
      // rank by and correctly declines.
      await context.record({
        statement: 'the retry budget is five attempts per provider',
        contextKind: ContextKind.FACT,
        subjectId: subject,
        scope: repository,
        provenance: { producer: 'rival', producerVersion: '2.0.0', sourceSystem: 'other-system' },
      });

      const trust = await context.trust(id, READ);

      expect(trust?.supportCount).toBe(2);
      // Two sources disagreeing about nothing that ranks them: Ferret says so
      // rather than picking one.
      expect(trust?.undecided).toBe(true);
      expect(trust?.preferredEvidenceId).toBeUndefined();
      expect(trust?.reason).toMatch(/nothing in the evidence/);
    });

    it('reports a contradiction without resolving it', async () => {
      const subject = (
        await entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'src/contradicted.ts', scope: repository },
          attributes: { path: 'src/contradicted.ts' },
        })
      ).entity.id;

      const twenty = await record('The default ingestion page limit is twenty pages per pass', {
        subjectId: subject,
      });
      const fifty = await record('The default ingestion page limit is fifty pages per pass', {
        subjectId: subject,
      });

      const trust = await context.trust(fifty, READ);

      expect(trust?.contradictedBy).toContain(twenty);
      expect(trust?.current).toBe(true);
      expect(trust?.reason).toMatch(/contradicted by 1 other record/);
      // Both are still current. Ferret reports the disagreement and picks no
      // winner until a producer says which replaced which.
      expect((await context.trust(twenty, READ))?.current).toBe(true);
    });

    it('says nothing supports a record the caller may not see', async () => {
      const id = await record('This support is scoped away from an anonymous caller', {
        provenance: by('scoped-producer', { permissionScope: 'team:secret' }),
      });

      const withoutScope = await context.trust(id, READ);
      const withScope = await context.trust(id, { permittedScopes: ['team:secret'] });

      expect(withoutScope?.supportCount).toBe(0);
      expect(withoutScope?.reason).toMatch(/nothing visible to this caller supports it/);
      expect(withScope?.supportCount).toBe(1);
    });

    it('has no report for a record that does not exist', async () => {
      expect(await context.trust('00000000-0000-8000-8000-00000000dead', READ)).toBeUndefined();
    });
  });
});
