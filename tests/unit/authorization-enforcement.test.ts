import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { EvidenceReader } from '../../src/context/index.js';
import { UNRESTRICTED_READ } from '../../src/storage/index.js';

/**
 * That enforcement exists everywhere it must — EPIC-083 AC-11.
 *
 * The lesson of #85 and #87, in a test. Both were one line, both were on a path
 * nobody exercised, and the second arrived *after* the first was fixed and
 * reviewed — so the control cannot be "someone will notice". This enumerates the
 * entry points from the source and fails when one of them is unguarded.
 *
 * A source-scanning test for the same reason `boundaries.test.ts` is one: the
 * property is about the shape of the code, and a runtime assertion can only
 * observe the paths a test happens to drive. That is precisely the gap #87 lived
 * in.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf8');
}

/** Block comments and whole-line comments removed, so prose cannot satisfy a check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the caller-facing evidence port cannot be called unscoped — AC-1', () => {
  const port = stripComments(read('context/evidence-port.ts'));
  const body = port.slice(port.indexOf('export interface EvidenceReader'));

  it('finds the port, so a passing suite is not an empty one', () => {
    expect(body).toContain('forSubject(');
    expect(body).toContain('conflictsFor(');
  });

  it('declares no optional permission-scope parameter anywhere', () => {
    // The exact spelling that made both defects possible. `permittedScopes?:`
    // reads as a courtesy and behaves as an opt-out.
    expect(body).not.toContain('permittedScopes?:');
  });

  it('makes the options argument itself required on every read', () => {
    // `query?:` would restore the hole from the other side: an omitted object is
    // an omitted scope. Every read must be handed something that names one.
    expect(body).not.toMatch(/\b(?:query|options)\?\s*:/);
  });

  it('names every read the port exposes, so a new one cannot be added unnoticed', () => {
    const methods = [...body.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]);
    expect(methods.sort()).toStrictEqual([
      'conflictsFor',
      'forSubject',
      'forSubjectWithState',
      'provenanceOf',
      'verify',
    ]);
  });

  it('rejects an unscoped read at compile time, not at review time', () => {
    const reader = {} as EvidenceReader;

    // Each of these is the defect that shipped twice. The directive is the
    // assertion: if any of them ever compiles, `tsc --noEmit` fails on an unused
    // `@ts-expect-error` and this file is what breaks.
    // @ts-expect-error — a subject read with no permitted scopes.
    void (() => reader.forSubject('id', {}));
    // @ts-expect-error — #85: the traceability subject read.
    void (() => reader.forSubject('id', { state: 'current' }));
    // @ts-expect-error — #87: the conflict report, ten lines below it.
    void (() => reader.conflictsFor('id'));
    // @ts-expect-error — a lineage walk with a depth and no scopes.
    void (() => reader.provenanceOf('id', { maxDepth: 3 }));
    // @ts-expect-error — an integrity check.
    void (() => reader.verify('id'));
    // @ts-expect-error — the state projection the selection path uses.
    void (() => reader.forSubjectWithState('id', {}));

    expect(true).toBe(true);
  });
});

describe('the one unrestricted read is named rather than reached by omission — AC-2', () => {
  const store = stripComments(read('storage/evidence.ts'));

  it('exports a name for it', () => {
    expect(UNRESTRICTED_READ).toStrictEqual({ permittedScopes: undefined });
  });

  it('uses that name at the internal read that needs it', () => {
    // `verifyAll` sweeps a subject's records for tampering and must see all of
    // them. That is a real requirement; what this Epic removes is arriving at it
    // by passing nothing.
    expect(store).toContain('{ ...UNRESTRICTED_READ, limit: 1_000 }');
  });

  it('has no other unrestricted read inside the store', () => {
    // Every internal `this.forSubject(...)` either names its scopes or names the
    // decision. A bare `this.forSubject(x)` is the shape that hid both defects.
    const calls = [...store.matchAll(/this\.forSubject\w*\(([^;]*?)\)\s*;/gs)].map(
      (match) => match[1] ?? '',
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/permittedScopes|UNRESTRICTED_READ/);
    }
  });
});

describe('the CLI is authorized like every other entry point — AC-3, AC-4', () => {
  const commands = resolve(SRC, 'cli/commands');
  const files = readdirSync(commands).filter((name) => name.endsWith('.ts'));

  it('finds the command modules, so a passing suite is not an empty one', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('asserts a permission in every command that indexes', () => {
    // Enumerated from the source rather than listed here: a second indexing
    // command added later is caught by the same test that covers the first.
    const indexing = files.filter((name) =>
      stripComments(readFileSync(resolve(commands, name), 'utf8')).includes('RepositoryIndexer'),
    );
    expect(indexing).not.toStrictEqual([]);
    for (const name of indexing) {
      const source = stripComments(readFileSync(resolve(commands, name), 'utf8'));
      expect(source, `${name} indexes without asserting a permission`).toMatch(
        /assertPermitted\(\s*(?:localOperatorFrom|principalFrom)\(/,
      );
      expect(source, `${name} must assert the index permission`).toContain('Permission.INDEX');
    }
  });

  it('reads the grant from configuration, never from an argument or the environment', () => {
    // Governance §12: the grant comes from configuration only. A CLI flag that
    // widened it would be exactly the opt-out the MCP surface does not have.
    for (const name of files) {
      const source = stripComments(readFileSync(resolve(commands, name), 'utf8'));
      for (const call of [...source.matchAll(/(?:localOperatorFrom|principalFrom)\(([^)]*)\)/g)]) {
        expect(call[1]?.trim(), `${name} builds a principal from something else`).toBe(
          'context.config',
        );
      }
    }
  });
});
