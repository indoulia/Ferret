import { randomUUID } from 'node:crypto';

import { Command, Option } from 'commander';

import { Permission, assertPermitted, localOperatorFrom } from '../../authorization/index.js';
import {
  MEMORY_KINDS,
  createEngineeringMemory,
  createSession,
  createSessionCheckpoint,
  endSession,
  recoverSession,
  type JsonValue,
  type MemoryKind,
  type RecoveryBundle,
  type Session,
} from '../../domain/index.js';
import { ErrorCode, FerretError } from '../../errors/index.js';
import type { LogLevel } from '../../logging/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { createRuntime } from '../../runtime/index.js';
import { MigrationPolicy, SessionStore, createStorageProvider } from '../../storage/index.js';
import { emitResult, type OutputOptions } from '../output.js';

/**
 * `ferret session` — record and recall what a session decided.
 *
 * EPIC-039 to EPIC-043 built the model and EPIC-109 built the store; this is
 * the surface that finally reaches them. Until it existed the capability was
 * real, tested and unreachable, which is what `planned.ts` had been saying.
 *
 * **Recall is the command that matters.** Everything else here exists so that
 * there is something to recall: a bundle is assembled from what was already
 * distilled while the work happened — a checkpoint and a few dozen sentences —
 * rather than from a transcript, because EPIC-043's whole constraint is
 * reconstructing context without replaying one.
 *
 * Every subcommand emits structured JSON under `--json`, so EPIC-111 can expose
 * these as MCP tools without a second implementation — the arrangement
 * Governance §16 requires and `ferret config` already follows.
 *
 * **Nothing here writes a transcript.** `session_capture` is a stream an AI
 * client produces, not something an operator types at a prompt, so EPIC-110
 * leaves capture to the client adapters that will own it. A memory recorded
 * here is `explicit` — a person stating a decision knows they made one — and
 * needs no captures to cite.
 */

interface Globals {
  readonly json?: boolean;
  readonly logLevel?: LogLevel;
}

/** Opens storage, checks the permission, and hands over the store. */
async function withStore<T>(
  globals: Globals,
  permission: Permission,
  action: string,
  body: (store: SessionStore, actorId: string) => Promise<T>,
): Promise<T> {
  const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });
  const runtime = createRuntime({
    providers: [storage],
    ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
  });

  return runtime.run(async (context) => {
    const operator = localOperatorFrom(context.config);
    assertPermitted(operator, permission, action);
    assertSupported(runtime.providers.supports(Capability.STORAGE));
    return body(new SessionStore(storage.db), operator.id);
  });
}

function usage(message: string, remediation: string, details: Record<string, unknown> = {}): FerretError {
  return new FerretError(ErrorCode.USAGE, message, { details, remediation });
}

/** Reads `--state`, which must be a JSON object rather than any JSON value. */
function parseState(raw: string | undefined): Record<string, JsonValue> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usage('--state is not valid JSON', 'Pass a JSON object, for example \'{"next":"run the suite"}\'.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usage(
      '--state must be a JSON object',
      'Continuation state is a set of named values; an array or a bare literal cannot be read back as one.',
    );
  }
  return parsed as Record<string, JsonValue>;
}

function asMemoryKind(raw: string): MemoryKind {
  if (!(MEMORY_KINDS as readonly string[]).includes(raw)) {
    throw usage(`"${raw}" is not a memory kind`, `Use one of: ${MEMORY_KINDS.join(', ')}.`, { kind: raw });
  }
  return raw as MemoryKind;
}

async function mustFind(store: SessionStore, sessionId: string): Promise<Session> {
  const session = await store.getSession(sessionId);
  if (session === undefined) {
    throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `Session "${sessionId}" is not on record`, {
      details: { sessionId },
      remediation: 'Run `ferret session list` to see the sessions this installation holds.',
    });
  }
  return session;
}

function describeSession(session: Session): string {
  const scope = [session.repositoryId, session.branch].filter((part) => part !== undefined).join(' @ ');
  return [
    `${session.sessionId}  ${session.status}`,
    `  provider   ${session.provider}`,
    `  actor      ${session.actorId}`,
    ...(scope === '' ? [] : [`  scope      ${scope}`]),
    ...(session.parentSessionId === undefined ? [] : [`  continues  ${session.parentSessionId}`]),
    `  started    ${session.startedAt}`,
    ...(session.endedAt === null ? [] : [`  ended      ${session.endedAt}`]),
  ].join('\n');
}

/**
 * Renders a bundle for a person.
 *
 * Omissions are printed, never dropped. A bundle that quietly held back half
 * the memories would be the failure EPIC-043 names in its own doc comment — a
 * recovery that looks complete and is not is worse than one that says so.
 */
