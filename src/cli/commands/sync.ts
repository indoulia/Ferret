import { Command, Option } from 'commander';

import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import {
  defaultConfigSourceList,
  resolveConfig,
  type FerretConfig,
} from '../../config/index.js';
import { ErrorCode, FerretError, toFerretError } from '../../errors/index.js';
import { GITHUB_PROVIDER_ID, GITHUB_SOURCE_SYSTEM, createGithubProvider } from '../../github/index.js';
import { JIRA_PROVIDER_ID, JIRA_SOURCE_SYSTEM, createJiraProvider, jiraOptionsSchema } from '../../jira/index.js';
import type { LogLevel } from '../../logging/index.js';
import { ProjectSynchronizer, type ProjectSyncReport } from '../../project/index.js';
import { Capability, assertSupported, type Provider } from '../../providers/index.js';
import type { ProjectSource } from '../../providers/contracts/source-project.js';
import { createRuntime } from '../../runtime/index.js';
import {
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  SyncCursorStore,
  createStorageProvider,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';
import { ExitCode } from '../exit-codes.js';

/**
 * `ferret sync` — EPIC-113.
 *
 * The last `(planned)` entry, and the reason it was one: the GitHub and Jira
 * providers, the project model, the cursor store and the three canonical stores
 * all existed and were tested, and **nothing composed them**. This file is that
 * composition, and it is deliberately the same shape as `ferret index` — a
 * command that constructs providers, asks the registry for a *capability*, and
 * hands ports to something that knows about neither.
 *
 * **One explicit pass, no daemon** (D-113.2). Ferret runs no timer; the
 * scheduler is `cron`, a `systemd` timer or Task Scheduler, exactly as
 * `ferret reconcile` says. What this owes them is a deterministic report, an
 * exit code, and a pass that is harmless when it overlaps with another —
 * EPIC-080 makes the writes idempotent, so an overlap is wasteful and never
 * wrong.
 *
 * **No credential is stored** (D-113.1). The token is resolved from
 * configuration on every invocation through the `$secret` mechanism EPIC-081
 * and EPIC-015 already built. Persisting one was authorised and turned out not
 * to be needed: a one-shot command has nothing for a stored credential to
 * outlive, and Ferret has no key-management mechanism to store one under, so
 * building one would have settled a security posture to satisfy a requirement
 * nothing has.
 */

interface SyncOptions {
  provider?: string;
  full: boolean;
  dryRun: boolean;
  issues: boolean;
  pullRequests: boolean;
  reviews: boolean;
  pageLimit?: number;
}

/** One project's outcome, whether or not it succeeded. */
export interface SyncEntry {
  readonly provider: string;
  readonly project: string;
  readonly report?: ProjectSyncReport;
  /** Present when this project failed. The code, never the message body. */
  readonly failureCode?: string;
}

export interface SyncPassReport {
  readonly entries: readonly SyncEntry[];
  readonly synchronized: number;
  readonly failed: number;
  readonly dryRun: boolean;
}

export function syncCommand(
  output: (json: boolean) => OutputOptions,
  reportExitCode: (code: number) => void,
): Command {
  return new Command('sync')
    .description('Ingest issues, pull requests and reviews from a configured tracker')
    .argument(
      '[projects...]',
      'Projects to synchronize — `owner/repo` for GitHub, a key for Jira. Defaults to the configured list.',
    )
    .addOption(new Option('--provider <id>', 'Synchronize only this provider'))
    .addOption(
      new Option('--full', 'Ignore the cursor and read everything the tracker will return').default(
        false,
      ),
    )
    .addOption(new Option('--dry-run', 'Read the tracker and write nothing').default(false))
    .addOption(new Option('--no-issues', 'Skip issues'))
    .addOption(new Option('--no-pull-requests', 'Skip pull requests, and therefore reviews'))
    .addOption(new Option('--no-reviews', 'Skip reviews, which cost one request per pull request'))
    .addOption(
      new Option('--page-limit <n>', 'Pages to read per collection before stopping short').argParser(
        Number,
      ),
    )
    .action(async (projects: string[], options: SyncOptions, command: Command) => {
      const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
      const json = globals.json === true;

      if (options.pageLimit !== undefined && !Number.isInteger(options.pageLimit)) {
        throw new FerretError(ErrorCode.USAGE, '--page-limit must be a whole number of pages', {
          details: { pageLimit: options.pageLimit },
          remediation: 'Pass a positive integer, for example `--page-limit 5`.',
        });
      }

      // Configuration is resolved **here**, before the runtime exists, because
      // which providers to construct is decided by it: a Ferret with no tracker
      // configured must not register a GitHub provider that would then report a
      // missing token. The runtime resolves the same layers again for its own
      // context; the read is cheap and neither copy is authoritative over the
      // other, because both come from the same sources in the same order.
      const { config } = resolveConfig(defaultConfigSourceList());
      const composed = composeProjectSources(config, options.provider);

      const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
      const runtime = createRuntime({
        providers: [storage, ...composed.map((one) => one.provider)],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      const report = await runtime.run(async (context) => {
        // A sync ingests, so it is checked as an ingestion — the same grant
        // `ferret index` and `ferret reconcile` need. Spelled out at the call
        // site rather than hoisted, which is the shape
        // `authorization-enforcement.test.ts` asserts across every command.
        assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'sync');
        assertSupported(runtime.providers.supports(Capability.STORAGE));
        assertSupported(runtime.providers.supports(Capability.SOURCE_PROJECT));

        const entities = new EntityStore(storage.db);
        const relationships = new RelationshipStore(storage.db);
        const evidence = new EvidenceStore(storage.db);
        const cursors = new SyncCursorStore(storage.db, storage.pool);
        const operation = { logger: context.logger, signal: context.signal };

        const entries: SyncEntry[] = [];

        for (const source of composed) {
          const synchronizer = new ProjectSynchronizer({
            source: source.projectSource,
            providerId: source.providerId,
            sourceSystem: source.sourceSystem,
            operations: source.operations,
            entities,
            relationships,
            evidence,
            cursors,
            logger: context.logger,
          });

          for (const project of projects.length > 0 ? projects : source.configuredProjects()) {
            try {
              const result = await synchronizer.sync(
                {
                  project,
                  full: options.full,
                  dryRun: options.dryRun,
                  withIssues: options.issues,
                  withPullRequests: options.pullRequests,
                  withReviews: options.reviews,
                  ...(options.pageLimit === undefined ? {} : { pageLimit: options.pageLimit }),
                },
                operation,
              );
              entries.push({ provider: source.providerId, project, report: result });
            } catch (error) {
              // EPIC-093's isolation grain, applied to a loop the way
              // `reconcile` applies it: one project whose token was revoked
              // must not stop the other five. The code, never the message —
              // this line reaches a terminal and a log file.
              const classified = toFerretError(error);
              context.logger.warn(
                {
                  operation: 'sync.project.failed',
                  provider: source.providerId,
                  project,
                  code: classified.code,
                },
                `Synchronizing "${project}" failed; the pass continues`,
              );
              entries.push({
                provider: source.providerId,
                project,
                failureCode: classified.code,
              });
            }
          }
        }

        if (entries.length === 0) {
          throw new FerretError(
            ErrorCode.CONFIG_INVALID,
            'No project was named and none is configured',
            {
              details: { providers: composed.map((one) => one.providerId) },
              remediation:
                'Pass a project — `ferret sync owner/repo` — or set `projects` in the provider options with `ferret config set`.',
            },
          );
        }

        return {
          entries,
          synchronized: entries.filter((entry) => entry.failureCode === undefined).length,
          failed: entries.filter((entry) => entry.failureCode !== undefined).length,
          dryRun: options.dryRun,
        } satisfies SyncPassReport;
      });

      // A pass in which one project failed is a failed pass, so a scheduler can
      // branch on it. A pass that read nothing new is not.
      if (report.failed > 0) reportExitCode(ExitCode.ERROR);

      emitResult(output(json), report, () => render(report));
    });
}

/** One composed tracker: the provider, and how to ask it what to sync. */
interface ComposedSource {
  readonly provider: Provider;
  readonly providerId: string;
  readonly sourceSystem: string;
  readonly projectSource: ProjectSource;
  readonly operations: readonly string[];
  /** Read after initialization, so it reflects configuration rather than the constructor. */
  configuredProjects(): readonly string[];
}

/**
 * The trackers configuration actually asks for.
 *
 * **Presence in `providers` is the switch.** A provider absent from the
 * configuration is not composed at all, rather than composed and left to fail
 * at first use for want of a token: Governance §2 forbids making anything
 * mandatory to start Ferret, and a GitHub provider nobody configured has
 * nothing to say. `enabled: false` is honoured for the same reason the registry
 * honours it.
 */
function composeProjectSources(config: FerretConfig, only: string | undefined): ComposedSource[] {
  const composed: ComposedSource[] = [];

  const wanted = (id: string): boolean => {
    if (only !== undefined && only !== id) return false;
    const entry = config.providers[id];
    return entry !== undefined && entry.enabled;
  };

  if (wanted(GITHUB_PROVIDER_ID)) {
    // Constructed with nothing: every option — the token included — is read
    // from `context.settings` at initialization, which is what EPIC-015 built
    // and what nothing had used.
    const provider = createGithubProvider();
    composed.push({
      provider,
      providerId: GITHUB_PROVIDER_ID,
      sourceSystem: GITHUB_SOURCE_SYSTEM,
      projectSource: provider,
      operations: provider.capabilities.flatMap((one) => [...(one.operations ?? [])]),
      configuredProjects: () => provider.effectiveOptions.projects ?? [],
    });
  }

  if (wanted(JIRA_PROVIDER_ID)) {
    // Jira's `baseUrl` is required at construction — the type says so — so it
    // is the one option this file must read for itself. A configuration that
    // does not parse fails here, naming the provider, rather than at first use.
    const parsed = jiraOptionsSchema.safeParse(config.providers[JIRA_PROVIDER_ID]?.options ?? {});
    if (!parsed.success) {
      throw new FerretError(
        ErrorCode.CONFIG_INVALID,
        `The Jira provider is configured but its options are not valid: ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`,
        {
          details: { providerId: JIRA_PROVIDER_ID },
          remediation: `Set at least \`providers.${JIRA_PROVIDER_ID}.options.baseUrl\` to your Jira address.`,
        },
      );
    }
    const provider = createJiraProvider({ baseUrl: parsed.data.baseUrl });
    composed.push({
      provider,
      providerId: JIRA_PROVIDER_ID,
      sourceSystem: JIRA_SOURCE_SYSTEM,
      projectSource: provider,
      operations: provider.capabilities.flatMap((one) => [...(one.operations ?? [])]),
      configuredProjects: () => provider.effectiveOptions.projects ?? [],
    });
  }

  if (composed.length === 0) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      only === undefined
        ? 'No project source is configured, so there is nothing to synchronize'
        : `Provider "${only}" is not configured, or is disabled`,
      {
        details: {
          known: [GITHUB_PROVIDER_ID, JIRA_PROVIDER_ID],
          ...(only === undefined ? {} : { requested: only }),
        },
        remediation: `Configure one, for example: \`ferret config set providers.${GITHUB_PROVIDER_ID}.options.token '{"$secret":{"env":"FERRET_GITHUB_TOKEN"}}'\`.`,
      },
    );
  }

  return composed;
}

