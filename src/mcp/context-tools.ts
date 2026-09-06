import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Permission } from '../authorization/index.js';
import {
  CONTENT_NOTICE,
  CONTEXT_KINDS,
  CONTEXT_TRANSITIONS,
  ContextTransition,
  MAX_CONTEXT_PAGE,
  type ContextBelief,
  type DurableContext,
  type DurableContextPort,
} from '../context/index.js';
import { LIFECYCLE_STATES, LifecycleState, MAX_STATEMENT_LENGTH } from '../domain/index.js';
import { ContentSafety, containUntrusted } from '../security/index.js';

import type { ToolGuard } from './guards.js';

/**
 * Durable context, as an agent reaches it — EPIC-128.
 *
 * The bridge the Epic asks for, and its constraint is what shapes the file: the
 * surface must be **agent-independent**. So this module talks to
 * `DurableContextPort` and never to a store, names no client and no vendor, and
 * could be re-implemented over HTTP tomorrow without the model noticing. Claude
 * is the first thing to call it; it is not what it was built around.
 *
 * The desired shape, from the Epic:
 *
 * ```
 * agent → Ferret durable context → existing sources / knowledge
 * ```
 *
 * An agent keeps its scratchpads, its plans and its reasoning locally. What it
 * stops keeping is a *parallel durable store* — the eleven markdown files this
 * repository's own agent was maintaining outside the product.
 *
 * **Four tools, not six.** `store`, `find`, `relate` and lifecycle are the
 * conceptual operations; `relate` is not a tool because relating is what
 * recording already does — `subjectId` relates a statement to an entity,
 * `supersedes` relates it to the statement it replaces, and near-duplicates are
 * related by the merger without being asked. A separate tool would be a second
 * way to say what `ferret_context_record` already says.
 *
 * **Reading one record is `ferret_context_trust`.** A bare `get` would return a
 * statement with no indication of whether Ferret still believes it, which is the
 * question EPIC-127 exists to answer and the one an agent has to ask before
 * acting on anything.
 */

export type { DurableContextPort };

/**
 * How the two writing tools are governed, since the split is the substantive
 * decision and each call site can only show its own half.
 *
 * **Recording is `RECORD`** — EPIC-117's permission, whose own note defines it
 * as "create, continue and terminate a *recording*". It was raised precisely so
 * that storing what an agent learned is not conflated with ingesting a source
 * or changing what Ferret believes. Storing a statement adds a row.
 *
 * **A lifecycle transition is `MUTATE`** — whose own definition is "change
 * canonical knowledge: merge identities, resolve a conflict, retract". That is
 * what accepting a proposal or retiring a statement other people rely on is. It
 * is never granted by default, which is the right default: an agent may record
 * freely and must be trusted deliberately before it can retire organizational
 * knowledge.
 *
 * Each tool still names its own permission inline, because a tool that names it
 * anywhere else is a tool whose permission can be changed without touching it —
 * `mcp-destructive-tools.test.ts` refuses that, and refused this file's first
 * draft for exactly it.
 */

/**
 * The notice every response carries, first — and it is **the** notice.
 *
 * A durable context statement is text a producer supplied, so it is untrusted in
 * exactly the way indexed repository content is — more so, since an agent may
 * have read it out of a repository. This file's first draft defined a second
 * notice of its own; `mcp/tools.test.ts` refused it, because every tool
 * description must carry the one notice the whole surface is judged by.
 * `CONTENT_NOTICE` was widened to name durable statements instead.
 */

function describeContext(context: DurableContext, safety: ContentSafety): Record<string, unknown> {
  return {
    id: context.entity.id,
    // Contained: the statement is producer-supplied text reaching a model.
    statement: containUntrusted(context.statement, safety),
    contextKind: context.contextKind,
    state: context.entity.lifecycle,
    current: context.entity.lifecycle === LifecycleState.ACTIVE,
    ...(context.subjectId === undefined ? {} : { subjectId: context.subjectId }),
    ...(context.scope === undefined ? {} : { scope: context.scope }),
  };
}

