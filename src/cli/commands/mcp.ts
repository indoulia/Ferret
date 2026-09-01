import { Command } from 'commander';

import { effectiveExclusions } from '../../config/index.js';
import type { LogLevel } from '../../logging/index.js';
import { createMcpServer, serveStdio } from '../../mcp/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import {
  PUBLIC_ACCESS,
  QueryPlanner,
  assertUsableAccess,
  type AccessContext,
} from '../../retrieval/index.js';
import { createRuntime } from '../../runtime/index.js';
import { EvidenceStore, MigrationPolicy, RetrievalStore, createStorageProvider } from '../../storage/index.js';

/**
 * `ferret mcp` — serve the AI control plane over stdio.
 *
 * The command an AI client is configured to spawn. It runs until the client
 * closes the transport or the process is signalled, which is why it is the only
 * long-lived command Ferret has.
 *
 * **Nothing may reach stdout but protocol messages.** stdout *is* the transport,
 * and one stray line corrupts the stream — which is why Ferret's logger has
 * written to stderr since EPIC-001, and why this command prints nothing itself.
 *
 * The schema policy is `verify`, not `auto`. A migration is a change to a shared
 * database, and an AI client spawning a subprocess is not the moment to make
 * one: `ferret init` is the command that asks for that, run by a person who
 * meant it (Governance §16).
 */
export function mcpCommand(): Command {
  return new Command('mcp')
    .description('Serve the Model Context Protocol interface to AI clients over stdio')
    .action(async (_options: unknown, command: Command) => {
      const globals = command.optsWithGlobals<{ logLevel?: LogLevel }>();
      const storage = createStorageProvider({ policy: MigrationPolicy.VERIFY });

      const runtime = createRuntime({
        providers: [storage],
        ...(globals.logLevel === undefined ? {} : { logLevel: globals.logLevel }),
      });

      await runtime.run(async (context) => {
        assertSupported(runtime.providers.supports(Capability.STORAGE));

        const retrieval = new RetrievalStore(storage.db);

        // EPIC-058. Authorization comes from **configuration**, not from tool
        // input: no tool this server registers accepts a scope, a selector or an
        // exclusion, so nothing an AI client sends can widen what it sees
        // (Governance §12).
        //
        // The permitted set is empty — unscoped content only. Ferret has no
        // authentication yet, so there is no principal whose scopes could be
        // looked up; asserting one from configuration would be inventing a
        // caller. EPIC-068 is where a principal comes from, and until then the
        // honest position is that this server holds no permission scope, which is
        // also the safe one. Exclusions and the scope selector *are* real
        // configuration and are applied.
        const access: AccessContext = {
          ...PUBLIC_ACCESS,
          exclusions: effectiveExclusions(context.config),
        };
        // Loud here, conservative per row. A policy Ferret cannot evaluate
        // withholds everything at query time, which is safe and invisible — so
        // the operator hears about it at startup, where they can fix it, rather
        // than concluding the index is empty.
        assertUsableAccess(access);

        // EPIC-055. `semantic` is deliberately absent: Ferret ships no embedding
        // provider, so the planner reports semantic retrieval as unavailable
        // with the reason, rather than returning an empty result that reads as
        // "nothing was similar". When an operator registers one, it is passed
        // here and nothing else changes.
        const server = createMcpServer({
          retrieval,
          // EPIC-048. Without this the traceability tool is not registered at
          // all, and the 556 evidence rows a single index run records stay
          // unreachable from the only surface an AI client has.
          evidence: new EvidenceStore(storage.db),
          planner: new QueryPlanner({
            exact: retrieval,
            // The whole result, not just the hits: EPIC-058's withheld count has
            // to survive the adapter, and dogfooding found that dropping it here
            // meant the count reached nobody — the planner is the path the CLI
            // wires, so it is the only path a real client takes.
            text: retrieval,
            logger: context.logger,
          }),
          access,
          logger: context.logger,
        });

        context.logger.info(
          { operation: 'mcp.serve', transport: 'stdio' },
          'Ferret MCP server ready',
        );

        const transport = await serveStdio(server);

        // Resolve when the client goes away or the runtime is shutting down.
        // Either is an ordinary end to a session, not a failure.
        await new Promise<void>((resolve) => {
          transport.onclose = (): void => {
            resolve();
          };
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });

        await server.close().catch(() => undefined);
        return { served: true };
      });
    });
}
