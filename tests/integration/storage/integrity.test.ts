import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EntityKind,
  EvidenceMethod,
  IntegrityFindingKind,
  RelationshipType,
  createNullLogger,
} from '../../../src/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexRunStore,
  IntegrityService,
  RelationshipStore,
  RunOutcome,
  migrate,
  type FerretDatabase,
  type ProducerIdentityResolver,
} from '../../../src/storage/index.js';
import { CONTENT_ARTIFACT_KIND, contentProducerIdentity } from '../../../src/indexing/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-094 — detection against real rows, corrupted the way a corruption
 * actually happens.
 *
 * Every criterion here is a property of a stored row, so the fixtures are direct
 * SQL: EPIC-008 set that bar and it is the right one. A mocked store would
 * assert that a mock was called, and the defect this Epic exists to catch —
 * *nothing recomputed the hash from a stored row* — is precisely the kind a mock
 * cannot see.
 *
 * The sweep is read-only, and `does not repair as it goes` is asserted rather
 * than assumed: a checker that quietly fixed what it found would make its own
 * report unreproducible.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let evidence: EvidenceStore;
let runs: IndexRunStore;
let integrity: IntegrityService;
let repositoryId: string;

async function makeFile(path: string): Promise<string> {
  const result = await entities.upsert({
    kind: EntityKind.FILE,
    source: { system: 'git', id: path, scope: repositoryId },
    attributes: { path },
  });
  return result.entity.id;
}