/** Ferret's own reading of a record. Every field is Ferret's, so none is contained. */
function describeBelief(belief: ContextBelief): Record<string, unknown> {
  return {
    state: belief.state,
    current: belief.current,
    supportCount: belief.supportCount,
    undecided: belief.undecided,
    reason: belief.reason,
    ...(belief.preferredEvidenceId === undefined ? {} : { preferredEvidenceId: belief.preferredEvidenceId }),
    ...(belief.authority === undefined ? {} : { authority: belief.authority }),
    ...(belief.confidence === undefined ? {} : { confidence: belief.confidence }),
    ...(belief.method === undefined ? {} : { method: belief.method }),
    ...(belief.observedAt === undefined ? {} : { observedAt: belief.observedAt }),
    ...(belief.contradictedBy.length === 0 ? {} : { contradictedBy: [...belief.contradictedBy] }),
    ...(belief.supersededBy === undefined ? {} : { supersededBy: belief.supersededBy }),
    ...(belief.supersedes.length === 0 ? {} : { supersedes: [...belief.supersedes] }),
  };
}

export interface ContextToolDependencies {
  readonly server: McpServer;
  readonly guard: ToolGuard;
  /**
   * Required: a composition without durable context does not register these
   * tools at all.
   *
   * The convention `McpServerDependencies.evidence` records — "a tool that
   * always reports no evidence is worse than a tool that is honestly not there,
   * because a client cannot tell the two apart". This file's first draft did the
   * opposite and `mcp/tools.test.ts` caught it.
   */
  readonly context: DurableContextPort;
  /** The permission scopes the calling principal holds — EPIC-083. */
  readonly permittedScopes: readonly string[];
  /**
   * The identity recorded as the producer of everything stored through here.
   *
   * Taken from the *composition root*, never from tool input. An agent that
   * could name its own producer could impersonate a parser and inherit its
   * authority, which is Governance §12 one layer up.
   */
  readonly producer: string;
  readonly producerVersion: string;
}