function render(report: SyncPassReport): string {
  const lines = [report.dryRun ? 'Would synchronize:' : 'Synchronized:'];

  for (const entry of report.entries) {
    if (entry.report === undefined) {
      lines.push(`  failed    ${entry.project} — ${entry.failureCode ?? 'unknown'}`);
      continue;
    }
    const counts = entry.report.counts;
    const marks: string[] = [];
    if (entry.report.truncated) marks.push('truncated');
    if (entry.report.unchanged.length > 0) marks.push(`unchanged: ${entry.report.unchanged.join(', ')}`);
    if (entry.report.unsupported.length > 0)
      marks.push(`unsupported: ${entry.report.unsupported.join(', ')}`);
    if (entry.report.skipped.length > 0) marks.push(`${String(entry.report.skipped.length)} skipped`);
    lines.push(
      `  ok        ${entry.project} — ${String(counts.issues)} issues, ` +
        `${String(counts.pullRequests)} pull requests, ${String(counts.reviews)} reviews` +
        (marks.length === 0 ? '' : ` (${marks.join('; ')})`),
    );
  }

  lines.push(
    '',
    `${String(report.synchronized)} synchronized, ${String(report.failed)} failed`,
  );

  const truncated = report.entries.some((entry) => entry.report?.truncated === true);
  if (truncated) {
    lines.push(
      '',
      'A page limit stopped an enumeration short, so the cursor was not advanced',
      'and the next pass reads the same window again. Raise `--page-limit` to',
      'read further in one pass.',
    );
  }

  // Where an operator setting this up will read it — the same statement
  // `ferret reconcile` ends with, and for the same reason.
  lines.push(
    '',
    'Ferret runs no timer. Schedule this with cron, a systemd timer, or Task',
    'Scheduler — each already survives a reboot and logs when it ran.',
  );
  return lines.join('\n');
}
