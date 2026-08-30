// Removes build output. Kept as a script so it behaves identically on Windows
// and POSIX without depending on a shell.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const target of ['../dist', '../coverage']) {
  rmSync(fileURLToPath(new URL(target, import.meta.url)), { recursive: true, force: true });
}
console.log('cleaned dist/ and coverage/');