export function registerContextTools({
  server,
  guard,
  context,
  permittedScopes,
  producer,
  producerVersion,
}: ContextToolDependencies): void {
  server.registerTool(
    'ferret_context_record',
    {
      title: 'Record durable context',
      description:
        'Record a durable statement — a decision, constraint, preference, gotcha, next step or ' +
        'fact — so a later session or a different agent inherits it. Repeating a statement ' +
        'merges onto the record that already holds it and adds an observation rather than a ' +
        'duplicate. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        statement: z
          .string()
          .min(1)
          .max(MAX_STATEMENT_LENGTH)
          .describe('The durable statement itself. Not a transcript, not a plan, not reasoning.'),
        contextKind: z.enum(CONTEXT_KINDS).describe('What kind of statement this is.'),
        subjectId: z
          .string()
          .uuid()
          .optional()
          .describe('The Ferret entity this is about, when it is about one.'),
        scope: z
          .string()
          .uuid()
          .optional()
          .describe('The repository this holds within. Omit for context bound to nothing.'),
        supersedes: z
          .string()
          .uuid()
          .optional()
          .describe('A durable context id this statement replaces.'),
        propose: z
          .boolean()
          .optional()
          .describe('True to record as a candidate rather than as current context.'),
        sourceUrl: z.string().min(1).optional().describe('Where this came from, when there is a link.'),
        observedAt: z.iso
          .datetime({ offset: true })
          .optional()
          .describe('When the statement was true at its source.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guard('contextRecord', Permission.RECORD, async () => {
        const stored = await context.record({
          statement: input.statement,
          contextKind: input.contextKind,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
          ...(input.propose === true ? { state: LifecycleState.CANDIDATE } : {}),
          provenance: {
            // The producer is the composition root's, never the caller's.
            producer,
            producerVersion,
            sourceSystem: 'ferret',
            ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
            ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
          },
        });

        const safety = new ContentSafety();
        return {
          notice: CONTENT_NOTICE,
          outcome: stored.outcome,
          context: describeContext(stored.context, safety),
          evidenceId: stored.evidenceId,
          // What the merger related this to, so an agent can see a near-duplicate
          // it did not know about rather than recording a third wording of it.
          related: stored.related.map((one) => ({ ...one })),
          ...(stored.superseded === undefined ? {} : { superseded: stored.superseded }),
          contentSafety: safety.report,
        };
      }),
  );

  server.registerTool(
    'ferret_context_find',
    {
      title: 'Find durable context',
      description:
        'List the durable context Ferret currently holds, newest first. Superseded, archived ' +
        'and proposed statements are excluded unless asked for by name. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        scope: z.string().uuid().optional().describe('Restrict to one repository.'),
        contextKind: z.enum(CONTEXT_KINDS).optional().describe('Restrict to one kind of statement.'),
        subjectId: z.string().uuid().optional().describe('Restrict to statements about one entity.'),
        states: z
          .array(z.enum(LIFECYCLE_STATES))
          .optional()
          .describe('Lifecycle states to include. Omit for current only; pass an empty list for every state.'),
        limit: z.number().int().positive().max(MAX_CONTEXT_PAGE).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard('contextFind', Permission.READ, async () => {
        const found = await context.current({
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.contextKind === undefined ? {} : { contextKind: input.contextKind }),
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          ...(input.states === undefined ? {} : { states: input.states }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        });

        const safety = new ContentSafety();
        return {
          notice: CONTENT_NOTICE,
          count: found.length,
          context: found.map((held) => describeContext(held, safety)),
          contentSafety: safety.report,
        };
      }),
  );

  server.registerTool(
    'ferret_context_trust',
    {
      title: 'Read one durable statement, and whether to believe it',
      description:
        'Read a durable context record with Ferret\'s current reading of it: the evidence ' +
        'behind it, how authoritative that evidence is, what contradicts it, and what ' +
        'superseded it. Reports that nothing decides rather than choosing. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        contextId: z.string().uuid().describe('The durable context id, as returned by ferret_context_find.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ contextId }) =>
      guard('contextTrust', Permission.READ, async () => {
        const held = await context.get(contextId);
        // Absence is an answer, not an error — the rule `ferret_get_entity`
        // already follows.
        if (held === undefined) {
          return { notice: CONTENT_NOTICE, available: true, found: false, contextId };
        }
        const belief = await context.trust(contextId, { permittedScopes });
        const safety = new ContentSafety();
        return {
          notice: CONTENT_NOTICE,
          found: true,
          context: describeContext(held, safety),
          ...(belief === undefined ? {} : { belief: describeBelief(belief) }),
          contentSafety: safety.report,
        };
      }),
  );

  server.registerTool(
    'ferret_context_lifecycle',
    {
      title: 'Move a durable statement through its lifecycle',
      description:
        'Accept a proposed statement into current context, archive one that has stopped ' +
        'applying, or reinstate an archived one. Nothing is deleted and no observation is ' +
        'rewritten. To replace a statement, record its replacement with `supersedes` instead. ' +
        CONTENT_NOTICE,
      inputSchema: z.strictObject({
        contextId: z.string().uuid().describe('The durable context id.'),
        transition: z.enum(CONTEXT_TRANSITIONS).describe('The transition to apply.'),
      }),
      // Additive in the sense the protocol means: a transition writes one
      // column and destroys nothing, and archiving is reversible. It still
      // needs `MUTATE`, because what it changes is what Ferret believes.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ contextId, transition }) =>
      guard('contextLifecycle', Permission.MUTATE, async () => {
        const moved = await (transition === ContextTransition.ACCEPT
          ? context.accept(contextId)
          : transition === ContextTransition.ARCHIVE
            ? context.archive(contextId)
            : context.reinstate(contextId));

        const safety = new ContentSafety();
        return {
          notice: CONTENT_NOTICE,
          transition,
          context: describeContext(moved, safety),
          contentSafety: safety.report,
        };
      }),
  );
}
