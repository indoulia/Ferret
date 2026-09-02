/**
 * The AI control plane, over MCP.
 *
 * Published as `@indoulia/ferret/mcp` rather than from the package root: it
 * carries the Model Context Protocol SDK, and the core must not.
 * `boundaries.test.ts` proves it.
 */

export { MCP_SERVER_NAME, createMcpServer, serveStdio, type McpServerDependencies } from './server.js';

/**
 * The controls every tool passes through — EPIC-068, EPIC-069.
 *
 * `createDestructiveToolGuard` is exported rather than private because it is the
 * *contract* a destructive tool satisfies: EPIC-066 composes with it, and a test
 * drives a tool of its own through it to prove the confirmation flow works over
 * the real protocol without Ferret shipping a destructive tool to prove it.
 */
/**
 * Configuration over MCP — EPIC-066.
 *
 * `registerConfigTools` is exported so a consumer embedding Ferret can compose
 * the configuration surface onto a server of its own, the same way
 * `createMcpServer` does.
 */
export {
  registerConfigTools,
  type ConfigToolDependencies,
  type ConfigurationAccess,
} from './config-tools.js';

export {
  CONFIRM_PARAMETER_DESCRIPTION,
  createDestructiveToolGuard,
  createToolGuard,
  type DestructiveToolGuard,
  type GuardDependencies,
  type ToolGuard,
  type ToolResult,
} from './guards.js';
export { registerProviderTools, type ProviderAdministration, type ProviderToolDependencies } from './provider-tools.js';
export {
  registerHealthTools,
  type HealthAccess,
  type HealthToolDependencies,
  type IndexCounts,
} from './health-tools.js';