function describeBundle(bundle: RecoveryBundle): string {
  if (bundle.empty) return bundle.reason ?? 'Nothing to recover.';

  const lines: string[] = [];
  if (bundle.checkpoint !== undefined) {
    lines.push(
      `checkpoint ${String(bundle.checkpoint.checkpointSequence)} — ${bundle.checkpoint.summary}`,
      `  captured through turn ${String(bundle.checkpoint.capturedThroughSequence)} at ${bundle.checkpoint.checkpointedAt}`,
    );
    const state = Object.entries(bundle.checkpoint.continuationState);
    for (const [key, value] of state) lines.push(`  ${key}: ${JSON.stringify(value)}`);
    lines.push('');
  }

  if (bundle.memories.length > 0) {
    lines.push(`${String(bundle.memories.length)} memories, most useful first:`);
    for (const entry of bundle.memories) {
      // The generation is shown only when it is not this session's own, so the
      // common case stays quiet and an inherited memory is obvious.
      const from = entry.generation === 0 ? '' : `  (from ${entry.sessionId})`;
      lines.push(`  [${entry.memory.kind}] ${entry.memory.statement}${from}`);
      if (entry.memory.rationale !== undefined) lines.push(`      ${entry.memory.rationale}`);
    }
  }

  if (bundle.omissions.length > 0) {
    lines.push('', 'Not included:');
    for (const omission of bundle.omissions) lines.push(`  ${omission.detail}`);
  }
  if (bundle.lineage.length > 1) lines.push('', `Drawn from: ${bundle.lineage.join(' <- ')}`);
  return lines.join('\n');
}

