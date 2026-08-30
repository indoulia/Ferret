"""Measures MCP cold start (spawn -> initialized) and tool-call round trip.

Mirrors spikes/typescript/bench/mcp-client.mjs: same rounds, same call
counts, same payload sizes.
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import emit  # noqa: E402

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

HERE = Path(__file__).resolve().parent
SERVER = HERE / "mcp_server.py"


async def main():
    startups, tool_small, tool_large = [], [], []
    tools = 0
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)])

    for round_i in range(5):
        t0 = time.perf_counter()
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                listed = await session.list_tools()
                startups.append((time.perf_counter() - t0) * 1000.0)
                tools = len(listed.tools)

                if round_i == 0:
                    for _ in range(100):
                        t = time.perf_counter()
                        await session.call_tool("echo", {"text": "ferret"})
                        tool_small.append((time.perf_counter() - t) * 1000.0)
                    for _ in range(20):
                        t = time.perf_counter()
                        await session.call_tool("payload", {"n": 5000})
                        tool_large.append((time.perf_counter() - t) * 1000.0)

    emit("mcp_startup", "ms", startups,
         {"tools": tools, "transport": "stdio", "sdk": "mcp (python)"})
    emit("mcp_tool_small", "ms", tool_small, {"calls": len(tool_small), "payload": "echo"})
    emit("mcp_tool_large", "ms", tool_large,
         {"calls": len(tool_large), "payload": "5000 rows json"})


if __name__ == "__main__":
    asyncio.run(main())
