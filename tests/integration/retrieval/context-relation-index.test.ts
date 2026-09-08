import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContextKind,
  ContextPackBuilder,
  ContextRelation,
  EntityKind,
  IndexSignal,
  PUBLIC_ACCESS,
  RelationshipType,
  createNullLogger,
  renderPack,
  type AccessContext,
  type ContextRelationReader,
} from '../../../src/index.js';
import {
  CodeStateStore,
  DurableContextStore,
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  RetrievalStore,
  migrate,
  type ContextProvenance,
  type FerretDatabase,
  type WorktreeReader,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-139A — the relation index against a real PostgreSQL.
 *
 * The pure rules are covered in `tests/unit/context-aggregate.test.ts`. What
 * only a database proves is the part the measured defect was about: the pack
 * held both endpoints of a real `ENTITY_SUPERSEDES_ENTITY` row and never read
 * it, at four round trips and 2 295 tokens to recover one edge. So these tests
 * are about the real edge, the real `locator` rows, the read count, and the
 * promise that `standing` did not change while all of that arrived.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const QUESTION = 'Should CI add a macOS runner for the storage suites?';
const CI = '.github/workflows/ci.yml';
const EPIC = 'docs/EPICs/EPIC-115-macOS-Packaging-Validation.md';
const RELEASE = 'scripts/package-macos.sh';
const HEAD = 'a'.repeat(40);

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let retrieval: RetrievalStore;
let repository: string;
let otherRepository: string;
let ciFile: string;

/** Counts what the pack asks of the relation port, so AC-23 is measured. */
interface CountingReader extends ContextRelationReader {
  readonly calls: { readonly ids: readonly string[] }[];
}

function counting(inner: ContextRelationReader): CountingReader {
  const calls: { ids: readonly string[] }[] = [];
  return {
    calls,
    relationsAmong: async (ids) => {
      calls.push({ ids: [...ids] });
      return inner.relationsAmong(ids);
    },
  };
}

function by(producer: string, overrides: Partial<ContextProvenance> = {}): ContextProvenance {
  return { producer, producerVersion: '1.0.0', sourceSystem: 'ferret', ...overrides };
}

/** The tree being evaluated. A test moves an indexed path under a statement. */
const live = { headCommit: HEAD, branch: 'main', dirtyPaths: [] as string[], dirtySampleTruncated: false };

const worktree: WorktreeReader = {
  read: () => Promise.resolve({ ...live, dirtyPaths: [...live.dirtyPaths] }),
};

function contextStore(): DurableContextStore {
  return new DurableContextStore(handle, {
    codeState: new CodeStateStore(handle, { access: PUBLIC_ACCESS, worktree }),
  });
}

function builderFor(
  access: AccessContext = PUBLIC_ACCESS,
  relations?: ContextRelationReader,
): ContextPackBuilder {
  return new ContextPackBuilder(retrieval, access, new EvidenceStore(handle), undefined, relations);
}

/** With EPIC-137 wired, so every standing entry carries a verdict. */
function verifyingBuilder(relations?: ContextRelationReader): ContextPackBuilder {
  return new ContextPackBuilder(
    retrieval,
    PUBLIC_ACCESS,
    new EvidenceStore(handle),
    new CodeStateStore(handle, { access: PUBLIC_ACCESS, worktree }),
    relations,
  );
}

/**
 * Points a path at `hash` in `scope`, so an anchor can resolve against it.
 *
 * Retires whatever version it held, so moving a path is a change rather than a
 * second open edge.
 */
async function indexFile(scope: string, path: string, hash: string): Promise<string> {
  const file = (
    await entities.upsert({
      kind: EntityKind.FILE,
      // `source_id` is the repo-relative path for a `file` — that is what
      // `CodeStateStore` resolves an anchor against.
      source: { system: 'git', id: path, scope },
      attributes: { path },
    })
  ).entity.id;
  const version = (
    await entities.upsert({
      kind: EntityKind.FILE_VERSION,
      source: { system: 'git', id: `${file}:${hash}`, scope: file },
      attributes: { contentHash: hash, path },
    })
  ).entity.id;
  const open = await relationships.outgoing(file, { type: RelationshipType.FILE_HAS_VERSION });
  for (const held of open) {
    if (held.toId !== version) await relationships.retire(file, RelationshipType.FILE_HAS_VERSION, held.toId);
  }
  await relationships.assert(
    {
      fromId: file,
      type: RelationshipType.FILE_HAS_VERSION,
      toId: version,
      fromKind: 'file',
      toKind: 'file_version',
      sourceSystem: 'git',
    },
    new Date(),
  );
  return file;
}

async function tableState(): Promise<string> {
  const rows = await handle.execute(sql`
    select
      (select count(*) from ferret.entity) as entities,
      (select count(*) from ferret.relationship) as relationships,
      (select count(*) from ferret.evidence) as evidence,
      (select coalesce(string_agg(id::text || lifecycle, '|' order by id), '') from ferret.entity) as lifecycles
  `);
  return JSON.stringify(rows.rows);
}

describeDb(`the relation index (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('relation-index');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
    retrieval = new RetrievalStore(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/index-repo' },
        attributes: { path: '/index-repo' },
      })
    ).entity.id;
    otherRepository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/other-repo' },
        attributes: { path: '/other-repo' },
      })
    ).entity.id;

    // Correspondence needs an indexed branch whose head is the tree being
    // evaluated — EPIC-137 §8. Without it every verdict is `unknown`.
    await entities.upsert({
      kind: EntityKind.BRANCH,
      source: { system: 'git', id: 'refs/heads/main', scope: repository },
      attributes: { ref: 'refs/heads/main', shortName: 'main', isDefault: true, headCommit: HEAD },
    });
    ciFile = await indexFile(repository, CI, 'b'.repeat(40));
    await indexFile(repository, EPIC, 'c'.repeat(40));
    await indexFile(repository, RELEASE, 'd'.repeat(40));
    await indexFile(otherRepository, CI, 'e'.repeat(40));

    const context = contextStore();

    // The constraint and the decision: both about the CI workflow, both
    // anchored to it, and both naming it as their subject — so one pair
    // exercises the anchor group and the subject group at once.
    await context.record({
      statement:
        'The storage integration suites need a Linux service container for PostgreSQL 17 with pgvector, ' +
        'so they run only on ubuntu-latest',
      contextKind: ContextKind.CONSTRAINT,
      scope: repository,
      subjectId: ciFile,
      provenance: by('ferret.agent', { anchors: [{ path: CI, symbol: 'storage' }] }),
    });
    await context.record({
      statement:
        'A macos-latest job was designed and declined by the owner: macOS left the verify matrix and remote ' +
        'CI for it is not enabled',
      contextKind: ContextKind.DECISION,
      scope: repository,
      subjectId: ciFile,
      provenance: by('ferret.agent', { anchors: [{ path: CI, symbol: 'verify' }] }),
    });

    // A third statement resting on the CI workflow *and* on the Epic that
    // records the decision. Two anchors, so it is the statement that would
    // have bridged unrelated groups under connected components.
    await context.record({
      statement: 'Pull request 140 ran 112 test files and 2463 tests on macos-latest before the runner was dropped',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('ferret.agent', { anchors: [{ path: CI }, { path: EPIC }] }),
    });

    // A statement resting on the Epic alone. It is what makes the Epic a shared
    // record rather than one statement's anchor — and, because it does not rest
    // on the workflow, it is the member that stays verified when the workflow
    // moves under the statement beside it.
    await context.record({
      statement: 'The clause that survives is that no record may claim macOS is validated unless packaging ran there',
      contextKind: ContextKind.GOTCHA,
      scope: repository,
      provenance: by('ferret.agent', { anchors: [{ path: EPIC }] }),
    });

    // A statement resting only on the packaging script: it shares the Epic's
    // vocabulary and no record with the CI group, which is the negative
    // control the design turns on.
    await context.record({
      statement: 'Packaging validation for macOS executes during every tagged release of the desktop bundle',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('ferret.agent', { anchors: [{ path: RELEASE }] }),
    });

    // The supersession, recorded the way an agent records one: state the
    // replacement and name what it replaces.
    const retired = await context.record({
      statement: 'Every release gate for this repository includes a macos-latest runner job',
      contextKind: ContextKind.FACT,
      scope: repository,
      provenance: by('ferret.agent'),
    });
    await context.record({
      statement: 'No release gate for this repository includes a macos-latest runner job any longer',
      contextKind: ContextKind.FACT,
      scope: repository,
      supersedes: retired.context.entity.id,
      provenance: by('ferret.agent'),
    });
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the measured defect', () => {
    it('reports the supersession the pack already held both endpoints of', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const links = pack.relations?.links.filter((one) => one.relation === ContextRelation.SUPERSEDES) ?? [];

      expect(links).toHaveLength(1);
      const [link] = links;
      // Both ends are in the list the pack delivered, so a reader resolves them
      // without another call.
      const ids = pack.standing.map((entry) => entry.id);
      expect(ids).toContain(link?.from);
      expect(ids).toContain(link?.to);
      // The superseded end is still delivered, and still says it is history —
      // keeping it is what makes the replacement checkable.
      expect(pack.standing.find((entry) => entry.id === link?.to)?.current).toBe(false);
      expect(pack.standing.find((entry) => entry.id === link?.from)?.current).toBe(true);
    });

    it('names the relationship row that carries the link', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const link = pack.relations?.links.find((one) => one.relation === ContextRelation.SUPERSEDES);

      const rows = await handle.execute(sql`
        select id::text as id from ferret.relationship where id = ${link?.via ?? ''}::uuid
      `);
      // Not a derivation: the id resolves to the row a person can inspect.
      expect(rows.rows).toHaveLength(1);
    });

    it('carries no index at all when nothing is recorded between the statements', async () => {
      // A build with no reader is the pack as it was before this Epic.
      const pack = await builderFor().build({ question: QUESTION, budget: 6000 });

      expect(pack.relations).toBeUndefined();
    });
  });

  describe('groups over real locator rows', () => {
    it('groups the statements resting on the CI workflow, keyed on its path', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const group = pack.relations?.anchors.find((one) => one.path === CI);

      expect(group?.scope).toBe(repository);
      expect((group?.statements.length ?? 0) >= 2).toBe(true);
      // Every id indexes into the list above it.
      for (const id of group?.statements ?? []) {
        expect(pack.standing.map((entry) => entry.id)).toContain(id);
      }
    });

    it('groups the statements naming the CI workflow as their subject', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const group = pack.relations?.subjects.find((one) => one.subject === ciFile);

      expect(group?.statements.length).toBe(2);
      // A grouping and never an edge: no link anywhere carries a subject.
      for (const link of pack.relations?.links ?? []) {
        expect([ContextRelation.SUPERSEDES, ContextRelation.CONTRADICTS]).toContain(link.relation);
      }
    });

    it('never puts a statement sharing no record with the CI group into it', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const packaging = pack.standing.find((entry) => entry.statement.includes('Packaging validation'));
      const ci = pack.relations?.anchors.find((one) => one.path === CI);

      // It shares the word macOS with every member of the CI group and rests on
      // a different file. Under a component it is one hop from joining through
      // the two-anchor statement; here it cannot.
      expect(ci?.statements).not.toContain(packaging?.id);
      for (const group of pack.relations?.anchors ?? []) {
        if (group.path === RELEASE) continue;
        expect(group.statements).not.toContain(packaging?.id);
      }
    });

    it('does not group one path across two repositories', async () => {
      const context = contextStore();
      const other = await context.record({
        statement: 'The workflow in the second repository pins its runner image explicitly',
        contextKind: ContextKind.GOTCHA,
        scope: otherRepository,
        provenance: by('ferret.agent', { anchors: [{ path: CI }] }),
      });

      const pack = await builderFor(PUBLIC_ACCESS, context).build({ question: QUESTION, budget: 6000 });
      const groups = pack.relations?.anchors.filter((one) => one.path === CI) ?? [];

      // One group per (scope, path). A second repository's `ci.yml` is a
      // different file, and EPIC-137 §5 already put cross-repo anchors out of
      // scope — so the other repository's statement can never appear in the
      // group keyed on this one.
      for (const group of groups) {
        if (group.scope !== repository) continue;
        expect(group.statements).not.toContain(other.context.entity.id);
      }
      expect(new Set(groups.map((group) => group.scope)).size).toBe(groups.length);
    });

    it('reports the signals it read and did not find', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });

      // No contradiction has formed: it needs two same-kind statements sharing
      // a subject at Jaccard 0.8 or above, and none was manufactured. Reported
      // rather than omitted, so the absence is visible.
      expect(pack.relations?.absent).toContain(IndexSignal.CONTRADICTS);
      expect(pack.relations?.absent).not.toContain(IndexSignal.SUPERSEDES);
      expect(pack.relations?.absent).not.toContain(IndexSignal.SHARED_ANCHOR);
      expect(pack.relations?.absent).not.toContain(IndexSignal.SAME_SUBJECT);
    });
  });

  describe('what the index must not change', () => {
    it('leaves `standing` byte-identical with the index present and absent', async () => {
      const without = await builderFor().build({ question: QUESTION, budget: 6000 });
      const withIndex = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });

      expect(JSON.stringify(withIndex.standing)).toBe(JSON.stringify(without.standing));
      expect(withIndex.relations).toBeDefined();
      expect(without.relations).toBeUndefined();
    });

    it('writes nothing', async () => {
      const before = await tableState();
      await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const after = await tableState();

      // Full entity, relationship and evidence state, lifecycles included.
      expect(after).toBe(before);
    });

    it('costs exactly one relation read, whatever the pack contains', async () => {
      const reader = counting(contextStore());
      await builderFor(PUBLIC_ACCESS, reader).build({ question: QUESTION, budget: 6000 });

      expect(reader.calls).toHaveLength(1);
    });

    it('asks only about ids the caller was already given', async () => {
      const reader = counting(contextStore());
      const pack = await builderFor(PUBLIC_ACCESS, reader).build({ question: QUESTION, budget: 6000 });
      const asked = reader.calls[0]?.ids ?? [];

      // The bound and the security property in one assertion: the query is over
      // the page, never the corpus, and the page has already been through the
      // permission filter — so a record the caller may not see is not in the
      // question, and cannot bridge two records that are.
      const delivered = new Set(pack.standing.map((entry) => entry.id));
      for (const id of asked) expect(delivered.has(id)).toBe(true);
    });

    it('produces an identical index on two builds against a fixed store', async () => {
      const builder = builderFor(PUBLIC_ACCESS, contextStore());
      const first = await builder.build({ question: QUESTION, budget: 6000 });
      const second = await builder.build({ question: QUESTION, budget: 6000 });

      expect(JSON.stringify(first.relations)).toBe(JSON.stringify(second.relations));
    });
  });

  describe('budget and rendering', () => {
    it('charges the index and stays inside the budget', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });

      expect(pack.relations?.estimatedTokens).toBeGreaterThan(0);
      expect(pack.estimatedTokens).toBeLessThanOrEqual(pack.budget);
    });

    it('drops the index whole rather than partially, and says so', async () => {
      // Tight enough that the index cannot fit beside the statements it is
      // about. Half an index is a set of silent false negatives, so there is no
      // partial state to find here.
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 300 });

      expect(pack.estimatedTokens).toBeLessThanOrEqual(pack.budget);
      if (pack.relations === undefined) {
        expect(pack.omitted.length).toBeGreaterThan(0);
      } else {
        // If it did fit, it fits completely.
        expect(pack.relations.links.length + pack.relations.anchors.length).toBeGreaterThan(0);
      }
    });

    it('renders the relations after the statements they are about', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const rendered = renderPack(pack);

      const held = rendered.indexOf('## What Ferret currently holds');
      const between = rendered.indexOf('## What Ferret recorded between them');

      expect(held).toBeGreaterThanOrEqual(0);
      expect(between).toBeGreaterThan(held);
      expect(rendered).toContain('supersedes statement');
      // The sentence says what a shared file is and is not.
      expect(rendered).toContain('not evidence that they are one belief');
    });
  });

  describe('verification stays per member — the mandatory-safety property', () => {
    it('holds a verified and a stale statement in one group, and asserts nothing about either', async () => {
      // What EPIC-139A's C3 task and gate G5 are about: a group must never make
      // a stale statement look trustworthy because a group-mate is verified.
      // Statement 2 rests on both the CI workflow and the Epic; statement 7
      // rests on the Epic only. Moving the workflow makes 2 stale and leaves 7
      // verified, and they stay in one group on the Epic.
      const verified = await verifyingBuilder(contextStore()).build({ question: QUESTION, budget: 8000 });
      const before = new Map(verified.standing.map((entry) => [entry.id, entry.verification?.verdict]));
      expect([...before.values()]).toContain('verified');

      // A genuine change to one anchored path — the mechanism EPIC-137 already
      // has, exercised rather than simulated.
      await indexFile(repository, CI, 'f'.repeat(40));
      const after = await verifyingBuilder(contextStore()).build({ question: QUESTION, budget: 8000 });
      const verdicts = new Map(after.standing.map((entry) => [entry.id, entry.verification?.verdict]));

      expect([...verdicts.values()]).toContain('stale');
      expect([...verdicts.values()]).toContain('verified');

      // A group holding both, which is the case the safety rule is about.
      const mixed = (after.relations?.anchors ?? []).filter((group) => {
        const held = group.statements.map((id) => verdicts.get(id));
        return held.includes('stale') && held.includes('verified');
      });
      expect(mixed.length).toBeGreaterThan(0);

      // And the index says nothing about verification: no verdict, no count, no
      // promotion. Each member keeps what EPIC-137 computed.
      expect(JSON.stringify(after.relations)).not.toContain('verified');
      expect(JSON.stringify(after.relations)).not.toContain('stale');
      for (const [id, verdict] of verdicts) {
        if (before.get(id) === undefined) continue;
        // Only the statement resting on the moved path changed.
        const restsOnCi = (after.relations?.anchors ?? []).some(
          (group) => group.path === CI && group.statements.includes(id),
        );
        if (!restsOnCi) expect(verdict).toBe(before.get(id));
      }

      await indexFile(repository, CI, 'b'.repeat(40));
    });
  });

  describe('G2 — independent contribution', () => {
    it('reaches, with each claimed signal, a statement no other signal reaches', async () => {
      // The gate as EPIC-139A §26.6 states it, measured where it is meaningful:
      // every claimed signal must change the index when removed alone. On this
      // corpus each one is the *only* signal connecting some statement, so
      // removing it loses that statement — which is leave-one-out contribution
      // observed directly rather than simulated.
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const index = pack.relations;
      expect(index).toBeDefined();

      const inLinks = new Set(index?.links.flatMap((link) => [link.from, link.to]) ?? []);
      const inAnchors = new Set(index?.anchors.flatMap((group) => group.statements) ?? []);
      const inSubjects = new Set(index?.subjects.flatMap((group) => group.statements) ?? []);

      // `supersedes` — the retired statement carries no anchor and no subject,
      // so nothing but the recorded row reaches it.
      const onlyByLink = [...inLinks].filter((id) => !inAnchors.has(id) && !inSubjects.has(id));
      expect(onlyByLink.length).toBeGreaterThan(0);

      // `shared-anchor` — the two-anchor fact names no subject and is in no
      // link, so nothing but a path reaches it.
      const onlyByAnchor = [...inAnchors].filter((id) => !inLinks.has(id) && !inSubjects.has(id));
      expect(onlyByAnchor.length).toBeGreaterThan(0);

      // `same-subject` — it reports which entity a producer named, which no
      // path reports. Its statements are also anchored, so its contribution is
      // the group itself rather than a statement only it reaches.
      expect(index?.subjects).toHaveLength(1);
      expect(index?.subjects[0]?.statements.length).toBe(2);
    });

    it('claims no signal it does not read, and reads no signal it hides', async () => {
      const pack = await builderFor(PUBLIC_ACCESS, contextStore()).build({ question: QUESTION, budget: 6000 });
      const index = pack.relations;

      // The anti-gaming half: every signal is either present or named absent.
      // A relation cannot be demoted out of the report to avoid being tested.
      const named = new Set([
        ...(index?.links.map((link) => String(link.relation)) ?? []),
        ...((index?.anchors.length ?? 0) > 0 ? [IndexSignal.SHARED_ANCHOR] : []),
        ...((index?.subjects.length ?? 0) > 0 ? [IndexSignal.SAME_SUBJECT] : []),
        ...(index?.absent ?? []),
      ]);
      expect([...named].sort()).toEqual([
        IndexSignal.CONTRADICTS,
        IndexSignal.SAME_SUBJECT,
        IndexSignal.SHARED_ANCHOR,
        IndexSignal.SUPERSEDES,
      ].sort());
    });
  });
});
