import { dirname } from 'node:path';

import { Command, Option } from 'commander';

import { AuditCategory, AuditOutcome, AuditWriter, auditEventsPath } from '../../audit/index.js';
import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import { userConfigPath } from '../../config/index.js';
import { processInvocationId, type LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  MigrationPolicy,
  RETENTION_TARGETS,
  RetentionService,
  RetentionTarget,
  createStorageProvider,
  planReclaims,
  type RetentionCount,
  type RetentionPlan,
} from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret prune` — EPIC-088, the only command that deletes.
 *
 * Two properties it never gives up:
 *
 * - **Nothing goes unless it is named and confirmed.** No target means a plan
 *   and no deletion; a named target still needs `--yes`. The flag rather than a
 *   prompt for `verify --repair`'s reason: Ferret is spawned by an AI client,
 *   and a prompt would hang in a pipe.
 * - **A tombstone has no flag.** EPIC-006 §D-009 — "what happened to this file,
 *   when was it deleted, what did it contain — are precisely the questions
 *   Ferret indexes history to answer." There is nothing to type here that
 *   deletes one.
 */
export function pruneCommand(output: (json: boolean) => OutputOptions): Command {
  return new Command('prune')
    .description('Report what could be reclaimed, and reclaim it when asked')
    .addOption(new Option('--blobs', 'Content no file version references').default(false))
    .addOption(new Option('--journals', 'Rotated audit journals above the kept count').default(false))
    .addOption(
      new Option('--evidence', 'Superseded evidence past --superseded-older-than days').default(false),
    )
    .addOption(
      new Option(
        '--superseded-older-than <days>',
        'Minimum age of superseded evidence. Required with --evidence; there is no default',
      ).argParser(Number),
    )
    .addOption(new Option('--journal-keep <n>', 'Rotated journal copies to keep').argParser(Number))
    .addOption(
      new Option('--sessions', 'Sessions that ended, past --sessions-older-than days').default(false),
    )
    .addOption(
      new Option(
        '--sessions-older-than <days>',
        'Minimum age of an ended session. Required with --sessions; there is no default',
      ).argParser(Number),
    )
    .addOption(
      new Option('--context', 'Archived durable context, past --archived-older-than days').default(false),
    )
    .addOption(
      new Option(
        '--archived-older-than <days>',
        'Minimum age of archived durable context. Required with --context; there is no default',
      ).argParser(Number),
    )
    .addOption(new Option('--yes', 'Actually delete what the plan names').default(false))
    .action(
      async (
        options: {
          blobs: boolean;
          journals: boolean;
          evidence: boolean;
          sessions: boolean;
          context: boolean;
          supersededOlderThan?: number;
          sessionsOlderThan?: number;
          archivedOlderThan?: number;
          journalKeep?: number;
          yes: boolean;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<{ json?: boolean; logLevel?: LogLevel }>();
        const json = globals.json === true;

        const named: RetentionTarget[] = [];
        if (options.blobs) named.push(RetentionTarget.BLOBS);
        if (options.journals) named.push(RetentionTarget.JOURNALS);
        if (options.evidence) named.push(RetentionTarget.EVIDENCE);
        if (options.sessions) named.push(RetentionTarget.SESSIONS);
        if (options.context) named.push(RetentionTarget.CONTEXT);

        // AC-1 — no target reports what *could* go across all of them, and
        // deletes nothing whatever `--yes` says. A caller who typed `--yes`
        // alone asked to delete nothing in particular, which is nothing.
        const targets = named.length === 0 ? RETENTION_TARGETS : named;
        const apply = options.yes && named.length > 0;

        const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
        const runtime = createRuntime({
          providers: [storage],
          ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
        });

        const result = await runtime.run(async (context) => {
          // Reading the plan is a read; deleting is not an index but a
          // destructive write, and EPIC-069's own repair path spells both out
          // at the call site rather than hoisting them — the shape
          // `authorization-enforcement.test.ts` asserts across every command.
          assertPermitted(localOperatorFrom(context.config), Permission.READ, 'prune');
          if (apply) {
            assertPermitted(localOperatorFrom(context.config), Permission.INDEX, 'prune.apply');
          }
          assertSupported(runtime.providers.supports(Capability.STORAGE));

          // Beside the configuration file, which is where EPIC-085 puts it and
          // EPIC-003's journal already lives.
          const journalPath = auditEventsPath(dirname(userConfigPath()));
          const retention = new RetentionService(storage.db);
          const plan = await retention.prune({
            targets,
            apply,
            journalPath,
            ...(options.supersededOlderThan === undefined || Number.isNaN(options.supersededOlderThan)
              ? {}
              : { supersededOlderThanDays: options.supersededOlderThan }),
            ...(options.sessionsOlderThan === undefined || Number.isNaN(options.sessionsOlderThan)
              ? {}
              : { sessionsEndedOlderThanDays: options.sessionsOlderThan }),
            ...(options.archivedOlderThan === undefined
              ? {}
              : { archivedOlderThanDays: options.archivedOlderThan }),
            ...(options.journalKeep === undefined || Number.isNaN(options.journalKeep)
              ? {}
              : { journalKeep: options.journalKeep }),
          });

          // §8.6 — one event per target that deleted something, naming the
          // target and the count and no row's contents. This is the Epic that
          // most needs the trail EPIC-085 landed.
          if (apply) {
            const journal = new AuditWriter({
              path: journalPath,
              invocation: processInvocationId(),
              agent: 'ferret-cli',
            });
            for (const count of plan.counts) {
              if (count.rows === 0) continue;
              journal.record({
                category: AuditCategory.CONFIGURATION,
                action: `prune.${count.target}`,
                outcome: AuditOutcome.PERMITTED,
                actor: localOperatorFrom(context.config).id,
                subject: count.target,
                reason: `${String(count.rows)} row(s)`,
              });
            }
          }

          return { plan, confirmed: apply, wouldDelete: !apply && planReclaims(plan) };
        });

        emitResult(output(json), result, () => render(result.plan, result.wouldDelete));
      },
    );
}

function describe(count: RetentionCount): string {
  const bytes = count.bytes === undefined ? '' : ` (${String(count.bytes)} bytes)`;
  const suffix =
    count.failure !== undefined
      ? ` — FAILED: ${count.failure}`
      : count.note !== undefined
        ? ` — ${count.note}`
        : '';
  return `  ${count.target}: ${String(count.rows)} row(s)${bytes}${suffix}`;
}

function render(plan: RetentionPlan, wouldDelete: boolean): string {
  const lines = [
    plan.applied ? 'Reclaimed:' : 'Would reclaim:',
    ...plan.counts.map((count) => describe(count)),
  ];
  if (!plan.applied && wouldDelete) {
    lines.push('', 'Nothing has been deleted. Name a target and re-run with --yes to proceed.');
  }
  // §8.4, stated where an operator looking for the flag will look for it.
  lines.push('', 'Tombstoned entities are never pruned — EPIC-088 §8.4.');
  return lines.join('\n');
}
