import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ActorClass,
  EntityKind,
  EvidenceMethod,
  LifecycleState,
  RelationshipType,
  createNullLogger,
} from '../../../src/index.js';
import {
  EntityStore,
  EvidenceStore,
  IdentityStore,
  LinkOutcome,
  RelationshipStore,
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
 * Identity reconciliation against a real PostgreSQL.
 *
 * The behaviours EPIC-009 requires are all about *refusing to guess*: a
 * collision reported rather than merged, a developer never merged with an agent,
 * and history kept when a mapping changes. Each is only meaningful against real
 * constraints and real concurrency.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let entities: EntityStore;
let evidence: EvidenceStore;
let relationships: RelationshipStore;
let store: IdentityStore;
let handle: FerretDatabase;

async function actor(kind: EntityKind, sourceId: string, name: string): Promise<string> {
  const result = await entities.upsert({
    kind,
    source: { system: 'ferret', id: sourceId },
    attributes: kind === EntityKind.DEVELOPER ? { name, emails: [] } : { name },
  });
  return result.entity.id;
}

async function reason(subjectId: string, statement: string): Promise<string> {
  const recorded = await evidence.record({
    subjectId,
    field: 'identity.reconciliation',
    statement,
    method: EvidenceMethod.ASSERTED,
    producer: 'ferret.identity',
    producerVersion: '1.0.0',
    sourceSystem: 'ferret',
  });
  return recorded.evidence.id;
}

describeDb(`identity reconciliation (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let alice: string;
  let bob: string;
  let claude: string;

  beforeAll(async () => {
    db = await createTestDatabase('identity');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);
    relationships = new RelationshipStore(handle);
    store = new IdentityStore(handle);

    alice = await actor(EntityKind.DEVELOPER, 'dev-alice', 'Alice');
    bob = await actor(EntityKind.DEVELOPER, 'dev-bob', 'Bob');
    claude = await actor(EntityKind.AGENT, 'agent-claude', 'claude-code');
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the schema the migration created', () => {
    it('matches what the Drizzle schema declares', async () => {
      const columns = await db.pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'ferret' AND table_name = 'identity_alias' ORDER BY column_name`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

      expect(byName.get('valid_to')?.is_nullable).toBe('YES');
      expect(byName.get('actor_class')?.is_nullable).toBe('NO');
      // Evidence is optional: a GitHub login *is* that account, so there is
      // nothing to infer. It is reconciliation, not assertion, that must be
      // auditable.
      expect(byName.get('evidence_id')?.is_nullable).toBe('YES');
      expect(byName.get('confidence')?.is_nullable).toBe('YES');
    });

    it('enforces one current actor per external identity at the database level', async () => {
      // A backstop behind the explicit collision check, so a code path that
      // forgets to check still cannot corrupt the mapping.
      const indexes = await db.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'ferret' AND tablename = 'identity_alias'`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain('identity_alias_current_idx');
    });
  });

  describe('linking an identity', () => {
    it('maps an external identity to an actor', async () => {
      const result = await store.link({
        system: 'git',
        externalId: 'alice@example.com',
        actorId: alice,
        actorClass: ActorClass.DEVELOPER,
      });

      expect(result.outcome).toBe(LinkOutcome.LINKED);
      expect((await store.resolve('git', 'alice@example.com'))?.actorId).toBe(alice);
    });

    it('is idempotent', async () => {
      const repeat = await store.link({
        system: 'git',
        externalId: 'alice@example.com',
        actorId: alice,
        actorClass: ActorClass.DEVELOPER,
      });
      expect(repeat.outcome).toBe(LinkOutcome.UNCHANGED);

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.identity_alias
          WHERE system = 'git' AND external_id = 'alice@example.com'`,
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('lets one actor hold several identities across systems', async () => {
      await store.link({
        system: 'git',
        externalId: 'alice@old-employer.com',
        actorId: alice,
        actorClass: ActorClass.DEVELOPER,
        evidenceId: await reason(alice, 'same display name and overlapping commit history'),
        confidence: 0.9,
      });
      await store.link({
        system: 'github',
        externalId: 'alice-dev',
        actorId: alice,
        actorClass: ActorClass.DEVELOPER,
      });

      const aliases = await store.aliasesOf(alice);
      expect(aliases.map((entry) => entry.externalId).sort()).toStrictEqual([
        'alice-dev',
        'alice@example.com',
        'alice@old-employer.com',
      ]);
      // The inferred one carries its basis; the stated one does not need to.
      expect(aliases.find((entry) => entry.externalId === 'alice@old-employer.com')?.evidenceId).toBeDefined();
      expect(aliases.find((entry) => entry.externalId === 'alice-dev')?.evidenceId).toBeUndefined();
    });

    it('refuses an identity linked to something that is not an actor', async () => {
      // Only a developer or an agent can hold an identity. Linking one to a
      // commit would produce an actor that is not one.
      const commit = (
        await entities.upsert({
          kind: EntityKind.COMMIT,
          source: { system: 'git', id: 'not-an-actor', scope: 'id-repo' },
          attributes: { sha: 'not-an-actor' },
        })
      ).entity.id;

      await expect(
        store.link({
          system: 'git',
          externalId: 'nonsense',
          actorId: commit,
          actorClass: ActorClass.DEVELOPER,
        }),
      ).rejects.toMatchObject({ code: 'E_IDENTITY_INVALID' });
    });

    it('refuses an alias whose class disagrees with the entity it names', async () => {
      // A record that contradicts itself surfaces much later as a wrong answer
      // about who did something.
      await expect(
        store.link({
          system: 'ferret',
          externalId: 'claude-mislabelled',
          actorId: claude,
          actorClass: ActorClass.DEVELOPER,
        }),
      ).rejects.toMatchObject({ code: 'E_IDENTITY_INVALID' });
    });
  });

  describe('collisions', () => {
    it('reports a second actor claiming an identity, and writes nothing', async () => {
      // AC-5: detected rather than silently merged. Answering this automatically
      // is how two people who shared a shell account become one contributor,
      // permanently and invisibly.
      const result = await store.link({
        system: 'git',
        externalId: 'alice@example.com',
        actorId: bob,
        actorClass: ActorClass.DEVELOPER,
      });

      expect(result.outcome).toBe(LinkOutcome.COLLISION);
      expect(result.collision).toMatchObject({
        existingActorId: alice,
        proposedActorId: bob,
        crossesActorClass: false,
      });

      // Unchanged: the existing mapping still stands.
      expect((await store.resolve('git', 'alice@example.com'))?.actorId).toBe(alice);
      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.identity_alias
          WHERE system = 'git' AND external_id = 'alice@example.com'`,
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('flags a collision that crosses the developer/agent boundary', async () => {
      await store.link({
        system: 'ferret',
        externalId: 'shared@example.com',
        actorId: claude,
        actorClass: ActorClass.AGENT,
      });

      const result = await store.link({
        system: 'ferret',
        externalId: 'shared@example.com',
        actorId: bob,
        actorClass: ActorClass.DEVELOPER,
      });

      expect(result.outcome).toBe(LinkOutcome.COLLISION);
      expect(result.collision?.crossesActorClass).toBe(true);
    });

    it('can be asked about a collision without attempting the link', async () => {
      const collision = await store.collisionFor('git', 'alice@example.com', bob);
      expect(collision?.existingActorId).toBe(alice);
      expect(await store.collisionFor('git', 'alice@example.com', alice)).toBeUndefined();
      expect(await store.collisionFor('git', 'never-seen', bob)).toBeUndefined();
    });
  });

  describe('merging two actors', () => {
    let duplicate: string;
    let survivor: string;

    beforeAll(async () => {
      survivor = await actor(EntityKind.DEVELOPER, 'dev-carol', 'Carol');
      duplicate = await actor(EntityKind.DEVELOPER, 'dev-carol-dup', 'C. Smith');

      await store.link({
        system: 'git',
        externalId: 'carol@example.com',
        actorId: survivor,
        actorClass: ActorClass.DEVELOPER,
      });
      await store.link({
        system: 'git',
        externalId: 'c.smith@example.com',
        actorId: duplicate,
        actorClass: ActorClass.DEVELOPER,
      });
    });

    it('moves the aliases and supersedes the duplicate without deleting it', async () => {
      const evidenceId = await reason(survivor, 'same person: matching display name and commit signature');
      const result = await store.merge(survivor, duplicate, evidenceId);

      expect(result.movedAliases).toHaveLength(1);
      expect((await store.resolve('git', 'c.smith@example.com'))?.actorId).toBe(survivor);

      // Superseded, not deleted — an id that appears in older data must still
      // resolve.
      const merged = await entities.get(duplicate);
      expect(merged?.lifecycle).toBe(LifecycleState.SUPERSEDED);
    });

    it('records the merge as a traceable relationship', async () => {
      const links = await relationships.outgoing(duplicate, {
        type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
      });
      expect(links[0]?.toId).toBe(survivor);
      expect(links[0]?.metadata).toMatchObject({ reason: 'identity-reconciliation' });
    });

    it('keeps the history of who held the identity', async () => {
      // AC-6. Without this, an address reassigned within an organisation would
      // silently reattribute every commit its previous owner made.
      const history = await store.history('git', 'c.smith@example.com');
      expect(history).toHaveLength(2);
      expect(history[0]?.actorId).toBe(duplicate);
      expect(history[0]?.validTo).not.toBeNull();
      expect(history[1]?.actorId).toBe(survivor);
      expect(history[1]?.validTo).toBeNull();
    });

    it('attaches the evidence to the moved alias', async () => {
      const moved = await store.resolve('git', 'c.smith@example.com');
      expect(moved?.evidenceId).toBeDefined();
      const supporting = await evidence.get(moved?.evidenceId ?? '');
      expect(supporting?.statement).toContain('same person');
    });

    it('refuses to merge a developer into an agent', async () => {
      const evidenceId = await reason(survivor, 'attempted cross-class merge');
      await expect(store.merge(survivor, claude, evidenceId)).rejects.toMatchObject({
        code: 'E_IDENTITY_INVALID',
      });
      // And nothing changed.
      expect((await entities.get(claude))?.lifecycle).toBe(LifecycleState.ACTIVE);
    });

    it('refuses to merge an actor into itself', async () => {
      const evidenceId = await reason(survivor, 'self merge');
      await expect(store.merge(survivor, survivor, evidenceId)).rejects.toMatchObject({
        code: 'E_IDENTITY_INVALID',
      });
    });

    it('records no supersession when the merge transaction fails — F-12', async () => {
      // The relationship write sat in a `finally`, which runs on the way out of
      // a `catch` that rethrows. So a merge that never happened - rolled back,
      // or refused before the transaction opened - still asserted
      // ENTITY_SUPERSEDES_ENTITY from the merged identity to the survivor, and
      // the graph was left holding an edge for an event that did not occur.
      //
      // Identity is the one place Ferret cannot correct itself afterwards:
      // `merge` refuses to cross the actor-class boundary, so a false
      // supersession recorded by a refused cross-class merge is not reversible
      // by another merge. This asserts the refusal leaves the graph untouched.
      // The failure has to come from *inside* the transaction. A cross-class or
      // self merge is refused by `assertSameActorClass` before the `try` opens,
      // so the `finally` never runs for those and they prove nothing here. An
      // evidence id that does not exist gets past every pre-check and violates
      // the alias table's foreign key once the transaction is under way, which
      // is the shape of every real failure this guard is about: a constraint, a
      // dropped connection, a deadlock.
      const absentEvidence = '00000000-0000-4000-8000-00000000f12f';
      const left = await actor(EntityKind.DEVELOPER, 'dev-f12-left', 'F12 Left');
      const right = await actor(EntityKind.DEVELOPER, 'dev-f12-right', 'F12 Right');
      await store.link({
        system: 'git',
        externalId: 'f12.right@example.com',
        actorId: right,
        actorClass: ActorClass.DEVELOPER,
      });

      await expect(store.merge(left, right, absentEvidence)).rejects.toBeDefined();

      const edges = await handle.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM "ferret"."relationship"
         WHERE type = 'entity_supersedes_entity' AND from_id = ${right}
      `);
      expect(edges.rows[0]?.n, 'a failed merge recorded a supersession').toBe('0');

      // And the merge really did roll back, so the assertion above is about a
      // missing edge rather than a merge that quietly succeeded.
      expect((await entities.get(right))?.lifecycle).toBe(LifecycleState.ACTIVE);
    });
  });

  describe('an identity that is reassigned', () => {
    it('answers who held it at a past instant', async () => {
      // The whole reason history is retained: attribution of an old commit must
      // not follow a later reassignment.
      const first = await actor(EntityKind.DEVELOPER, 'dev-first-holder', 'First');
      const second = await actor(EntityKind.DEVELOPER, 'dev-second-holder', 'Second');

      await store.link(
        {
          system: 'git',
          externalId: 'shared-desk@example.com',
          actorId: first,
          actorClass: ActorClass.DEVELOPER,
          validFrom: '2026-01-01T00:00:00.000Z',
        },
        new Date('2026-01-01T00:00:00.000Z'),
      );
      await store.unlink('git', 'shared-desk@example.com', new Date('2026-06-01T00:00:00.000Z'));
      await store.link(
        {
          system: 'git',
          externalId: 'shared-desk@example.com',
          actorId: second,
          actorClass: ActorClass.DEVELOPER,
          validFrom: '2026-06-01T00:00:00.000Z',
        },
        new Date('2026-06-01T00:00:00.000Z'),
      );

      expect((await store.resolve('git', 'shared-desk@example.com'))?.actorId).toBe(second);
      expect(
        (await store.resolve('git', 'shared-desk@example.com', new Date('2026-03-01T00:00:00.000Z')))?.actorId,
      ).toBe(first);
      // Half-open, matching EPIC-007: exactly one answer at the handover.
      expect(
        (await store.resolve('git', 'shared-desk@example.com', new Date('2026-06-01T00:00:00.000Z')))?.actorId,
      ).toBe(second);
    });

    it('reports nothing before the first mapping existed', async () => {
      expect(
        await store.resolve('git', 'shared-desk@example.com', new Date('2025-01-01T00:00:00.000Z')),
      ).toBeUndefined();
    });

    it('refuses to end a mapping before it began', async () => {
      const before = await store.resolve('git', 'shared-desk@example.com');
      const result = await store.unlink(
        'git',
        'shared-desk@example.com',
        new Date('2020-01-01T00:00:00.000Z'),
      );
      expect(result?.validTo).toBeNull();
      expect((await store.resolve('git', 'shared-desk@example.com'))?.actorId).toBe(before?.actorId);
    });
  });

  describe('concurrent reconciliation', () => {
    it('lets exactly one of twelve racing actors claim an identity', async () => {
      // An explicit test requirement. The read-decide-write shape here is the
      // same one that produced write skew in EPIC-007, and the same fix applies:
      // a transaction-scoped advisory lock keyed on the external identity.
      const contenders = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          actor(EntityKind.DEVELOPER, `dev-race-${String(index)}`, `Racer ${String(index)}`),
        ),
      );

      const results = await Promise.all(
        contenders.map((actorId) =>
          store.link({
            system: 'git',
            externalId: 'contested@example.com',
            actorId,
            actorClass: ActorClass.DEVELOPER,
          }),
        ),
      );

      expect(results.filter((result) => result.outcome === LinkOutcome.LINKED)).toHaveLength(1);
      expect(results.filter((result) => result.outcome === LinkOutcome.COLLISION)).toHaveLength(11);

      const current = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.identity_alias
          WHERE system = 'git' AND external_id = 'contested@example.com' AND valid_to IS NULL`,
      );
      expect(current.rows[0]?.count).toBe('1');
    }, 120_000);

    it('never leaves two current mappings for one identity, anywhere in the table', async () => {
      // The invariant stated over the whole table, so a future change cannot
      // break it for one code path and pass.
      const duplicates = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM (
           SELECT system, external_id FROM ferret.identity_alias
            WHERE valid_to IS NULL
            GROUP BY system, external_id HAVING count(*) > 1
         ) AS d`,
      );
      expect(duplicates.rows[0]?.count).toBe('0');
    });

    it('serializes only writers contending for the same identity', async () => {
      // Keyed on the identity, not globally: reconciling different people must
      // not queue behind one another, or ingestion would crawl.
      const people = await Promise.all(
        ['p1', 'p2', 'p3', 'p4'].map((suffix) =>
          actor(EntityKind.DEVELOPER, `dev-parallel-${suffix}`, suffix),
        ),
      );

      const started = Date.now();
      await Promise.all(
        people.map((actorId, index) =>
          store.link({
            system: 'git',
            externalId: `parallel-${String(index)}@example.com`,
            actorId,
            actorClass: ActorClass.DEVELOPER,
          }),
        ),
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    }, 60_000);
  });

  describe('durability', () => {
    it('cascades aliases when the actor is removed', async () => {
      const doomed = await actor(EntityKind.DEVELOPER, 'dev-doomed', 'Doomed');
      await store.link({
        system: 'git',
        externalId: 'doomed@example.com',
        actorId: doomed,
        actorClass: ActorClass.DEVELOPER,
      });

      await db.pool.query('DELETE FROM ferret.entity WHERE id = $1', [doomed]);
      expect(await store.resolve('git', 'doomed@example.com')).toBeUndefined();
    });

    it('keeps the alias when its supporting evidence is removed', async () => {
      // The mapping survives losing its justification — with the justification
      // gone rather than the mapping silently gone, which is the honest failure.
      const dave = await actor(EntityKind.DEVELOPER, 'dev-dave', 'Dave');
      const evidenceId = await reason(dave, 'matching signature');
      await store.link({
        system: 'git',
        externalId: 'dave@example.com',
        actorId: dave,
        actorClass: ActorClass.DEVELOPER,
        evidenceId,
      });

      await db.pool.query('DELETE FROM ferret.evidence WHERE id = $1', [evidenceId]);

      const alias = await store.resolve('git', 'dave@example.com');
      expect(alias?.actorId).toBe(dave);
      expect(alias?.evidenceId).toBeUndefined();
    });

    it('survives the server terminating every connection', async () => {
      const before = await store.resolve('git', 'alice@example.com');
      await db.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      expect((await store.resolve('git', 'alice@example.com'))?.actorId).toBe(before?.actorId);
    });
  });
});