export function sessionCommand(output: (json: boolean) => OutputOptions): Command {
  const session = new Command('session').description('Record and recall agent sessions and what they decided');

  session
    .command('start')
    .description('Open a session and print its identifier')
    .addOption(new Option('--id <id>', 'Session identifier. Generated when omitted'))
    .addOption(new Option('--provider <name>', 'The AI client this session belongs to').default('ferret-cli'))
    .addOption(new Option('--actor <id>', 'Who is operating it. Defaults to the local operator'))
    .addOption(new Option('--repository <id>', 'Repository scope, when known'))
    .addOption(new Option('--worktree <id>', 'Worktree scope, when known'))
    .addOption(new Option('--branch <name>', 'Branch scope, when known'))
    .addOption(new Option('--parent <id>', 'The session this one continues'))
    .action(
      async (
        options: {
          id?: string;
          provider: string;
          actor?: string;
          repository?: string;
          worktree?: string;
          branch?: string;
          parent?: string;
        },
        command: Command,
      ) => {
        const globals = command.optsWithGlobals<Globals>();
        // EPIC-117 — `RECORD`, not `INDEX`. The four writing subcommands moved
        // together, because the CLI and the MCP surface read their grant from the
        // same configuration and a session write that needed different
        // permissions depending on how it arrived would be two rules wearing one
        // name. The local operator's default includes it, so nothing an operator
        // could already do at their own machine changed.
        const started = await withStore(globals, Permission.RECORD, 'session.start', async (store, operator) => {
          const value = createSession({
            sessionId: options.id ?? randomUUID(),
            provider: options.provider,
            actorId: options.actor ?? operator,
            ...(options.repository === undefined ? {} : { repositoryId: options.repository }),
            ...(options.worktree === undefined ? {} : { worktreeId: options.worktree }),
            ...(options.branch === undefined ? {} : { branch: options.branch }),
            ...(options.parent === undefined ? {} : { parentSessionId: options.parent }),
            startedAt: new Date().toISOString(),
          });
          await store.save(value);
          return value;
        });

        emitResult(output(globals.json === true), started, () => describeSession(started));
      },
    );

  session
    .command('end')
    .description('Close a session. It becomes immutable')
    .argument('<id>', 'The session to close')
    .addOption(new Option('--abandoned', 'Record it as abandoned rather than completed').default(false))
    .action(async (id: string, options: { abandoned: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<Globals>();
      const ended = await withStore(globals, Permission.RECORD, 'session.end', async (store) => {
        const value = endSession(await mustFind(store, id), options.abandoned ? 'abandoned' : 'completed', new Date());
        await store.save(value);
        return value;
      });

      emitResult(output(globals.json === true), ended, () => describeSession(ended));
    });

  session
    .command('checkpoint')
    .description('Record resumable state for a session')
    .argument('<id>', 'The session to checkpoint')
    .requiredOption('--summary <text>', 'What has happened so far, compactly')
    .addOption(new Option('--through <n>', 'Highest captured turn this represents').argParser(Number).default(0))
    .addOption(new Option('--state <json>', 'Continuation state, as a JSON object'))
    .action(
      async (id: string, options: { summary: string; through: number; state?: string }, command: Command) => {
        const globals = command.optsWithGlobals<Globals>();
        const state = parseState(options.state);
        if (!Number.isInteger(options.through) || options.through < 0) {
          throw usage('--through must be a non-negative whole number', 'It is a turn number, or 0 when unknown.');
        }

        const checkpoint = await withStore(globals, Permission.RECORD, 'session.checkpoint', async (store) => {
          const owner = await mustFind(store, id);
          // The next sequence, read rather than asked for: a caller who has to
          // supply it can only get it wrong, and EPIC-041 makes the progression
          // monotonic precisely so nobody has to track it by hand.
          const latest = await store.latestCheckpoint(id);
          const value = createSessionCheckpoint({
            sessionId: id,
            provider: owner.provider,
            checkpointSequence: (latest?.checkpointSequence ?? 0) + 1,
            capturedThroughSequence: Math.max(options.through, latest?.capturedThroughSequence ?? 0),
            checkpointedAt: new Date().toISOString(),
            summary: options.summary,
            continuationState: state,
          });
          await store.saveCheckpoint(value);
          return value;
        });

        emitResult(
          output(globals.json === true),
          checkpoint,
          () => `checkpoint ${String(checkpoint.checkpointSequence)} recorded for ${checkpoint.sessionId}`,
        );
      },
    );

  session
    .command('remember')
    .description('Record something a session decided or learned')
    .argument('<id>', 'The session that decided it')
    .requiredOption('--kind <kind>', `One of: ${MEMORY_KINDS.join(', ')}`)
    .requiredOption('--statement <text>', 'What holds, in one sentence')
    .addOption(new Option('--rationale <text>', 'Why — what it was chosen over'))
    .action(
      async (id: string, options: { kind: string; statement: string; rationale?: string }, command: Command) => {
        const globals = command.optsWithGlobals<Globals>();
        const kind = asMemoryKind(options.kind);

        const memory = await withStore(globals, Permission.RECORD, 'session.remember', async (store) => {
          await mustFind(store, id);
          const value = createEngineeringMemory({
            sessionId: id,
            kind,
            statement: options.statement,
            ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
            // Stated by a person at a prompt, so `explicit` — and explicit
            // memories need no captures to cite, which is why this command can
            // exist before anything writes a transcript.
            origin: 'explicit',
            recordedAt: new Date().toISOString(),
          });
          await store.recordMemory(value);
          return value;
        });

        emitResult(
          output(globals.json === true),
          memory,
          () => `[${memory.kind}] ${memory.statement}${memory.truncated ? '  (truncated)' : ''}`,
        );
      },
    );

  session
    .command('recall')
    .description('Assemble what a later session needs from an earlier one')
    .argument('<id>', 'The session to recover')
    .addOption(new Option('--limit <n>', 'Most memories to include').argParser(Number))
    .addOption(new Option('--include-superseded', 'Include memories a later decision replaced').default(false))
    .action(async (id: string, options: { limit?: number; includeSuperseded: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<Globals>();
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
        throw usage('--limit must be a whole number of at least 1', 'Omit it to use the default bundle size.');
      }

      const bundle = await withStore(globals, Permission.READ, 'session.recall', async (store) => {
        await mustFind(store, id);
        return recoverSession(id, store, {
          ...(options.limit === undefined ? {} : { memoryLimit: options.limit }),
          includeSuperseded: options.includeSuperseded,
        });
      });

      emitResult(output(globals.json === true), bundle, () => describeBundle(bundle));
    });

  session
    .command('list')
    .description('Sessions this installation holds, newest first')
    .addOption(new Option('--actor <id>', 'Whose sessions. Defaults to the local operator'))
    .addOption(new Option('--limit <n>', 'How many to list').argParser(Number).default(20))
    .action(async (options: { actor?: string; limit: number }, command: Command) => {
      const globals = command.optsWithGlobals<Globals>();
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw usage('--limit must be a whole number of at least 1', 'Omit it to list the most recent 20.');
      }

      const { sessions, total } = await withStore(globals, Permission.READ, 'session.list', async (store, operator) => ({
        sessions: await store.sessionsFor(options.actor ?? operator, options.limit),
        total: await store.count(),
      }));

      emitResult(output(globals.json === true), { sessions, total }, () =>
        sessions.length === 0
          ? `No sessions recorded for this actor. ${String(total)} on record in total.`
          : sessions
              .map((value) => `${value.startedAt}  ${value.status.padEnd(9)}  ${value.sessionId}`)
              .join('\n'),
      );
    });

  session
    .command('show')
    .description('One session, with its latest checkpoint and what it decided')
    .argument('<id>', 'The session to show')
    .action(async (id: string, _options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<Globals>();
      const detail = await withStore(globals, Permission.READ, 'session.show', async (store) => ({
        session: await mustFind(store, id),
        checkpoint: await store.latestCheckpoint(id),
        memories: await store.memoriesFor(id),
      }));

      emitResult(output(globals.json === true), detail, () =>
        [
          describeSession(detail.session),
          '',
          detail.checkpoint === undefined
            ? 'No checkpoint.'
            : `checkpoint ${String(detail.checkpoint.checkpointSequence)} — ${detail.checkpoint.summary}`,
          '',
          detail.memories.length === 0
            ? 'Nothing recorded.'
            : detail.memories
                .map(
                  (memory) =>
                    `  [${memory.kind}] ${memory.statement}${memory.supersededBy === undefined ? '' : '  (superseded)'}`,
                )
                .join('\n'),
        ].join('\n'),
      );
    });

  return session;
}
