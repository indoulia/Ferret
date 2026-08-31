import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCode, FerretError } from '../../errors/index.js';

/**
 * Finding, loading and identifying grammar binaries.
 *
 * TECHNOLOGY-DECISIONS §4 makes grammar identity mandatory rather than nice to
 * have: the Node and Python tree-sitter ecosystems disagreed by 1.2% of named
 * nodes over the same 1,590 files. A result is therefore only reproducible if
 * the grammar that produced it is recorded, so every load hashes the exact
 * bytes it loaded.
 */

/** Grammar provenance, recorded with every result the grammar produced. */
export interface GrammarIdentity {
  readonly grammar: string;
  /** tree-sitter's language ABI version. */
  readonly abiVersion: number;
  /** SHA-256 of the `.wasm` actually loaded, truncated to 16 hex characters. */
  readonly binaryHash: string;
}

/**
 * Where grammars are looked for, in order.
 *
 * 1. Beside the compiled module — what an installed package has, because the
 *    build copies them there.
 * 2. `tree-sitter-wasms` — what a checkout of this repository has, where the
 *    package is a *dev* dependency and the build has not necessarily run.
 *
 * Two locations rather than one because the alternative is either shipping
 * forty grammars to every user or being unable to run the tests before a build.
 */
export function grammarSearchPaths(moduleUrl: string = import.meta.url): readonly string[] {
  const beside = join(dirname(fileURLToPath(moduleUrl)), 'grammars');
  try {
    const require = createRequire(moduleUrl);
    return [beside, join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out')];
  } catch {
    // The dev dependency is absent, which is the normal state of an installed
    // package. The packaged directory is the only candidate, and it is there.
    return [beside];
  }
}

async function readGrammar(grammar: string, searchPaths: readonly string[]): Promise<Uint8Array> {
  const file = `tree-sitter-${grammar}.wasm`;
  const tried: string[] = [];
  for (const directory of searchPaths) {
    const path = join(directory, file);
    tried.push(path);
    try {
      return await readFile(path);
    } catch {
      continue;
    }
  }
  throw new FerretError(ErrorCode.DEPENDENCY_UNAVAILABLE, `Grammar "${grammar}" was not found`, {
    details: { grammar, tried },
    remediation:
      'Run `npm run build` so the grammars are copied beside the compiled parser, or reinstall the package.',
  });
}

export interface LoadedGrammar {
  readonly identity: GrammarIdentity;
  readonly bytes: Uint8Array;
}

/**
 * Reads a grammar and computes its identity.
 *
 * The hash is over the bytes that were read, not over a version string a
 * package claims: a republished package with the same version number is exactly
 * the case a recorded version would miss.
 */
export async function loadGrammarBytes(
  grammar: string,
  searchPaths: readonly string[] = grammarSearchPaths(),
): Promise<Omit<LoadedGrammar, 'identity'> & { readonly binaryHash: string }> {
  const bytes = await readGrammar(grammar, searchPaths);
  const binaryHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return { bytes, binaryHash };
}
