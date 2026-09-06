import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AuditWriter } from '../audit/index.js';
import { Permission, type Principal } from '../authorization/index.js';
import {
  DEFAULT_MEMORY_LIMIT,
  MEMORY_KINDS,
  createEngineeringMemory,
  createSession,
  createSessionCheckpoint,
  endSession,
  recoverSession,
  type EngineeringMemory,
  type Session,
  type SessionCheckpoint,
  type JsonValue,
  type SessionRecoveryPort,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
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
 * **Recording — EPIC-117.** The read half shipped first because the write half
 * needed an answer to who owns a session's identity and lifetime. It has one,
 * and three decisions carry it:
 *
 * **The server mints the identity (D-117.1).** `ferret_session_start` returns an
 * id the client did not choose, and there is deliberately no way to supply one.
 * A client may *participate* in a session — every later call names the id it was
 * given — without owning the namespace, so a buggy or hostile client cannot
 * collide with, or write into, another client's session.
 *
 * **A closed transport is not an ended session (D-117.2).** Nothing here, and
 * nothing in `server.ts`, ends a session when a connection drops. An editor
 * restarting is the common case and it is not the user finishing their work.
 * A session ends when `ferret_session_end` says so and at no other time, which
 * leaves the reclamation of a crashed client's session where EPIC-112 already
 * put it: `ferret prune --sessions`, on an age an operator supplies.
 *
 * **Recording has its own permission (D-117.3).** `Permission.RECORD`, an
 * EPIC-068 amendment raised as one rather than an overload of `INDEX`. See the
 * permission's own note for why both overload candidates were worse.
 *
 * **Additive, not destructive.** The four writing tools declare
 * `destructiveHint: false`, which is the protocol's own word for a tool that
 * performs only additive updates. Recording a decision adds a row; ending a
 * session refuses later writes and destroys nothing that was already recorded.
 * Routing them through EPIC-069's confirmation gate would have made an agent ask
 * a human to approve each sentence it wanted to remember, which is the capability
 * this Epic exists to provide.
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
  /**
   * The write half — EPIC-117. Optional, and its absence is a *reported* refusal.
   *
   * A composition that supplies a read-only access object gets the read tools
   * and a recording tool that says recording is unavailable here, rather than a
   * tool that is silently absent. "This build cannot record" and "this tool does
   * not exist" are different facts, and a client that cannot tell them apart
   * concludes the wrong one.
   */
  save?(value: Session): Promise<void>;
  saveCheckpoint?(value: SessionCheckpoint): Promise<void>;
  recordMemory?(value: EngineeringMemory): Promise<void>;
}

export interface SessionToolDependencies {
  readonly sessions: SessionAccess;
  readonly logger: Logger;
  readonly principal: Principal;
  readonly audit?: AuditWriter | undefined;
}

/**
 * The writer, or a refusal that says why.
 *
 * A composition without the write half is a real state — `server.ts` takes
 * `SessionAccess` from whatever a caller supplies — and the honest answer is
 * "this installation cannot record", not a missing method's `TypeError`.
 */
function writerOrRefuse<T>(method: T | undefined, what: string): T {
  if (method === undefined) {
    throw new FerretError(
      ErrorCode.NOT_IMPLEMENTED,
      `This Ferret cannot ${what}: no session store is composed on this server`,
      {
        remediation:
          'Start the server with `ferret mcp`, which composes the session store, and check `ferret status`.',
      },
    );
  }
  return method;
}

/** The session named by a call, or a refusal naming it. */
async function mustFind(sessions: SessionAccess, sessionId: string): Promise<Session> {
  const session = await sessions.getSession(sessionId);
  if (session === undefined) {
    throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `Session "${sessionId}" is not on record`, {
      details: { sessionId },
      remediation:
        'Call ferret_session_start to open one, or ferret_session_list to find an identifier this installation holds.',
    });
  }
  return session;
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
/**
 * What a caller is told about a session that is not theirs — EPIC-133.
 *
 * **The same answer for "no such session" and "not your session."** A message
 * that distinguished them would let a caller enumerate another agent's work by
 * probing identifiers, which is the disclosure the ownership check exists to
 * prevent. A legitimate owner who mistyped one still gets an actionable answer.
 *
 * Stated once and used by every read, because a rule written three times is a
 * rule that will hold in two places.
 */
