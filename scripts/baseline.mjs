// Records EPIC-001 performance baselines.
//
// This is not an optimisation exercise. The numbers exist so a later Epic can
// notice a regression: if `ferret --help` suddenly takes a second, or the
// package triples in size, these figures are what makes that visible.
//
// Usage: npm run baseline [-- --write]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli', 'main.js');
const SAMPLES = 10;

function npmCli() {
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('npm CLI not found');
}

function measure(label, run) {
  const samples = [];
  run(); // discard one warm-up so the figures are not dominated by page-in cost
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    samples: SAMPLES,
    minMs: round(samples[0]),
    medianMs: round(samples[Math.floor(samples.length / 2)]),
    maxMs: round(samples.at(-1)),
  };
}

const round = (value) => Math.round(value * 10) / 10;

const cli = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { stdio: 'ignore', windowsHide: true });

const results = [
  measure('cli startup (--version)', () => cli(['--version'])),
  measure('cli help (--help)', () => cli(['--help'])),
  measure('runtime initialize + shutdown (env)', () => cli(['env', '--json'])),
];

// In-process lifecycle, isolating the runtime from process spawn cost.
const { createRuntime, createNullLogger } = await import(
  pathToFileURL(join(ROOT, 'dist', 'index.js')).href,
);
const lifecycle = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const runtime = createRuntime({ logger: createNullLogger() });
  const started = performance.now();
  await runtime.initialize();
  const ready = performance.now();
  await runtime.shutdown();
  lifecycle.push({ initialize: ready - started, shutdown: performance.now() - ready });
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.floor(sorted.length / 2)]);
};
results.push(
  { label: 'runtime.initialize (in process)', samples: SAMPLES, medianMs: median(lifecycle.map((l) => l.initialize)) },
  { label: 'runtime.shutdown (in process)', samples: SAMPLES, medianMs: median(lifecycle.map((l) => l.shutdown)) },
);

// Package size, measured from a real tarball.
const workspace = mkdtempSync(join(tmpdir(), 'ferret-baseline-'));
let pack;
try {
  const raw = execFileSync(
    process.execPath,
    // `--ignore-scripts`: the caller has already built, and letting `prepack`
    // rebuild here would measure the build rather than the package.
    [npmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', workspace],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  pack = JSON.parse(raw)[0];
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

const report = {
  recordedAt: new Date().toISOString(),
  platform: `${process.platform}/${process.arch}`,
  node: process.versions.node,
  timings: results,
  package: {
    tarballBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    fileCount: pack.files.length,
  },
};

console.log(JSON.stringify(report, null, 2));

if (process.argv.includes('--write')) {
  const target = join(ROOT, 'docs', 'Performance');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, `EPIC-001-baseline-${process.platform}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote docs/Performance/EPIC-001-baseline-${process.platform}.json`);
}
