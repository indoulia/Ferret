import { resolve } from 'node:path';

import { Command, Option } from 'commander';

import { createGitSourceProvider } from '../../git/index.js';
import { RepositoryIndexer, type IndexReport } from '../../indexing/index.js';
import type { LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  createStorageProvider,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';

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

          const indexer = new RepositoryIndexer({
            source,
            entities: new EntityStore(storage.db),
            relationships: new RelationshipStore(storage.db),
            evidence: new EvidenceStore(storage.db),
            watermarks: new CompatibilityService(storage.db, storage.pool),
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
