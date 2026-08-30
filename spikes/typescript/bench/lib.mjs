import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SPIKES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORPUS = path.join(SPIKES, 'corpus');
export const DOCS = path.join(CORPUS, 'docs');
export const CODE = path.join(CORPUS, 'code');
export const MALFORMED = path.join(CORPUS, 'malformed');
export const LARGE = path.join(CORPUS, 'large');

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
    n: s.length,
  };
}

export function emit(benchmark, unit, samples, meta = {}) {
  const out = { benchmark, runtime: 'node', unit, samples, ...stats(samples), meta };
  process.stdout.write(JSON.stringify(out) + '\n');
}

export async function timed(fn) {
  const t = process.hrtime.bigint();
  const meta = await fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, meta };
}

export async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export { stat };

// pdfjs requires a URL with a trailing forward slash; a Windows path fails.
export const STD_FONTS = path.join(SPIKES, 'typescript', 'node_modules', 'pdfjs-dist', 'standard_fonts')
  .replaceAll('\\', '/') + '/';
