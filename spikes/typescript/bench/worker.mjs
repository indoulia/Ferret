import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { sha256 } from './lib.mjs';

const out = [];
for (const p of workerData.files) {
  const buf = await readFile(p);
  out.push(sha256(buf).slice(0, 8));
}
parentPort.postMessage(out.length);
