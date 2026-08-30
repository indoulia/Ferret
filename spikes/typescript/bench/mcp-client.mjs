// Measures MCP cold start (spawn -> initialized) and tool-call round trip.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { emit, stats } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'mcp-server.mjs');

const startups = [];
let toolSmall = [];
let toolLarge = [];
let tools = 0;

for (let round = 0; round < 5; round++) {
  const t0 = process.hrtime.bigint();
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  const client = new Client({ name: 'ferret-bench', version: '0.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  startups.push(Number(process.hrtime.bigint() - t0) / 1e6);
  tools = listed.tools.length;

  if (round === 0) {
    for (let i = 0; i < 100; i++) {
      const t = process.hrtime.bigint();
      await client.callTool({ name: 'echo', arguments: { text: 'ferret' } });
      toolSmall.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    for (let i = 0; i < 20; i++) {
      const t = process.hrtime.bigint();
      await client.callTool({ name: 'payload', arguments: { n: 5000 } });
      toolLarge.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  await client.close();
}

emit('mcp_startup', 'ms', startups, { tools, transport: 'stdio', sdk: '@modelcontextprotocol/sdk' });
emit('mcp_tool_small', 'ms', toolSmall, { calls: toolSmall.length, payload: 'echo' });
emit('mcp_tool_large', 'ms', toolLarge, { calls: toolLarge.length, payload: '5000 rows json' });
