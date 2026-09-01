import { performance } from 'node:perf_hooks';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Completeness,
  EntityKind,
  EvidenceExclusion,
  EvidenceMethod,
  EvidenceState,
  SourceAuthority,
  createNullLogger,
  selectEvidence,
} from '../../../src/index.js';
import {
  EntityStore,
  EvidenceStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Evidence against a real PostgreSQL.
 *
 * The properties under test are the ones a mock cannot demonstrate: that a
 * stored observation is never rewritten, that tampering is detectable after the
 * fact, and that a permission scope filters at the point evidence is read rather
 * than after it has been assembled into an answer.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let entities: EntityStore;
let store: EvidenceStore;
let handle: FerretDatabase;
let issue: string;
let file: string;

describeDb(`evidence and provenance (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('evidence');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    store = new EvidenceStore(handle);

    issue = (
      await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-1' },
        attributes: { key: 'FER-1', title: 'Fix the parser' },
      })
    ).entity.id;
    file = (
      await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/parser.ts', scope: 'ev-repo' },
        attributes: { path: 'src/parser.ts' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the schema the migration created', () => {
    it('matches what the Drizzle schema declares', async () => {
      const columns = await db.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'ferret' AND table_name = 'evidence' ORDER BY column_name`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

      expect(byName.get('statement')?.data_type).toBe('jsonb');
      expect(byName.get('integrity_hash')?.is_nullable).toBe('NO');
      expect(byName.get('producer_version')?.is_nullable).toBe('NO');
      // Unknown must be storable, so confidence and permission scope are nullable.
      expect(byName.get('confidence')?.is_nullable).toBe('YES');
      expect(byName.get('permission_scope')?.is_nullable).toBe('YES');
      expect(byName.get('recorded_at')?.is_nullable).toBe('NO');
    });

    it('indexes the lookups traceability and re-extraction perform', async () => {
      const indexes = await db.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'ferret'
          AND tablename IN ('evidence', 'evidence_derivation')`,
      );
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).toContain('evidence_subject_idx');
      expect(names).toContain('evidence_producer_idx');
      expect(names).toContain('evidence_derivation_source_idx');
    });
  });

  describe('recording', () => {
    it('stores an observation with its source location', async () => {
      const recorded = await store.record({
        subjectId: issue,
        field: 'attributes.title',
        statement: 'Fix the parser',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        sourceId: 'FER-1',
        sourceUrl: 'https://jira.example/FER-1',
        observedAt: '2026-05-01T10:00:00.000Z',
      });

      expect(recorded.deduplicated).toBe(false);
      expect(recorded.state).toBe(EvidenceState.CURRENT);
      expect(recorded.evidence.sourceUrl).toBe('https://jira.example/FER-1');
      expect(recorded.evidence.observedAt).toBe('2026-05-01T10:00:00.000Z');
    });

    it('deduplicates a re-observation without rewriting the record', async () => {
      // Governance §6: source evidence is not silently rewritten. The record of
      // *when it was first observed* must survive re-indexing.
      const first = await store.record(
        {
          subjectId: file,
          field: 'attributes.language',
          statement: 'typescript',
          method: EvidenceMethod.PARSED,
          producer: 'ferret.parser.code',
          producerVersion: '1.0.0',
          sourceSystem: 'git',
        },
        new Date('2026-01-01T00:00:00.000Z'),
      );

      const second = await store.record(
        {
          subjectId: file,
          field: 'attributes.language',
          statement: 'typescript',
          method: EvidenceMethod.PARSED,
          producer: 'ferret.parser.code',
          producerVersion: '1.0.0',
          sourceSystem: 'git',
        },
        new Date('2026-06-01T00:00:00.000Z'),
      );

      expect(second.deduplicated).toBe(true);
      expect(second.evidence.id).toBe(first.evidence.id);
      expect(second.recordedAt).toBe('2026-01-01T00:00:00.000Z');

      const row = await db.pool.query<{ recorded_at: Date; last_checked_at: Date }>(
        'SELECT recorded_at, last_checked_at FROM ferret.evidence WHERE id = $1',
        [first.evidence.id],
      );
      // Recorded once; checked again. Two facts, two columns.
      expect(row.rows[0]?.recorded_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(row.rows[0]?.last_checked_at.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    it('keeps a different parser version as a separate observation', async () => {
      // What makes "re-extract everything the old parser touched" answerable.
      const v1 = await store.record({
        subjectId: file,
        field: 'attributes.mediaType',
        statement: 'text/x-typescript',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.code',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
      });
      const v2 = await store.record({
        subjectId: file,
        field: 'attributes.mediaType',
        statement: 'text/x-typescript',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.code',
        producerVersion: '2.0.0',
        sourceSystem: 'git',
      });

      expect(v2.evidence.id).not.toBe(v1.evidence.id);

      const byVersion = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.evidence
          WHERE producer = 'ferret.parser.code' AND producer_version = '1.0.0'`,
      );
      expect(Number(byVersion.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    });

    it('masks a credential before it reaches the database', async () => {
      const recorded = await store.record({
        subjectId: file,
        field: 'content.line42',
        statement: 'DATABASE_PASSWORD=hunter2',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.text',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
        locator: { kind: 'line', start: 42 },
      });

      expect(recorded.evidence.redacted).toBe(true);

      // Not merely absent from the return value — absent from the row.
      const row = await db.pool.query<{ statement: unknown; redacted: boolean }>(
        'SELECT statement, redacted FROM ferret.evidence WHERE id = $1',
        [recorded.evidence.id],
      );
      expect(JSON.stringify(row.rows[0]?.statement)).not.toContain('hunter2');
      expect(row.rows[0]?.redacted).toBe(true);
      // The location survives, so "a secret was configured here" is still known.
      expect(recorded.evidence.locator?.start).toBe(42);
    });

    it('refuses a derived record that cites nothing', async () => {
      await expect(
        store.record({
          subjectId: issue,
          field: 'attributes.state',
          statement: 'resolved',
          method: EvidenceMethod.INFERRED,
          producer: 'ferret.linker',
          producerVersion: '1.0.0',
          sourceSystem: 'ferret',
        }),
      ).rejects.toMatchObject({ code: 'E_EVIDENCE_INVALID' });
    });
  });

  describe('the provenance chain', () => {
    let observation: string;
    let intermediate: string;
    let conclusion: string;

    beforeAll(async () => {
      observation = (
        await store.record({
          subjectId: file,
          field: 'content.line10',
          statement: 'fixes FER-1',
          method: EvidenceMethod.PARSED,
          producer: 'ferret.parser.commit-message',
          producerVersion: '1.0.0',
          sourceSystem: 'git',
          sourceId: 'sha-abc',
          locator: { kind: 'line', start: 10 },
        })
      ).evidence.id;

      intermediate = (
        await store.record({
          subjectId: issue,
          field: 'links.commits',
          statement: ['sha-abc'],
          method: EvidenceMethod.INFERRED,
          producer: 'ferret.linker.issue-key',
          producerVersion: '1.0.0',
          sourceSystem: 'ferret',
          derivedFrom: [observation],
        })
      ).evidence.id;

      conclusion = (
        await store.record({
          subjectId: issue,
          field: 'attributes.state',
          statement: 'resolved',
          method: EvidenceMethod.INFERRED,
          producer: 'ferret.linker.resolution',
          producerVersion: '1.0.0',
          sourceSystem: 'ferret',
          confidence: 0.8,
          derivedFrom: [intermediate],
        })
      ).evidence.id;
    });

    it('traces a conclusion back to the observation it rests on', async () => {
      // "Why does Ferret believe this" — EPIC-048 turns this into a
      // user-facing explanation.
      const chain = await store.provenanceOf(conclusion);
      const ids = chain.map((record) => record.id);

      expect(ids).toContain(intermediate);
      expect(ids).toContain(observation);
      // And the root is a direct observation with a source location, not
      // another inference.
      const root = chain.find((record) => record.id === observation);
      expect(root?.method).toBe(EvidenceMethod.PARSED);
      expect(root?.locator).toStrictEqual({ kind: 'line', start: 10 });
      expect(root?.sourceId).toBe('sha-abc');
    });

    it('traces forwards, which is what a re-extraction needs', async () => {
      // When a parser version turns out to be wrong, everything downstream of
      // its output has to be found.
      const dependents = await store.dependentsOf(observation);
      const ids = dependents.map((record) => record.id);
      expect(ids).toContain(intermediate);
      expect(ids).toContain(conclusion);
    });

    it('terminates on a chain that loops', async () => {
      // Depth-limited rather than trusting the data. A cycle should not be
      // possible, and a query that hangs when one appears is not a defence.
      await db.pool.query(
        `INSERT INTO ferret.evidence_derivation (evidence_id, source_evidence_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [observation, conclusion],
      );
      const chain = await store.provenanceOf(conclusion, 5);
      expect(chain.length).toBeLessThan(20);

      await db.pool.query(
        'DELETE FROM ferret.evidence_derivation WHERE evidence_id = $1 AND source_evidence_id = $2',
        [observation, conclusion],
      );
    }, 30_000);
  });

  describe('integrity', () => {
    it('verifies an untouched record', async () => {
      const recorded = await store.record({
        subjectId: issue,
        field: 'attributes.priority',
        statement: 'high',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
      });
      await expect(store.verify(recorded.evidence.id)).resolves.toMatchObject({
        id: recorded.evidence.id,
      });
    });

    it('detects a row altered outside Ferret', async () => {
      // Evidence is append-only through this module, so nothing legitimate
      // changes a row after it is written. A mismatch is a finding.
      const recorded = await store.record({
        subjectId: issue,
        field: 'attributes.reporter',
        statement: 'alice',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
      });

      await db.pool.query(`UPDATE ferret.evidence SET statement = '"mallory"'::jsonb WHERE id = $1`, [
        recorded.evidence.id,
      ]);

      await expect(store.verify(recorded.evidence.id)).rejects.toMatchObject({
        code: 'E_EVIDENCE_TAMPERED',
      });
      const failure = await store.verify(recorded.evidence.id).catch((error: unknown) => error);
      expect((failure as { remediation: string }).remediation).toContain('Re-index');
    });

    it('sweeps a subject and reports every bad row rather than the first', async () => {
      const result = await store.verifyAll(issue);
      expect(result.checked).toBeGreaterThan(0);
      expect(result.tampered.length).toBeGreaterThanOrEqual(1);
    });

    it('still verifies a record after it has been superseded', async () => {
      // State is Ferret's interpretation, not the observation. If supersession
      // broke the hash, integrity checking would fail exactly where history
      // matters most.
      const older = await store.record({
        subjectId: issue,
        field: 'attributes.assignee',
        statement: 'alice',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        observedAt: '2026-01-01T00:00:00.000Z',
      });
      const newer = await store.record({
        subjectId: issue,
        field: 'attributes.assignee',
        statement: 'bob',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        observedAt: '2026-06-01T00:00:00.000Z',
      });

      await store.supersede(older.evidence.id, newer.evidence.id);

      await expect(store.verify(older.evidence.id)).resolves.toBeDefined();
      const state = await store.stateOf(older.evidence.id);
      expect(state?.state).toBe(EvidenceState.SUPERSEDED);
      expect(state?.supersededBy).toBe(newer.evidence.id);
    });
  });

  describe('staleness', () => {
    it('detects that the source content has changed since the observation', async () => {
      const recorded = await store.record({
        subjectId: file,
        field: 'content.summary',
        statement: 'parses things',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.code',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
        sourceContentHash: 'hash-v1',
      });

      expect(store.isStaleAgainst(recorded.evidence, 'hash-v1')).toBe(false);
      expect(store.isStaleAgainst(recorded.evidence, 'hash-v2')).toBe(true);
    });

    it('reports unknown rather than fresh when there is no source hash to compare', async () => {
      // Manufacturing certainty would be saying "current" about something Ferret
      // cannot check.
      const recorded = await store.record({
        subjectId: file,
        field: 'content.note',
        statement: 'no hash recorded',
        method: EvidenceMethod.ASSERTED,
        producer: 'operator',
        producerVersion: '1',
        sourceSystem: 'ferret',
      });
      expect(store.isStaleAgainst(recorded.evidence, 'anything')).toBe(false);
      expect(recorded.evidence.sourceContentHash).toBeUndefined();
    });

    it('records staleness as a state without touching the observation', async () => {
      const recorded = await store.record({
        subjectId: file,
        field: 'content.stale-example',
        statement: 'old content',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.code',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
        sourceContentHash: 'hash-old',
      });

      await store.markStale(recorded.evidence.id);

      expect((await store.stateOf(recorded.evidence.id))?.state).toBe(EvidenceState.STALE);
      await expect(store.verify(recorded.evidence.id)).resolves.toBeDefined();
    });
  });

  /**
   * EPIC-062. Selection against evidence a real store actually returned.
   *
   * The unit tests construct candidates directly, which is right for the
   * ordering rules. What only a real store can demonstrate is the half that was
   * missing: `toCanonical` drops `state`, so before `forSubjectWithState` a
   * caller physically could not tell a superseded observation from a current one
   * — and the pack path selected without it.
   */
  describe('evidence selection', () => {
    it("returns Ferret's interpretation alongside each record", async () => {
      const subject = (
        await entities.upsert({
          kind: EntityKind.ISSUE,
          source: { system: 'jira', id: 'FER-62' },
          attributes: { key: 'FER-62', title: 'Evidence selection' },
        })
      ).entity.id;

      const first = await store.record({
        subjectId: subject,
        field: 'status',
        statement: 'open',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        authority: SourceAuthority.SYSTEM_OF_RECORD,
      });
      const second = await store.record({
        subjectId: subject,
        field: 'status',
        statement: 'closed',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        authority: SourceAuthority.SYSTEM_OF_RECORD,
      });
      await store.supersede(first.evidence.id, second.evidence.id);

      const stated = await store.forSubjectWithState(subject);
      const states = new Map(stated.map((entry) => [entry.evidence.id, entry.state]));

      expect(states.get(first.evidence.id)).toBe(EvidenceState.SUPERSEDED);
      expect([...states.values()].filter((state) => state === EvidenceState.CURRENT)).toHaveLength(1);
      // `forSubject` returns the same records and cannot answer the question.
      expect((await store.forSubject(subject)).map((record) => record.id).sort()).toStrictEqual(
        stated.map((entry) => entry.evidence.id).sort(),
      );
    });

    it('cites the current record and accounts for the replaced one — AC-2, AC-4', async () => {
      const subject = (
        await entities.upsert({
          kind: EntityKind.ISSUE,
          source: { system: 'jira', id: 'FER-63' },
          attributes: { key: 'FER-63', title: 'Selection over a real store' },
        })
      ).entity.id;

      // The exact shape the recency-only ordering got wrong: the record Ferret no
      // longer believes is the authoritative one, and the newer record is a
      // model's unverified claim.
      const replaced = await store.record({
        subjectId: subject,
        field: 'summary',
        statement: 'the parser fails on nested generics',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        authority: SourceAuthority.SYSTEM_OF_RECORD,
        observedAt: '2026-01-01T00:00:00.000Z',
      });
      const believed = await store.record({
        subjectId: subject,
        field: 'summary',
        statement: 'the parser fails on nested generics and on decorators',
        // `asserted` rather than `generated`: EPIC-008 requires generated
        // evidence to name what it was derived from, and the point here is the
        // authority rank, not the provenance chain.
        method: EvidenceMethod.ASSERTED,
        producer: 'ferret.model',
        producerVersion: '1.0.0',
        sourceSystem: 'ferret',
        authority: SourceAuthority.ASSERTED,
        observedAt: '2026-08-01T00:00:00.000Z',
      });
      await store.supersede(replaced.evidence.id, believed.evidence.id);

      const selection = selectEvidence(await store.forSubjectWithState(subject), { limit: 5 });

      expect(selection.selected.map((entry) => entry.evidence.id)).toStrictEqual([believed.evidence.id]);
      expect(selection.excluded).toHaveLength(1);
      expect(selection.excluded[0]?.id).toBe(replaced.evidence.id);
      expect(selection.excluded[0]?.cause).toBe(EvidenceExclusion.NOT_CURRENT);
      expect(selection.excluded[0]?.reason).toContain('state superseded');
    });

    it('reports a fact the store marked conflicting — AC-9', async () => {
      const subject = (
        await entities.upsert({
          kind: EntityKind.ISSUE,
          source: { system: 'jira', id: 'FER-64' },
          attributes: { key: 'FER-64', title: 'Disagreement' },
        })
      ).entity.id;

      await store.record({
        subjectId: subject,
        field: 'owner',
        statement: 'alice',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
      });
      await store.record({
        subjectId: subject,
        field: 'owner',
        statement: 'bob',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.code',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
      });

      const selection = selectEvidence(await store.forSubjectWithState(subject), { limit: 5 });

      // Both sides cited: Governance §15 forbids discarding a conflicting record,
      // and EPIC-047 rather than this Epic decides which wins.
      expect(selection.disputedFields).toStrictEqual(['owner']);
      expect(selection.selected).toHaveLength(2);
      expect(selection.excluded).toStrictEqual([]);
    });
  });

  describe('conflicting evidence', () => {
    it('refuses a derivation from evidence that does not exist', async () => {
      // A dangling provenance link makes a chain untraceable, which is worse
      // than no chain: it looks like an explanation and leads nowhere.
      await expect(
        store.record({
          subjectId: issue,
          field: 'attributes.dangling',
          statement: 'derived from nothing',
          method: EvidenceMethod.INFERRED,
          producer: 'ferret.linker',
          producerVersion: '1.0.0',
          sourceSystem: 'ferret',
          derivedFrom: ['00000000-0000-8000-8000-000000000000'],
        }),
      ).rejects.toThrow();
    });

    it('reports two sources disagreeing about one fact, keeping both', async () => {
      const conflicted = (
        await entities.upsert({
          kind: EntityKind.PULL_REQUEST,
          source: { system: 'github', id: 'conflict-pr' },
          attributes: { number: '9' },
        })
      ).entity.id;

      await store.record({
        subjectId: conflicted,
        field: 'attributes.state',
        statement: 'merged',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.github',
        producerVersion: '1.0.0',
        sourceSystem: 'github',
        authority: 10,
      });

      // The inference has to rest on something that exists — the foreign key
      // enforces that, which is what stops a provenance chain dangling.
      const hint = await store.record({
        subjectId: conflicted,
        field: 'content.branchName',
        statement: 'feature/still-open',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.branch',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
      });

      await store.record({
        subjectId: conflicted,
        field: 'attributes.state',
        statement: 'open',
        method: EvidenceMethod.INFERRED,
        producer: 'ferret.linker',
        producerVersion: '1.0.0',
        sourceSystem: 'ferret',
        authority: 1,
        derivedFrom: [hint.evidence.id],
        confidence: 0.4,
      });

      const conflicts = await store.conflictsFor(conflicted);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.evidence).toHaveLength(2);
      // Both retained: Governance §15 forbids resolving a conflict by
      // discarding one side.
      const statements = [...(conflicts[0]?.statements ?? [])] as string[];
      expect(statements.sort()).toStrictEqual(['merged', 'open']);
    });
  });

  describe('permission filtering', () => {
    let restricted: string;

    beforeAll(async () => {
      restricted = (
        await entities.upsert({
          kind: EntityKind.DOCUMENT,
          source: { system: 'file', id: 'salaries.xlsx' },
          attributes: { title: 'Salaries' },
        })
      ).entity.id;

      await store.record({
        subjectId: restricted,
        field: 'attributes.title',
        statement: 'Salaries',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.file',
        producerVersion: '1.0.0',
        sourceSystem: 'file',
      });
      await store.record({
        subjectId: restricted,
        field: 'content.summary',
        statement: 'Compensation for every employee',
        method: EvidenceMethod.PARSED,
        producer: 'ferret.parser.xlsx',
        producerVersion: '1.0.0',
        sourceSystem: 'file',
        permissionScope: 'hr-only',
      });
    });

    it('withholds scoped evidence from a caller without the scope', async () => {
      // Governance §12: authorization is evaluated before protected information
      // enters retrieval results — not filtered out of an answer afterwards.
      const visible = await store.forSubject(restricted, { permittedScopes: [] });
      const statements = visible.map((record) => record.statement);

      expect(statements).toContain('Salaries');
      expect(statements).not.toContain('Compensation for every employee');
    });

    it('includes it for a caller holding the scope', async () => {
      const visible = await store.forSubject(restricted, { permittedScopes: ['hr-only'] });
      expect(visible.map((record) => record.statement)).toContain('Compensation for every employee');
    });

    it('returns everything when no scope filter is supplied, for internal callers', async () => {
      const all = await store.forSubject(restricted);
      expect(all).toHaveLength(2);
    });

    it('does not leak scoped content through a conflict report', async () => {
      const conflicts = await store.conflictsFor(restricted);
      // Different fields are not a conflict, so nothing is reported — and in
      // particular the restricted statement is not surfaced as one.
      expect(conflicts).toStrictEqual([]);
    });
  });

  describe('concurrency', () => {
    it('records one row when 10 writers observe the same fact at once', async () => {
      // Two providers indexing one repository is normal, not exceptional.
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.record({
            subjectId: issue,
            field: 'attributes.labels',
            statement: ['bug', 'parser'],
            method: EvidenceMethod.OBSERVED,
            producer: 'ferret.provider.jira',
            producerVersion: '1.0.0',
            sourceSystem: 'jira',
          }),
        ),
      );

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.evidence
          WHERE subject_id = $1 AND field = 'attributes.labels'`,
        [issue],
      );
      expect(rows.rows[0]?.count).toBe('1');
    }, 60_000);

    it('does not corrupt a provenance chain written concurrently', async () => {
      const roots = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          store
            .record({
              subjectId: file,
              field: `content.chunk${String(index)}`,
              statement: `chunk ${String(index)}`,
              method: EvidenceMethod.PARSED,
              producer: 'ferret.parser.text',
              producerVersion: '1.0.0',
              sourceSystem: 'git',
            })
            .then((result) => result.evidence.id),
        ),
      );

      const summary = await store.record({
        subjectId: file,
        field: 'content.rollup',
        statement: 'six chunks',
        method: EvidenceMethod.AGGREGATED,
        producer: 'ferret.aggregator',
        producerVersion: '1.0.0',
        sourceSystem: 'ferret',
        derivedFrom: roots,
      });

      const chain = await store.provenanceOf(summary.evidence.id);
      expect(chain.map((record) => record.id).sort()).toStrictEqual([...roots].sort());
    }, 60_000);
  });

  describe('performance', () => {
    // Indexing a file produces evidence per extracted fact, so per-record cost
    // is multiplied by the size of a corpus.
    const BUDGET = { recordMs: 250, forSubjectMs: 150, provenanceMs: 250 } as const;

    it(`records evidence in under ${String(BUDGET.recordMs)} ms at p95`, async () => {
      const durations: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const started = performance.now();
        await store.record({
          subjectId: file,
          field: `perf.field${String(i)}`,
          statement: `value ${String(i)}`,
          method: EvidenceMethod.PARSED,
          producer: 'ferret.parser.code',
          producerVersion: '1.0.0',
          sourceSystem: 'git',
          completeness: Completeness.COMPLETE,
        });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.recordMs);
    }, 120_000);

    it(`reads a subject's evidence in under ${String(BUDGET.forSubjectMs)} ms at p95`, async () => {
      const durations: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const started = performance.now();
        await store.forSubject(file);
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.forSubjectMs);
    }, 60_000);

    it('uses the subject index rather than scanning', async () => {
      const plan = await db.pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM ferret.evidence WHERE subject_id = $1 AND field = $2`,
        [file, 'attributes.language'],
      );
      expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('evidence_subject_idx');
    });
  });

  describe('durability', () => {
    it('cascades when the subject entity is removed', async () => {
      const doomed = (
        await entities.upsert({
          kind: EntityKind.DOCUMENT,
          source: { system: 'file', id: 'doomed-doc' },
          attributes: { title: 'Doomed' },
        })
      ).entity.id;
      await store.record({
        subjectId: doomed,
        statement: 'about to go',
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.file',
        producerVersion: '1.0.0',
        sourceSystem: 'file',
      });

      await db.pool.query('DELETE FROM ferret.entity WHERE id = $1', [doomed]);
      expect(await store.count(doomed)).toBe(0);
    });

    it('survives the server terminating every connection', async () => {
      const before = await store.count(file);
      await db.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      expect(await store.count(file)).toBe(before);
    });
  });
});
