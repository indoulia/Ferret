import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErrorCode, type FerretError } from '../../../src/index.js';
import { BlobUnavailable, listFiles, readBlob } from '../../../src/git/index.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * EPIC-108 §8.3 — reading a blob's bytes, byte for byte.
 *
 * The property under test is that **content survives the round trip unchanged**.
 * Everything downstream depends on it and nothing downstream can detect its
 * absence: a parser handed re-encoded bytes produces spans into a string that
 * is not the file, and a content hash computed over them is a hash of something
 * the repository does not contain. `git ls-tree` output is text and is decoded;
 * `git cat-file blob` output is content and must not be.
 *
 * The second property is that the **bound is enforced before the bytes are
 * materialised**. A read that returns 400 MB in order to reject it has already
 * paid the cost the bound exists to avoid, so the assertion is on the verdict
 * rather than on a length.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-108] SKIPPING every blob-content test: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-blob-');
});

afterAll(async () => {
  if (version === undefined) return;
  await workspace.cleanup();
});

async function repository(name: string): Promise<string> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  return createRepository(root, name);
}

function options(path: string): { cwd: string; signal: AbortSignal } {
  return { cwd: path, signal: new AbortController().signal };
}

async function oidOf(path: string, file: string): Promise<string> {
  const listing = await listFiles(options(path));
  const entry = listing.entries.find((candidate) => candidate.path === file);
  if (entry === undefined) throw new Error(`${file} is not in the tree`);
  return entry.oid;
}

withGit('reading a blob', () => {
  it('returns the exact bytes, including ones that are not valid UTF-8', async () => {
    const path = await repository('binary-safe');
    // A lone 0x80 continuation byte, a NUL, and 0xFF. None of these survives a
    // UTF-8 decode-and-re-encode: each becomes U+FFFD and comes back as three
    // different bytes.
    const content = Uint8Array.from([0x68, 0x69, 0x00, 0x80, 0xff, 0x0a, 0xc3, 0xa9]);
    await writeFile(join(path, 'raw.bin'), content);
    await git(path, ['add', 'raw.bin']);
    await git(path, ['commit', '-m', 'binary']);

    const result = await readBlob({ ...options(path), oid: await oidOf(path, 'raw.bin') });

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect([...result.bytes]).toStrictEqual([...content]);
    expect(result.sizeBytes).toBe(content.length);
  });

  it('preserves CRLF exactly as the object store holds it', async () => {
    // Git's own `core.autocrlf` can rewrite a working copy on checkout. The
    // object is what was committed, and the object is what is indexed: a run
    // whose content depended on the reader's line-ending settings would give
    // two developers different spans for the same commit.
    const path = await repository('line-endings');
    const content = Buffer.from('alpha\r\nbeta\r\n', 'utf8');
    await writeFile(join(path, 'crlf.txt'), content);
    await git(path, ['add', '--renormalize=false', 'crlf.txt']).catch(async () => {
      await git(path, ['add', 'crlf.txt']);
    });
    await git(path, ['commit', '-m', 'crlf']);

    const result = await readBlob({ ...options(path), oid: await oidOf(path, 'crlf.txt') });

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(Buffer.from(result.bytes).includes('\r\n')).toBe(true);
  });

  it('reads an empty blob as zero bytes rather than as a failure', async () => {
    const path = await repository('empty-blob');
    await writeFile(join(path, 'empty.txt'), '');
    await git(path, ['add', 'empty.txt']);
    await git(path, ['commit', '-m', 'empty']);

    const result = await readBlob({ ...options(path), oid: await oidOf(path, 'empty.txt') });

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(result.sizeBytes).toBe(0);
  });

  it('reads the committed object, not the working tree', async () => {
    // The whole reason content is read through the object store. A file edited
    // but not committed must index as the revision holds it, or `--revision`
    // means nothing and a dirty checkout silently changes what was indexed.
    const path = await repository('committed-not-working');
    await writeFile(join(path, 'source.ts'), 'export const committed = 1;\n', 'utf8');
    await git(path, ['add', 'source.ts']);
    await git(path, ['commit', '-m', 'source']);
    const oid = await oidOf(path, 'source.ts');

    await writeFile(join(path, 'source.ts'), 'export const uncommitted = 2;\n', 'utf8');

    const result = await readBlob({ ...options(path), oid });

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('export const committed = 1;\n');
  });
});

