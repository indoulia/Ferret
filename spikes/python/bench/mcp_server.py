"""Minimal MCP server over stdio.

Deliberately trivial tools: this measures SDK/runtime protocol overhead,
not Ferret logic. Mirrors spikes/typescript/bench/mcp-server.mjs.
"""
import json

from mcp.server.mcpserver import MCPServer

server = MCPServer(name="ferret-spike")


@server.tool(description="Echo text back.")
def echo(text: str) -> str:
    return text


@server.tool(description="Return a payload of n rows.")
def payload(n: int) -> str:
    return json.dumps([{"id": i, "name": f"row{i}"} for i in range(n)])


if __name__ == "__main__":
    server.run()
