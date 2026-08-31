import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RelationshipType,
  describeFileStructure,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider, TreeEntryKind, extensionOf, gitContentHash, parseTree } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * EPIC-022 and EPIC-023 — the files a repository holds, and their identity.
 *
 * The decision under test throughout is that **file identity is the repository
 * and the path**, matching what EPIC-020 chose for files seen in commit history.
 * If the two schemes disagreed, a file found by listing a tree and the same file
 * found in a commit would be two entities, and every file in Ferret would exist
 * twice. That is asserted directly rather than assumed.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-022/023] SKIPPING every file test: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-files-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

afterAll(async () => {
  if (version === undefined) return;
  await provider.shutdown();
  await workspace.cleanup();
});

interface Fixture {
  path: string;
  discovered: DiscoveredRepository;
}

async function repository(name: string): Promise<Fixture> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, name, {
    origin: `https://github.com/indoulia/${name}.git`,
  });
  return { path, discovered: await provider.describeRepository(path, context) };
}

describe('parsing a tree listing', () => {
  const NUL = '\0';

  it('reads mode, object id, size and path', () => {
    const stdout = `100644 blob a81a69f6f624b2200d87fe078d56a15f367a08eb    3849\tsrc/main.ts${NUL}`;
    expect(parseTree(stdout)).toStrictEqual([
      {
        path: 'src/main.ts',
        kind: TreeEntryKind.FILE,
        oid: 'a81a69f6f624b2200d87fe078d56a15f367a08eb',
        sizeBytes: 3849,
        mode: '100644',
      },
    ]);
  });

  it('reads a path containing spaces', () => {
    // The tab before the path is the only reliable boundary: the size column is
    // right-aligned with variable padding, and a path may contain spaces.
    const stdout = `100644 blob ${'b'.repeat(40)}      12\tdocs/two words.md${NUL}`;
    expect(parseTree(stdout)[0]?.path).toBe('docs/two words.md');
  });

  it.each([
    ['100644', TreeEntryKind.FILE],
    ['100755', TreeEntryKind.EXECUTABLE],
    ['120000', TreeEntryKind.SYMLINK],
    ['160000', TreeEntryKind.SUBMODULE],
    ['100777', TreeEntryKind.UNKNOWN],
  ])('reads mode %s as %s', (mode, kind) => {
    // The `type` column says `blob` for a file, an executable *and* a symlink.
    // Only the mode tells them apart, and treating a symlink as a file would
    // index the string `../../etc/passwd` as though someone had written it.
    const type = mode === '160000' ? 'commit' : 'blob';
    const stdout = `${mode} ${type} ${'c'.repeat(40)}      7\tp${NUL}`;
    expect(parseTree(stdout)[0]?.kind).toBe(kind);
  });

  it('reads a submodule’s absent size as absent', () => {
    const stdout = `160000 commit ${'d'.repeat(40)}       -\tvendor/lib${NUL}`;
    expect(parseTree(stdout)[0]?.sizeBytes).toBeUndefined();
  });

  it('skips a malformed entry rather than abandoning the listing', () => {
    const stdout = `nonsense${NUL}100644 blob ${'e'.repeat(40)}      1\tgood.txt${NUL}`;
    expect(parseTree(stdout).map((entry) => entry.path)).toStrictEqual(['good.txt']);
  });

  it('bounds and normalizes a path', () => {
    const long = 'p'.repeat(10_000);
    const stdout = `100644 blob ${'f'.repeat(40)}      1\t${long}${NUL}`;
    expect(parseTree(stdout)[0]?.path.length).toBeLessThanOrEqual(4096);

    const windows = `100644 blob ${'f'.repeat(40)}      1\tsrc\\win\\a.ts${NUL}`;
    expect(parseTree(windows)[0]?.path).toBe('src/win/a.ts');
  });

  it('returns nothing for empty output', () => {
    expect(parseTree('')).toStrictEqual([]);
  });
});

