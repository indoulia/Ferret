import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AuditWriter } from '../audit/index.js';
import { Permission, type Principal } from '../authorization/index.js';
import { DEFAULT_MEMORY_LIMIT, recoverSession, type Session, type SessionRecoveryPort } from '../domain/index.js';
import type { Logger } from '../logging/index.js';

import { createToolGuard, type ToolGuard } from './guards.js';

/**
 * Session recall, over MCP — EPIC-111.
 *
 * EPIC-109 made a session's context durable and EPIC-110 gave an operator a
 * command for it. Neither helped the caller the whole domain exists for: an AI
 * client, which is usually a process with no shell, no `ferret` on its path and
 * no way to read another process's exit code. `ferret session recall` was
 * exactly as reachable to it as `ferret status --json` was before EPIC-070 —
 * which is to say, not.
 *
 * **This is the surface that makes agent memory an agent's.** A client opening
 * a session on a repository asks what the last one decided, and gets back the
 * checkpoint and a few dozen sentences instead of a transcript it would have to
 * pay for twice.
 *
 * **Read-only, deliberately.** Recording over MCP — opening a session, closing
 * it, checkpointing it — is a larger question than it looks: it needs an answer
 * to who owns a session's identity and lifetime when the client and the server
 * disagree about when a session began. EPIC-117 owns that. Half of it built
 * here would be a write path with no lifecycle behind it, and the FK from a
 * memory to its session would refuse the first call.
 */

/**
 * What this surface needs.
 *
 * `SessionRecoveryPort` is EPIC-043's own port and `SessionStore` already
 * satisfies it, so the composition root passes the store straight through and
 * this layer never learns that PostgreSQL exists — the boundary
 * `boundaries.test.ts` enforces, and the reason these tools are testable
 * without a database.
 */
export interface SessionAccess extends SessionRecoveryPort {
  /** Sessions an actor ran, newest first. */
  sessionsFor(actorId: string, limit: number): Promise<readonly Session[]>;
}

export interface SessionToolDependencies {
  readonly sessions: SessionAccess;
  readonly logger: Logger;
  readonly principal: Principal;
  readonly audit?: AuditWriter | undefined;
}

/** Most sessions one `ferret_session_list` call returns. */
export const MAX_SESSION_LIST = 100;

function summarize(session: Session): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    actorId: session.actorId,
    status: session.status,
    repositoryId: session.repositoryId,
    branch: session.branch,
    parentSessionId: session.parentSessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

/**
 * Registers the session tools.
 *
 * Its own module for EPIC-066's reason, the same one `health-tools.ts` gives:
 * `server.ts` is already the longest file in the project, and
 * `mcp-destructive-tools.test.ts` scans every module in `src/mcp/`, so a
 * control naming one file would stop covering the surface.
 */
