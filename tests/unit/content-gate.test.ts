import { describe, expect, it } from 'vitest';

import {
  CONTENT_ARTIFACT_KIND,
  CONTENT_PRODUCER,
  ParserFramework,
  ParserSupport,
  SegmentKind,
  UnparsedReason,
  contentScopeId,
  runContentStage,
  type CanonicalEntity,
  type ContentArtifactStore,
  type ContentParser,
  type ContentReader,
  type DerivedArtifactRecord,
  type DiscoveredRepository,
  type ParseTarget,
  type ProviderOperationContext,
  type SymbolIndexPort,
} from '../../src/index.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * EPIC-108 §8.7 — the re-parse gate's decision table, and the flow it gates.
 *
 * A unit test because the decision is arithmetic over four values — content
 * hash, parser id, parser version, grammar identity — and a decision table
 * proved against a real database is a decision table proved slowly and
 * incompletely. What genuinely needs PostgreSQL (the write counts of AC-6, the
 * mass-tombstoning regression) belongs to the integration suite.
 *
 * The property under test throughout: **an unchanged file is not re-read**, and
 * a parser or grammar change *is* a change. The gate consults the content hash
 * `listFiles` already returned, which is what lets it skip the read rather than
 * merely the parse — a gate that skipped only the parse would still pay for
 * every byte of the repository on every run.
 */

const REPOSITORY = { identityKey: 'r', root: '/r' } as unknown as DiscoveredRepository;
const REPOSITORY_ID = '00000000-0000-4000-8000-000000000001';
const HASH = 'git-blob:abc123';

function context(): ProviderOperationContext {
  return { logger: new RecordingLogger(), signal: new AbortController().signal };
}

function fileVersion(path: string, contentHash: string): CanonicalEntity {
  return {
    id: `v-${path}`,
    kind: 'file_version',
    attributes: { path, contentHash },
  } as unknown as CanonicalEntity;
}

/** A parser that claims TypeScript and reports a grammar identity we control. */
function parserWith(options: {
  parserVersion?: string;
  grammar?: string;
  outline?: boolean;
}): ContentParser {
  return {
    parserId: 'test.parser',
    parserVersion: options.parserVersion ?? '1.0.0',
    supports: (target: ParseTarget) =>
      target.path.endsWith('.ts') ? ParserSupport.NATIVE : ParserSupport.NONE,
    producerIdentity: (target: ParseTarget) =>
      Promise.resolve(target.path.endsWith('.ts') ? (options.grammar ?? 'ts@14/aaaa') : undefined),
    parse: () => ({
      segments: [
        {
          kind: SegmentKind.CODE,
          text: 'export function alpha() {}',
          span: { startByte: 0, endByte: 26, startLine: 1, endLine: 1 },
          label: 'alpha',
        },
      ],
      // EPIC-029 §8.4. A fake code parser says its outline is a symbol table,
      // as the real one does: absent means no code symbols, deliberately.
      outlineKind: 'code' as const,
      outline:
        options.outline === false
          ? []
          : [
              {
                title: 'alpha',
                kind: 'function',
                span: { startByte: 0, endByte: 26, startLine: 1, endLine: 1 },
                children: [],
              },
            ],
    }),
  };
}

interface Recorded {
  readonly producerVersion: string;
  readonly sourceContentHash: string | undefined;
  readonly metadata: Record<string, unknown> | undefined;
}

/** An artefact store backed by a map, so a second run sees the first run's record. */
function store(): ContentArtifactStore & { readonly written: Map<string, Recorded>; reads: number } {
  const written = new Map<string, Recorded>();
  const self = {
    written,
    reads: 0,
    getArtifact: (kind: string, scopeId?: string): Promise<DerivedArtifactRecord | undefined> => {
      self.reads += 1;
      const record = written.get(`${kind}:${scopeId ?? ''}`);
      if (record === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        producer: CONTENT_PRODUCER,
        producerVersion: record.producerVersion,
        schemaVersion: 1,
        sourceContentHash: record.sourceContentHash,
        metadata: record.metadata ?? {},
      });
    },
    // The real rules, applied the way `CompatibilityService.validateArtifact`
    // applies them. Reproduced here rather than mocked to `true`, because a gate
    // test whose gate always agrees proves nothing.
    validateArtifact: (
      artifact: DerivedArtifactRecord,
      current: { producer: string; producerVersion: string; sourceContentHash?: string },
    ): { valid: boolean; reason: string | undefined } => {
      if (artifact.producer !== current.producer || artifact.producerVersion !== current.producerVersion) {
        return { valid: false, reason: 'built by a different producer version' };
      }
      if (
        current.sourceContentHash !== undefined &&
        artifact.sourceContentHash !== undefined &&
        artifact.sourceContentHash !== current.sourceContentHash
      ) {
        return { valid: false, reason: 'the source content has changed since it was built' };
      }
      return { valid: true, reason: undefined };
    },
    recordArtifact: (input: {
      kind: string;
      scopeId?: string | undefined;
      producerVersion: string;
      sourceContentHash?: string | undefined;
      metadata?: Record<string, unknown>;
    }): Promise<unknown> => {
      written.set(`${input.kind}:${input.scopeId ?? ''}`, {
        producerVersion: input.producerVersion,
        sourceContentHash: input.sourceContentHash,
        metadata: input.metadata,
      });
      return Promise.resolve(undefined);
    },
  };
  return self;
}

