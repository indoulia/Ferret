/**
 * The AI control plane, over MCP.
 *
 * Published as `@indoulia/ferret/mcp` rather than from the package root: it
 * carries the Model Context Protocol SDK, and the core must not.
 * `boundaries.test.ts` proves it.
 */

export { MCP_SERVER_NAME, createMcpServer, serveStdio, type McpServerDependencies } from './server.js';