withGit('the read bound', () => {
  it('refuses a blob over the bound without materialising it', async () => {
    const path = await repository('over-bound');
    await writeFile(join(path, 'big.txt'), 'x'.repeat(64 * 1024), 'utf8');
    await git(path, ['add', 'big.txt']);
    await git(path, ['commit', '-m', 'big']);

    const result = await readBlob({
      ...options(path),
      oid: await oidOf(path, 'big.txt'),
      maxBytes: 1024,
    });

    expect(result.read).toBe(false);
    if (result.read) return;
    expect(result.reason).toBe(BlobUnavailable.TOO_LARGE);
    expect(result.detail).toContain('1024');
  });

  it('accepts a blob exactly at the bound', async () => {
    // The boundary is inclusive, and getting it wrong by one is how a bound
    // becomes a rule nobody can predict.
    const path = await repository('at-bound');
    await writeFile(join(path, 'exact.txt'), 'y'.repeat(1024), 'utf8');
    await git(path, ['add', 'exact.txt']);
    await git(path, ['commit', '-m', 'exact']);

    const result = await readBlob({
      ...options(path),
      oid: await oidOf(path, 'exact.txt'),
      maxBytes: 1024,
    });

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(result.sizeBytes).toBe(1024);
  });

  it('rejects a bound that is not a positive integer', async () => {
    const path = await repository('bad-bound');
    await expect(
      readBlob({ ...options(path), oid: await oidOf(path, 'README.md'), maxBytes: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE });
  });
});

withGit('a blob that is not there', () => {
  it('reports a missing object rather than throwing', async () => {
    const path = await repository('missing-object');
    const result = await readBlob({
      ...options(path),
      oid: '0000000000000000000000000000000000000001',
    });

    expect(result.read).toBe(false);
    if (result.read) return;
    expect(result.reason).toBe(BlobUnavailable.NOT_FOUND);
    // Git's own words are kept, because `bad file` is also what it says for an
    // object that exists and is not a blob, and the two are not separable from
    // its output.
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('reports an object that exists but is not a blob the same way', async () => {
    const path = await repository('not-a-blob');
    const tree = (await git(path, ['rev-parse', 'HEAD^{tree}'])).trim();
    const result = await readBlob({ ...options(path), oid: tree });

    expect(result.read).toBe(false);
    if (result.read) return;
    expect(result.reason).toBe(BlobUnavailable.NOT_FOUND);
  });

  it('refuses an object id that is not one, without asking Git', async () => {
    // An id is the address of the content. Anything else reaching the argument
    // vector is a path or an option, and `--upload-pack=` is the reason this is
    // checked here rather than trusted.
    const path = await repository('bad-oid');
    for (const oid of ['--upload-pack=evil', '../../etc/passwd', 'HEAD', '']) {
      const result = await readBlob({ ...options(path), oid });
      expect(result.read).toBe(false);
      if (result.read) continue;
      expect(result.reason).toBe(BlobUnavailable.NOT_FOUND);
    }
  });
});

withGit('cancellation', () => {
  it('fails the read rather than reporting a short one', async () => {
    // A cancelled child also looks truncated. Reporting that as a successful
    // partial read is how a cancelled run would claim to have indexed a file it
    // only half saw.
    const path = await repository('cancelled-read');
    const controller = new AbortController();
    controller.abort();

    await expect(
      readBlob({
        cwd: path,
        signal: controller.signal,
        oid: await oidOf(path, 'README.md'),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED } satisfies Partial<FerretError>);
  });
});