describe('content hashes name their algorithm', () => {
  it('prefixes a Git object id', () => {
    // A Git object id is `sha1("blob <length>" + NUL + bytes)`, which is *not*
    // the SHA-1 of the bytes and is not comparable with anything else called a
    // hash. Two values meaning different things must not share a column
    // without saying which they are.
    expect(gitContentHash('a'.repeat(40))).toBe(`git-blob:${'a'.repeat(40)}`);
  });
});

describe('extensions', () => {
  it.each([
    ['src/main.ts', 'ts'],
    ['README.MD', 'md'],
    ['a/b/c.tar.gz', 'gz'],
    ['Makefile', undefined],
    ['.gitignore', undefined],
    ['trailing.', undefined],
  ])('reads %s as %s', (path, expected) => {
    // A dotfile has no extension: `.gitignore` is a name, not an extension of
    // an empty one.
    expect(extensionOf(path)).toBe(expected);
  });
});

withGit('listing a repository’s files', () => {
  it('lists the files a revision holds, with size and object id', async () => {
    const fixture = await repository('listing');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'main.ts'), 'export const x = 1;\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add source']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const main = entries.find((entry) => entry.path === 'src/main.ts');

    expect(entries.map((entry) => entry.path).sort()).toStrictEqual(['README.md', 'src/main.ts']);
    expect(main?.kind).toBe(TreeEntryKind.FILE);
    expect(main?.oid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(main?.sizeBytes).toBe(20);
  });

  it('lists a historical revision, not just the current one', async () => {
    // The reason this reads a tree rather than walking a directory: most
    // revisions are not checked out anywhere.
    const fixture = await repository('historical');
    const first = (await git(fixture.path, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(fixture.path, 'later.txt'), 'later\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add later']);

    const now = await provider.listFiles(fixture.discovered, {}, context);
    const then = await provider.listFiles(fixture.discovered, { revision: first }, context);

    expect(now.entries.map((e) => e.path)).toContain('later.txt');
    expect(then.entries.map((e) => e.path)).not.toContain('later.txt');
  });

  it('gives identical content identity to identical bytes in two repositories', async () => {
    // A Git object id is a content hash, so two copies of one file are one
    // version. This is what makes "who else has this file" answerable.
    const a = await repository('same-bytes-a');
    const b = await repository('same-bytes-b');
    for (const fixture of [a, b]) {
      await writeFile(join(fixture.path, 'shared.txt'), 'identical contents\n');
      await git(fixture.path, ['add', '-A']);
      await git(fixture.path, ['commit', '-m', 'add shared']);
    }

    const find = async (fixture: Fixture): Promise<string | undefined> =>
      (await provider.listFiles(fixture.discovered, {}, context)).entries.find(
        (entry) => entry.path === 'shared.txt',
      )?.oid;

    expect(await find(a)).toBe(await find(b));
  });

  it('distinguishes an executable, a symlink and a regular file', async () => {
    const fixture = await repository('modes');
    await writeFile(join(fixture.path, 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(fixture.path, 'run.sh'), 0o755);
    await writeFile(join(fixture.path, 'plain.txt'), 'plain\n');
    let linked = true;
    try {
      await symlink('plain.txt', join(fixture.path, 'link.txt'));
    } catch {
      linked = false;
      process.stderr.write('[EPIC-022] symlink creation unavailable; link mode not exercised\n');
    }
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'modes']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const kind = (path: string): TreeEntryKind | undefined =>
      entries.find((entry) => entry.path === path)?.kind;

    expect(kind('plain.txt')).toBe(TreeEntryKind.FILE);
    if (process.platform !== 'win32') expect(kind('run.sh')).toBe(TreeEntryKind.EXECUTABLE);
    if (linked && process.platform !== 'win32') expect(kind('link.txt')).toBe(TreeEntryKind.SYMLINK);
  });

  it('pages through a listing', async () => {
    const fixture = await repository('paged-files');
    for (let i = 0; i < 7; i += 1) {
      await writeFile(join(fixture.path, `f${String(i)}.txt`), `${String(i)}\n`);
    }
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add many']);

    const seen: string[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await provider.listFiles(fixture.discovered, { limit: 3, offset }, context);
      seen.push(...result.entries.map((entry) => entry.path));
      if (result.cursor === undefined) break;
      offset += result.entries.length;
    }

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('answers with nothing for a revision that does not exist', async () => {
    const fixture = await repository('no-such-revision');
    const { entries } = await provider.listFiles(
      fixture.discovered,
      { revision: 'refs/heads/never' },
      context,
    );
    expect(entries).toStrictEqual([]);
  });
});

withGit('emitting files and their versions', () => {
  it('emits a file and the version a revision holds', async () => {
    const fixture = await repository('emit-files');
    await writeFile(join(fixture.path, 'a.ts'), 'const a = 1;\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add a']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const graph = provider.emitFiles(fixture.discovered, entries, { revision: 'HEAD' });

    const file = graph.entities.find(
      (entity) => entity.kind === 'file' && entity.attributes['path'] === 'a.ts',
    );
    expect(file).toBeDefined();
    expect(file?.attributes['extension']).toBe('ts');

    const version = graph.entities.find((entity) => entity.kind === 'file_version');
    expect(String(version?.attributes['contentHash'])).toMatch(/^git-blob:[0-9a-f]{40,64}$/);
    expect(version?.attributes['sizeBytes']).toBe(13);

    const types = new Set(graph.relationships.map((r) => r.type));
    expect(types).toContain(RelationshipType.REPOSITORY_CONTAINS_FILE);
    expect(types).toContain(RelationshipType.FILE_HAS_VERSION);
  });

  it('records EPIC-030 structure when the caller supplies it — AC-10', async () => {
    const fixture = await repository('emit-structure');
    await mkdir(join(fixture.path, 'dist'), { recursive: true });
    await writeFile(join(fixture.path, 'dist', 'bundle.min.js'), 'var a=1;\r\nvar b=2;\r\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add bundle']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    // Nothing in `emitFiles` opens a file, so the caller reads the bytes and
    // hands the structure in. That is the whole integration point: EPIC-030
    // derives, EPIC-022 emits, and neither gains a filesystem dependency.
    const path = 'dist/bundle.min.js';
    const structure = describeFileStructure(path, await readFile(join(fixture.path, 'dist', 'bundle.min.js')));

    const graph = provider.emitFiles(fixture.discovered, entries, {
      structure: new Map([[path, structure]]),
    });

    const file = graph.entities.find(
      (entity) => entity.kind === 'file' && entity.attributes['path'] === path,
    );
    expect(file?.attributes).toMatchObject({
      classification: 'generated',
      isGenerated: true,
      isVendored: false,
      isBinary: false,
    });

    const version = graph.entities.find(
      (entity) => entity.kind === 'file_version' && entity.attributes['path'] === path,
    );
    expect(version?.attributes).toMatchObject({ lineCount: 2, lineEnding: 'crlf', endsWithNewline: true });
  });

  it('emits exactly as before when no structure is supplied — AC-10', async () => {
    const fixture = await repository('emit-no-structure');
    await writeFile(join(fixture.path, 'plain.ts'), 'const a = 1;\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add plain']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const graph = provider.emitFiles(fixture.discovered, entries);
    const file = graph.entities.find(
      (entity) => entity.kind === 'file' && entity.attributes['path'] === 'plain.ts',
    );

    expect(file?.attributes).toStrictEqual({ path: 'plain.ts', extension: 'ts' });
  });

  it('gives a file the same identity whether it was listed or seen in a commit', async () => {
    // The decision this Epic pair exists to keep consistent. EPIC-020 chose
    // repository + path for files seen in history; if listing chose anything
    // else, every file in Ferret would exist twice.
    const fixture = await repository('identity-agreement');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'shared.ts'), 'x\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add shared']);

    const listed = provider.emitFiles(
      fixture.discovered,
      (await provider.listFiles(fixture.discovered, {}, context)).entries,
    );
    const fromHistory = provider.emitHistory(
      fixture.discovered,
      (await provider.readHistory(fixture.discovered, { withChanges: true }, context)).commits,
    );

    // Typed by what it needs, not by one of the two graph shapes: `emitFiles`
    // also reports what it skipped and `emitHistory` does not.
    const idOf = (graph: { entities: readonly { kind: string; id: string; attributes: Readonly<Record<string, unknown>> }[] }): string | undefined =>
      graph.entities.find(
        (entity) => entity.kind === 'file' && entity.attributes['path'] === 'src/shared.ts',
      )?.id;

    expect(idOf(listed)).toBeDefined();
    expect(idOf(fromHistory)).toBeDefined();
    expect(idOf(listed)).toBe(idOf(fromHistory));
  });

  it('does not emit a symlink or a submodule as a file, and says why', async () => {
    // A symlink's blob holds a target path, not content. Indexing it as source
    // would record `../../etc/passwd` as though someone had written it.
    const fixture = await repository('not-files');
    let linked = false;
    try {
      await writeFile(join(fixture.path, 'target.txt'), 't\n');
      await symlink('target.txt', join(fixture.path, 'alias.txt'));
      linked = true;
    } catch {
      process.stderr.write('[EPIC-022] symlink creation unavailable; skip-reason not exercised\n');
    }
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'maybe a link']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const graph = provider.emitFiles(fixture.discovered, entries);

    if (linked && process.platform !== 'win32') {
      expect(graph.skipped.map((skip) => skip.reason)).toContain('symlink');
      expect(
        graph.entities.some((entity) => entity.kind === 'file' && entity.attributes['path'] === 'alias.txt'),
      ).toBe(false);
    }
    // A submodule entry, synthesised: creating a real one needs a second
    // repository and a network-free `git submodule add`, and the property under
    // test is the emitter's, not Git's.
    const withSubmodule = provider.emitFiles(fixture.discovered, [
      ...entries,
      { path: 'vendor/lib', kind: TreeEntryKind.SUBMODULE, oid: 'a'.repeat(40), sizeBytes: undefined, mode: '160000' },
    ]);
    expect(withSubmodule.skipped.map((skip) => skip.reason)).toContain('submodule');
  });

  it('gives the same bytes at two paths two versions of two files', async () => {
    // Version identity is scoped to the file, not to the repository: the same
    // bytes at two paths are two versions, because a version is a version *of
    // something*.
    const fixture = await repository('same-bytes-two-paths');
    await writeFile(join(fixture.path, 'one.txt'), 'duplicate\n');
    await writeFile(join(fixture.path, 'two.txt'), 'duplicate\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'duplicates']);

    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const graph = provider.emitFiles(fixture.discovered, entries);
    const versions = graph.entities.filter((entity) => entity.kind === 'file_version');

    const duplicates = versions.filter((entity) =>
      ['one.txt', 'two.txt'].includes(String(entity.attributes['path'])),
    );
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((entity) => entity.id)).size).toBe(2);
    // …but the content hash is the same, which is what makes duplication
    // detectable at all.
    expect(new Set(duplicates.map((entity) => entity.attributes['contentHash'])).size).toBe(1);
  });

  it('emits identical ids for an unchanged revision read twice', async () => {
    const fixture = await repository('idempotent-files');
    const { entries } = await provider.listFiles(fixture.discovered, {}, context);

    const first = provider.emitFiles(fixture.discovered, entries);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = provider.emitFiles(fixture.discovered, entries);

    expect(second.entities.map((e) => e.id)).toStrictEqual(first.entities.map((e) => e.id));
  });

  it('lists and emits a large tree within budget', async () => {
    const fixture = await repository('bulk-files');
    for (let i = 0; i < 400; i += 1) {
      await writeFile(join(fixture.path, `file-${String(i)}.txt`), `contents ${String(i)}\n`);
    }
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'bulk']);

    const started = performance.now();
    const { entries } = await provider.listFiles(fixture.discovered, {}, context);
    const graph = provider.emitFiles(fixture.discovered, entries);
    const elapsed = performance.now() - started;

    expect(entries).toHaveLength(401);
    // One Git invocation for four hundred files, and no file opened at all —
    // the object id and the size both come from the tree.
    expect(graph.entities.length).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(20_000);
  }, 180_000);
});
