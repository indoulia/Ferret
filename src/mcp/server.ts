import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  AnswerPackBuilder,
  CONTENT_NOTICE,
  ContextPackBuilder,
  MAX_ANSWER_BUDGET,
  MAX_BUDGET,
  MAX_LINEAGE_DEPTH,
  renderAnswer,
  renderPack,
  type EvidenceReader,
} from '../context/index.js';
import {
  ANONYMOUS_PRINCIPAL,
  ConfirmationGate,
  Permission,
  type Principal,
} from '../authorization/index.js';
import { ContentSafety, NO_CONTENT_SAFETY, containAttributes } from '../security/index.js';
import {
  EvidenceState,
  integrityHashOf,
  type CanonicalEntity,
  type CanonicalEvidence,
} from '../domain/index.js';
import type { Logger } from '../logging/index.js';
import {
  MAX_LIMIT,
  PUBLIC_ACCESS,
  explainQuery,
  renderExplanation,
  type AccessContext,
  type QueryPlanner,
  type RetrievalPort,
  type SearchHit,
} from '../retrieval/index.js';
import { VERSION } from '../version.js';

import { registerConfigTools, type ConfigurationAccess } from './config-tools.js';
import { createToolGuard } from './guards.js';

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
 * there is nothing here that writes. Indexing is a command a human runs.
 *
 * A destructive tool is now *possible* rather than forbidden: EPIC-068 supplies
 * the permission it must be granted, EPIC-069 the confirmation it must be given,
 * and `createDestructiveToolGuard` in `./guards.ts` is the only path it may take.
 * Both controls hold, in that order — a caller that was not granted the
 * permission never learns what the operation would have done, because a plan is a
 * disclosure about Ferret's state. `tests/unit/mcp-destructive-tools.test.ts`
 * reads this file and fails if a tool is registered without `readOnlyHint: true`
 * and without that guard, so the guarantee does not rest on the next author
 * remembering it. The two that exist — `ferret_config_set` and
 * `ferret_config_unset`, EPIC-066's — live in `./config-tools.ts`; nothing in
 * this file writes.
 */

export const MCP_SERVER_NAME = 'ferret';

/** Results a tool will return however many are asked for. */
const TOOL_RESULT_LIMIT = 50;

export interface McpServerDependencies {
  readonly retrieval: RetrievalPort;
  /**
   * EPIC-055's planner, when one is wired.
   *
   * Optional so that a caller with only a `RetrievalPort` still gets a working
   * server — the planner is an improvement to how a question is routed, not a
   * new requirement for answering one.
   */
  readonly planner?: QueryPlanner;
  /**
   * EPIC-048's evidence reader, when one is wired.
   *
   * Optional for the same reason `planner` is: a caller with only a
   * `RetrievalPort` still gets a working server. When it is absent
   * `ferret_why` is not registered at all, rather than registered and answering
   * "nothing" — a tool that always reports no evidence is worse than a tool that
   * is honestly not there, because a client cannot tell the two apart.
   */
  readonly evidence?: EvidenceReader;
  /**
   * Who this server answers for — EPIC-058.
   *
   * From **configuration**, never from tool input: no tool here accepts a scope,
   * a selector or an exclusion, so nothing an AI client sends can widen what it
   * sees. Governance §12 puts the control in Ferret rather than in a prompt, and
   * a tool parameter would put it back in the prompt.
   *
   * Defaults to {@link PUBLIC_ACCESS} — unscoped content only — so a caller that
   * composes a server without thinking about authorization gets the restricted
   * view rather than everything.
   */
  readonly access?: AccessContext;
  /**
   * Who this server answers for — EPIC-068.
   *
   * Defaults to {@link ANONYMOUS_PRINCIPAL}: read-only, no scopes. So a caller
   * that composes a server without thinking about authorization gets the
   * restricted principal rather than an unrestricted one, and no mutating tool
   * can ever be reached by accident.
   *
   * Beside `access` rather than replacing it, because they answer different
   * questions — *may you do this at all* and *what of it may you see* — and
   * EPIC-069 will add a third. `accessContextFor` is how a caller derives the
   * second from the first without letting them drift.
   */
  readonly principal?: Principal;
  /**
   * Whether a destructive operation was intended — EPIC-069.
   *
   * A third question beside `access` and `principal`: *may you do this at all*,
   * *what of it may you see*, and *did you mean it*. All three are separate
   * because a caller can pass one and fail another.
   *
   * Defaults to a gate with default bounds rather than to no gate, so a caller
   * that composes a server without thinking about confirmation gets the
   * confirming one. An `undefined` that meant "do not confirm" would be a way to
   * switch off a Governance §12 control by omission.
   *
   * EPIC-069 deliberately did not add this field, on the grounds that a
   * dependency a server accepts and hands to nothing is not a seam. EPIC-066
   * brings the first tools that need it.
   */
  readonly confirmations?: ConfirmationGate;
  /**
   * Reading and writing Ferret's own configuration — EPIC-066.
   *
   * Optional, and when it is absent the configuration tools are **not
   * registered** rather than registered and failing. Same reasoning as
   * `evidence`: a tool that is honestly not there is better than one a client
   * cannot distinguish from a broken one. A consumer embedding Ferret with only
   * a `RetrievalPort` still gets a working knowledge server.
   */
  readonly configuration?: ConfigurationAccess;
  readonly logger: Logger;
}

