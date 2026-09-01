import {
  assertPermitted,
  type ConfirmationGate,
  type OperationPlan,
  type Permission,
  type Principal,
} from '../authorization/index.js';
import { serializeError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';

/**
 * What every MCP tool handler passes through — EPIC-068, EPIC-069.
 *
 * Extracted from `server.ts` when EPIC-069 gave a tool a *second* control to
 * satisfy. Two reasons it is its own module rather than two closures inside
 * `createMcpServer`:
 *
 * - **The destructive path is now a named thing.** "The one path a destructive
 *   tool may take" cannot be a private closure if a test is going to prove a tool
 *   took it, and `tests/unit/mcp-destructive-tools.test.ts` reads the source of
 *   `server.ts` looking for exactly this call.
 * - **The mechanism is demonstrable without adding a destructive tool to
 *   Ferret.** EPIC-069 §4 excludes adding one — EPIC-066 owns the first — but a
 *   confirmation flow nobody has driven through the real protocol is a
 *   confirmation flow nobody has tested. A test can register a tool of its own
 *   through this exact composition, which is the same code a real tool will use.
 */

/**
 * What the MCP SDK expects a tool handler to return.
 *
 * A type alias rather than an `interface` deliberately: the SDK's own result type
 * carries an index signature, and only an alias of an object type gets the
 * implicit one that makes it assignable. An interface here compiles everywhere
 * except at the six `registerTool` call sites, which is the worst place to find
 * out.
 */
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export type ToolGuard = (
  operation: string,
  permission: Permission,
  run: () => Promise<unknown>,
) => Promise<ToolResult>;

export type DestructiveToolGuard = (
  operation: string,
  permission: Permission,
  plan: () => Promise<OperationPlan> | OperationPlan,
  confirm: string | undefined,
  run: () => Promise<unknown>,
) => Promise<ToolResult>;

export interface GuardDependencies {
  readonly principal: Principal;
  readonly logger: Logger;
}

/**
 * Wraps a handler so a failure becomes a redacted tool error, never a crash —
 * and so no handler runs for a caller that was not granted its permission.
 *
 * The permission is checked **here**, before `run`, rather than inside each
 * handler. EPIC-068 AC-9: a check a handler performs is a check a handler can
 * forget, and this is the one place every tool already passes through. Every
 * tool names its permission at its call site, so a new tool cannot be added
 * without naming one.
 */
export function createToolGuard({ principal, logger }: GuardDependencies): ToolGuard {
  return async (operation, permission, run) => {
    try {
      assertPermitted(principal, permission, `mcp.${operation}`);
      const result = await run();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // Serialized, therefore redacted: an error crossing to an AI client is
      // exactly the path a credential must not take, and EPIC-009's serializer
      // is the one place that guarantee lives.
      const serialized = serializeError(error);
      logger.warn({ operation: `mcp.${operation}`, err: error }, `MCP tool ${operation} failed`);
      return {
        content: [{ type: 'text', text: JSON.stringify(serialized, null, 2) }],
        isError: true,
      };
    }
  };
}

/**
 * The only path a destructive tool may take — EPIC-069.
 *
 * Two controls, in this order, and the order is a contract rather than an
 * implementation detail. The permission is checked before `plan` is ever built,
 * so an unpermitted caller receives `NOT_PERMITTED` and no plan: a plan names
 * configuration paths and current values, and handing that to a caller who may
 * not act is a disclosure about Ferret's state made to someone who was refused.
 * Only then does `consume` refuse unless a token issued for *this exact plan* was
 * presented.
 *
 * `plan` is a thunk rather than a value for that same reason — building it may
 * read current state to fill in an effect's `from`, and doing that for a caller
 * about to be refused is work Ferret should not do.
 *
 * The gate is consumed before `run`, so a destructive operation can never both
 * spend nothing and change something.
 */
export function createDestructiveToolGuard(
  dependencies: GuardDependencies & { readonly confirmations: ConfirmationGate },
  guard: ToolGuard = createToolGuard(dependencies),
): DestructiveToolGuard {
  return async (operation, permission, plan, confirm, run) =>
    guard(operation, permission, async () => {
      dependencies.confirmations.consume(await plan(), confirm);
      return run();
    });
}

/**
 * The parameter every destructive tool accepts, described once.
 *
 * A single spelling across every destructive tool, so a client that has learned
 * the flow once has learned it everywhere. The description is what an AI client
 * reads before its first attempt, and it says the thing that matters: do not
 * invent this value.
 */
export const CONFIRM_PARAMETER_DESCRIPTION =
  'The confirmation token from this tool\'s previous call. Omit it to see what ' +
  'the operation would do without doing it; Ferret then returns a plan and a ' +
  'token. Never construct this value — only a token Ferret issued for this exact ' +
  'plan is accepted, and it is valid once.';
