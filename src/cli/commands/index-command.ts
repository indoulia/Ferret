import { resolve } from 'node:path';

import { Command, Option } from 'commander';

import type { SymbolIndexPort } from '../../code/index.js';
import { createGitSourceProvider, type GitSourceProvider } from '../../git/index.js';
import {
  RepositoryIndexer,
  type ContentArtifactStore,
  type ContentReader,
  type IndexReport,
} from '../../indexing/index.js';
import { ParserFramework } from '../../parsing/index.js';
import type { LogLevel, Logger } from '../../logging/index.js';
import {
  Capability,
  CapabilitySupport,
  RepositoryOperation,
  assertSupported,
  discoverProviders,
} from '../../providers/index.js';
import { createRuntime, type FerretRuntime } from '../../runtime/index.js';
import {
  CompatibilityService,
  EntityStore,
  IndexLifecycleStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  SymbolStore,
  createStorageProvider,
  type FerretDatabase,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';
import { FERRET_PARSERS_MODULE, loadFerretParsers } from './parser-composition.js';

/**
 * `ferret index` — read a repository and store what it holds.
 *
 * The first command that makes Ferret useful rather than merely installed, and
 * the place where the whole architecture is finally load-bearing: this file
 * composes a **storage** provider and a **source** provider, asks the registry
 * for the `source.repository` capability rather than for Git, and hands both to
 * an indexer that knows about neither.
 *
 * Incremental by default. A repository indexed an hour ago is re-read only from
 * where the last run stopped, because a tool that re-reads a large repository's
 * entire history every hour is a tool people turn off. `--full` is the explicit
 * escape hatch for "Ferret's model of this repository is wrong".
 */
export function indexCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('index')
    .description('Index a Git repository into Ferret')
    .argument('[path]', 'Repository to index. Defaults to the current directory.')
    .addOption(new Option('--revision <rev>', 'Revision to index').default('HEAD'))
    .addOption(new Option('--full', 'Re-read everything, ignoring what was indexed before').default(false))
    .addOption(new Option('--no-history', 'Skip commit history'))
    .addOption(new Option('--no-files', 'Skip the file tree'))
    .addOption(
      new Option('--no-changes', 'Skip per-commit file changes, which cost Git a diff per commit'),
    )
    .addOption(new Option('--limit <n>', 'Commits to read in this run').argParser(Number))
    .addOption(
      new Option(
        '--content',
        'Read file content, and derive structure and symbols from it. Off by default.',
      ).default(false),
    )
    .action(
      async (
        path: string | undefined,
        options: {
          revision: string;
          full: boolean;
          history: boolean;
          files: boolean;
          changes: boolean;
          limit?: number;
          content: boolean;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
        const json = globals.json === true;

        const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
        const source = createGitSourceProvider();

        const runtime = createRuntime({
          providers: [storage, source],
          ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
        });

        const report = await runtime.run(async (context) => {
          // Asked for by capability, never by name. This command is the only
          // place that *constructs* a Git provider; everything after this line
          // works through the capability, so replacing the source provider
          // means changing one composition line rather than the indexer.
          //
          // `assertSupported` rather than a graceful degradation: an index with
          // no source has nothing to index, which is one of the few call sites
          // that genuinely cannot carry on (EPIC-011).
          assertSupported(runtime.providers.supports(Capability.SOURCE_REPOSITORY));
          assertSupported(runtime.providers.supports(Capability.STORAGE));

          const root = resolve(path ?? context.environment.cwd);
          const operation = { logger: context.logger, signal: context.signal };
          const repository = await source.describeRepository(root, operation);

          // One service, two roles: EPIC-031's watermark and EPIC-108's
          // re-parse gate are both derived artefacts, which is exactly why
          // neither needed a table of its own.
          const compatibility = new CompatibilityService(storage.db, storage.pool);
          const contentPorts = await composeContent(
            options.content,
            runtime,
            source,
            storage,
            compatibility,
            context.logger,
          );

          const indexer = new RepositoryIndexer({
            source,
            entities: new EntityStore(storage.db),
            relationships: new RelationshipStore(storage.db),
            evidence: new EvidenceStore(storage.db),
            watermarks: compatibility,
            lifecycle: new IndexLifecycleStore(storage.db),
            ...contentPorts,
            logger: context.logger,
          });

          return indexer.index(
            repository,
            {
              revision: options.revision,
              full: options.full,
              withHistory: options.history,
              withFiles: options.files,
              withChanges: options.changes,
              withContent: options.content,
              ...(options.limit === undefined || Number.isNaN(options.limit)
                ? {}
                : { historyLimit: options.limit }),
            },
            operation,
          );
        });

        emitResult(output(json), report, () => summarize(report));
      },
    );
}

/**
 * Composes the content stage, or explains why it is not composed.
 *
 * EPIC-108 AC-16. The capability question is asked **here**, in the composition
 * root, and answered before the indexer exists — not inside it, and not at the
 * call site. Two reasons, and the second is the architectural one:
 *
 * - A source that cannot read content must not be made to pretend it can. The
 *   run degrades to a metadata-only index and says so, rather than failing on a
 *   missing method somewhere in the middle of a repository.
 * - The indexer must not know the registry exists. It takes ports; deciding
 *   which ports it gets is this file's job, and that is what keeps EPIC-031's
 *   "the indexer depends on no provider" true with a content stage present.
 *
 * Returns the ports to hand the indexer, which is nothing at all when content
 * was not asked for or cannot be served.
 */
async function composeContent(
  requested: boolean,
  runtime: FerretRuntime,
  source: GitSourceProvider,
  storage: { db: FerretDatabase },
  artifacts: ContentArtifactStore,
  logger: Logger,
): Promise<{
  content?: ContentReader;
  symbols?: SymbolIndexPort;
  parser?: ParserFramework;
  artifacts?: ContentArtifactStore;
}> {
  if (!requested) return {};

  // Asked before it is called, never discovered by exception. A version-1
  // provider lands here too: the operation was introduced at version 2, and
  // `declares()` will not infer it from an older declaration however that
  // declaration is written.
  const verdict = runtime.providers.supports(
    Capability.SOURCE_REPOSITORY,
    RepositoryOperation.READ_CONTENT,
  );
  if (verdict.support !== CapabilitySupport.SUPPORTED) {
    logger.info(
      {
        operation: 'index.content.compose',
        support: verdict.support,
        providerId: verdict.providerId,
        detail: verdict.detail,
      },
      `Content indexing was requested but is unavailable: ${verdict.detail}`,
    );
    return {};
  }

  // The parser is loaded here and nowhere else, on demand, for a run that asked
  // for it. `ferret status` and `ferret config` never reach this line and never
  // pay for the grammar runtime.
  const discovery = await discoverProviders(
    runtime.providers,
    [FERRET_PARSERS_MODULE],
    loadFerretParsers,
  );
  for (const skip of discovery.skipped) {
    logger.warn(
      { operation: 'index.content.compose', module: skip.module, reason: skip.reason, detail: skip.detail },
      `Parser module "${skip.module}" was not loaded: ${skip.detail}`,
    );
  }

  const parser = runtime.providers.supports(Capability.PARSER);
  if (parser.support !== CapabilitySupport.SUPPORTED) {
    // Discovery is best-effort by design (EPIC-013), so a parser that failed to
    // load leaves the run metadata-only rather than failing it. Reading every
    // file in order to parse none of them would be cost with no result.
    logger.info(
      { operation: 'index.content.compose', support: parser.support, detail: parser.detail },
      `Content indexing was requested but no parser is available: ${parser.detail}`,
    );
    return {};
  }

  logger.info(
    {
      operation: 'index.content.compose',
      module: FERRET_PARSERS_MODULE,
      providers: discovery.providers,
      parser: parser.providerId,
    },
    'Content indexing composed',
  );

  return {
    content: source,
    symbols: new SymbolStore(storage.db),
    // Built from the registry, so it holds whatever the discovery above
    // composed and this file never names a parser.
    parser: new ParserFramework({ registry: runtime.providers }),
    artifacts,
  };
}

function summarize(report: IndexReport): string {
  const counts = (label: string, value: { created: number; updated: number; unchanged: number }): string =>
    `${label.padEnd(18)}${String(value.created)} new, ${String(value.updated)} changed, ${String(value.unchanged)} unchanged`;

  const lines = [
    `repository        ${report.repositoryKey}`,
    `mode              ${report.incremental ? 'incremental' : 'full'}`,
    `read              ${String(report.commitsRead)} commits, ${String(report.filesRead)} files, ${String(report.branchesRead)} branches, ${String(report.worktreesRead)} worktrees`,
    counts('entities', report.entities),
    counts('relationships', report.relationships),
    `evidence          ${String(report.evidence.recorded)} recorded, ${String(report.evidence.deduplicated)} already known`,
  ];

  // Reported even when zero, and reported when it did not run. A run that
  // quietly tombstoned four per cent of a repository should not look like one
  // that did nothing, and neither should a run that skipped the check.
  const { retired, reinstated, skippedReason } = report.lifecycle;
  if (skippedReason !== undefined) {
    lines.push(`lifecycle         not reconciled — ${skippedReason}`);
  } else {
    lines.push(
      `lifecycle         ${String(retired)} deleted, ${String(reinstated)} restored`,
    );
  }
  if (report.skipped.length > 0) {
    const reasons = new Map<string, number>();
    for (const skip of report.skipped) reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
    lines.push(
      `skipped           ${[...reasons].map(([reason, count]) => `${String(count)} ${reason}`).join(', ')}`,
    );
  }
  if (report.watermark !== undefined) lines.push(`watermark         ${report.watermark}`);
  lines.push(`took              ${String(Math.round(report.durationMs))}ms`);
  return lines.join('\n');
}
