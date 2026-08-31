import { Command } from 'commander';

import type { LogLevel } from '../../logging/index.js';
import { createMcpServer, serveStdio } from '../../mcp/index.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { QueryPlanner } from '../../retrieval/index.js';
import { createRuntime } from '../../runtime/index.js';
import { MigrationPolicy, RetrievalStore, createStorageProvider } from '../../storage/index.js';

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

        // EPIC-055. `semantic` is deliberately absent: Ferret ships no embedding
        // provider, so the planner reports semantic retrieval as unavailable
        // with the reason, rather than returning an empty result that reads as
        // "nothing was similar". When an operator registers one, it is passed
        // here and nothing else changes.
        const server = createMcpServer({
          retrieval,
          planner: new QueryPlanner({
            exact: retrieval,
            text: { search: (query) => retrieval.search(query) },
            logger: context.logger,
          }),
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