/**
 * Builds the Ferret MCP server.
 *
 * Separated from serving it so the tools can be tested without a transport,
 * which is most of what is worth testing.
 */
export function createMcpServer(dependencies: McpServerDependencies): McpServer {
  const { retrieval, planner, evidence, logger } = dependencies;
  const access = dependencies.access ?? PUBLIC_ACCESS;
  const principal = dependencies.principal ?? ANONYMOUS_PRINCIPAL;
  const confirmations = dependencies.confirmations ?? new ConfirmationGate();
  const packs = new ContextPackBuilder(retrieval, access, evidence);

  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION },
    {
      instructions:
        'Ferret answers questions about indexed repositories: commits, files, ' +
        'branches, worktrees, developers and the evidence behind each fact. ' +
        CONTENT_NOTICE,
    },
  );

  // EPIC-068. The permission is checked here rather than in each handler; see
  // `createToolGuard`. The two destructive tools live in `./config-tools.ts` and
  // take `createDestructiveToolGuard` from the same module.
  const guard = createToolGuard({ principal, logger });

  // EPIC-066. Registered only when a caller supplied the access, so a knowledge-
  // only server does not advertise tools it cannot serve.
  if (dependencies.configuration !== undefined) {
    registerConfigTools(server, {
      principal,
      confirmations,
      configuration: dependencies.configuration,
      logger,
    });
  }

  server.registerTool(
    'ferret_search',
    {
      title: 'Search indexed knowledge',
      description:
        'Search indexed repositories: commit messages, file paths, branch names ' +
        'and recorded evidence. Understands an abbreviated commit id or a file ' +
        'path as an exact lookup, and prose as a ranked search. Use this when ' +
        'you half-remember something and need to find it. The response reports ' +
        'which strategies ran and which could not, so a partial answer says so. ' +
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
      guard('search', Permission.READ, async () => {
        const bounded = Math.min(limit ?? 20, TOOL_RESULT_LIMIT);

        // Without a planner the behaviour is exactly what it was: one ranked
        // full-text search. The planner is an improvement to routing, not a new
        // requirement for answering, so its absence changes nothing a caller
        // depends on.
        if (planner === undefined) {
          const { hits, withheld } = await retrieval.search(
            {
              text: query,
              ...(kinds === undefined ? {} : { kinds }),
              limit: bounded,
            },
            access,
          );
          const safety = new ContentSafety();
          const results = hits.map((hit) => describeHit(hit, safety));
          return {
            notice: CONTENT_NOTICE,
            count: hits.length,
            results,
            contentSafety: safety.report,
            // EPIC-058. A count and nothing else. It tells a caller the answer is
            // short without telling it what is missing.
            withheld: withheld.total,
          };
        }

        const { plan, hits, withheld } = await planner.search(
          {
            question: query,
            ...(kinds === undefined ? {} : { kinds }),
            limit: bounded,
          },
          access,
        );

        const safety = new ContentSafety();
        const plannedResults = hits.map((hit) => ({ ...describeHit(hit, safety), foundBy: hit.foundBy }));
        return {
          notice: CONTENT_NOTICE,
          count: hits.length,
          contentSafety: safety.report,
          // EPIC-058. Present on both branches of this tool: dogfooding found it
          // on the unplanned one and absent on the planned one, which is the path
          // the CLI wires — so in production the count reached nobody.
          withheld: withheld.total,
          // Reported, not hidden. A caller cannot tell a complete answer from a
          // partial one unless the answer says which it is, and `partial` is the
          // single field that says so.
          plan: {
            interpretedAs: plan.shape,
            why: plan.reason,
            partial: plan.partial,
            strategies: plan.strategies.map((outcome) => ({
              strategy: outcome.strategy,
              ran: outcome.ran,
              returned: outcome.returned,
              ...(outcome.skipped === undefined ? {} : { skipped: outcome.skipped }),
            })),
          },
          results: plannedResults,
        };
      }),
  );

  // EPIC-063. Registered only when a planner is wired, for the reason
  // `ferret_why` is registered only with an evidence reader: an explanation with
  // no plan behind it could describe the ranking and nothing about how the
  // question was read, and a tool that answers half the question is
  // indistinguishable, to a client, from one that answered all of it.
  if (planner !== undefined) {
    server.registerTool(
      'ferret_explain',
      {
        title: 'Why did this query return this',
        description:
          'Explain a search: how the question was read, which strategies ran ' +
          'and which could not and why, why each result ranks where it does, ' +
          'and how much was withheld. Every sentence comes from a field Ferret ' +
          'recorded — nothing is guessed, and no indexed content appears in an ' +
          'explanation, so this response carries no repository text. Ask this ' +
          'when a result order is surprising or an answer looks short. For why ' +
          'Ferret believes a fact about one entity, use ferret_why instead.',
        inputSchema: z.strictObject({
          query: z.string().min(1).max(1024).describe('The search to explain, exactly as it would be searched.'),
          kinds: z.array(z.string().min(1)).max(20).optional(),
          limit: z.number().int().min(1).max(TOOL_RESULT_LIMIT).optional(),
          format: z.enum(['json', 'text']).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, kinds, limit, format }) =>
        guard('explain', Permission.READ, async () => {
          // Re-run rather than accept a result set — EPIC-063 §8.5. A handed
          // result set is unverifiable input, and explaining it would mean
          // describing rows this caller may not be allowed to see.
          const { plan, hits, withheld } = await planner.search(
            {
              question: query,
              ...(kinds === undefined ? {} : { kinds }),
              limit: Math.min(limit ?? 20, TOOL_RESULT_LIMIT),
            },
            access,
          );
          const explanation = explainQuery(query, plan, hits, withheld);
          // No content notice on either branch. An explanation contains no
          // repository text, so there is nothing for a notice to govern, and a
          // notice on a document that needs none teaches a reader to ignore
          // notices.
          return format === 'text' ? { rendered: renderExplanation(explanation) } : explanation;
        }),
    );
  }

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
      guard('getEntity', Permission.READ, async () => {
        const entity = await retrieval.getEntity(id, access);
        // Absence is an answer, not an error. A client asking about something
        // Ferret has not indexed should be told that, not handed a failure it
        // has to interpret.
        if (entity === undefined) {
          return { notice: CONTENT_NOTICE, found: false, id, contentSafety: NO_CONTENT_SAFETY };
        }
        const safety = new ContentSafety();
        const described = describeEntity(entity, safety);
        return { notice: CONTENT_NOTICE, found: true, entity: described, contentSafety: safety.report };
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
      guard('neighbours', Permission.READ, async () => {
        const neighbours = await retrieval.neighbours({
          from: id,
          ...(types === undefined ? {} : { types }),
          ...(direction === undefined ? {} : { direction }),
          ...(at === undefined ? {} : { at }),
          ...(includeHistorical === undefined ? {} : { includeHistorical }),
          limit: Math.min(limit ?? 20, TOOL_RESULT_LIMIT),
        }, access);
        const safety = new ContentSafety();
        return {
          notice: CONTENT_NOTICE,
          asOf: includeHistorical === true ? 'all time' : (at ?? 'now'),
          count: neighbours.length,
          neighbours: neighbours.map((neighbour) => ({
            id: neighbour.entity.id,
            kind: neighbour.entity.kind,
            lifecycle: neighbour.entity.lifecycle,
            attributes: containAttributes(neighbour.entity.attributes, safety),
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
          contentSafety: safety.report,
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
      guard('contextPack', Permission.READ, async () => {
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
      guard('find', Permission.READ, async () => {
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
        }, access);
        const truncated = entities.length > requested;
        const page = truncated ? entities.slice(0, requested) : entities;
        const safety = new ContentSafety();
        const described = page.map((entity) => describeEntity(entity, safety));
        return {
          notice: CONTENT_NOTICE,
          count: page.length,
          contentSafety: safety.report,
          ...(truncated
            ? {
                truncated: true,
                more: `More than ${requested} entities match. This is a partial answer — raise \`limit\` (max ${MAX_LIMIT}) or narrow the query.`,
              }
            : { truncated: false }),
          // `results`, the same key `ferret_search` uses. It was `entities`, and
          // a client reading `response.results` from this tool got `undefined`,
          // which flows into `(x ?? []).find(...)` and reads as a confident
          // "not found" rather than as an error. Ferret's own dogfood script hit
          // exactly that and reported an empty index that was in fact correct.
          // One key for row-bearing responses. Issue #51.
          results: described,
        };
      }),
  );

  // EPIC-060. Registered under the same rule as `ferret_why` and for the same
  // reason: an answer pack whose every claim is uncited is not an answer, and a
  // client cannot tell that tool from a subject Ferret genuinely holds no
  // evidence about.
  if (evidence !== undefined) {
    const answers = new AnswerPackBuilder({
      retrieval,
      evidence,
      access,
      ...(planner === undefined ? {} : { planner }),
    });

    server.registerTool(
      'ferret_answer',
      {
        title: 'Answer a question with one right answer',
        description:
          'Answer a question that identifies one thing — a Ferret entity id, a ' +
          'Git object id or abbreviation, or a file path — as claims with the ' +
          'observations behind each, plus an explicit list of what Ferret does ' +
          'not know. Unlike a context pack this does not rank: it either answers ' +
          'about one subject, reports that several match, reports that nothing ' +
          'matches, or says the question has no single right answer and a ' +
          'context pack is the right tool. Ferret never writes the prose answer; ' +
          'it states the claims and cites them. ' + CONTENT_NOTICE,
        inputSchema: z.strictObject({
          question: z.string().min(1).max(1024),
          budget: z
            .number()
            .int()
            .min(100)
            .max(MAX_ANSWER_BUDGET)
            .optional()
            .describe('Estimated tokens the answer may occupy.'),
          format: z.enum(['json', 'text']).optional(),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ question, budget, format }) =>
        guard('answer', Permission.READ, async () => {
          const pack = await answers.answer({
            question,
            ...(budget === undefined ? {} : { budget }),
          });
          return format === 'text' ? { notice: CONTENT_NOTICE, rendered: renderAnswer(pack) } : pack;
        }),
    );
  }

  // EPIC-048. Registered only when an evidence reader is wired: a tool that is
  // present and always answers "nothing held" is indistinguishable, to a client,
  // from a subject that genuinely has no evidence.
  if (evidence !== undefined) {
    server.registerTool(
      'ferret_why',
      {
        title: 'Why does Ferret believe this',
        description:
          'Show the observations behind what Ferret holds about one entity: how ' +
          'each fact was obtained, by which producer and version, where in the ' +
          'source it came from, how authoritative that source is, and what each ' +
          'observation was derived from. Use this to check an answer rather than ' +
          'trust it. Reports honestly when Ferret holds no evidence for the ' +
          'entity. ' + CONTENT_NOTICE,
        inputSchema: z.strictObject({
          id: z.string().uuid().describe('The Ferret entity id, as returned by ferret_search.'),
          field: z.string().min(1).max(256).optional().describe('Restrict to observations about one field.'),
          depth: z
            .number()
            .int()
            .min(1)
            .max(MAX_LINEAGE_DEPTH)
            .optional()
            .describe(`How far back to walk each derivation chain. Default and maximum ${String(MAX_LINEAGE_DEPTH)}.`),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ id, field, depth }) =>
        guard('why', Permission.READ, async () => {
          const maxDepth = depth ?? MAX_LINEAGE_DEPTH;
          // `current` explicitly, never the default. Unfiltered, `forSubject`
          // returns superseded and stale records too, and citing an observation
          // a newer one replaced — without saying so — would make this tool a
          // source of confidently wrong answers rather than a check on them.
          // Nothing is deleted; EPIC-044 AC-6 keeps the history, and reading it
          // back is a separate question from "what does Ferret believe now".
          const held = await evidence.forSubject(id, {
            state: EvidenceState.CURRENT,
            ...(field === undefined ? {} : { field }),
            limit: TOOL_RESULT_LIMIT,
            // EPIC-058, and it was missing here. `permissionFilter` treats
            // `undefined` as unrestricted — correct for the indexer reading back
            // what it wrote, wrong for a query on a caller's behalf — so this tool
            // returned protected statements that `ferret_search` withheld. The
            // lineage walk below supplied it and this call did not, which is the
            // shape `storage/evidence.ts` warned about: "exactly how a filter ends
            // up applied on the path everyone tests and missing on the path nobody
            // does."
            permittedScopes: access.permittedScopes,
          });

          // Absence is an answer, not an error — EPIC-065 AC-20. Said in words
          // as well as in an empty array, because a client that treats `[]` as a
          // failure and a client that treats it as "nothing known" both exist.
          if (held.length === 0) {
            return {
              notice: CONTENT_NOTICE,
              id,
              held: false,
              detail:
                'Ferret holds no current evidence for this entity. That is what is recorded, ' +
                'not a failure to look — an answer about it cannot be traced to a source.',
              evidence: [],
              conflicts: [],
              contentSafety: NO_CONTENT_SAFETY,
            };
          }

          const safety = new ContentSafety();
          const described = await Promise.all(
            held.map(async (record) => {
              const lineage = await evidence.provenanceOf(record.id, { maxDepth, permittedScopes: access.permittedScopes });
              return describeEvidence(record, lineage, maxDepth, safety);
            }),
          );

          // Reported, never resolved. EPIC-045 owns which source wins and
          // EPIC-047 acts on it; hiding a disagreement inside a citation would
          // be the one thing Governance §15 forbids.
          // Scoped for the same reason the reads above are, and missed for the
          // same reason #85 was: `ScopedRead` defaults to `undefined`, which the
          // store reads as unrestricted. A group carries no statement, but it
          // names the field and both record ids — EPIC-058 AC-12.
          const conflicts = await evidence.conflictsFor(id, {
            permittedScopes: access.permittedScopes,
          });

          return {
            notice: CONTENT_NOTICE,
            id,
            held: true,
            count: described.length,
            evidence: described,
            conflicts: conflicts.map((group) => ({
              field: group.field,
              records: group.evidence.map((record) => record.id),
              detail: 'Ferret holds observations that disagree about this field. Neither is discarded.',
            })),
            contentSafety: safety.report,
          };
        }),
    );
  }

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

/**
 * One search hit, as a client sees it.
 *
 * Shared by the planned and unplanned paths so the two cannot drift into
 * describing the same thing differently — which is how a client ends up with a
 * field that exists only sometimes.
 */
/**
 * One search hit, with its repository-authored text contained — EPIC-084.
 *
 * `highlight` is an extract of indexed content and is contained unconditionally;
 * the attributes go through the policy in `containAttributes`, which wraps prose
 * and leaves tokens like `path` matchable. Ferret's own fields — the id, the
 * kind, the score — are structural and are emitted as they are.
 */
function describeHit(hit: SearchHit, safety: ContentSafety): Record<string, unknown> {
  return {
    id: hit.entity.id,
    kind: hit.entity.kind,
    lifecycle: hit.entity.lifecycle,
    source: hit.entity.source,
    attributes: containAttributes(hit.entity.attributes, safety),
    matchedIn: hit.source,
    highlight: hit.highlight === undefined ? undefined : safety.contain(hit.highlight),
    score: hit.score,
    // EPIC-063 AC-16. The breakdown EPIC-056 and EPIC-057 record was emitted
    // nowhere, so a client had an opaque score and no way to ask why one hit
    // beat another. Structural throughout — a count, a band, and Ferret's own
    // field names — so it is not contained, because none of it is content.
    ranking:
      hit.ranking === undefined
        ? undefined
        : {
            relevance: hit.ranking.relevance,
            builtFrom: hit.ranking.contributors,
            folded: hit.ranking.subsumed.length,
            standing: hit.ranking.standing,
            ...(hit.ranking.why === undefined ? {} : { why: hit.ranking.why }),
          },
  };
}

/**
 * One entity, contained the same way a hit is.
 *
 * The same policy on the same fields, so a client cannot be handed a contained
 * value by one tool and a raw one by another. Two surfaces disagreeing about
 * where content starts is the same defect as having no boundary at all.
 */
function describeEntity(entity: CanonicalEntity, safety: ContentSafety): Record<string, unknown> {
  return { ...entity, attributes: containAttributes(entity.attributes, safety) };
}

/**
 * One observation, as a citation a person or a model can check — EPIC-048.
 *
 * `statement` is source content and is contained like every other value that
 * came out of a repository; the rest is Ferret's own record of how it looked and
 * is not.
 *
 * Two fields exist purely so the answer cannot overstate itself. `truncated`
 * marks a chain cut short by the depth bound, because a chain that stops
 * silently reads as a chain that ended. `derivedFrom` is reported from the
 * *store*, never from a search hit — a hit always carries an empty array for
 * performance reasons, and empty is indistinguishable from "nothing derived
 * this".
 */
function describeEvidence(
  record: CanonicalEvidence,
  lineage: readonly CanonicalEvidence[],
  maxDepth: number,
  safety: ContentSafety,
): Record<string, unknown> {
  return {
    id: record.id,
    field: record.field,
    statement: safety.contain(JSON.stringify(record.statement)),
    // How Ferret came to believe it, and how much that is worth.
    method: record.method,
    producer: `${record.producer}@${record.producerVersion}`,
    sourceSystem: record.sourceSystem,
    sourceUrl: record.sourceUrl,
    locator: record.locator,
    authority: record.authority,
    confidence: record.confidence,
    completeness: record.completeness,
    observedAt: record.observedAt,
    redacted: record.redacted,
    // AC-4. Recomputed here rather than fetched: `integrityHashOf` is pure, so
    // a citation can be shown untampered without a round trip per record. A
    // tool whose job is checking answers should not itself be taken on trust.
    integrity: integrityHashOf(record) === record.integrityHash ? 'verified' : 'tampered',
    derivedFrom: lineage.map((ancestor) => ({
      id: ancestor.id,
      method: ancestor.method,
      producer: `${ancestor.producer}@${ancestor.producerVersion}`,
      locator: ancestor.locator,
    })),
    truncated: lineage.length >= maxDepth,
  };
}
