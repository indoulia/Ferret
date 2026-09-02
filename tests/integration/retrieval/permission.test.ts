import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMcpServer } from '../../../src/mcp/index.js';

import { ferretConfigSchema } from '../../../src/config/index.js';
import {
  ANONYMOUS_PRINCIPAL,
  accessContextFor,
  principalFrom,
} from '../../../src/authorization/index.js';
import {
  EntityKind,
  EvidenceMethod,
  PUBLIC_ACCESS,
  RelationshipType,
  ScopeKind,
  WithholdReason,
  createNullLogger,
  type AccessContext,
} from '../../../src/index.js';
import {
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  RetrievalStore,
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
 * Permission-aware retrieval against a real PostgreSQL — EPIC-058.
 *
 * The evaluation rules are pure and are proved without a database in
 * `tests/unit/permission-aware-retrieval.test.ts`. What only a real server can
 * demonstrate is the property Governance §12 actually asks for — that
 * authorization is evaluated **before** protected information enters a result.
 *
 * That is not a filtering assertion, it is a *fetching* one, and a mock cannot
 * make it: the test that matters here searches for a term appearing **only**
 * inside a protected evidence statement and asserts the response contains
 * neither the hit nor the statement. Before this Epic that query returned the
 * statement verbatim, because the evidence branch of the search selected
 * `permission_scope` onto the hit and never consulted it.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** A phrase that exists nowhere but inside the protected observation. */
const SECRET_PHRASE = 'zarquon embargo disclosure';
const OPEN_PHRASE = 'ordinary public observation';
const SCOPE = 'jira:restricted-team';

/**
 * The field two protected records disagree about.
 *
 * A conflict group carries no statement, so what leaks is the field name and the
 * ids of the records — which is the disclosure `conflictsFor`'s own test names:
 * "the fields in a conflict group name the fact".
 */
const CONFLICT_FIELD = 'incident-owner';

/** A scope beneath {@link SCOPE}, and a sibling that merely starts the same way. */
const DESCENDANT_SCOPE = `${SCOPE}:alpha`;
const SIBLING_SCOPE = 'jira:restricted-teamwork';
const DESCENDANT_PHRASE = 'quadrant alpha descendant';
const SIBLING_PHRASE = 'quadrant beta sibling';

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let evidence: EvidenceStore;
let retrieval: RetrievalStore;
let subject: string;
let openSubject: string;
let mixedSubject: string;
let hierarchySubject: string;
let repositoryA: string;
let repositoryB: string;
let fileInB: string;

const holding = (...scopes: readonly string[]): AccessContext => ({
  ...PUBLIC_ACCESS,
  permittedScopes: scopes,
});

describeDb(`permission-aware retrieval (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('permission');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);
    retrieval = new RetrievalStore(handle);

    repositoryA = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/repo-a' },
        attributes: { path: '/repo-a' },
      })
    ).entity.id;
    repositoryB = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/repo-b' },
        attributes: { path: '/repo-b' },
      })
    ).entity.id;

    subject = (
      await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-58' },
        attributes: { key: 'FER-58', title: 'Permission-aware retrieval' },
      })
    ).entity.id;
    openSubject = (
      await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-59' },
        attributes: { key: 'FER-59', title: 'An open issue' },
      })
    ).entity.id;

    // A subject a caller holding nothing may partly see: one unscoped record, so
    // `ferret_why` gets past its "nothing held" early return, and two protected
    // records that disagree, so there is a conflict group to leak.
    mixedSubject = (
      await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-83' },
        attributes: { key: 'FER-83', title: 'A partly visible issue' },
      })
    ).entity.id;

    // Two scopes that a substring test would confuse — EPIC-083 AC-5.
    hierarchySubject = (
      await entities.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-83-H' },
        attributes: { key: 'FER-83-H', title: 'A hierarchically scoped issue' },
      })
    ).entity.id;

    fileInB = (
      await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'secrets/keys.txt', scope: repositoryB },
        attributes: { path: 'secrets/keys.txt' },
      })
    ).entity.id;
    await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: 'src/open.ts', scope: repositoryA },
      attributes: { path: 'src/open.ts' },
    });

    // The protected observation. Its statement is the only place the phrase
    // appears anywhere in the database.
    await evidence.record({
      subjectId: subject,
      field: 'summary',
      statement: `${SECRET_PHRASE} — the restricted summary`,
      method: EvidenceMethod.OBSERVED,
      producer: 'ferret.provider.jira',
      producerVersion: '1.0.0',
      sourceSystem: 'jira',
      permissionScope: SCOPE,
    });
    await evidence.record({
      subjectId: openSubject,
      field: 'summary',
      statement: `${OPEN_PHRASE} — anyone may read this`,
      method: EvidenceMethod.OBSERVED,
      producer: 'ferret.provider.jira',
      producerVersion: '1.0.0',
      sourceSystem: 'jira',
    });

    await evidence.record({
      subjectId: hierarchySubject,
      field: 'summary',
      statement: `${DESCENDANT_PHRASE} — beneath the granted scope`,
      method: EvidenceMethod.OBSERVED,
      producer: 'ferret.provider.jira',
      producerVersion: '1.0.0',
      sourceSystem: 'jira',
      permissionScope: DESCENDANT_SCOPE,
    });
    await evidence.record({
      subjectId: hierarchySubject,
      field: 'notes',
      statement: `${SIBLING_PHRASE} — a different team entirely`,
      method: EvidenceMethod.OBSERVED,
      producer: 'ferret.provider.jira',
      producerVersion: '1.0.0',
      sourceSystem: 'jira',
      permissionScope: SIBLING_SCOPE,
    });

    await evidence.record({
      subjectId: mixedSubject,
      field: 'status',
      statement: 'open',
      method: EvidenceMethod.OBSERVED,
      producer: 'ferret.provider.jira',
      producerVersion: '1.0.0',
      sourceSystem: 'jira',
    });
    for (const owner of ['first responder', 'second responder']) {
      await evidence.record({
        subjectId: mixedSubject,
        field: CONFLICT_FIELD,
        statement: owner,
        method: EvidenceMethod.OBSERVED,
        producer: 'ferret.provider.jira',
        producerVersion: '1.0.0',
        sourceSystem: 'jira',
        permissionScope: SCOPE,
      });
    }
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the leak this Epic closes', () => {
    it('never returns a protected statement to a caller holding nothing — AC-2, AC-5', async () => {
      const result = await retrieval.search({ text: SECRET_PHRASE }, PUBLIC_ACCESS);

      expect(result.hits).toStrictEqual([]);
      // Not "no hit about that entity" — the *phrase* must be absent from the
      // whole response. A highlight is generated from the matched text, and a
      // highlight of a protected statement is the same disclosure as the
      // statement.
      expect(JSON.stringify(result)).not.toContain('zarquon');
    });

    it('returns it to a caller holding the scope — AC-3', async () => {
      // The assertion that makes the previous one mean something: a filter that
      // hides everything proves nothing about authorization.
      const result = await retrieval.search({ text: SECRET_PHRASE }, holding(SCOPE));

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.entity.id).toBe(subject);
      expect(String(result.hits[0]?.evidence?.statement)).toContain(SECRET_PHRASE);
    });

    it('still returns unscoped evidence to a caller holding nothing — AC-4', async () => {
      const result = await retrieval.search({ text: OPEN_PHRASE }, PUBLIC_ACCESS);

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.entity.id).toBe(openSubject);
    });

    it('counts what it withheld, and says nothing about it — AC-10', async () => {
      const result = await retrieval.search({ text: SECRET_PHRASE }, PUBLIC_ACCESS);

      expect(result.withheld.total).toBe(1);
      expect(result.withheld.byReason).toStrictEqual({ [WithholdReason.PERMISSION]: 1 });
      expect(Object.keys(result.withheld).sort()).toStrictEqual(['byReason', 'total']);
    });

    it('does not throw when everything matching is protected — AC-11', async () => {
      // A denial is not an error. An error is itself a disclosure, and it would
      // let a caller probe for existence by watching which queries fail.
      await expect(retrieval.search({ text: SECRET_PHRASE }, PUBLIC_ACCESS)).resolves.toBeDefined();
    });

    it('withholds nothing when nothing matching is protected', async () => {
      const result = await retrieval.search({ text: OPEN_PHRASE }, PUBLIC_ACCESS);
      expect(result.withheld.total).toBe(0);
    });
  });

  describe('evidence reads on the traceability path — AC-12', () => {
    it('hides a protected record from a scoped subject read', async () => {
      const held = await evidence.forSubject(subject, { permittedScopes: [] });
      expect(held).toStrictEqual([]);

      const permitted = await evidence.forSubject(subject, { permittedScopes: [SCOPE] });
      expect(permitted).toHaveLength(1);
    });

    it('hides it from the state projection the selection path uses', async () => {
      const stated = await evidence.forSubjectWithState(subject, { permittedScopes: [] });
      expect(stated).toStrictEqual([]);
    });

    it('reports no conflict it may not see', async () => {
      // `conflictsFor` reads current evidence and groups it. Unfiltered, a
      // disagreement between two protected records would be reported to a caller
      // who may see neither — and the fields in a conflict group name the fact.
      expect(await evidence.conflictsFor(subject, { permittedScopes: [] })).toStrictEqual([]);
      expect(await evidence.conflictsFor(subject, { permittedScopes: [SCOPE] })).toStrictEqual([]);
    });

    it('refuses to verify a record the caller may not see, as if absent', async () => {
      const [record] = await evidence.forSubject(subject, { permittedScopes: [SCOPE] });
      const id = record?.id ?? '';

      await expect(evidence.verify(id, { permittedScopes: [] })).rejects.toMatchObject({
        // The same error as a genuinely unknown id, deliberately: a distinct
        // "you may not verify this" would confirm the record exists.
        code: 'E_ENTITY_NOT_FOUND',
      });
      await expect(evidence.verify(id, { permittedScopes: [SCOPE] })).resolves.toBeDefined();
    });

    it('reads everything for an internal caller that supplies no scopes at all', async () => {
      // `Checkpoints/EPIC-008.md:112`: "an internal caller omitting it is
      // correct, a retrieval caller omitting it is a leak." The indexer reads
      // back what it wrote; only the retrieval path is gated, and there the
      // context is a required parameter.
      expect(await evidence.forSubject(subject)).toHaveLength(1);
    });
  });

  describe('the AI surface must not bypass the filter the store implements', () => {
    /**
     * EPIC-083. `EvidenceStore` filters correctly on every read and says so:
     * "Omitted means unrestricted, which is correct for internal callers and
     * **wrong for a query on behalf of a user**" (`storage/evidence.ts`). Its
     * `permissionFilter` even names the failure mode — "exactly how a filter ends
     * up applied on the path everyone tests and missing on the path nobody does".
     *
     * `ferret_why` is that path. It calls `forSubject` without `permittedScopes`,
     * so a protected statement withheld from `ferret_search` is returned by the
     * traceability tool. Nothing in EPIC-058's suite caught it, because every case
     * there exercises the *store* rather than the wiring above it.
     */
    it('does not return through ferret_why what it withholds from search', async () => {
      const server = createMcpServer({
        retrieval,
        evidence,
        // Holds nothing, exactly like the default principal.
        access: holding(),
        logger,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'why-leak-probe', version: '0.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      try {
        // The control: search withholds it, which is EPIC-058 working.
        const searched = (await client.callTool({
          name: 'ferret_search',
          arguments: { query: SECRET_PHRASE },
        })) as { content: { text: string }[] };
        expect(searched.content[0]?.text).not.toContain(SECRET_PHRASE);

        // The same protected statement, asked for a different way.
        const traced = (await client.callTool({
          name: 'ferret_why',
          arguments: { id: subject },
        })) as { content: { text: string }[] };
        expect(traced.content[0]?.text ?? '').not.toContain(SECRET_PHRASE);
      } finally {
        await client.close();
      }
    });

    /**
     * #85 again, ten lines below where it was fixed.
     *
     * `ferret_why` supplies the access context to `forSubject` and to the lineage
     * walk, and then calls `conflictsFor(id)` with no options at all. `ScopedRead`
     * defaults `permittedScopes` to `undefined`, which `permissionFilter` reads as
     * unrestricted — so a disagreement between two records the caller may not see
     * is reported to them, naming the field and both record ids.
     *
     * Narrower than #85: a conflict group carries no statement. It is the same
     * defect nonetheless, and the second instance is the argument that the fix is
     * structural rather than another call site — EPIC-083 AC-1.
     */
    it('does not report through ferret_why a conflict between records it may not see', async () => {
      const server = createMcpServer({ retrieval, evidence, access: holding(), logger });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'conflict-leak-probe', version: '0.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      try {
        const traced = (await client.callTool({
          name: 'ferret_why',
          arguments: { id: mixedSubject },
        })) as { content: { text: string }[] };
        const text = traced.content[0]?.text ?? '';

        // The control: the caller does see this subject, so an empty answer is
        // not what makes the assertion below pass.
        expect(text).toContain('"held": true');
        expect(text).not.toContain(CONFLICT_FIELD);
      } finally {
        await client.close();
      }
    });

    it('still reports a conflict to a caller holding the scope', async () => {
      const server = createMcpServer({ retrieval, evidence, access: holding(SCOPE), logger });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'conflict-visible-probe', version: '0.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      try {
        const traced = (await client.callTool({
          name: 'ferret_why',
          arguments: { id: mixedSubject },
        })) as { content: { text: string }[] };
        expect(traced.content[0]?.text ?? '').toContain(CONFLICT_FIELD);
      } finally {
        await client.close();
      }
    });
  });

  describe('what a permission scope means, in SQL — EPIC-083 AC-5, AC-6', () => {
    /**
     * The rule is pure and is proved without a database in
     * `tests/unit/permission-scope.test.ts`. What only PostgreSQL can show is
     * that the *filter* implements the same rule as the checker — the predicate
     * is a `WHERE` clause built from `LIKE` patterns, and a membership decision
     * that differs between the filter and the checker is two decisions.
     */
    it('shows a descendant scope to a caller holding the parent, through search', async () => {
      const result = await retrieval.search({ text: DESCENDANT_PHRASE }, holding(SCOPE));
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.entity.id).toBe(hierarchySubject);
    });

    it('shows it through the evidence read as well', async () => {
      const held = await evidence.forSubject(hierarchySubject, {
        field: 'summary',
        permittedScopes: [SCOPE],
      });
      expect(held).toHaveLength(1);
      expect(String(held[0]?.statement)).toContain(DESCENDANT_PHRASE);
    });

    it('withholds a sibling whose name merely starts the same way', async () => {
      // `jira:restricted-teamwork` is a different team. A bare prefix match in
      // SQL would hand it over, which is the failure this rule exists to avoid.
      const searched = await retrieval.search({ text: SIBLING_PHRASE }, holding(SCOPE));
      expect(searched.hits).toStrictEqual([]);
      expect(JSON.stringify(searched)).not.toContain('sibling');

      const held = await evidence.forSubject(hierarchySubject, {
        field: 'notes',
        permittedScopes: [SCOPE],
      });
      expect(held).toStrictEqual([]);
    });

    it('shows the sibling to a caller who actually holds it', async () => {
      // The control: a filter that hides everything proves nothing.
      const result = await retrieval.search({ text: SIBLING_PHRASE }, holding(SIBLING_SCOPE));
      expect(result.hits).toHaveLength(1);
    });

    it('does not let a grant containing a LIKE wildcard match beyond what it names', async () => {
      // `%` is a wildcard in `LIKE`, so an unescaped pattern would turn a grant
      // into caller-controlled matching. Escaped, this grant names a scope that
      // does not exist and therefore matches nothing.
      const wildcard = await retrieval.search({ text: DESCENDANT_PHRASE }, holding('jira:restricted-tea%'));
      expect(wildcard.hits).toStrictEqual([]);

      const underscore = await evidence.forSubject(hierarchySubject, {
        field: 'summary',
        permittedScopes: ['jira:restricted-tea_'],
      });
      expect(underscore).toStrictEqual([]);
    });

    it('withholds everything scoped from a caller holding an empty string', async () => {
      // A blank line in a configuration file must not become root access: `''`
      // plus the separator is a prefix of every scoped token.
      const result = await retrieval.search({ text: DESCENDANT_PHRASE }, holding(''));
      expect(result.hits).toStrictEqual([]);
    });
  });


  /**
   * A walk must not continue through a node the caller cannot see — EPIC-050
   * §8.3, AC-10.
   *
   * The sharpest disclosure a multi-hop read can make, and the reason the
   * traversal is an iterative frontier rather than a recursive CTE: if the walk
   * expands through an invisible intermediate, the caller learns that a
   * relationship exists by receiving what lies on the other side of it.
   *
   * `A → B → fileInB`, where `B` and its file are outside the caller's scope.
   */
  describe('a traversal never passes through what it cannot see — EPIC-050 AC-10', () => {
    const onlyA = (): AccessContext => ({
      ...PUBLIC_ACCESS,
      scope: { include: [{ kind: ScopeKind.REPOSITORY, id: repositoryA }], exclude: [] },
    });

    beforeAll(async () => {
      const relationships = new RelationshipStore(handle);
      const at = new Date('2026-01-01T00:00:00.000Z');
      // `entity_supersedes_entity` accepts any endpoint kinds, so the chain
      // needs no new registered type to prove the property.
      await relationships.assert(
        {
          fromId: repositoryA,
          type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
          toId: repositoryB,
          validFrom: at.toISOString(),
          metadata: {},
          sourceSystem: 'git',
        },
        at,
      );
      await relationships.assert(
        {
          fromId: repositoryB,
          type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
          toId: fileInB,
          validFrom: at.toISOString(),
          metadata: {},
          sourceSystem: 'git',
        },
        at,
      );
    });

    it('reaches the far end when the whole chain is visible', async () => {
      // The assertion that stops the one below being vacuous: the graph really
      // does connect A to fileInB in two hops.
      const walk = await retrieval.traverse({ from: repositoryA, depth: 2, limit: 50 }, PUBLIC_ACCESS);

      expect(walk.paths.map((one) => one.entity.id)).toContain(repositoryB);
      expect(walk.paths.map((one) => one.entity.id)).toContain(fileInB);
    });

    it('stops at an invisible intermediate rather than walking through it', async () => {
      const walk = await retrieval.traverse({ from: repositoryA, depth: 3, limit: 50 }, onlyA());
      const reached = walk.paths.map((one) => one.entity.id);

      expect(reached).not.toContain(repositoryB);
      // The point of the Epic's §8.3: not merely that B is hidden, but that
      // nothing *beyond* B comes back either.
      expect(reached).not.toContain(fileInB);
    });

    it('never puts an invisible entity in a path, including as a step', async () => {
      const walk = await retrieval.traverse({ from: repositoryA, depth: 3, limit: 50 }, onlyA());

      for (const path of walk.paths) {
        for (const step of path.steps) {
          expect(step.entityId).not.toBe(repositoryB);
          expect(step.entityId).not.toBe(fileInB);
        }
      }
    });

    it('reports nothing at all from an origin the caller cannot see', async () => {
      const walk = await retrieval.traverse({ from: repositoryB, depth: 2, limit: 50 }, onlyA());

      expect(walk.paths).toStrictEqual([]);
    });
  });

  describe('scope selectors on every read path — AC-6', () => {
    // Built per test rather than in the describe body: the repository id is
    // resolved in `beforeAll`, and a describe-body literal captures `undefined`.
    const onlyA = (): AccessContext => ({
      ...PUBLIC_ACCESS,
      scope: { include: [{ kind: ScopeKind.REPOSITORY, id: repositoryA }], exclude: [] },
    });

    it('hides an entity from another repository in an exact query', async () => {
      const found = await retrieval.findEntities({ kind: EntityKind.FILE, limit: 50 }, onlyA());
      expect(found.map((entity) => entity.id)).not.toContain(fileInB);
      expect(found.length).toBeGreaterThan(0);
    });

    it('hides it from an exact lookup, as absent rather than forbidden', async () => {
      // Withheld and absent give the same answer, so an exact lookup cannot be
      // used to probe for the existence of something protected.
      expect(await retrieval.getEntity(fileInB, onlyA())).toBeUndefined();
      expect(await retrieval.getEntity(fileInB, PUBLIC_ACCESS)).toBeDefined();
    });

    it('hides it from search', async () => {
      const result = await retrieval.search({ text: 'keys.txt' }, onlyA());
      expect(result.hits.map((hit) => hit.entity.id)).not.toContain(fileInB);
    });

    it('hides it from an identifier lookup', async () => {
      const hits = await retrieval.byIdentifier('secrets/keys.txt', onlyA());
      expect(hits).toStrictEqual([]);
      expect(await retrieval.byIdentifier('secrets/keys.txt', PUBLIC_ACCESS)).toHaveLength(1);
    });
  });

  describe('path exclusion at retrieval time — AC-8', () => {
    const excluded: AccessContext = {
      ...PUBLIC_ACCESS,
      exclusions: [{ pattern: 'secrets/**', scope: 'global' }],
    };

    it('withholds an indexed path a rule now excludes', async () => {
      // EPIC-003 made exclusion incapable of deletion precisely so this case
      // would work: the file is indexed, the rule arrived afterwards, and the
      // history is intact.
      const hits = await retrieval.byIdentifier('secrets/keys.txt', excluded);
      expect(hits).toStrictEqual([]);

      const found = await retrieval.findEntities({ kind: EntityKind.FILE, limit: 50 }, excluded);
      expect(found.map((entity) => entity.attributes['path'])).not.toContain('secrets/keys.txt');
    });

    it('cannot be widened by a caller-supplied scope — AC-14', async () => {
      // `ferret_find` accepts a `scope` filter, which a probe flagged as a
      // possible way in. It is not: the caller's scope is ANDed with the access
      // context's predicate, so a supplied scope can only ever narrow. Asserted
      // rather than reasoned about, because "it can only narrow" is exactly the
      // kind of claim that stops being true after a refactor.
      const found = await retrieval.findEntities(
        { kind: EntityKind.FILE, scope: repositoryB, limit: 50 },
        excluded,
      );
      expect(found.map((entity) => entity.attributes['path'])).not.toContain('secrets/keys.txt');
    });

    it('leaves an unexcluded path alone', async () => {
      const found = await retrieval.findEntities({ kind: EntityKind.FILE, limit: 50 }, excluded);
      expect(found.map((entity) => entity.attributes['path'])).toContain('src/open.ts');
    });
  });

  /**
   * A configured grant reaching scoped evidence — EPIC-068 AC-12.
   *
   * EPIC-058 shipped enforcing `permittedScopes` correctly against a set that
   * was **always empty**, because "there is no principal whose scopes could be
   * looked up". This is the first test in which that set is non-empty and came
   * from configuration rather than from a literal in a test.
   */
  describe('a grant from configuration — EPIC-068 AC-12', () => {
    it('reaches scoped evidence the anonymous principal cannot', async () => {
      const configured = ferretConfigSchema.parse({
        authorization: { principalId: 'granted', permissions: ['read'], permittedScopes: [SCOPE] },
      });
      const principal = principalFrom(configured);

      const granted = await retrieval.search({ text: SECRET_PHRASE }, accessContextFor(principal));
      const anonymous = await retrieval.search(
        { text: SECRET_PHRASE },
        accessContextFor(ANONYMOUS_PRINCIPAL),
      );

      expect(granted.hits).toHaveLength(1);
      expect(String(granted.hits[0]?.evidence?.statement)).toContain(SECRET_PHRASE);

      // The same query, the same database, a different grant.
      expect(anonymous.hits).toStrictEqual([]);
      expect(anonymous.withheld.total).toBe(1);
    });

    it('does not reach it on a grant that names a different scope', async () => {
      const other = principalFrom(
        ferretConfigSchema.parse({
          authorization: { permissions: ['read'], permittedScopes: ['jira:some-other-team'] },
        }),
      );

      const result = await retrieval.search({ text: SECRET_PHRASE }, accessContextFor(other));

      expect(result.hits).toStrictEqual([]);
      expect(JSON.stringify(result)).not.toContain('zarquon');
    });

    it('applies configured exclusions through the same conversion', async () => {
      // `accessContextFor` is the only conversion, so an exclusion configured for
      // the installation and a scope granted to the principal arrive together.
      const configured = ferretConfigSchema.parse({
        exclude: ['secrets/**'],
        authorization: { permissions: ['read'], permittedScopes: [SCOPE] },
      });
      const principal = principalFrom(configured);

      const hits = await retrieval.byIdentifier(
        'secrets/keys.txt',
        accessContextFor(principal, configured),
      );

      expect(hits).toStrictEqual([]);
    });
  });
});