describeDb(`index integrity (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('integrity');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
    evidence = new EvidenceStore(handle);
    runs = new IndexRunStore(handle);
    integrity = new IntegrityService(handle);

    repositoryId = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/repo' },
        attributes: { name: 'repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('a clean installation — AC-9', () => {
    it('reports no findings, and says the sweep was complete', async () => {
      await makeFile('src/clean.ts');
      const report = await integrity.sweep();

      expect(report.findings).toStrictEqual([]);
      expect(report.complete).toBe(true);
      expect(report.truncated).toStrictEqual([]);
      expect(report.cursor).toBeUndefined();
      expect(report.examined.entities).toBeGreaterThan(0);
    });

    it('gives the same answer twice over an unchanged database', async () => {
      const first = await integrity.sweep();
      const second = await integrity.sweep();

      expect(second.findings).toStrictEqual(first.findings);
      expect(second.examined).toStrictEqual(first.examined);
    });
  });

  describe('an altered row is found — AC-1, AC-2, AC-3, AC-4', () => {
    it('reports an entity whose attributes were edited outside Ferret — AC-1', async () => {
      const id = await makeFile('src/tampered.ts');
      // The whole point of the Epic in one statement: before it, this row
      // verified against nothing and was served as fact.
      await handle.execute(
        sql`UPDATE ferret.entity SET attributes = jsonb_set(attributes, '{path}', '"src/not-what-was-indexed.ts"') WHERE id = ${id}`,
      );

      const report = await integrity.sweep();
      const finding = report.findings.find((one) => one.id === id);

      expect(finding?.kind).toBe(IntegrityFindingKind.CONTENT_HASH_MISMATCH);
      expect(finding?.entityKind).toBe(EntityKind.FILE);
      expect(finding?.canonicalKey).toBeDefined();
    });

    it('reports a re-pointed entity id — AC-3', async () => {
      const id = await makeFile('src/repointed.ts');
      // A row whose id is not what its canonical key derives to. Identity is
      // recomputable, so this is a corruption rather than an opinion.
      const stolen = '00000000-0000-8000-8000-0000000094a3';
      await handle.execute(sql`UPDATE ferret.entity SET id = ${stolen}::uuid WHERE id = ${id}`);

      const report = await integrity.sweep();
      const finding = report.findings.find((one) => one.id === stolen);

      expect(finding?.kind).toBe(IntegrityFindingKind.IDENTITY_MISMATCH);
      await handle.execute(sql`DELETE FROM ferret.entity WHERE id = ${stolen}::uuid`);
    });

    it('reports a relationship whose metadata was edited — AC-2', async () => {
      const to = await makeFile('src/a.ts');
      const asserted = await relationships.assert({
        fromId: repositoryId,
        type: RelationshipType.REPOSITORY_CONTAINS_FILE,
        toId: to,
        fromKind: EntityKind.REPOSITORY,
        toKind: EntityKind.FILE,
        sourceSystem: 'git',
        metadata: { revision: 'HEAD' },
      });
      await handle.execute(
        sql`UPDATE ferret.relationship SET metadata = '{"revision":"tampered"}'::jsonb WHERE id = ${asserted.relationship.id}`,
      );

      const report = await integrity.sweep();
      const finding = report.findings.find((one) => one.id === asserted.relationship.id);

      expect(finding?.kind).toBe(IntegrityFindingKind.CONTENT_HASH_MISMATCH);
    });

    it('reports a tampered observation through the sweep — AC-4', async () => {
      // EPIC-008 had this check and no caller: a per-id `verify` that only
      // helps a caller who already suspects the answer.
      const subject = await makeFile('src/observed.ts');
      const recorded = await evidence.record({
        subjectId: subject,
        field: 'path',
        statement: 'src/observed.ts',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.test',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
      });
      await handle.execute(
        sql`UPDATE ferret.evidence SET statement = '"src/altered.ts"'::jsonb WHERE id = ${recorded.evidence.id}`,
      );

      const report = await integrity.sweep();
      const finding = report.findings.find((one) => one.id === recorded.evidence.id);

      expect(finding?.kind).toBe(IntegrityFindingKind.EVIDENCE_TAMPERED);
      expect(finding?.remediation).toContain('do not edit evidence in place');
    });

    it('names a Ferret command in every remediation, and never SQL — AC-10', async () => {
      const report = await integrity.sweep();

      expect(report.findings.length).toBeGreaterThan(0);
      for (const finding of report.findings) {
        expect(finding.remediation, finding.kind).toContain('ferret ');
        // Governance §13 — the operator this Epic exists for is the one who
        // should not have to become a database administrator.
        expect(finding.remediation.toUpperCase(), finding.kind).not.toContain('UPDATE ');
        expect(finding.remediation.toUpperCase(), finding.kind).not.toContain('SELECT ');
        expect(finding.remediation, finding.kind).not.toContain('ferret.entity');
      }
    });

    it('quotes no stored value in a finding — §11', async () => {
      const report = await integrity.sweep();
      const serialized = JSON.stringify(report.findings.map((one) => one.detail));

      // The tampered values planted above. A diagnostic must not become the
      // surface that reverses EPIC-082's redaction.
      expect(serialized).not.toContain('not-what-was-indexed');
      expect(serialized).not.toContain('src/altered.ts');
      expect(serialized).not.toContain('tampered');
    });

    it('repairs nothing while detecting — the two verbs stay apart', async () => {
      const before = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.entity`,
      );
      await integrity.sweep();
      const after = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.entity`,
      );

      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      // And the corruption planted above is still there, which is the real
      // assertion: a sweep that quietly fixed what it found would make its own
      // report unreproducible.
      const still = await integrity.sweep();
      expect(still.findings.length).toBeGreaterThan(0);
    });
  });

  describe('the bound is reported, never applied silently — AC-5', () => {
    it('says a sweep is incomplete and names the table it stopped in', async () => {
      // The failure mode most worth its own test, because it looks exactly like
      // success: a partial sweep finding nothing is indistinguishable from a
      // clean installation unless it says it was partial.
      const report = await integrity.sweep({ limit: 1 });

      expect(report.complete).toBe(false);
      expect(report.truncated).toContain('entity');
      expect(report.examined.entities).toBe(1);
      expect(report.total.entities).toBeGreaterThan(1);
    });

    it('resumes from where it stopped', async () => {
      const first = await integrity.sweep({ limit: 1 });
      expect(first.cursor).toBeDefined();
      const second = await integrity.sweep({ limit: 1, ...(first.cursor === undefined ? {} : { after: first.cursor }) });

      // A different row, which is what makes the cursor a cursor rather than a
      // decoration on a report that always reads the same first page.
      expect(second.examined.entities).toBe(1);
      expect(second.cursor?.entity).not.toBe(first.cursor?.entity);
    });

    it('states what it examined against what exists', async () => {
      const report = await integrity.sweep({ limit: 2 });

      expect(report.examined.entities).toBeLessThanOrEqual(report.total.entities);
      expect(report.total.entities).toBeGreaterThan(0);
    });
  });

  describe('the run journal — AC-6', () => {
    beforeEach(async () => {
      await handle.execute(sql`DELETE FROM ferret.index_run`);
    });

    it('records a run that started and one that finished', async () => {
      const run = await runs.start({ repositoryKey: '/repo' });
      expect(run).toBeDefined();
      await runs.finish(run?.id ?? '', RunOutcome.SUCCEEDED, { entities: 3 }, repositoryId);

      const open = await runs.unfinished(new Date());
      expect(open).toStrictEqual([]);
    });

    it('reports a run that started and never finished — the killed-process case', async () => {
      // A run killed after stage 2 leaves rows written and, before this Epic, no
      // record that it ever started. The process cannot run its own cleanup, so
      // the open row *is* the evidence.
      const run = await runs.start({ repositoryKey: '/repo' });
      await handle.execute(
        sql`UPDATE ferret.index_run SET started_at = now() - interval '3 hours' WHERE id = ${run?.id ?? ''}::uuid`,
      );

      const report = await integrity.sweep();
      const finding = report.findings.find((one) => one.kind === IntegrityFindingKind.UNFINISHED_RUN);

      expect(finding).toBeDefined();
      expect(finding?.remediation).toContain('ferret index /repo');
    });

    it('does not report a run that is still going', async () => {
      // Age is the only evidence available — the database cannot be asked
      // whether a process is alive — so a fresh open row must not be a finding.
      await runs.start({ repositoryKey: '/repo' });
      const report = await integrity.sweep();

      expect(report.findings.some((one) => one.kind === IntegrityFindingKind.UNFINISHED_RUN)).toBe(false);
    });

    it('keeps the first outcome when a run is closed twice', async () => {
      const run = await runs.start({ repositoryKey: '/repo' });
      await runs.finish(run?.id ?? '', RunOutcome.SUCCEEDED);
      await runs.finish(run?.id ?? '', RunOutcome.FAILED);

      const rows = await handle.execute<{ [column: string]: unknown; outcome: string }>(
        sql`SELECT outcome FROM ferret.index_run WHERE id = ${run?.id ?? ''}::uuid`,
      );
      expect(rows.rows[0]?.outcome).toBe(RunOutcome.SUCCEEDED);
    });

    it('refuses a row that is half closed', async () => {
      // The constraint, exercised directly: a run in progress and a run that
      // ended must not be able to look the same.
      await expect(
        handle.execute(
          sql`INSERT INTO ferret.index_run (id, repository_key, ferret_version, host_pid, finished_at)
              VALUES (gen_random_uuid(), '/repo', '0.0.0', 1, now())`,
        ),
      ).rejects.toThrow();
    });
  });

  /**
   * AC-7 — "a derived artefact of **any** kind … `content-index` included".
   *
   * Recorded PARTIAL because the sweep judged only `ferret.indexer`: a
   * `content-index` artefact records the *parser's* identity, and comparing
   * that to `VERSION` reported all 540 of them stale on a freshly built index.
   * The fix is a seam, not a looser comparison — the caller, which has the
   * parser, says what it would stamp today.
   *
   * Both directions are asserted, because the failure that prompted the
   * `unassessable` bucket was over-reporting: a resolver that cannot judge a
   * row must leave it unjudged rather than call it stale.
   */
  describe('a stale artefact of any kind — AC-7', () => {
    /** A parser-shaped producer version, as measured on Ferret's own index. */
    const OLD_PARSER = 'ferret.parser.code@1.0.0+wts0.25.10+typescript@14/8515aa';
    const NEW_PARSER = 'ferret.parser.code@1.0.0+wts0.26.0+typescript@15/99beef';
    const CONTENT_PRODUCER = 'ferret.indexer.content';

    async function recordContentArtifact(producerVersion: string): Promise<void> {
      await new CompatibilityService(handle, db.pool).recordArtifact({
        kind: CONTENT_ARTIFACT_KIND,
        scopeId: repositoryId,
        producer: CONTENT_PRODUCER,
        producerVersion,
        sourceContentHash: 'abc123',
        metadata: { structure: { path: 'src/a.ts', mediaType: 'text/x-typescript', binary: false, sizeBytes: 20 } },
      });
    }

    /** A resolver that answers with one fixed version, or refuses to answer. */
    function resolver(version: string | undefined): ProducerIdentityResolver {
      return { versionFor: (artifact) => Promise.resolve(artifact.producer === CONTENT_PRODUCER ? version : undefined) };
    }

    it('counts a content artefact unassessable when nothing can judge it', async () => {
      await recordContentArtifact(OLD_PARSER);
      const report = await integrity.sweep({ logger });

      // The behaviour before the seam existed, and still the right answer when
      // no parser was composed: §8 — a check that cannot run says `unknown`.
      expect(report.unassessable).toBeGreaterThan(0);
      expect(report.findings.filter((one) => one.kind === IntegrityFindingKind.STALE_ARTIFACT)).toStrictEqual([]);
    });

    it('reports a content artefact built by a superseded parser', async () => {
      await recordContentArtifact(OLD_PARSER);
      const report = await integrity.sweep({ logger, producerIdentity: resolver(NEW_PARSER) });

      const stale = report.findings.filter((one) => one.kind === IntegrityFindingKind.STALE_ARTIFACT);
      expect(stale).toHaveLength(1);
      // Named, so an operator can tell which parser moved — and the stored
      // value is a producer identity, not repository content, so quoting it
      // does not breach §11.
      expect(stale[0]?.detail).toContain(OLD_PARSER);
      expect(report.unassessable).toBe(0);
    });

    it('leaves a current content artefact alone', async () => {
      await recordContentArtifact(NEW_PARSER);
      const report = await integrity.sweep({ logger, producerIdentity: resolver(NEW_PARSER) });

      expect(report.findings.filter((one) => one.kind === IntegrityFindingKind.STALE_ARTIFACT)).toStrictEqual([]);
      expect(report.unassessable).toBe(0);
    });

    it('does not report stale on the strength of not knowing', async () => {
      // The guard. A resolver that returns `undefined` has said "I cannot
      // judge this", which is not "this is stale". Getting this backwards is
      // how 540 healthy rows were reported corrupt on a freshly built index.
      await recordContentArtifact(OLD_PARSER);
      const report = await integrity.sweep({ logger, producerIdentity: resolver(undefined) });

      expect(report.findings.filter((one) => one.kind === IntegrityFindingKind.STALE_ARTIFACT)).toStrictEqual([]);
      expect(report.unassessable).toBeGreaterThan(0);
    });

    it('agrees with what the content stage writes for an unparsed file', async () => {
      // `record` writes the literal `none` when no parser claims the path, so
      // the resolver must answer `none` too. If the two disagreed, every
      // unparsed file would report stale for ever — the exact over-reporting
      // this criterion was held back to avoid.
      const identity = contentProducerIdentity({ producerVersion: () => Promise.resolve(undefined) });
      await expect(
        identity.versionFor({
          kind: CONTENT_ARTIFACT_KIND,
          producer: CONTENT_PRODUCER,
          metadata: { structure: { path: 'LICENSE', mediaType: 'text/plain', binary: false, sizeBytes: 10 } },
        }),
      ).resolves.toBe('none');
    });

    it('says nothing about an artefact whose metadata carries no structure', async () => {
      // Fails closed: a row this cannot build a target from is unassessable,
      // not stale.
      const identity = contentProducerIdentity({ producerVersion: () => Promise.resolve(NEW_PARSER) });
      await expect(
        identity.versionFor({ kind: CONTENT_ARTIFACT_KIND, producer: CONTENT_PRODUCER, metadata: {} }),
      ).resolves.toBeUndefined();
    });
  });
});
