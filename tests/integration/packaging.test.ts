import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PACKAGE_NAME, VERSION } from '../../src/index.js';
import { ROOT } from '../helpers/cli.js';

interface PackedFile {
  readonly path: string;
  readonly size: number;
}

interface PackResult {
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: readonly PackedFile[];
}

let workspace: string;
let prefix: string;
let installRoot: string;
let pack: PackResult;
let tarball: string;
let shippedFiles: Array<{ path: string; text: string }>;

/** Everything the package must never ship. */
const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['test sources', /^tests?\//],
  ['test files', /\.(test|spec)\.[cm]?[jt]s$/],
  ['test fixtures', /fixtures?\//],
  ['TypeScript sources', /^src\//],
  ['benchmark and evaluation spikes', /^spikes\//],
  ['project documentation', /^docs\//],
  ['CI configuration', /^\.github\//],
  ['editor and tool state', /^\.(vscode|idea|tokensave)\//],
  ['dependency tree', /(^|\/)node_modules\//],
  ['lockfile', /^package-lock\.json$/],
  ['environment files', /(^|\/)\.env/],
  ['local databases', /\.(db|sqlite|sqlite3)$/],
  ['archives', /\.(tgz|tar|zip)$/],
  ['coverage output', /^coverage\//],
  ['tool configuration', /^(tsconfig.*\.json|vitest\.config\.ts|eslint\.config\.js)$/],
  ['build scripts', /^scripts\//],
];

/** Credential shapes that must not appear anywhere in the shipped bytes. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private key block', /-----BEGIN[A-Z ]*PRIVATE KEY-----/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{16,}/],
  ['aws access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['credentialled URI', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/],
  // A quoted literal, so a type declaration such as `password: string` is not
  // mistaken for an assigned credential.
  ['assigned password literal', /\bpassw(?:or)?d\s*[=:]\s*["'][^"']{6,}["']/i],
];

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'ferret-pack-'));

  const raw = execFileSync(
    process.execPath,
    [requireNpmCli(), 'pack', '--json', '--pack-destination', workspace],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  pack = (JSON.parse(raw) as PackResult[])[0] as PackResult;
  tarball = join(workspace, pack.filename);

  // Install the tarball globally into a throwaway prefix. This both proves the
  // package installs and unpacks it for inspection, so the contents scanned
  // below are exactly the bytes a user ends up with on disk.
  prefix = join(workspace, 'global');
  execFileSync(
    process.execPath,
    [requireNpmCli(), 'install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );

  installRoot =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', ...PACKAGE_NAME.split('/'))
      : join(prefix, 'lib', 'node_modules', ...PACKAGE_NAME.split('/'));
  shippedFiles = readTree(installRoot);
}, 300_000);

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

/** Locates npm's own CLI so the test never depends on shell resolution. */
function requireNpmCli(): string {
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.execPath, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
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

describe('package contents', () => {
  it('builds a tarball named for the package and version', () => {
    expect(pack.filename).toContain('ferret');
    expect(pack.filename).toContain(VERSION);
  });

  it('ships the built runtime, the manifest, the licence and the readme', () => {
    const paths = pack.files.map((file) => file.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('README.md');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');
    expect(paths).toContain('dist/cli/main.js');
  });

  it.each(FORBIDDEN_PATTERNS)('ships no %s', (_label, pattern) => {
    const offenders = pack.files.map((file) => file.path).filter((path) => pattern.test(path));
    expect(offenders).toStrictEqual([]);
  });

  it('ships only dist output plus the three root files', () => {
    const unexpected = pack.files
      .map((file) => file.path)
      .filter((path) => !path.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE'].includes(path));
    expect(unexpected).toStrictEqual([]);
  });

  it('is reproducible — packing twice yields byte-identical tarballs', () => {
    const second = join(workspace, 'repack');
    mkdirSync(second, { recursive: true });
    execFileSync(process.execPath, [requireNpmCli(), 'pack', '--json', '--pack-destination', second], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const digest = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex');

    expect(digest(join(second, pack.filename))).toBe(digest(tarball));
  });

  it('stays small enough to install quickly', () => {
    // A regression baseline, not a tuned target: the runtime is ~50 kB of
    // JavaScript, so anything approaching a megabyte means something leaked in.
    expect(pack.unpackedSize).toBeLessThan(1_000_000);
  });
});

describe('installed package scan', () => {
  it('contains exactly the files the tarball declared', () => {
    expect(shippedFiles.map((file) => file.path).sort()).toStrictEqual(
      pack.files.map((file) => file.path).sort(),
    );
  });

  it.each(SECRET_PATTERNS)('contains no %s', (_label, pattern) => {
    const offenders = shippedFiles.filter(({ text }) => pattern.test(text)).map(({ path }) => path);
    expect(offenders).toStrictEqual([]);
  });
});

/**
 * Reads the package's own installed files as text, with relative paths.
 *
 * `node_modules/` is skipped: those are the resolved dependency tree that npm
 * places beside the package, not bytes Ferret ships. Dependency contents are
 * governed by the audit in CI, not by this scan.
 */
function readTree(root: string): Array<{ path: string; text: string }> {
  const results: Array<{ path: string; text: string }> = [];
  const walk = (directory: string, relativePrefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(directory, entry.name);
      const relative = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`;
      if (entry.isDirectory()) walk(full, relative);
      else results.push({ path: relative, text: readFileSync(full, 'utf8') });
    }
  };
  walk(root, '');
  return results;
}

describe('global installation', () => {
  /**
   * Runs the globally installed `ferret` through its generated launcher.
   *
   * On Windows npm writes a `.cmd` shim, which needs `cmd.exe` to execute;
   * the arguments are fixed literals, so no untrusted input reaches the shell.
   */
  function runInstalled(args: readonly string[]): string {
    if (process.platform === 'win32') {
      return execFileSync('cmd.exe', ['/d', '/s', '/c', join(prefix, 'ferret.cmd'), ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
    }
    return execFileSync(join(prefix, 'bin', 'ferret'), [...args], { encoding: 'utf8' });
  }

  it('installs the package under the requested prefix', () => {
    expect(statSync(join(installRoot, 'dist', 'cli', 'main.js')).isFile()).toBe(true);
  });

  it('exposes a working `ferret --help`', () => {
    const output = runInstalled(['--help']);
    expect(output).toContain('Usage: ferret');
    expect(output).toContain('version');
  });

  it('reports its version through the installed binary', () => {
    const payload = JSON.parse(runInstalled(['version', '--json'])) as {
      ok: boolean;
      data: { name: string; version: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.name).toBe(PACKAGE_NAME);
    expect(payload.data.version).toBe(VERSION);
  });

  it('starts the runtime from the installed location', () => {
    const payload = JSON.parse(runInstalled(['env', '--json'])) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
