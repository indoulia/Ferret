import { describe, expect, it } from 'vitest';

import {
  ContentUnavailable,
  DEFAULT_MAX_PARSE_BYTES,
  ErrorCode,
  ParserFramework,
  ParserSupport,
  SegmentKind,
  UNPARSED_REASONS,
  UnparsedReason,
  runContentStage,
  type CanonicalEntity,
  type ContentArtifactStore,
  type ContentParser,
  type ContentReader,
  type DiscoveredRepository,
  type ProviderOperationContext,
  type SymbolIndexPort,
} from '../../src/index.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * EPIC-108 §8.9 — one bad file costs exactly itself.
 *
 * Three different things can go wrong with one file, and collapsing any two of
 * them hides a fault inside a statistic: Ferret could not obtain the bytes;
 * Ferret has the bytes and no parser produced a result; the parser was handed
 * the bytes and threw. The first is a provider fault, the second is a fact about
 * the repository, and the third is a defect in a parser. §8.8 gives each its own
 * counter and this file proves they stay apart.
 *
 * Cancellation is the exception that is deliberately not isolated: a cancelled
 * stage fails the run, because a partial count reported as a whole one is the
 * claim Governance §6 forbids, and because the watermark must not move on a run
 * that did not finish (AC-10).
 */

const REPOSITORY = { identityKey: 'r' } as unknown as DiscoveredRepository;
const REPOSITORY_ID = '00000000-0000-4000-8000-000000000001';

function fileVersion(path: string): CanonicalEntity {
  return {
    id: `v-${path}`,
    kind: 'file_version',
    attributes: { path, contentHash: `git-blob:${path}` },
  } as unknown as CanonicalEntity;
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
    indexFileSymbols: (ctx, list) =>
      Promise.resolve({
        path: ctx.path,
        created: list.length,
        updated: 0,
        unchanged: 0,
        tombstoned: 0,
        reinstated: 0,
      }),
    findSymbols: () => Promise.resolve([]),
  };
}

/** A reader whose answer depends on the path, so one run can mix outcomes. */
function mixedReader(): ContentReader {
  return {
    readFileContent: (_repository, request) => {
      if (request.path === 'unreadable.ts') {
        return Promise.resolve({
          read: false,
          reason: ContentUnavailable.UNREADABLE,
          detail: 'the object store is damaged',
        });
      }
      if (request.path === 'huge.ts') {
        return Promise.resolve({
          read: false,
          reason: ContentUnavailable.TOO_LARGE,
          detail: 'larger than the read bound',
        });
      }
      if (request.path === 'over-parse-bound.ts') {
        // Under the provider's read bound and over EPIC-024's parse bound. The
        // two bounds answer different questions, and this is the file that
        // proves the second one is still reachable.
        return Promise.resolve({
          read: true,
          bytes: new Uint8Array(DEFAULT_MAX_PARSE_BYTES + 1),
          sizeBytes: DEFAULT_MAX_PARSE_BYTES + 1,
        });
      }
      const body = new TextEncoder().encode('export function ok(): void {}\n');
      return Promise.resolve({ read: true, bytes: body, sizeBytes: body.length });
    },
  };
}

/** A parser that throws on one path and succeeds on the rest. */
function volatileParser(): ContentParser {
  return {
    parserId: 'test.parser',
    parserVersion: '1.0.0',
    supports: (target) => (target.path.endsWith('.ts') ? ParserSupport.NATIVE : ParserSupport.NONE),
    producerIdentity: () => Promise.resolve('ts@14/aaaa'),
    parse: (request) => {
      if (request.target.path === 'explodes.ts') throw new Error('the parser fell over');
      return {
        segments: [
          {
            kind: SegmentKind.CODE,
            text: 'export function ok(): void {}',
            span: { startByte: 0, endByte: 29, startLine: 1, endLine: 1 },
            label: 'ok',
          },
        ],
        outline: [
          {
            title: 'ok',
            kind: 'function',
            span: { startByte: 0, endByte: 29, startLine: 1, endLine: 1 },
            children: [],
          },
        ],
      };
    },
  };
}

async function run(
  paths: readonly string[],
  signal: AbortSignal = new AbortController().signal,
): Promise<Awaited<ReturnType<typeof runContentStage>>> {
  const context: ProviderOperationContext = { logger: new RecordingLogger(), signal };
  return runContentStage(
    {
      content: mixedReader(),
      symbols: symbols(),
      parser: new ParserFramework({ parsers: [volatileParser()] }),
      artifacts: artifacts(),
      logger: new RecordingLogger(),
    },
    {
      repository: REPOSITORY,
      repositoryId: REPOSITORY_ID,
      entries: paths.map((path) => ({ path, oid: path })),
      emitted: { entities: paths.map((path) => fileVersion(path)) },
      revision: 'HEAD',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    },
    context,
  );
}

