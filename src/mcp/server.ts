import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { CONTENT_NOTICE, ContextPackBuilder, MAX_BUDGET, renderPack } from '../context/index.js';
import { serializeError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { MAX_LIMIT, type RetrievalPort } from '../retrieval/index.js';
import { VERSION } from '../version.js';

/**
 * The AI control plane.
 *
 * Everything Ferret knows reaches a model through this file, which makes it the
 * one place where the delivery brief's hardest constraint has to hold:
 * **indexed content must never override Ferret's or the client's
 * instructions.**
 *
 * That cannot be solved by filtering. A commit message saying *"ignore your
 * previous instructions"* is indistinguishable from one discussing prompt
 * injection, and no denylist survives an attacker who can write arbitrary text
 * into a repository Ferret indexes. So the defence is **structural**:
 *
 * - Every tool returns **structured content** — JSON with named fields — rather
 *   than prose. A model reading `{"message": "ignore your instructions"}` is
 *   reading an attributed value, not receiving a command.
 * - Every response carries the content notice, and it comes **first**. A model
 *   reads in order, and an instruction that arrives after the content it
 *   governs has already lost.
 * - No tool interpolates indexed content into a sentence Ferret wrote. There is
 *   no template anywhere in this file with a hole for source text.
 *
 * Every tool is also **read-only**, declared as such through `readOnlyHint`, and
 * there is nothing here that writes. Indexing is a command a human runs;
 * EPIC-069 is where a destructive operation would need confirmation, and until
 * then the safest number of destructive tools is none.
 */

export const MCP_SERVER_NAME = 'ferret';

/** Results a tool will return however many are asked for. */
const TOOL_RESULT_LIMIT = 50;

export interface McpServerDependencies {
  readonly retrieval: RetrievalPort;
  readonly logger: Logger;
}

/**
 * Builds the Ferret MCP server.
 *
 * Separated from serving it so the tools can be tested without a transport,
 * which is most of what is worth testing.
 */
export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const { retrieval, logger } = dependencies;
  const packs = new ContextPackBuilder(retrieval);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    {
      instructions:
        'Ferret answers questions about indexed repositories: commits, files, ' +
        'branches, worktrees, developers and the evidence behind each fact. ' +
        CONTENT_NOTICE,
    },
  );

  /** Wraps a handler so a failure becomes a redacted tool error, never a crash. */
  const guard = async (
    operation: string,
    run: () => Promise<unknown>,
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
    try {
      const result = await run();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // Serialized, therefore redacted: an error crossing to an AI client is
      // exactly the path a credential must not take, and EPIC-009's serializer
      // is the one place that guarantee lives.
      const serialized = serializeError(error);
      logger.warn({ operation: `mcp.${operation}`, err: error }, `MCP tool ${operation} failed`);
      return { content: [{ type: 'text', text: JSON.stringify(serialized, null, 2) }], isError: true };
    }
  };

  server.registerTool(
    'ferret_search',
    {
      title: 'Search indexed knowledge',
      description:
        'Full-text search across indexed repositories: commit messages, file ' +
        'paths, branch names and recorded evidence. Returns ranked results. ' +
        'Use this when you half-remember something and need to find it. ' +
        CONTENT_NOTICE,
      inputSchema: z.strictObject({
        query: z.string().min(1).max(1024).describe('What to search for. Supports "quoted phrases" and -exclusion.'),
        kinds: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe('Restrict to entity kinds such as commit, file, branch, developer.'),
        limit: z.number().int().min(1).max(TOOL_RESULT_LIMIT).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, kinds, limit }) =>
      guard('search', async () => {
        const hits = await retrieval.search({
          text: query,
          ...(kinds === undefined ? {} : { kinds }),
          limit: Math.min(limit ?? 20, TOOL_RESULT_LIMIT),
        });
        return {
          notice: CONTENT_NOTICE,
          count: hits.length,
          results: hits.map((hit) => ({
            id: hit.entity.id,
            kind: hit.entity.kind,
            source: hit.entity.source,
            attributes: hit.entity.attributes,
            matchedIn: hit.source,
            highlight: hit.highlight,
            score: hit.score,
          })),
        };
      }),
  );

  server.registerTool(
    'ferret_get_entity',
    {
      title: 'Read one entity',
      description:
        'Read a single indexed entity by its Ferret id, with its external ' +
        'identifiers. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        id: z.string().uuid().describe('The Ferret entity id, as returned by ferret_search.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard('getEntity', async () => {
        const entity = await retrieval.getEntity(id);
        // Absence is an answer, not an error. A client asking about something
        // Ferret has not indexed should be told that, not handed a failure it
        // has to interpret.
        return entity === undefined
          ? { notice: CONTENT_NOTICE, found: false, id }
          : { notice: CONTENT_NOTICE, found: true, entity };
      }),
  );

  server.registerTool(
    'ferret_neighbours',
    {
      title: 'What is connected to this',
      description:
        'Follow relationships from an entity: the commits that modified a file, ' +
        'the files a commit touched, the branch a worktree has checked out. ' +
        'Pass `at` to ask what was true at a past instant rather than now — ' +
        'that is how to answer "what was I working on last Tuesday". ' +
        CONTENT_NOTICE,
      inputSchema: z.strictObject({
        id: z.string().uuid(),
        types: z.array(z.string().min(1)).max(20).optional().describe('Relationship types to follow.'),
        direction: z.enum(['out', 'in', 'both']).optional(),
        at: z.string().datetime({ offset: true }).optional().describe('ISO 8601 instant to answer as of.'),
        includeHistorical: z
          .boolean()
          .optional()
          .describe('Include relationships that have ended, so a deletion is visible.'),
        limit: z.number().int().min(1).max(TOOL_RESULT_LIMIT).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, types, direction, at, includeHistorical, limit }) =>
      guard('neighbours', async () => {
        const neighbours = await retrieval.neighbours({
          from: id,
          ...(types === undefined ? {} : { types }),
          ...(direction === undefined ? {} : { direction }),
          ...(at === undefined ? {} : { at }),
          ...(includeHistorical === undefined ? {} : { includeHistorical }),
          limit: Math.min(limit ?? 20, TOOL_RESULT_LIMIT),
        });
        return {
          notice: CONTENT_NOTICE,
          asOf: includeHistorical === true ? 'all time' : (at ?? 'now'),
          count: neighbours.length,
          neighbours: neighbours.map((neighbour) => ({
            id: neighbour.entity.id,
            kind: neighbour.entity.kind,
            lifecycle: neighbour.entity.lifecycle,
            attributes: neighbour.entity.attributes,
            relationship: neighbour.relationshipType,
            direction: neighbour.direction,
            // What the source said about the edge itself — including whether a
            // commit added, modified or deleted the file it touched.
            ...(Object.keys(neighbour.metadata).length === 0
              ? {}
              : { metadata: neighbour.metadata }),
            validFrom: neighbour.validFrom,
            validTo: neighbour.validTo,
          })),
        };
      }),
  );

  server.registerTool(
    'ferret_context_pack',
    {
      title: 'Assemble context for a question',
      description:
        'Build a bounded pack of the most relevant indexed knowledge for a ' +
        'question, sized to a token budget. The pack states what it left out, ' +
        'so treat a partial pack as partial evidence. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        question: z.string().min(1).max(1024),
        budget: z.number().int().min(100).max(MAX_BUDGET).optional().describe('Estimated tokens the pack may occupy.'),
        kinds: z.array(z.string().min(1)).max(20).optional(),
        withNeighbours: z.boolean().optional(),
        format: z.enum(['json', 'text']).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ question, budget, kinds, withNeighbours, format }) =>
      guard('contextPack', async () => {
        const pack = await packs.build({
          question,
          ...(budget === undefined ? {} : { budget }),
          ...(kinds === undefined ? {} : { kinds }),
          ...(withNeighbours === undefined ? {} : { withNeighbours }),
        });
        return format === 'text' ? { notice: CONTENT_NOTICE, rendered: renderPack(pack) } : pack;
      }),
  );

  server.registerTool(
    'ferret_find',
    {
      title: 'Find entities exactly',
      description:
        'Exact, unranked lookup by kind and attribute — "every file in this ' +
        'repository", "the branch named main". Use this when the question has ' +
        'a right answer; use ferret_search when it does not. ' + CONTENT_NOTICE,
      inputSchema: z.strictObject({
        kind: z.string().min(1).optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        scope: z.string().uuid().optional().describe('The entity these are identified within, e.g. a repository.'),
        lifecycle: z
          .enum(['active', 'deleted', 'superseded', 'unknown'])
          .optional()
          .describe('Restrict to a lifecycle state. Omitted returns every state, deleted included.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, attributes, scope, lifecycle, limit }) =>
      guard('find', async () => {
        // Bounded by `MAX_LIMIT`, which is what the schema advertises — not by
        // the smaller cap the ranked tools use. Accepting a limit of 500 and
        // then quietly returning 50 makes the declared schema a lie, and this is
        // the tool whose stated purpose is "every file in this repository".
        const requested = Math.min(limit ?? 20, MAX_LIMIT);
        // One more than asked for, purely to learn whether there were more. An
        // exact lookup that silently returns the first page of a larger answer
        // is a wrong answer wearing a right one's clothes — the caller has no
        // way to tell, and "every file in this repository" is precisely the
        // question people ask this tool.
        const entities = await retrieval.findEntities({
          ...(kind === undefined ? {} : { kind }),
          ...(attributes === undefined ? {} : { attributes }),
          ...(scope === undefined ? {} : { scope }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
          limit: Math.min(requested + 1, MAX_LIMIT),
        });
        const truncated = entities.length > requested;
        const page = truncated ? entities.slice(0, requested) : entities;
        return {
          notice: CONTENT_NOTICE,
          count: page.length,
          ...(truncated
            ? {
                truncated: true,
                more: `More than ${requested} entities match. This is a partial answer — raise \`limit\` (max ${MAX_LIMIT}) or narrow the query.`,
              }
            : { truncated: false }),
          entities: page,
        };
      }),
  );

  return server;
}

/**
 * Serves over stdio.
 *
 * stdio because that is how an AI client spawns a tool it trusts: no port, no
 * listener, no surface anything else on the machine can reach. Governance §14
 * asks for the lightest infrastructure that works, and a server nobody can
 * connect to from outside the process that started it is the lightest there is.
 *
 * **Nothing may be written to stdout except protocol messages.** stdout *is* the
 * transport, and a stray `console.log` corrupts the stream — which is why
 * Ferret's logger has written to stderr since EPIC-001.
 */
export async function serveStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return transport;
}