/** A reader that counts how many times content was actually fetched. */
function reader(body = 'export function alpha() {}\n'): ContentReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFileContent: (_repository, request) => {
      reads.push(request.path);
      return Promise.resolve({
        read: true,
        bytes: new TextEncoder().encode(body),
        sizeBytes: body.length,
      });
    },
  };
}

function symbolSink(): SymbolIndexPort & { calls: { path: string; count: number }[] } {
  const calls: { path: string; count: number }[] = [];
  return {
    calls,
    indexFileSymbols: (ctx, symbols) => {
      calls.push({ path: ctx.path, count: symbols.length });
      return Promise.resolve({
        path: ctx.path,
        created: symbols.length,
        updated: 0,
        unchanged: 0,
        tombstoned: 0,
        reinstated: 0,
      });
    },
    findSymbols: () => Promise.resolve([]),
  };
}

interface Harness {
  readonly artifacts: ReturnType<typeof store>;
  readonly content: ReturnType<typeof reader>;
  readonly symbols: ReturnType<typeof symbolSink>;
}

async function stage(
  harness: Harness,
  parser: ContentParser,
  entries: readonly { path: string; oid: string }[] = [{ path: 'src/a.ts', oid: 'abc123' }],
  hash = HASH,
): Promise<Awaited<ReturnType<typeof runContentStage>>> {
  return runContentStage(
    {
      content: harness.content,
      symbols: harness.symbols,
      parser: new ParserFramework({ parsers: [parser] }),
      artifacts: harness.artifacts,
    },
    {
      repository: REPOSITORY,
      repositoryId: REPOSITORY_ID,
      entries,
      emitted: { entities: entries.map((entry) => fileVersion(entry.path, hash)) },
      revision: 'HEAD',
      observedAt: new Date('2026-01-01T00:00:00Z'),
    },
    context(),
  );
}

function harness(): Harness {
  return { artifacts: store(), content: reader(), symbols: symbolSink() };
}

