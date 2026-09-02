import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AuditWriter } from '../audit/index.js';
import { Permission, type Principal } from '../authorization/index.js';
import type { HealthReport } from '../diagnostics/index.js';
import type { Logger } from '../logging/index.js';

import { createToolGuard, type ToolGuard } from './guards.js';

/**
 * Health, over MCP — EPIC-070.
 *
 * `validation/EPIC-004-VALIDATION.md` has carried one row since EPIC-004:
 * *"Health is not yet exposed over MCP. An AI client must shell out to `ferret
 * status --json`. The report is already structured for it."*
 *
 * Shelling out is the part that does not work. An MCP client is often a process
 * with no shell, no `ferret` on its path, and no way to read a second process's
 * exit code — so "already structured for it" has been true and unreachable for
 * the whole life of the project.
 *
 * **Readiness, not capability.** EPIC-067's `ferret_providers` answers *what can
 * this Ferret do, and which provider is stopping it*. This answers *is this
 * Ferret working, and is there anything in it*. §8.4 states the boundary because
 * two tools that both drifted toward "everything about the server" would end up
 * disagreeing, and a client would have no way to know which to trust.
 */

/**
 * What this surface needs. Two functions, because `probeHealth` lives in
 * `src/cli/` and `boundaries.test.ts` asserts no MCP module reaches a CLI one —
 * so the port is a boundary requirement rather than only a preference.
 */
export interface HealthAccess {
  /** EPIC-004's report. Never throws — Governance §20. */
  readonly probe: () => Promise<HealthReport>;
  /** EPIC-095's inventory, or `undefined` when there is no database to ask. */
  readonly inventory: () => Promise<IndexCounts | undefined>;
}

/**
 * What is indexed, as counts.
 *
 * Declared here rather than imported from `src/storage/`, and the boundary gate
 * is what decided it: `boundaries.test.ts` refuses an MCP module that builds on
 * storage, and importing `IndexInventory` — a type — pulled Drizzle and `pg`
 * into this layer's package set. Structurally identical to EPIC-095's
 * `IndexInventory`, so the composition root passes one straight through, and
 * this layer depends on a shape rather than on a store.
 */
export interface IndexCounts {
  readonly entities: readonly { readonly kind: string; readonly count: number }[];
  readonly evidence: number;
  readonly relationships: number;
  readonly contentBlobs: number;
  readonly contentBytes: number;
  readonly lastRun:
    | {
        readonly repository: string;
        readonly outcome: string;
        readonly finishedAt: string;
        readonly ageSeconds: number;
      }
    | undefined;
}

export interface HealthToolDependencies {
  readonly health: HealthAccess;
  readonly logger: Logger;
  readonly principal: Principal;
  readonly audit?: AuditWriter | undefined;
}

/**
 * Registers the health tool.
 *
 * Its own module rather than more of `server.ts`, following EPIC-066's reason:
 * that file is already the longest in the project, and
 * `mcp-destructive-tools.test.ts` scans every module in `src/mcp/` so a control
 * naming one file would stop covering the surface.
 */
export function registerHealthTools(server: McpServer, dependencies: HealthToolDependencies): void {
  const { health, logger, principal, audit } = dependencies;
  const guard: ToolGuard = createToolGuard({
    principal,
    logger,
    ...(audit === undefined ? {} : { audit }),
  });

  server.registerTool(
    'ferret_health',
    {
      title: 'Is Ferret working, and is there anything in it',
      description:
        'Report whether Ferret is working right now: the database, the schema, ' +
        'the index and synchronization, each with its own status and a ' +
        'remediation when it has one — plus how much is indexed. Call this ' +
        'before concluding that a search found nothing, because an empty index ' +
        'and an unmatched query look identical from a result set. A check that ' +
        'could not run reports `unknown` rather than being left out. For which ' +
        'capabilities are available and which provider is stopping one, use ' +
        '`ferret_providers` instead.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard('health', Permission.READ, async () => {
        // §8.2 — `probeHealth` never throws, because Governance §20 requires
        // `status` and `doctor` to stay dependable "when other subsystems are
        // unhealthy, which is precisely when they are worth running". A health
        // tool that failed when things were unhealthy would be useless at the
        // only moment it matters.
        const report = await health.probe();

        // The inventory needs a database; the report does not. So a failure
        // here is reported as an absence with a reason rather than failing the
        // whole call — the same shape §8.3 requires of a check that could not
        // run.
        let inventory: IndexCounts | undefined;
        let inventoryDetail: string | undefined;
        try {
          inventory = await health.inventory();
          if (inventory === undefined) {
            inventoryDetail = 'No database is reachable, so nothing could be counted.';
          }
        } catch {
          inventoryDetail = 'The index could not be counted; the health components above say why.';
        }

        const indexed =
          inventory === undefined
            ? 0
            : inventory.entities.reduce((total, entry) => total + entry.count, 0);

        return {
          status: report.status,
          summary: report.summary,
          checkedAt: report.checkedAt,
          ferret: report.ferret,
          // Every component, `unknown` ones included — §8.3, and EPIC-004's own
          // reasoning: an operator must "see that a check did not run, rather
          // than having to notice that a name is missing", and a client is
          // worse at noticing an absence than a person is.
          components: report.components,
          index:
            inventory === undefined
              ? { available: false, detail: inventoryDetail }
              : {
                  available: true,
                  entities: inventory.entities,
                  totalEntities: indexed,
                  evidence: inventory.evidence,
                  relationships: inventory.relationships,
                  contentBlobs: inventory.contentBlobs,
                  contentBytes: inventory.contentBytes,
                  lastRun: inventory.lastRun,
                  ...(inventoryDetail === undefined ? {} : { detail: inventoryDetail }),
                },
          notice:
            indexed === 0
              ? 'Nothing is indexed. A search will find nothing, and that is not a failure — run `ferret index <path>` first.'
              : undefined,
          // §8.4, said in the response so a client does not have to infer the
          // boundary from two tool descriptions.
          providers: 'Use ferret_providers for capability and provider state; this tool reports readiness.',
        };
      }),
  );
}
