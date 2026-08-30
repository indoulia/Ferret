// Writes one configuration key from a separate OS process, so the lock is
// exercised across processes rather than only across promises in one.
//
// Read-modify-write without a lock loses every update but the last. This
// fixture is what makes that failure mode reproducible: N of these run at once
// and every key must survive.
//
// Usage: node concurrent-config-writer.mjs <configPath> <auditPath> <key> <value>
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { ConfigStore } = await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href);

const [configPath, auditPath, key, rawValue] = process.argv.slice(2);

let value = rawValue;
try {
  value = JSON.parse(rawValue);
} catch {
  // Not JSON: keep it as the literal string, matching `ferret config set`.
}

// A generous lock timeout: with eight writers contending, the last one in the
// queue legitimately waits for the seven ahead of it.
const store = new ConfigStore({ path: configPath, auditPath, env: {}, lock: { timeoutMs: 30_000 } });
store.set(key, value);

process.stdout.write(`wrote ${key}\n`);