export function registerSessionTools(server: McpServer, dependencies: SessionToolDependencies): void {
  const { sessions, logger, principal, audit } = dependencies;
  const guard: ToolGuard = createToolGuard({
    principal,
    logger,
    ...(audit === undefined ? {} : { audit }),
  });

  server.registerTool(
    'ferret_session_recall',
    {
      title: 'What did the last session decide',
      description:
        'Recover what an earlier session decided, constrained and left ' +
        'unfinished, so this one can continue it. Returns the latest ' +
        'checkpoint and the memories that session recorded — a few dozen ' +
        'sentences — rather than a transcript, and follows the parent chain so ' +
        'a continuation inherits what its ancestors decided. Call this when ' +
        'resuming work, before asking the user to repeat context they have ' +
        'already given. Anything left out is reported in `omissions` rather ' +
        'than silently dropped, and a session that recorded nothing is ' +
        'reported as `empty` rather than as an absence of context.',
      inputSchema: z.strictObject({
        sessionId: z.string().min(1).describe('The session to recover.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`Most memories to include. Defaults to ${String(DEFAULT_MEMORY_LIMIT)}.`),
        includeSuperseded: z
          .boolean()
          .optional()
          .describe('Include memories a later decision replaced. Off by default.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard('session.recall', Permission.READ, async () => {
        // Refused here rather than returning an empty bundle: "this session
        // decided nothing" and "there is no such session" are different
        // answers, and a client that cannot tell them apart will ask the user
        // to repeat context that was never lost.
        const session = await sessions.getSession(input.sessionId);
        if (session === undefined) {
          return {
            found: false,
            sessionId: input.sessionId,
            detail: 'No session with that identifier is on record.',
            remediation: 'Call ferret_session_list to see the sessions this installation holds.',
          };
        }

        const bundle = await recoverSession(input.sessionId, sessions, {
          ...(input.limit === undefined ? {} : { memoryLimit: input.limit }),
          ...(input.includeSuperseded === undefined ? {} : { includeSuperseded: input.includeSuperseded }),
        });

        return {
          found: true,
          sessionId: bundle.sessionId,
          empty: bundle.empty,
          reason: bundle.reason,
          lineage: bundle.lineage,
          checkpoint:
            bundle.checkpoint === undefined
              ? undefined
              : {
                  sequence: bundle.checkpoint.checkpointSequence,
                  summary: bundle.checkpoint.summary,
                  continuationState: bundle.checkpoint.continuationState,
                  capturedThroughSequence: bundle.checkpoint.capturedThroughSequence,
                  checkpointedAt: bundle.checkpoint.checkpointedAt,
                },
          // Flattened: a client should not have to know that a memory is
          // wrapped in a recovery envelope to read what it says. The generation
          // and origin session stay, because "we decided this two sessions ago"
          // is the part that tells a reader how much weight it carries.
          memories: bundle.memories.map((entry) => ({
            kind: entry.memory.kind,
            statement: entry.memory.statement,
            rationale: entry.memory.rationale,
            origin: entry.memory.origin,
            confidence: entry.memory.confidence,
            recordedAt: entry.memory.recordedAt,
            fromSessionId: entry.sessionId,
            generation: entry.generation,
          })),
          // Never dropped — EPIC-043: a bundle that looks complete and is not
          // is worse than one that says so.
          omissions: bundle.omissions,
        };
      }),
  );

  server.registerTool(
    'ferret_session_list',
    {
      title: 'Which sessions are on record',
      description:
        'List the sessions this installation holds for an actor, newest ' +
        'first. Use it to find the identifier a recall needs when the client ' +
        'does not already know it — for example when resuming work after a ' +
        'restart. Reports the total held as well as the page returned, so an ' +
        'empty list for one actor is distinguishable from an empty store.',
      inputSchema: z.strictObject({
        actorId: z
          .string()
          .min(1)
          .optional()
          .describe('Whose sessions. Defaults to the principal making the call.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SESSION_LIST)
          .optional()
          .describe(`How many to return. Defaults to 20, at most ${String(MAX_SESSION_LIST)}.`),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard('session.list', Permission.READ, async () => {
        const actorId = input.actorId ?? principal.id;
        const found = await sessions.sessionsFor(actorId, input.limit ?? 20);
        return {
          actorId,
          sessions: found.map(summarize),
          count: found.length,
          notice:
            found.length === 0
              ? `No sessions are recorded for "${actorId}". Sessions are recorded by \`ferret session start\`.`
              : undefined,
        };
      }),
  );

  server.registerTool(
    'ferret_session_show',
    {
      title: 'One session, and everything it recorded',
      description:
        'Report one session with its latest checkpoint and every memory it ' +
        'recorded, superseded ones included. Where `ferret_session_recall` ' +
        'assembles what a *later* session needs — bounded, prioritised, and ' +
        'drawn from a whole lineage — this reports what one session actually ' +
        'holds. Use it to inspect a specific session; use recall to resume work.',
      inputSchema: z.strictObject({
        sessionId: z.string().min(1).describe('The session to report.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard('session.show', Permission.READ, async () => {
        const session = await sessions.getSession(input.sessionId);
        if (session === undefined) {
          return {
            found: false,
            sessionId: input.sessionId,
            detail: 'No session with that identifier is on record.',
            remediation: 'Call ferret_session_list to see the sessions this installation holds.',
          };
        }

        const [checkpoint, memories] = await Promise.all([
          sessions.latestCheckpoint(input.sessionId),
          sessions.memoriesFor(input.sessionId),
        ]);

        return {
          found: true,
          session: summarize(session),
          checkpoint:
            checkpoint === undefined
              ? undefined
              : {
                  sequence: checkpoint.checkpointSequence,
                  summary: checkpoint.summary,
                  continuationState: checkpoint.continuationState,
                  checkpointedAt: checkpoint.checkpointedAt,
                },
          memories: memories.map((memory) => ({
            kind: memory.kind,
            statement: memory.statement,
            rationale: memory.rationale,
            origin: memory.origin,
            confidence: memory.confidence,
            recordedAt: memory.recordedAt,
            // Reported rather than filtered: "why did we change our mind" is
            // worth answering, and a client that cannot see the replaced half
            // cannot answer it.
            supersededBy: memory.supersededBy,
            supersedes: memory.supersedes,
          })),
        };
      }),
  );
}
