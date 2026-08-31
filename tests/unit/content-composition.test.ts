import { describe, expect, it } from 'vitest';

import {
  ContentStageSkip,
  ParserFramework,
  RepositoryIndexer,
  type ContentArtifactStore,
  type CanonicalEntity,
  type ContentReader,
  type DiscoveredRepository,
  type IndexOptions,
  type IndexReport,
  type IndexableSource,
  type IndexerDependencies,
  type ProviderOperationContext,
  type SymbolIndexPort,
} from '../../src/index.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * EPIC-108 Phase 2 — the composition, proved without the pipeline.
 *
 * The flag, the two ports and the metadata-only fallback are decided before a
 * single file is read, and that is deliberate: a run that cannot read content
 * must degrade to a metadata index and *say so*, rather than fail on a missing
 * method somewhere in the middle of a repository (AC-16).
 *
 * The per-file flow the flag gates is Phase 3 and is not present yet, so what
 * these assert is the decision and its reporting. A flag that silently did
 * nothing would be indistinguishable from one wired wrongly, which is the whole
 * reason the decision is reported rather than merely taken.
 */

const REPOSITORY: DiscoveredRepository = {
  identityKey: 'github.com/indoulia/ferret',
  identityKind: 'remote',
  root: '/repo',
  gitDir: '/repo/.git',
  commonGitDir: '/repo/.git',
  bare: false,
  linkedWorktree: false,
  remotes: [],
  originUrl: 'https://github.com/indoulia/ferret.git',
};

const REPOSITORY_ENTITY = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'repository',
} as unknown as CanonicalEntity;

function context(): ProviderOperationContext {
  return {
    logger: new RecordingLogger(),
    signal: new AbortController().signal,
  };
}

/** A source that answers every metadata question with nothing. */
function source(): IndexableSource {
  const empty = { entities: [], relationships: [], evidence: [] };
  return {
    listWorktrees: () => Promise.resolve([]),
    listBranches: () => Promise.resolve({ items: [] }),
    readHistory: () => Promise.resolve({ commits: [] }),
    listFiles: () => Promise.resolve({ entries: [], cursor: undefined }),
    emit: () => ({ entity: REPOSITORY_ENTITY, evidence: [] }),
    emitGraph: () => empty,
    emitHistory: () => empty,
    emitFiles: () => ({ ...empty, skipped: [] }),
  };
}

/** Stores that accept everything and remember nothing. */
function writableStores(): Omit<IndexerDependencies, 'source'> {
  return {
    entities: { upsert: () => Promise.resolve({ entity: REPOSITORY_ENTITY, outcome: 'unchanged' }) },
    relationships: { assert: () => Promise.resolve({ relationship: {}, outcome: 'unchanged' }) },
    evidence: { record: () => Promise.resolve({ evidence: {}, deduplicated: true }) },
    watermarks: {
      getArtifact: () => Promise.resolve(undefined),
      recordArtifact: () => Promise.resolve(undefined),
    },
  } as unknown as Omit<IndexerDependencies, 'source'>;
}

/** A content reader that fails the test if it is ever consulted. */
function neverRead(): ContentReader {
  return {
    readFileContent: () => {
      throw new Error('content must not be read when the stage did not run');
    },
  };
}

function artifactStore(): ContentArtifactStore {
  return {
    getArtifact: () => Promise.resolve(undefined),
    validateArtifact: () => ({ valid: false, reason: 'no artefact' }),
    recordArtifact: () => Promise.resolve(undefined),
  };
}

/** Every collaborator the content stage needs, so the decision is "run". */
function fullyComposed(): Partial<IndexerDependencies> {
  return {
    content: neverRead(),
    symbols: symbolPort(),
    parser: new ParserFramework({ parsers: [] }),
    artifacts: artifactStore(),
  };
}

function symbolPort(): SymbolIndexPort {
  return {
    indexFileSymbols: () =>
      Promise.resolve({
        path: '',
        created: 0,
        updated: 0,
        unchanged: 0,
        tombstoned: 0,
        reinstated: 0,
      }),
    findSymbols: () => Promise.resolve([]),
  };
}

async function run(
  options: IndexOptions,
  extra: Partial<IndexerDependencies> = {},
): Promise<{ report: IndexReport; logger: RecordingLogger }> {
  const logger = new RecordingLogger();
  const indexer = new RepositoryIndexer({
    source: source(),
    ...writableStores(),
    logger,
    ...extra,
  });
  const report = await indexer.index(REPOSITORY, options, context());
  return { report, logger };
}