function notYours(sessionId: string): Record<string, unknown> {
  return {
    found: false,
    sessionId,
    detail: 'No session you own has that identifier.',
    remediation: 'Call ferret_session_list to see the sessions this agent has recorded.',
  };
}

/** True when this session is the calling principal's to read. */
function ownedBy(session: Session | undefined, actorId: string): session is Session {
  return session !== undefined && session.actorId === actorId;
}

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
        // EPIC-133. A session is read by the agent that ran it. Found by
        // EPIC-132: an agent could recall, and then publish, another agent's
        // working state simply by naming its identifier.
        const session = await sessions.getSession(input.sessionId);
        if (!ownedBy(session, principal.id)) {
          return notYours(input.sessionId);
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
        // EPIC-133. The principal's own sessions, and there is no field a
        // caller could name someone else's in. Listing another agent's
        // sessions disclosed how much work it had done and when, and handed
        // over the identifiers every other session read takes.
        const actorId = principal.id;
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
        // EPIC-133, the same rule as recall: a session is read by the agent
        // that ran it.
        const session = await sessions.getSession(input.sessionId);
        if (!ownedBy(session, principal.id)) {
          return notYours(input.sessionId);
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
  // ─── Recording — EPIC-117 ────────────────────────────────────────────────
  //
  // Four tools, one permission, and a lifecycle nothing but an explicit call
  // advances. Each is `readOnlyHint: false` and `destructiveHint: false`: they
  // write, and what they write is additive.

  server.registerTool(
    'ferret_session_start',
    {
      title: 'Open a session to record work in',
      description:
        'Open a session and return the identifier Ferret minted for it. Call ' +
        'this once at the start of a piece of work, then pass the identifier ' +
        'to ferret_session_remember, ferret_session_checkpoint and ' +
        'ferret_session_end. The identifier is the server-s and cannot be ' +
        'chosen by the client; a client resuming work should call ' +
        'ferret_session_list to find the one it was given rather than opening ' +
        'a second session. Closing the connection does not end a session.',
      inputSchema: z.strictObject({
        provider: z
          .string()
          .min(1)
          .optional()
          .describe('The AI client this session belongs to. Defaults to the calling principal.'),
        repositoryId: z.string().min(1).optional().describe('Repository scope, when known.'),
        worktreeId: z.string().min(1).optional().describe('Worktree scope, when known.'),
        branch: z.string().min(1).optional().describe('Branch scope, when known.'),
        parentSessionId: z
          .string()
          .min(1)
          .optional()
          .describe('The session this one continues, so a recall inherits what it decided.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      guard('session.start', Permission.RECORD, async () => {
        const save = writerOrRefuse(sessions.save?.bind(sessions), 'open a session');

        // D-117.1 — minted here, and there is no input field that could carry
        // one. A client that supplied its own would make session ids a shared
        // namespace, and nothing would stop it writing into another client's.
        const value = createSession({
          sessionId: randomUUID(),
          provider: input.provider ?? principal.id,
          actorId: principal.id,
          ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
          ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
          startedAt: new Date().toISOString(),
        });
        await save(value);

        return {
          session: summarize(value),
          sessionId: value.sessionId,
          notice:
            'Keep this identifier for the rest of this piece of work. A closed connection does not end the session; call ferret_session_end when the work is done.',
        };
      }),
  );

  server.registerTool(
    'ferret_session_remember',
    {
      title: 'Record what this session decided',
      description:
        'Record one thing this session decided, was constrained by, preferred, ' +
        'or discovered the hard way, so a later session inherits it without ' +
        'replaying the transcript. One sentence per call, with the reasoning in ' +
        '`rationale` — what it was chosen over is the part a later reader ' +
        'cannot reconstruct. Credentials are removed from what is stored.',
      inputSchema: z.strictObject({
        sessionId: z.string().min(1).describe('The session that decided it.'),
        kind: z.enum(MEMORY_KINDS).describe('What sort of thing this is.'),
        statement: z.string().min(1).describe('What holds, in one sentence.'),
        rationale: z.string().min(1).optional().describe('Why — and what it was chosen over.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      guard('session.remember', Permission.RECORD, async () => {
        const record = writerOrRefuse(sessions.recordMemory?.bind(sessions), 'record a memory');
        await mustFind(sessions, input.sessionId);

        // `explicit`, because a client stating something is not an extraction
        // from a transcript — and EPIC-042 requires an *extracted* memory to
        // cite the captures it was drawn from. Claiming extraction here would
        // either fail that constraint or fabricate the citation.
        const memory = createEngineeringMemory({
          sessionId: input.sessionId,
          kind: input.kind,
          statement: input.statement,
          ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
          origin: 'explicit',
          recordedAt: new Date().toISOString(),
        });
        await record(memory);

        return {
          sessionId: memory.sessionId,
          kind: memory.kind,
          statement: memory.statement,
          rationale: memory.rationale,
          // Reported rather than silent: a client that pasted a credential
          // should learn that Ferret removed it, and a truncated statement is
          // not the statement the caller sent.
          redactedSecrets: memory.redactedSecrets,
          truncated: memory.truncated,
          recordedAt: memory.recordedAt,
        };
      }),
  );

  server.registerTool(
    'ferret_session_checkpoint',
    {
      title: 'Record resumable state for this session',
      description:
        'Record where this session has got to, compactly, so a later session ' +
        'can resume without the transcript. The summary is prose; ' +
        '`continuationState` is whatever the client needs handed back to it. ' +
        'Checkpoints are numbered by Ferret and never overwrite one another, ' +
        'so call this whenever the state of the work changes materially.',
      inputSchema: z.strictObject({
        sessionId: z.string().min(1).describe('The session to checkpoint.'),
        summary: z.string().min(1).describe('What has happened so far, compactly.'),
        continuationState: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Whatever this client needs handed back to resume. An object.'),
        capturedThroughSequence: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Highest captured turn this checkpoint represents, or 0 when unknown.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      guard('session.checkpoint', Permission.RECORD, async () => {
        const save = writerOrRefuse(sessions.saveCheckpoint?.bind(sessions), 'record a checkpoint');
        const owner = await mustFind(sessions, input.sessionId);

        // The sequence is read, never asked for — EPIC-110's reasoning, and the
        // same one: a caller who has to supply it can only get it wrong, and
        // EPIC-041 makes the progression monotonic so nobody has to track it.
        const latest = await sessions.latestCheckpoint(input.sessionId);
        const checkpoint = createSessionCheckpoint({
          sessionId: input.sessionId,
          provider: owner.provider,
          checkpointSequence: (latest?.checkpointSequence ?? 0) + 1,
          capturedThroughSequence: Math.max(
            input.capturedThroughSequence ?? 0,
            latest?.capturedThroughSequence ?? 0,
          ),
          checkpointedAt: new Date().toISOString(),
          summary: input.summary,
          // The MCP schema accepts an object of unknowns and the domain
          // accepts only JSON values, which is the same set expressed twice:
          // a tool argument arrived as JSON and cannot hold anything else.
          // `createSessionCheckpoint` re-validates it either way.
          continuationState: (input.continuationState ?? {}) as Record<string, JsonValue>,
        });
        await save(checkpoint);

        return {
          sessionId: checkpoint.sessionId,
          sequence: checkpoint.checkpointSequence,
          capturedThroughSequence: checkpoint.capturedThroughSequence,
          checkpointedAt: checkpoint.checkpointedAt,
        };
      }),
  );

  server.registerTool(
    'ferret_session_end',
    {
      title: 'Close this session',
      description:
        'Close a session. What it recorded stays readable for ever; only ' +
        'further writes to it are refused. Call this when the work is finished ' +
        'or abandoned. **Do not call it because a connection is closing** — a ' +
        'session outlives the transport deliberately, so an editor restart ' +
        'resumes the same work rather than fragmenting it.',
      inputSchema: z.strictObject({
        sessionId: z.string().min(1).describe('The session to close.'),
        abandoned: z
          .boolean()
          .optional()
          .describe('Record it as abandoned rather than completed. Off by default.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      guard('session.end', Permission.RECORD, async () => {
        const save = writerOrRefuse(sessions.save?.bind(sessions), 'close a session');
        const session = await mustFind(sessions, input.sessionId);

        // D-117.2 — this call, and nothing else, is what ends a session. The
        // domain refuses a second terminal transition, so a client that ends an
        // already-ended session is told rather than silently re-ending it.
        const ended = endSession(session, input.abandoned === true ? 'abandoned' : 'completed', new Date());
        await save(ended);

        return { session: summarize(ended), endedAt: ended.endedAt, status: ended.status };
      }),
  );
}
