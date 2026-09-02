import { Command } from 'commander';

import { accessContextFor, principalFrom } from '../../authorization/index.js';
import { ConfigStore, defaultConfigSources, resolveConfig } from '../../config/index.js';
import type { LogLevel } from '../../logging/index.js';
import { createMcpServer, serveStdio } from '../../mcp/index.js';
import { probeHealth } from '../health.js';
import { Capability, assertSupported } from '../../providers/index.js';
import { QueryPlanner, assertUsableAccess, type AccessContext } from '../../retrieval/index.js';
import { createRuntime } from '../../runtime/index.js';
import {
  EvidenceStore,
  MigrationPolicy,
  RetrievalStore,
  createStorageProvider,
  readInventory,
} from '../../storage/index.js';

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

        // EPIC-068, and what it closes. Authorization comes from
        // **configuration**, not from tool input: no tool this server registers
        // accepts a scope, a selector, an exclusion or a permission, so nothing
        // an AI client sends can widen what it may do or see (Governance §12).
        //
        // EPIC-058 shipped with the permitted set always empty, because "there
        // is no principal whose scopes could be looked up". There is one now.
        // `principalFrom` reads the grant — read-only with no scopes when
        // nothing is configured — and `accessContextFor` is the single
        // conversion into the retrieval context, so a scope granted for reading
        // and a scope enforced on reading cannot drift apart.
        //
        // A malformed grant throws here rather than at the first tool call:
        // an operator whose permission is misspelled hears about it at startup.
        const principal = principalFrom(context.config);
        const access: AccessContext = accessContextFor(principal, context.config);
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
          // EPIC-066. Governance §1 and §16: configuration is performed through
          // the connected AI client, and must be accessible through the control
          // plane. `resolve` re-reads on every call rather than closing over the
          // configuration this process started with — a tool that changed
          // configuration and then reported it as it was at startup would be
          // lying about its own effect. `ConfigStore` is EPIC-003's writer and
          // the only one: the lock, the validation, the atomic write and the
          // journal are its, not a second copy.
          configuration: {
            resolve: () => resolveConfig(defaultConfigSources().sources),
            store: new ConfigStore(),
          },
          // EPIC-067. Provider state was CLI-only, which inverts Governance
          // §3 — and a client that got results without embeddings had no way
          // to learn *why*. `known` is the whole vocabulary rather than the
          // registry's offered set, because the interesting answer is about the
          // capabilities that are **missing**.
          providers: {
            describe: () => runtime.providers.describe(),
            states: () => runtime.providers.states(),
            capabilities: () => runtime.providers.capabilities(),
            known: () => Object.values(Capability),
            supports: (capability) => runtime.providers.supports(capability),
            recover: async (providerId) =>
              runtime.providers.recover(providerId, {
                config: context.config,
                environment: context.environment,
                logger: context.logger,
                signal: context.signal,
              }),
          },
          // EPIC-070. `validation/EPIC-004-VALIDATION.md` has carried this
          // row since EPIC-004: an AI client had to shell out to `ferret status
          // --json`, which is exactly what an MCP client with no shell cannot
          // do. `probeHealth` opens its own connection and closes it, which is
          // EPIC-004's behaviour and is not changed here.
          health: {
            probe: async () => probeHealth({ logger: context.logger }),
            inventory: async () => readInventory(storage.pool),
          },
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
          principal,
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
