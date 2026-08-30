// Minimal MCP server over stdio: measures SDK startup and tool round-trip.
// Deliberately trivial tools - this measures protocol/runtime overhead, not
// Ferret logic.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ferret-spike', version: '0.0.0' });

server.registerTool(
  'echo',
  { description: 'Echo text back.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);

server.registerTool(
  'payload',
  { description: 'Return a payload of n rows.', inputSchema: { n: z.number() } },
  async ({ n }) => ({
    content: [{ type: 'text', text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `row${i}` }))) }],
  }),
);

await server.connect(new StdioServerTransport());
