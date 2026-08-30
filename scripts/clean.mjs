// Removes build output. Kept as a script so it behaves identically on Windows
// and POSIX without depending on a shell.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const target of ['../dist', '../coverage']) {
  rmSync(fileURLToPath(new URL(target, import.meta.url)), { recursive: true, force: true });
}
// stderr, not stdout. `prepack` runs this during `npm pack --json`, whose
// stdout is parsed as JSON — the same rule the MCP transport lives by, for the
// same reason.
process.stderr.write('cleaned dist/ and coverage/\n');