describe('the gate decision table — AC-6, AC-7', () => {
  it('reads and parses a file it has never seen', async () => {
    const h = harness();
    const result = await stage(h, parserWith({}));

    expect(result.counts.filesConsidered).toBe(1);
    expect(result.counts.filesSkippedUnchanged).toBe(0);
    expect(result.counts.filesRead).toBe(1);
    expect(result.counts.filesParsed).toBe(1);
    expect(h.content.reads).toStrictEqual(['src/a.ts']);
  });

  it('does not re-read unchanged content on a second run — AC-6', async () => {
    // The property the gate exists for. Not "does not re-parse": does not
    // *read*. The content hash comes from the listing, so an unchanged file
    // costs one comparison and no I/O.
    const h = harness();
    await stage(h, parserWith({}));
    const second = await stage(h, parserWith({}));

    expect(second.counts.filesSkippedUnchanged).toBe(1);
    expect(second.counts.filesRead).toBe(0);
    expect(second.counts.filesParsed).toBe(0);
    expect(h.content.reads).toStrictEqual(['src/a.ts']);
    expect(h.symbols.calls).toHaveLength(1);
  });

  it('re-reads when the content changed', async () => {
    const h = harness();
    await stage(h, parserWith({}));
    const second = await stage(h, parserWith({}), [{ path: 'src/a.ts', oid: 'def456' }], 'git-blob:def456');

    expect(second.counts.filesSkippedUnchanged).toBe(0);
    expect(second.counts.filesRead).toBe(1);
    expect(h.content.reads).toStrictEqual(['src/a.ts', 'src/a.ts']);
  });

  it('re-reads when the parser version changed — AC-7', async () => {
    // A parser fix that never reached files already indexed is the precise
    // failure EPIC-024 built result provenance to make detectable. Gating on
    // content alone would reintroduce it.
    const h = harness();
    await stage(h, parserWith({ parserVersion: '1.0.0' }));
    const second = await stage(h, parserWith({ parserVersion: '1.1.0' }));

    expect(second.counts.filesRead).toBe(1);
    expect(second.counts.filesSkippedUnchanged).toBe(0);
  });

  it('re-reads when the grammar binary hash changed — AC-7', async () => {
    // The half that needs an accessor: a grammar swap changes the output for
    // identical content and an identical parser version.
    const h = harness();
    await stage(h, parserWith({ grammar: 'ts@14/aaaa' }));
    const second = await stage(h, parserWith({ grammar: 'ts@14/bbbb' }));

    expect(second.counts.filesRead).toBe(1);
    expect(second.counts.filesSkippedUnchanged).toBe(0);
  });

  it('does not re-read when neither changed — AC-7', async () => {
    const h = harness();
    await stage(h, parserWith({ parserVersion: '2.0.0', grammar: 'ts@14/cccc' }));
    const second = await stage(h, parserWith({ parserVersion: '2.0.0', grammar: 'ts@14/cccc' }));

    expect(second.counts.filesRead).toBe(0);
    expect(second.counts.filesSkippedUnchanged).toBe(1);
  });

  it('reconsiders a file once a parser starts claiming it', async () => {
    // "No parser handles this" is a stable answer, and it is still a producer
    // version. It has to change when a parser is added, or a file recorded
    // before the parser existed would be skipped for ever.
    const h = harness();
    const noClaim: ContentParser = {
      ...parserWith({}),
      supports: () => ParserSupport.NONE,
    };
    await stage(h, noClaim);
    const second = await stage(h, parserWith({}));

    expect(second.counts.filesRead).toBe(1);
  });

  it('keys the artefact on the repository and the path, one row per file', () => {
    // Two files with identical bytes are two artefacts, because they declare
    // different symbols. The content is carried as `sourceContentHash` rather
    // than folded into the scope — see the revert test below for why.
    const a = contentScopeId(REPOSITORY_ID, 'src/a.ts');
    const b = contentScopeId(REPOSITORY_ID, 'src/b.ts');

    expect(a).not.toBe(b);
    expect(a).toBe(contentScopeId(REPOSITORY_ID, 'src/a.ts'));
    expect(a).not.toBe(contentScopeId('other-repository', 'src/a.ts'));
  });

  it('re-reads a file reverted to a version it indexed before', async () => {
    // The defect a per-file-version scope would have: edit, index, revert,
    // index. Under that scoping the revert finds the *first* run's artefact,
    // calls the file unchanged and skips it — while the second run has already
    // tombstoned the symbols the first one stored, and nothing brings them back.
    const h = harness();
    const original = [{ path: 'src/a.ts', oid: 'v1' }];

    await stage(h, parserWith({}), original, 'git-blob:v1');
    await stage(h, parserWith({}), [{ path: 'src/a.ts', oid: 'v2' }], 'git-blob:v2');
    const reverted = await stage(h, parserWith({}), original, 'git-blob:v1');

    expect(reverted.counts.filesRead).toBe(1);
    expect(reverted.counts.filesSkippedUnchanged).toBe(0);
    // Three reads for three distinct states, and the third is what a
    // per-version scope would have skipped.
    expect(h.content.reads).toHaveLength(3);
  });

  it('records the artefact under the kind the gate reads', async () => {
    const h = harness();
    await stage(h, parserWith({}));
    const key = `${CONTENT_ARTIFACT_KIND}:${contentScopeId(REPOSITORY_ID, 'src/a.ts')}`;
    expect(h.artifacts.written.has(key)).toBe(true);
    expect(h.artifacts.written.get(key)?.sourceContentHash).toBe(HASH);
  });
});

