import { describe, expect, it } from 'vitest';

import {
  ParserFramework,
  ParserSupport,
  SegmentKind,
  runContentStage,
  type CanonicalEntity,
  type ContentArtifactStore,
  type ContentBlobWriter,
  type ContentParser,
  type ContentReader,
  type DiscoveredRepository,
  type ProviderOperationContext,
  type SymbolIndexPort,
} from '../../src/index.js';
// From the storage subpath, not the core barrel: the core does not export a
// storage module, and a test that could import one from it would be asserting
// the opposite of Governance §4.
import { MAX_STORED_TEXT_BYTES, OMITTED_REASONS, classifyContent } from '../../src/storage/index.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * EPIC-087 — what is decided about a body before the database sees it, and how
 * the stage counts what it stored.
 *
 * The decision is a pure function on purpose: it is the only place the reason a
 * body is missing is derived, and it is the half of the Epic that does not need
 * PostgreSQL to be wrong. Dedup, the generated vector and the permission join
 * are proved in `tests/integration/storage/content-blobs.test.ts`, because none
 * of them exist outside a real database.
 */

const REPOSITORY = { identityKey: 'r' } as unknown as DiscoveredRepository;
const REPOSITORY_ID = '00000000-0000-4000-8000-000000000001';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('classifyContent — EPIC-087 §8.6', () => {
  it('stores a decodable text body verbatim when nothing needs redacting', () => {
    const decision = classifyContent({ contentHash: 'h', bytes: bytes('export const x = 1;\n') });

    expect(decision.text).toBe('export const x = 1;\n');
    expect(decision.omittedReason).toBeUndefined();
    expect(decision.redacted).toEqual({});
  });

  it('records a binary file rather than decoding it', () => {
    const decision = classifyContent({ contentHash: 'h', bytes: new Uint8Array([0, 1, 2]), binary: true });

    expect(decision.text).toBeUndefined();
    expect(decision.omittedReason).toBe(OMITTED_REASONS.BINARY);
  });

  it('refuses a body over the persistence bound, and says which bound', () => {
    // One byte over, so the test fails if the comparison is ever loosened to
    // `>=` or the constant is changed without a decision.
    const decision = classifyContent({
      contentHash: 'h',
      bytes: new Uint8Array(MAX_STORED_TEXT_BYTES + 1),
    });

    expect(decision.omittedReason).toBe(OMITTED_REASONS.OVER_SIZE_BOUND);
    expect(decision.text).toBeUndefined();
  });

  it('stores a body exactly at the bound', () => {
    const decision = classifyContent({ contentHash: 'h', bytes: new Uint8Array(MAX_STORED_TEXT_BYTES) });

    expect(decision.omittedReason).toBeUndefined();
  });

  it('records undecodable bytes rather than storing replacement characters', () => {
    // A lone continuation byte. The permissive decoder would turn this into
    // U+FFFD and store a body that differs from the file, indexing lexemes the
    // repository does not contain.
    const decision = classifyContent({ contentHash: 'h', bytes: new Uint8Array([0x41, 0x80, 0x42]) });

    expect(decision.omittedReason).toBe(OMITTED_REASONS.UNDECODABLE);
    expect(decision.text).toBeUndefined();
  });

  it('redacts a credential before the body is ever returned — AC-5', () => {
    const source = 'const c = { url: "postgres://ferret:sup3rsecret@db:5432/x" };\n';
    const decision = classifyContent({ contentHash: 'h', bytes: bytes(source) });

    expect(decision.text).toBeDefined();
    expect(decision.text).not.toContain('sup3rsecret');
    expect(Object.keys(decision.redacted).length).toBeGreaterThan(0);
  });

  it('reports redaction as kinds and counts, never as values', () => {
    const decision = classifyContent({
      contentHash: 'h',
      bytes: bytes('AWS_SECRET_ACCESS_KEY=abcd1234efgh5678\n'),
    });

    for (const value of Object.values(decision.redacted)) expect(typeof value).toBe('number');
    expect(JSON.stringify(decision.redacted)).not.toContain('abcd1234efgh5678');
  });

  it('keeps an empty file storable rather than calling it an omission', () => {
    // An empty file is content Ferret has, not content it declined to hold. The
    // XOR constraint in migration 0011 makes the distinction load-bearing: a row
    // with neither text nor a reason cannot be written at all.
    const decision = classifyContent({ contentHash: 'h', bytes: new Uint8Array(0) });

    expect(decision.text).toBe('');
    expect(decision.omittedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The stage's arithmetic.
// ---------------------------------------------------------------------------

function fileVersion(path: string, hash: string): CanonicalEntity {
  return { id: `v-${path}`, kind: 'file_version', attributes: { path, contentHash: hash } } as unknown as CanonicalEntity;
}

function artifacts(): ContentArtifactStore {
  return {
    getArtifact: () => Promise.resolve(undefined),
    validateArtifact: () => ({ valid: false, reason: 'never recorded' }),
    recordArtifact: () => Promise.resolve(undefined),
  };
}

function symbols(): SymbolIndexPort {
  return {
    indexFileSymbols: (ctx) =>
      Promise.resolve({ path: ctx.path, created: 0, updated: 0, unchanged: 0, tombstoned: 0, reinstated: 0 }),
    findSymbols: () => Promise.resolve([]),
  };
}

function reader(bodies: ReadonlyMap<string, string>): ContentReader {
  return {
    readFileContent: (_repository, request) => {
      const body = bytes(bodies.get(request.path) ?? 'export const ok = 1;\n');
      return Promise.resolve({ read: true, bytes: body, sizeBytes: body.length });
    },
  };
}

function parser(): ContentParser {
  return {
    parserId: 'test.parser',
    parserVersion: '1.0.0',
    supports: (target) => (target.path.endsWith('.ts') ? ParserSupport.NATIVE : ParserSupport.NONE),
    producerIdentity: () => Promise.resolve('ts@14/aaaa'),
    parse: () => ({
      segments: [
        {
          kind: SegmentKind.CODE,
          text: 'x',
          span: { startByte: 0, endByte: 1, startLine: 1, endLine: 1 },
          label: 'x',
        },
      ],
      outline: [],
    }),
  };
}

/** A writer that remembers hashes, so dedup is observable without a database. */
function recordingBlobs(options: { failOn?: string } = {}): ContentBlobWriter & {
  readonly seen: Map<string, number>;
} {
  const seen = new Map<string, number>();
  return {
    seen,
    store: (input) => {
      if (input.contentHash === options.failOn) return Promise.reject(new Error('the store said no'));
      const before = seen.get(input.contentHash) ?? 0;
      seen.set(input.contentHash, before + 1);
      const decision = classifyContent(input);
      return Promise.resolve({
        deduplicated: before > 0,
        omittedReason: decision.omittedReason,
        redacted: decision.redacted,
      });
    },
  };
}

async function run(
  files: readonly { path: string; hash: string }[],
  blobs: ContentBlobWriter | undefined,
  bodies: ReadonlyMap<string, string> = new Map(),
): Promise<Awaited<ReturnType<typeof runContentStage>>> {
  const context: ProviderOperationContext = {
    logger: new RecordingLogger(),
    signal: new AbortController().signal,
  };
  return runContentStage(
    {
      content: reader(bodies),
      symbols: symbols(),
      parser: new ParserFramework({ parsers: [parser()] }),
      artifacts: artifacts(),
      ...(blobs === undefined ? {} : { blobs }),
      logger: new RecordingLogger(),
    },
    {
      repository: REPOSITORY,
      repositoryId: REPOSITORY_ID,
      entries: files.map((f) => ({ path: f.path, oid: f.path })),
      emitted: { entities: files.map((f) => fileVersion(f.path, f.hash)) },
      revision: 'HEAD',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    },
    context,
  );
}

describe('the content stage stores what it read — EPIC-087 §12', () => {
  it('counts one stored blob per file it read', async () => {
    const blobs = recordingBlobs();
    const result = await run(
      [
        { path: 'a.ts', hash: 'h-a' },
        { path: 'b.ts', hash: 'h-b' },
      ],
      blobs,
    );

    expect(result.counts.blobs.stored).toBe(2);
    expect(result.counts.blobs.deduplicated).toBe(0);
    expect(result.counts.blobs.failed).toBe(0);
  });

  it('reports the second file with identical content as deduplicated — AC-2', async () => {
    const blobs = recordingBlobs();
    const result = await run(
      [
        { path: 'a.ts', hash: 'same' },
        { path: 'copy-of-a.ts', hash: 'same' },
      ],
      blobs,
    );

    expect(result.counts.blobs.stored).toBe(1);
    expect(result.counts.blobs.deduplicated).toBe(1);
    expect(blobs.seen.get('same')).toBe(2);
  });

  it('keeps parsing when the store rejects a file — AC-13', async () => {
    // The file is still read, still parsed and still indexed. Content retrieval
    // is an additional answer; losing it is not a reason to lose the symbols
    // this run already opened the file for.
    const result = await run(
      [
        { path: 'a.ts', hash: 'boom' },
        { path: 'b.ts', hash: 'fine' },
      ],
      recordingBlobs({ failOn: 'boom' }),
    );

    expect(result.counts.blobs.failed).toBe(1);
    expect(result.counts.blobs.stored).toBe(1);
    expect(result.counts.filesParsed).toBe(2);
    expect(result.counts.filesFailed).toBe(0);
  });

  it('breaks omissions down by reason rather than summing them', async () => {
    const result = await run(
      [
        { path: 'text.ts', hash: 'h1' },
        { path: 'big.ts', hash: 'h2' },
      ],
      recordingBlobs(),
      new Map([['big.ts', 'x'.repeat(MAX_STORED_TEXT_BYTES + 1)]]),
    );

    expect(result.counts.blobs.textOmitted).toEqual({ [OMITTED_REASONS.OVER_SIZE_BOUND]: 1 });
  });

  it('indexes exactly as before when no blob writer is composed', async () => {
    // EPIC-108 is VALIDATED and its composition must keep working untouched.
    const result = await run([{ path: 'a.ts', hash: 'h-a' }], undefined);

    expect(result.counts.filesParsed).toBe(1);
    expect(result.counts.blobs).toEqual({ stored: 0, deduplicated: 0, failed: 0, textOmitted: {} });
  });

  it('never logs a redacted value', async () => {
    const logger = new RecordingLogger();
    const context: ProviderOperationContext = { logger, signal: new AbortController().signal };
    await runContentStage(
      {
        content: reader(new Map([['a.ts', 'API_KEY=hunter2hunter2\n']])),
        symbols: symbols(),
        parser: new ParserFramework({ parsers: [parser()] }),
        artifacts: artifacts(),
        blobs: recordingBlobs(),
        logger,
      },
      {
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        entries: [{ path: 'a.ts', oid: 'a.ts' }],
        emitted: { entities: [fileVersion('a.ts', 'h-a')] },
        revision: 'HEAD',
        observedAt: new Date('2026-01-01T00:00:00Z'),
      },
      context,
    );

    expect(JSON.stringify(logger.records)).not.toContain('hunter2hunter2');
  });
});