describe('failure isolation — AC-9', () => {
  it('completes the run with a throwing parser, an unreadable blob and an over-bound file', async () => {
    // All three in one run, deliberately. Each having its own test would prove
    // each is survivable and not that they are survivable *together*, which is
    // the state a real repository is in.
    const result = await run([
      'good.ts',
      'explodes.ts',
      'unreadable.ts',
      'over-parse-bound.ts',
      'notes.md',
    ]);

    expect(result.counts.filesConsidered).toBe(5);
    expect(result.counts.filesParsed).toBe(1);
    expect(result.counts.filesFailed).toBe(1);
    expect(result.counts.filesUnparsed).toBe(3);
  });

  it('gives each failure its own reason, never a shared one', async () => {
    const result = await run([
      'good.ts',
      'explodes.ts',
      'unreadable.ts',
      'over-parse-bound.ts',
      'notes.md',
    ]);

    expect(result.counts.unparsedReasons[UnparsedReason.PARSER_FAILED]).toBe(1);
    expect(result.counts.unparsedReasons[UnparsedReason.TOO_LARGE]).toBe(1);
    expect(result.counts.unparsedReasons[UnparsedReason.NO_PARSER]).toBe(1);
  });

  it('counts a file it could not read separately from one it could not parse', async () => {
    // The distinction §8.8 calls load-bearing: one is "Ferret could not obtain
    // the bytes", the other is "Ferret has the bytes and no parser produced a
    // result". Collapsing them hides a provider fault inside a parser statistic.
    const unreadable = await run(['unreadable.ts']);
    expect(unreadable.counts.filesFailed).toBe(1);
    expect(unreadable.counts.filesUnparsed).toBe(0);
    expect(unreadable.counts.filesRead).toBe(0);

    const unparsed = await run(['notes.md']);
    expect(unparsed.counts.filesFailed).toBe(0);
    expect(unparsed.counts.filesUnparsed).toBe(1);
    expect(unparsed.counts.filesRead).toBe(1);
  });

  it('treats a blob over the read bound as unobtainable, not as unparsed', async () => {
    // Two bounds, in order. The provider's read bound stops the bytes ever
    // being held, so there is nothing to parse and nothing to call unparsed;
    // EPIC-024's parse bound applies to bytes Ferret does have.
    const result = await run(['huge.ts']);
    expect(result.counts.filesFailed).toBe(1);
    expect(result.counts.filesRead).toBe(0);
    expect(result.counts.filesUnparsed).toBe(0);
  });

  it('still derives structure for a file no parser claimed', async () => {
    // Unparsed is not unread. EPIC-030 works from bytes, not from a parse, so a
    // Markdown file with no parser still gets its structure recorded.
    const result = await run(['notes.md']);
    expect(result.structure.get('notes.md')).toBeDefined();
  });

  it('never lets one bad file stop the ones after it', async () => {
    const result = await run(['explodes.ts', 'unreadable.ts', 'good.ts']);
    expect(result.counts.filesParsed).toBe(1);
    expect(result.structure.get('good.ts')).toBeDefined();
  });
});

describe('the count invariants — AC-11', () => {
  it('keeps filesRead equal to parsed plus unparsed on a mixed run', async () => {
    const result = await run([
      'good.ts',
      'explodes.ts',
      'unreadable.ts',
      'over-parse-bound.ts',
      'notes.md',
      'huge.ts',
    ]);

    expect(result.counts.filesRead).toBe(result.counts.filesParsed + result.counts.filesUnparsed);
  });

  it('excludes files it could not read from filesRead', async () => {
    const result = await run(['unreadable.ts', 'huge.ts', 'good.ts']);
    expect(result.counts.filesRead).toBe(1);
    expect(result.counts.filesFailed).toBe(2);
    expect(result.counts.filesConsidered).toBe(3);
  });

  it('reports every unparsed reason, including the ones that did not occur', async () => {
    // An absent key would make a reader guess whether it meant zero or meant
    // the reason had been removed.
    const result = await run(['good.ts']);
    expect(Object.keys(result.counts.unparsedReasons).sort()).toStrictEqual([...UNPARSED_REASONS].sort());
  });

  it('sums symbol counts from the reports the store returned', async () => {
    const result = await run(['good.ts', 'notes.md']);
    expect(result.counts.symbols.created).toBe(1);
    expect(result.counts.symbols.tombstoned).toBe(0);
  });
});

describe('cancellation — AC-10', () => {
  it('fails the stage rather than returning what it had', async () => {
    // Not isolated like a bad file, and deliberately so: a cancelled stage means
    // the run failed. Returning partial counts would let the caller move the
    // watermark past work that was never done.
    const controller = new AbortController();
    controller.abort();

    await expect(run(['good.ts'], controller.signal)).rejects.toMatchObject({
      code: ErrorCode.INTERRUPTED,
    });
  });

  it('is checked between files, so a large repository stops promptly', async () => {
    // Between files rather than between stages (§8.9). A repository with forty
    // thousand files must stop when it is told to, not when it finishes.
    const controller = new AbortController();
    let readsBeforeAbort = 0;

    const counting: ContentReader = {
      readFileContent: () => {
        readsBeforeAbort += 1;
        if (readsBeforeAbort === 2) controller.abort();
        const body = new TextEncoder().encode('export function ok(): void {}\n');
        return Promise.resolve({ read: true, bytes: body, sizeBytes: body.length });
      },
    };

    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    await expect(
      runContentStage(
        {
          content: counting,
          symbols: symbols(),
          parser: new ParserFramework({ parsers: [volatileParser()] }),
          artifacts: artifacts(),
        },
        {
          repository: REPOSITORY,
          repositoryId: REPOSITORY_ID,
          entries: paths.map((path) => ({ path, oid: path })),
          emitted: { entities: paths.map((path) => fileVersion(path)) },
          revision: 'HEAD',
          observedAt: new Date(),
        },
        { logger: new RecordingLogger(), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED });

    // Stopped at the file after the abort, not at the end of the listing.
    expect(readsBeforeAbort).toBe(2);
  });
});