describe('the per-file flow — AC-4, AC-5, AC-15', () => {
  it('derives structure from the bytes it read — AC-4', async () => {
    const h = harness();
    const result = await stage(h, parserWith({}));

    const structure = result.structure.get('src/a.ts');
    expect(structure).toBeDefined();
    expect(structure?.path).toBe('src/a.ts');
    // One line plus a trailing newline: `describeFileStructure` counts lines,
    // not line terminators, so a file that ends in a newline is not one line
    // longer than it looks.
    expect(structure?.lineCount).toBe(1);
    expect(structure?.endsWithNewline).toBe(true);
    expect(structure?.binary).toBe(false);
  });

  it('replays structure for a gate-skipped file rather than dropping it — AC-6', async () => {
    // Without this, the second run emits the file *without* the structure the
    // first run gave it, the upsert reports `updated`, and "a second run writes
    // no rows" is false for exactly the files the gate made free.
    const h = harness();
    const first = await stage(h, parserWith({}));
    const second = await stage(h, parserWith({}));

    expect(second.counts.filesSkippedUnchanged).toBe(1);
    expect(second.structure.get('src/a.ts')).toStrictEqual(first.structure.get('src/a.ts'));
  });

  it('stores symbols through the one path, scoped to the repository — AC-5', async () => {
    const h = harness();
    const result = await stage(h, parserWith({}));

    expect(h.symbols.calls).toStrictEqual([{ path: 'src/a.ts', count: 1 }]);
    expect(result.counts.symbols.created).toBe(1);
  });

  it('derives no symbol identity of its own — AC-15', async () => {
    // §8.6 as a source-level assertion. EPIC-034 failed once by deriving the
    // same id in two places three files apart, and every symbol was retired on
    // every run. The guard is that this Epic's module never computes one.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/indexing/content.ts', import.meta.url), 'utf8');
    const body = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(body).not.toContain('codeSymbolId');
    expect(body).not.toContain('codeSymbolEntityInput');
    expect(body).not.toContain('canonicalKey');
    expect(body).not.toContain('symbolScope');
  });

  it('counts a file whose parser produced nothing as unparsed, never as parsed', async () => {
    const h = harness();
    const result = await stage(h, { ...parserWith({}), supports: () => ParserSupport.NONE });

    expect(result.counts.filesRead).toBe(1);
    expect(result.counts.filesParsed).toBe(0);
    expect(result.counts.filesUnparsed).toBe(1);
    expect(result.counts.unparsedReasons[UnparsedReason.NO_PARSER]).toBe(1);
    expect(h.symbols.calls).toStrictEqual([]);
  });

  it('keeps filesRead equal to parsed plus unparsed — AC-11', async () => {
    const h = harness();
    const result = await stage(h, parserWith({}), [
      { path: 'src/a.ts', oid: 'abc123' },
      { path: 'notes.md', oid: 'abc123' },
    ]);

    expect(result.counts.filesRead).toBe(
      result.counts.filesParsed + result.counts.filesUnparsed,
    );
    expect(result.counts.filesRead).toBe(2);
  });

  it('skips a path the listing produced no file version for', async () => {
    // A symlink, a submodule, a secret-bearing path: `emitFiles` already
    // decided and reported those. A `.env` is not read merely because content
    // indexing is on.
    const h = harness();
    const result = await runContentStage(
      {
        content: h.content,
        symbols: h.symbols,
        parser: new ParserFramework({ parsers: [parserWith({})] }),
        artifacts: h.artifacts,
      },
      {
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        entries: [{ path: '.env', oid: 'secret' }],
        emitted: { entities: [] },
        revision: 'HEAD',
        observedAt: new Date(),
      },
      context(),
    );

    expect(result.counts.filesConsidered).toBe(0);
    expect(h.content.reads).toStrictEqual([]);
  });
});

describe('grammar identity is obtained without parsing — AC-17', () => {
  it('asks the parser for its identity and never parses to get it', async () => {
    let parses = 0;
    let identityCalls = 0;
    const counting: ContentParser = {
      ...parserWith({}),
      producerIdentity: (target: ParseTarget) => {
        identityCalls += 1;
        return Promise.resolve(target.path.endsWith('.ts') ? 'ts@14/aaaa' : undefined);
      },
      parse: () => {
        parses += 1;
        return { segments: [], outline: [] };
      },
    };

    const framework = new ParserFramework({ parsers: [counting] });
    const version = await framework.producerVersion({
      path: 'src/a.ts',
      mediaType: 'text/x-typescript',
      binary: false,
      sizeBytes: 0,
    });

    expect(version).toBe('test.parser@1.0.0+ts@14/aaaa');
    expect(identityCalls).toBe(1);
    expect(parses).toBe(0);
  });

  it('falls back to the parser version alone when a parser declares no identity', async () => {
    const bare: ContentParser = {
      parserId: 'plain',
      parserVersion: '3.0.0',
      supports: () => ParserSupport.NATIVE,
      parse: () => ({ segments: [] }),
    };
    const framework = new ParserFramework({ parsers: [bare] });

    await expect(
      framework.producerVersion({ path: 'a.txt', mediaType: 'text/plain', binary: false, sizeBytes: 0 }),
    ).resolves.toBe('plain@3.0.0');
  });

  it('survives a parser whose identity accessor throws', async () => {
    // A grammar that will not load must cost that language and nothing else
    // (Governance §13). The parse that follows reports the real failure.
    const broken: ContentParser = {
      parserId: 'broken',
      parserVersion: '1.0.0',
      supports: () => ParserSupport.NATIVE,
      producerIdentity: () => Promise.reject(new Error('grammar missing')),
      parse: () => ({ segments: [] }),
    };
    const framework = new ParserFramework({ parsers: [broken] });

    await expect(
      framework.producerVersion({ path: 'a.ts', mediaType: 'text/x-typescript', binary: false, sizeBytes: 0 }),
    ).resolves.toBe('broken@1.0.0');
  });

  it('answers undefined when nothing claims the target', async () => {
    const framework = new ParserFramework({ parsers: [] });
    await expect(
      framework.producerVersion({ path: 'a.bin', mediaType: 'application/octet-stream', binary: true, sizeBytes: 0 }),
    ).resolves.toBeUndefined();
  });
});
