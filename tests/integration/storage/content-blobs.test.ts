import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  PUBLIC_ACCESS,
  ScopeKind,
  createNullLogger,
  type AccessContext,
} from '../../../src/index.js';
import {
  ContentStore,
  EntityStore,
  MAX_STORED_TEXT_BYTES,
  OMITTED_REASONS,
  RetrievalStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-087 against a real PostgreSQL.
 *
 * Four things exist only here and cannot be mocked into existence: the primary
 * key that makes storing idempotent, the generated `tsvector` — whose expression
 * must be `IMMUTABLE` or migration `0011` does not apply at all — the
 * camel-splitting that decides whether a body is reachable by the words a person
 * types, and the join that keeps a deduplicated blob from crossing a permission
 * boundary.
 *
 * The last one is the reason this file is long. A blob is shared by definition:
 * the same bytes at two paths are one row, and if those paths are in two
 * repositories, a content branch that ranked on the blob alone would answer a
 * query with source the caller cannot list. That is #87's shape, and it is
 * cheaper to prove than to remember.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** A word that exists in a file's body and in no path, name or message. */
const BODY_ONLY = 'zarquon';
/** An identifier a person would search for by its first word. */
const IDENTIFIER_BODY = 'export function authenticateUser(email: string): boolean { return true; }\n';

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let content: ContentStore;
let retrieval: RetrievalStore;
let repositoryA: string;
let repositoryB: string;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A `file` in a repository and a `file_version` of it carrying a content hash.
 *
 * Both, because that is the shape the Git provider writes and the shape the
 * content branch traverses: the blob is addressed by the version's hash and the
 * hit is the file. Creating only the version would make the tests below pass
 * against a graph Ferret never produces.
 */
async function fileWithVersion(path: string, contentHash: string, repository: string): Promise<string> {
  const file = await entities.upsert({
    kind: EntityKind.FILE,
    source: { system: 'git', id: path, scope: repository },
    attributes: { path },
  });
  await entities.upsert({
    kind: EntityKind.FILE_VERSION,
    source: { system: 'git', id: contentHash, scope: file.entity.id },
    attributes: { path, contentHash },
  });
  return file.entity.id;
}

async function rowCount(): Promise<number> {
  const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
    sql`SELECT count(*)::text AS n FROM ferret.content_blob`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

describeDb(`deduplicated content storage (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('content-blobs');
    // Migration 0011 applying at all is AC-14 and half of §8.4: a generated
    // column whose expression is not IMMUTABLE is rejected here, not later.
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    content = new ContentStore(handle);
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
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('one row per distinct content — AC-1, AC-2, AC-3', () => {
    it('stores content the first time and deduplicates every time after', async () => {
      const before = await rowCount();
      const first = await content.store({ contentHash: 'h:dedup', bytes: bytes('const a = 1;\n') });
      const second = await content.store({ contentHash: 'h:dedup', bytes: bytes('const a = 1;\n') });

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(await rowCount()).toBe(before + 1);
    });

    it('keeps one row for the same bytes reached by two different paths', async () => {
      // The deduplication claim itself. Two file versions, two paths, one body.
      const before = await rowCount();
      await fileWithVersion('src/a.ts', 'h:shared', repositoryA);
      await fileWithVersion('src/copy-of-a.ts', 'h:shared', repositoryA);
      await content.store({ contentHash: 'h:shared', bytes: bytes('shared body\n') });
      await content.store({ contentHash: 'h:shared', bytes: bytes('shared body\n') });

      expect(await rowCount()).toBe(before + 1);
    });

    it('does not overwrite a stored body when the same hash is stored again', async () => {
      // `ON CONFLICT DO NOTHING`, proved by storing different bytes under a hash
      // already held: the hash is the identity, and the first body wins. A store
      // that silently updated would make the row a function of run order.
      await content.store({ contentHash: 'h:stable', bytes: bytes('original\n') });
      await content.store({ contentHash: 'h:stable', bytes: bytes('a different body\n') });

      expect((await content.read('h:stable'))?.text).toBe('original\n');
    });
  });

  describe('what is stored, and what is honestly not — AC-4 through AC-7', () => {
    it('round-trips a text body', async () => {
      await content.store({
        contentHash: 'h:text',
        bytes: bytes('export const x = 1;\n'),
        mediaType: 'text/x-typescript',
        encoding: 'utf-8',
      });
      const body = await content.read('h:text');

      expect(body?.text).toBe('export const x = 1;\n');
      expect(body?.mediaType).toBe('text/x-typescript');
      expect(body?.byteSize).toBe(20);
      expect(body?.omittedReason).toBeUndefined();
    });

    it('stores a credential-bearing file with the credential gone — AC-5', async () => {
      await content.store({
        contentHash: 'h:secret',
        bytes: bytes('const dsn = "postgres://ferret:hunter2hunter2@db:5432/x";\n'),
      });

      const body = await content.read('h:secret');
      expect(body?.text).not.toContain('hunter2hunter2');

      // Not merely absent from the read path: absent from the table. A read-time
      // control is one a new caller can forget, which is why §8.2 puts it before
      // the insert.
      const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.content_blob WHERE text_content LIKE '%hunter2hunter2%'`,
      );
      expect(rows.rows[0]?.n).toBe('0');
    });

    it('records an over-bound body as present and empty, with the reason — AC-6', async () => {
      const result = await content.store({
        contentHash: 'h:big',
        bytes: new Uint8Array(MAX_STORED_TEXT_BYTES + 1),
      });
      const body = await content.read('h:big');

      expect(result.omittedReason).toBe(OMITTED_REASONS.OVER_SIZE_BOUND);
      expect(body?.text).toBeUndefined();
      expect(body?.omittedReason).toBe(OMITTED_REASONS.OVER_SIZE_BOUND);
      expect(body?.byteSize).toBe(MAX_STORED_TEXT_BYTES + 1);
    });

    it('records a binary file without its bytes — AC-7', async () => {
      await content.store({ contentHash: 'h:bin', bytes: new Uint8Array([0, 1, 2, 3]), binary: true });
      const body = await content.read('h:bin');

      expect(body?.omittedReason).toBe(OMITTED_REASONS.BINARY);
      expect(body?.text).toBeUndefined();
    });

    it('refuses a row that is neither text nor a stated reason', async () => {
      // The XOR constraint, exercised directly. Governance §6 — a row that is
      // silently empty is the one shape the table must not be able to hold, and
      // a constraint is the only version of that promise a future caller cannot
      // route around.
      await expect(
        handle.execute(
          sql`INSERT INTO ferret.content_blob (content_hash, byte_size) VALUES ('h:neither', 1)`,
        ),
      ).rejects.toThrow();
    });

    it('refuses an unrecognised omission reason', async () => {
      await expect(
        handle.execute(
          sql`INSERT INTO ferret.content_blob (content_hash, byte_size, omitted_reason)
              VALUES ('h:bogus', 1, 'because')`,
        ),
      ).rejects.toThrow();
    });

    it('answers nothing for a hash it does not hold', async () => {
      expect(await content.read('h:never-stored')).toBeUndefined();
    });
  });

  describe('reaching a file by what is inside it — AC-8, AC-10', () => {
    beforeAll(async () => {
      await fileWithVersion('src/notes.ts', 'h:body-only', repositoryA);
      await content.store({
        contentHash: 'h:body-only',
        bytes: bytes(`// a note about the ${BODY_ONLY} protocol\nexport const n = 1;\n`),
      });
      await fileWithVersion('src/auth/login.ts', 'h:identifier', repositoryA);
      await content.store({ contentHash: 'h:identifier', bytes: bytes(IDENTIFIER_BODY) });
    });

    it('finds a file by a term appearing only in its body — AC-8', async () => {
      const result = await retrieval.search({ text: BODY_ONLY }, PUBLIC_ACCESS);

      const hit = result.hits.find((one) => one.entity.attributes['path'] === 'src/notes.ts');
      expect(hit).toBeDefined();
      expect(hit?.source).toBe('content');
      // The file, not the version of it. A person searching for a word inside a
      // file is looking for the file; EPIC-096's labels say so independently,
      // and resolving to the version scored recall 0.00 against them.
      expect(hit?.entity.kind).toBe(EntityKind.FILE);
    });

    it('shows the matched line rather than the file name', async () => {
      const result = await retrieval.search({ text: BODY_ONLY }, PUBLIC_ACCESS);
      const hit = result.hits.find((one) => one.entity.attributes['path'] === 'src/notes.ts');

      expect(hit?.highlight).toContain('protocol');
    });

    it('reaches `authenticateUser` from the word `authenticate` — AC-10', async () => {
      // The measurement this Epic exists to move. Without the camel split in
      // migration 0011 the body is one lexeme, `authenticateuser`, and this
      // query matches nothing — a table full of bodies and the same 0.00.
      const result = await retrieval.search({ text: 'authenticate' }, PUBLIC_ACCESS);

      const paths = result.hits.map((one) => one.entity.attributes['path']);
      expect(paths).toContain('src/auth/login.ts');
    });

    it('still finds prose by its own words', async () => {
      // The split copy is additional, not a replacement: `email` appears in the
      // body verbatim and must not have been mangled out of the vector.
      const result = await retrieval.search({ text: 'email' }, PUBLIC_ACCESS);

      expect(result.hits.map((one) => one.entity.attributes['path'])).toContain('src/auth/login.ts');
    });

    it('returns nothing for a term in no body, no path and no message — AC-12', async () => {
      const result = await retrieval.search({ text: 'kubernetes' }, PUBLIC_ACCESS);

      expect(result.hits).toStrictEqual([]);
    });
  });

  describe('a shared blob does not cross a permission boundary — AC-9', () => {
    const SHARED_HASH = 'h:cross-repo';
    const SHARED_PHRASE = 'quadrant embargo notice';

    beforeAll(async () => {
      // The same bytes in two repositories — one row, two file versions. This is
      // exactly the state deduplication creates and the state a naive content
      // branch leaks from.
      await fileWithVersion('src/shared.ts', SHARED_HASH, repositoryA);
      await fileWithVersion('vendor/shared.ts', SHARED_HASH, repositoryB);
      await content.store({ contentHash: SHARED_HASH, bytes: bytes(`// ${SHARED_PHRASE}\n`) });
    });

    it('holds one row for content present in two repositories', async () => {
      const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.content_blob WHERE content_hash = ${SHARED_HASH}`,
      );
      expect(rows.rows[0]?.n).toBe('1');
    });

    it('returns only the file version in the repository the caller may see', async () => {
      const restricted: AccessContext = {
        ...PUBLIC_ACCESS,
        scope: { include: [{ kind: ScopeKind.REPOSITORY, id: repositoryA }], exclude: [] },
      };
      const result = await retrieval.search({ text: SHARED_PHRASE }, restricted);

      const paths = result.hits.map((one) => one.entity.attributes['path']);
      expect(paths).toContain('src/shared.ts');
      expect(paths).not.toContain('vendor/shared.ts');
    });

    it('leaks no body to a caller scoped to a repository that holds none of it', async () => {
      const elsewhere: AccessContext = {
        ...PUBLIC_ACCESS,
        scope: { include: [{ kind: ScopeKind.REPOSITORY, id: repositoryB }], exclude: [] },
      };
      const result = await retrieval.search({ text: BODY_ONLY }, elsewhere);

      // `zarquon` exists only in a body scoped to repository A. Neither the hit
      // nor the highlight may appear.
      expect(JSON.stringify(result.hits)).not.toContain(BODY_ONLY);
    });
  });

  describe('what the store holds — §12', () => {
    it('reports blobs, bodies and stored bytes', async () => {
      const stats = await content.stats();

      expect(stats.blobs).toBeGreaterThan(0);
      expect(stats.withText).toBeGreaterThan(0);
      expect(stats.withText).toBeLessThanOrEqual(stats.blobs);
      expect(stats.textBytes).toBeGreaterThan(0);
    });
  });
});
