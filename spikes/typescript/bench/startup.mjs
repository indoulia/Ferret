// Loads the core dependency surface Ferret would need at boot, then exits.
// Spawned repeatedly by the orchestrator to measure application cold start.
await Promise.all([
  import('pdfjs-dist/legacy/build/pdf.mjs'),
  import('mammoth'),
  import('exceljs'),
  import('csv-parse'),
  import('pg'),
  import('web-tree-sitter'),
  import('@modelcontextprotocol/sdk/server/mcp.js'),
]);
