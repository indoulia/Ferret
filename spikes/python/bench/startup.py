"""Loads the core dependency surface Ferret would need at boot, then exits.

Spawned repeatedly by the orchestrator to measure application cold start.
"""
import csv  # noqa: F401

import docx  # noqa: F401
import mcp.server.mcpserver  # noqa: F401
import openpyxl  # noqa: F401
import psycopg  # noqa: F401
import pypdf  # noqa: F401
import tree_sitter  # noqa: F401
import tree_sitter_javascript  # noqa: F401
import tree_sitter_python  # noqa: F401
import tree_sitter_typescript  # noqa: F401
