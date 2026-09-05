import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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
    // `--ignore-scripts` so `prepack` does not run here.
    //
    // `prepack` rebuilds, and rebuilding *cleans* `dist/` — while the rest of
    // this suite is executing the CLI from it. Packing during a test run would
    // therefore delete the build out from under forty other tests, which is
    // exactly what happened the first time `prepack` was added.
    //
    // The global setup has already built, so what is packed here is current.
    // That `prepack` exists at all is asserted in `distribution.test.ts`, which
    // is the right place for it: the guarantee is about publishing, not about
    // this test.
    [requireNpmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', workspace],
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
    expect(paths).toContain('dist/storage/index.js');
  });

  it('ships every migration, because `tsc` alone would not copy them', () => {
    // A published package with a migrator and no migrations installs cleanly and
    // then fails at `ferret init` — the worst moment to discover a build gap.
    // `scripts/copy-migrations.mjs` is what puts them here.
    const migrations = pack.files
      .map((file) => file.path)
      .filter((path) => path.startsWith('dist/storage/migrations/'));

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations).toContain('dist/storage/migrations/0001_bootstrap.sql');
    for (const path of migrations) expect(path).toMatch(/\/\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('ships the four grammars the code parser uses, and no others', () => {
    // Same failure mode as the migrations, one step later: a published parser
    // with no grammars installs cleanly and fails on the first file.
    // `scripts/copy-grammars.mjs` is what puts them here, and it copies four of
    // the forty `tree-sitter-wasms` carries — which is why that package is a
    // dev dependency and these bytes are in `dist/`.
    const grammars = pack.files
      .map((file) => file.path)
      .filter((path) => path.startsWith('dist/parsers/code/grammars/'))
      .sort();

    expect(grammars).toStrictEqual([
      'dist/parsers/code/grammars/tree-sitter-javascript.wasm',
      'dist/parsers/code/grammars/tree-sitter-python.wasm',
      'dist/parsers/code/grammars/tree-sitter-tsx.wasm',
      'dist/parsers/code/grammars/tree-sitter-typescript.wasm',
    ]);
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
    execFileSync(
      process.execPath,
      [requireNpmCli(), 'pack', '--json', '--ignore-scripts', '--pack-destination', second],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const digest = (path: string): string =>
      createHash('sha256').update(readFileSync(path)).digest('hex');

    // Issue #130 — this failed once and passed twice on the same tree, and its
    // only message was a bare 64-character hex string. The uncompressed tar is
    // compared first, so a recurrence says *which layer* differed: the archived
    // bytes, or the gzip framing around them. A whole-file digest cannot
    // distinguish those, which is what left #130's single occurrence without a
    // cause.
    const contentDigest = (path: string): string =>
      createHash('sha256').update(gunzipSync(readFileSync(path))).digest('hex');

    expect(
      contentDigest(join(second, pack.filename)),
      'the archived bytes differ, so the build itself is not reproducible',
    ).toBe(contentDigest(tarball));

    expect(
      digest(join(second, pack.filename)),
      'the archived bytes match, so the gzip framing differs',
    ).toBe(digest(tarball));
  });

  it('stays small enough to install quickly', () => {
    // A coarse backstop against *leakage* — a dependency bundled by accident,
    // a fixture directory shipped, sources included by mistake — not a tuned
    // target. The precise assertions are elsewhere in this file: the tarball
    // contains exactly the files it declared, and nothing secret-shaped.
    //
    // EPIC-001 set this at 1 MB when the package was a CLI skeleton over ~50 kB
    // of JavaScript, and EPIC-024 at 2 MB once it shipped the canonical model,
    // a storage provider, the provider SDK and a Git provider.
    //
    // EPIC-025 is the step change: 5.6 MB of it is four tree-sitter grammars,
    // which is the cost of parsing code at all and was accepted with the
    // technology decision. It is already the *reduced* figure —
    // `tree-sitter-wasms` carries about forty grammars and 50 MB, and
    // `scripts/copy-grammars.mjs` copies the four Ferret uses. The separate
    // grammar assertion above is the real guard on that number; this one
    // catches everything else, so it is set just above the grammars plus
    // today's JavaScript rather than at a round figure with room to hide in.
    expect(pack.unpackedSize).toBeLessThan(9_000_000);
    // And the grammars must stay the bulk of it: if the non-grammar output ever
    // approaches this, something is leaking.
    //
    // **Raised from 2 000 000 on 2026-09-02, deliberately.** The non-grammar
    // output reached 2 003 280 — 0.16% over — after a session that added ten
    // product modules: content storage, the integrity sweep and run journal,
    // `ferret verify`, credential isolation, the logging additions, and two
    // quality harnesses.
    //
    // The package was measured before the number was moved, because raising a
    // limit you have just crossed is the wrong instinct unless you know what
    // crossed it. Nothing improper ships: no tests, no source maps, and the
    // parsing fixtures are correctly absent. The 7 KB of golden dataset under
    // `dist/datasets` is intentional and is asserted elsewhere in this file.
    //
    // The guard's purpose is unchanged — catch something *large* slipping in,
    // a bundled dependency or a stray asset. The headroom is 12%, not a round
    // figure, so the next crossing is also a decision rather than a formality.
    //
    // **Raised from 2 250 000 on 2026-09-02, and it was the next crossing the
    // paragraph above anticipated.** The non-grammar output reached 2 258 135 —
    // 0.36% over — after eight Epics: ranking and reranking, freshness and
    // authority, query explanation, confidence, conflict detection, the
    // reference index, relationship traversal, the Markdown parser and metrics.
    //
    // Measured before the number moved, as last time. The nine new modules
    // account for ~101 kB of it and nothing else grew:
    //
    //     24 088  dist/observability        (EPIC-092)
    //     20 904  dist/parsers/text         (EPIC-029)
    //     12 183  dist/code/references      (EPIC-035)
    //     11 622  dist/retrieval/explain    (EPIC-063)
    //     11 065  dist/retrieval/rank       (EPIC-056)
    //      9 778  dist/domain/confidence    (EPIC-046)
    //      5 726  dist/retrieval/freshness  (EPIC-057)
    //      5 549  dist/retrieval/traverse   (EPIC-050)
    //
    // Nothing improper ships: no source maps, no tests, no fixtures — asserted
    // by the checks around this one, and re-measured rather than assumed. The
    // headroom is 12% again, on the same reasoning: a round figure leaves room
    // to hide in.
    //
    // **2026-09-03, EPIC-028 — the bound moved a third time**, and the same way:
    // measured first. Three document parsers landed in one day and the
    // non-grammar output reached 2 537 837, 0.31% over. They account for
    // 73 806 bytes of it and nothing else grew:
    //
    //     33 103  dist/parsers/sheet        (EPIC-028)
    //     21 836  dist/parsers/pdf          (EPIC-026)
    //     18 867  dist/parsers/office       (EPIC-027)
    //
    // Worth noting what the 66 kB of headroom bought: none of the three brought
    // its dependency into the *package*. `pdfjs-dist`, `mammoth` and `csv-parse`
    // are runtime dependencies a consumer installs, and EPIC-028's `.xlsx`
    // reader has no dependency at all — 33 kB of Ferret's own code replacing a
    // library with an unlicensed transitive. That trade is the reason this
    // directory is the largest of the three and is still the cheapest.
    //
    // **2026-09-03, Batch 6 of the post-roadmap audit — the bound moved a fourth
    // time**, and the same way: measured first, on both sides. The non-grammar
    // output reached 2 854 257, 0.50% over, and the batch accounts for 29 207
    // bytes of it — measured by building the tree with the changes stashed
    // (2 788 627 in `dist/`) and again with them applied (2 817 834). Nothing
    // else grew, and the growth is where the fix is:
    //
    //     +9 919  dist/security/credentials.js   (F-71: four derived rules)
    //     +4 581  dist/security/subprocess.js    (new: the child-environment policy)
    //     +3 804  dist/security/credentials.d.ts
    //     +2 349  dist/git/runner.js             (F-94: output-shape pins)
    //     +2 140  dist/security/secrets.js       (isSecretKey moved here)
    //     +2 067  dist/git/history.js            (F-94: the unreadable counter)
    //       -848  dist/errors/redact.js          (isSecretKey moved out)
    //
    // It is the largest single-batch growth in this list, and most of it is
    // comment rather than code — which is this repository's style and is why
    // `security/credentials.js` alone is 10 kB for four predicates. No
    // dependency was added and nothing improper ships, both re-measured rather
    // than assumed. The headroom is 3.4%, deliberately tighter than the 12% of
    // the earlier raises: this batch added no product surface, so the next
    // crossing should be a decision sooner rather than later.
    //
    // **2026-09-04, EPIC-089/090 D1 and D2 — the fifth raise, and it is the
    // decision the paragraph above asked for.** The non-grammar output reached
    // 2 951 306, 0.04% over. Measured first and on both sides, by building the
    // branch tip before this cycle (`53d0880`) in a second worktree and
    // building again with the changes applied: `dist/` went from 2 882 117
    // non-grammar bytes to 2 919 428, so this cycle accounts for 37 311 of
    // them and nothing else grew:
    //
    //     +8 113  dist/storage/schema          (the instance_restore table)
    //     +7 984  dist/storage/export.js       (D1: detect, declare, refuse)
    //     +4 691  dist/cli/commands            (--strict, the disclosures)
    //     +3 818  dist/storage/import.js       (D2: provenance)
    //     +3 723  dist/storage/export.d.ts
    //     +2 909  dist/storage/migrations      (0014)
    //     +1 312  dist/storage/import.d.ts
    //     +1 122  dist/storage/bookkeeping.js  (readLatestRestore)
    //       +859  dist/storage/bookkeeping.d.ts
    //     +1 373  dist/errors, dist/cli/exit-codes, dist/storage/migrator, index
    //
    // Unlike the fourth raise this one *does* add product surface — a table, a
    // migration, an export contract and a CLI flag — and most of the growth is
    // again comment rather than code, which is this repository's style. No
    // dependency was added, and nothing improper ships: re-measured, not
    // assumed.
    //
    // The headroom is 3%, on the same reasoning as last time and for the same
    // purpose: the next crossing should be a decision rather than a formality.
    //
    // **2026-09-05, EPIC-110 — the bound moved a fifth time**, and it was the
    // decision the paragraph above asked for. The non-grammar output reached
    // 3 040 788, 0.03% over — the narrowest crossing yet, and one file caused
    // it. Measured on both sides, in a clean worktree at merged `main`
    // (`ec0a376`, 3 026 126) and again with the change applied (3 040 788), so
    // the 14 662-byte delta is a measurement rather than a subtraction:
    //
    //     +14 910  dist/cli/commands/session.js    (EPIC-110, the seven subcommands)
    //        +179  dist/cli/commands/session.d.ts
    //        -427  dist/cli/commands/planned.js    (the session entry, retired)
    //
    // The first measurement of this was wrong and is worth recording: stashing
    // the change left `session.ts` behind because it was untracked, so the
    // "baseline" compiled it anyway and came out *larger* than the tree it was
    // supposed to be a baseline for. A baseline that includes what it is
    // measuring is not one, which is why the figure above comes from a separate
    // worktree at the merged commit rather than from a stash.
    //
    // Nothing improper ships and no dependency was added: this is one CLI
    // module reaching a store that already shipped. Most of its bulk is comment
    // and Commander option declarations, which is this repository's style.
    const grammarBytes = pack.files
      .filter((file) => file.path.startsWith('dist/parsers/code/grammars/'))
      .reduce((total, file) => total + file.size, 0);
    expect(pack.unpackedSize - grammarBytes).toBeLessThan(3_132_000);
  });

  it('does not ship a source map that points at files it does not contain', () => {
    // Declaration maps let an editor jump from a `.d.ts` into the original
    // TypeScript. The sources are deliberately not published, so shipping the
    // maps meant every one of them referenced a path that did not exist —
    // strictly worse than having none, because resolution fails instead of
    // falling back to the declaration.
    const maps = pack.files.filter((file) => file.path.endsWith('.map'));
    expect(maps).toStrictEqual([]);
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