function contentDecision(logger: RecordingLogger): Record<string, unknown> | undefined {
  return logger.records.find((record) => record.fields['operation'] === 'index.content')?.fields;
}

describe('the content flag', () => {
  it('is off unless asked for — AC-1', async () => {
    // The default is a decision, not a convenience: content indexing is a
    // materially different cost model and the first path on which
    // attacker-controlled bytes reach a parser in production.
    const { logger } = await run({});
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NOT_REQUESTED);
    expect(contentDecision(logger)?.['requested']).toBe(false);
  });

  it('reads no content when it is off, even with both ports supplied', async () => {
    // Supplying the ports must not be what turns the stage on. If it were, any
    // caller that composed them would silently start reading every file.
    // `neverRead` throws if consulted, so reaching the assertion is the result.
    const { logger } = await run({}, { content: neverRead(), symbols: symbolPort() });
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NOT_REQUESTED);
  });

  it('reports no content section when off, rather than zeroes — AC-1', async () => {
    // §8.8 exactly: `undefined`, not a block of zeroes. Zeroes would claim the
    // stage ran and found nothing, and "no result" and "nothing there" must
    // not look the same (Governance §6).
    const { report } = await run({});
    expect(report.content).toBeUndefined();
  });

  it('does not disturb the metadata report when off — AC-1', async () => {
    const withoutFlag = (await run({})).report;
    const shape = (report: IndexReport): unknown => ({
      ...report,
      durationMs: 0,
    });
    expect(shape(withoutFlag)).toStrictEqual(shape((await run({ withContent: false })).report));
  });
});

describe('the metadata-only fallback — AC-16', () => {
  it('degrades and says why when no content reader was composed', async () => {
    // The shape AC-16 requires: detected before the call, reported with a
    // reason, and never a missing-method failure. The composition root asks
    // `supports(capability, operation)` and simply does not supply the port.
    const { logger } = await run({ withContent: true }, { symbols: symbolPort() });

    const decision = contentDecision(logger);
    expect(decision?.['requested']).toBe(true);
    expect(decision?.['skipped']).toBe(ContentStageSkip.NO_CONTENT_PORT);
  });

  it('degrades and says why when there is nowhere to put symbols', async () => {
    // Reading every file in a repository in order to discard what it yields is
    // cost with no result, so the stage declines rather than half-running.
    const { logger } = await run({ withContent: true }, { content: neverRead() });
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NO_SYMBOL_PORT);
  });

  it('degrades and says why when the file tree was not read', async () => {
    const { logger } = await run(
      { withContent: true, withFiles: false },
      { content: neverRead(), symbols: symbolPort() },
    );
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NO_FILE_TREE);
  });

  it('still completes the run, rather than failing it', async () => {
    // Governance §13: a missing capability reduces what Ferret can answer; it
    // does not break what it can. A metadata index is a successful index.
    const { report } = await run({ withContent: true }, {});
    expect(report.repositoryKey).toBe(REPOSITORY.identityKey);
    expect(report.lifecycle.skippedReason).toBeDefined();
  });

  it('never touches the content reader on any fallback path', async () => {
    // `neverRead` throws if consulted. Each of these would have been a
    // missing-method failure in the middle of a repository under the design
    // AC-16 exists to forbid.
    await run({ withContent: true }, { content: neverRead() });
    await run({ withContent: true, withFiles: false }, { content: neverRead(), symbols: symbolPort() });
  });
});

describe('when the stage is fully composed', () => {
  it('reports no skip reason, because it did not skip', async () => {
    // With all four collaborators present the stage runs. There are no files in
    // this fixture's listing, so it runs over nothing — which is the point: the
    // decision is what is under test, and a decision to run must not log a
    // reason for not running.
    const { logger, report } = await run({ withContent: true }, fullyComposed());
    expect(contentDecision(logger)).toBeUndefined();
    expect(report.content).toBeDefined();
    expect(report.content?.filesConsidered).toBe(0);
  });

  it('declines when no parser was composed', async () => {
    const { logger } = await run(
      { withContent: true },
      { content: neverRead(), symbols: symbolPort(), artifacts: artifactStore() },
    );
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NO_PARSER);
  });

  it('declines when the re-parse gate has nowhere to record', async () => {
    // Running without the gate would work and would re-read every file on every
    // run, which is the cost AC-6 exists to remove. Declining is honest;
    // silently running ungated would not be.
    const { logger } = await run(
      { withContent: true },
      { content: neverRead(), symbols: symbolPort(), parser: new ParserFramework({ parsers: [] }) },
    );
    expect(contentDecision(logger)?.['skipped']).toBe(ContentStageSkip.NO_GATE_STORE);
  });
});
