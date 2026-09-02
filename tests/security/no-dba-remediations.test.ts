import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { remediationForHolder } from '../../src/storage/index.js';

/**
 * **A remediation is an action, not a lookup** — EPIC-095 §8, Governance §13.
 *
 * *"Corrupt or stale derived indexes must be detectable and recoverable without
 * requiring the user to become a database administrator."*
 *
 * Ferret's own remediation for a held migration lock used to end: *"inspect
 * pg_locks for a stale session holding the advisory lock."* A research task,
 * delegated to someone who came here to be told the answer — and the exact
 * instruction §13 exists to prevent, written by us.
 *
 * It lives in `tests/security/` rather than beside the diagnostics tests
 * because it is the shape those tests cannot have: a statement about *every*
 * remediation string the product produces, not about the one an author
 * remembered. EPIC-100 established that enumerating from the source is what
 * makes an invariant survive the next commit.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

function sourceFiles(directory: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full.slice(SRC.length + 1).split(sep).join('/'));
  }
  return found;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every `remediation:` string literal in `src/`.
 *
 * Template literals are included; a remediation built from a variable is not
 * readable here and is not claimed to be. That limit is stated rather than
 * hidden — the invariant covers the literals, which is where every one of
 * Ferret's remediations is written today.
 */
function remediations(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const file of sourceFiles()) {
    const source = stripComments(readFileSync(resolve(SRC, file), 'utf8'));
    for (const match of source.matchAll(/remediation:\s*(?:\n\s*)?(['"`])((?:[^\\]|\\.)*?)\1/gs)) {
      found.push({ file, text: match[2] ?? '' });
    }
  }
  return found;
}

/** Things that mean "go and be a DBA". */
const CATALOGUES = [/\bpg_[a-z_]+\b/, /\bferret\.[a-z_]+\b/, /\binformation_schema\b/];
const SQL_VERBS = [/\bSELECT\b/, /\bUPDATE\b/, /\bDELETE\b/, /\bINSERT\b/, /\bALTER\s+TABLE\b/, /\bDROP\s+TABLE\b/];

describe('no remediation sends an operator to a catalogue — AC-3', () => {
  it('finds the remediation strings at all', () => {
    // Failing closed. An invariant over an empty set is a test that reports
    // green about nothing, which is the one shape a guard must not have.
    const found = remediations();

    expect(found.length).toBeGreaterThan(20);
    process.stderr.write(`[EPIC-095] remediation strings checked: ${String(found.length)}\n`);
  });

  it('names no system catalogue or Ferret table', () => {
    for (const { file, text } of remediations()) {
      for (const pattern of CATALOGUES) {
        expect(pattern.test(text), `${file}: "${text}"`).toBe(false);
      }
    }
  });

  it('asks nobody to run SQL', () => {
    for (const { file, text } of remediations()) {
      for (const pattern of SQL_VERBS) {
        expect(pattern.test(text), `${file}: "${text}"`).toBe(false);
      }
    }
  });
});

describe('the lock remediation says what to do — AC-1, AC-2', () => {
  it('distinguishes a stuck client from a slow migration', () => {
    // The two cases call for opposite responses — wait, or go and end that
    // process — and the state is the only thing that separates them. A single
    // remediation covering both would be advice for neither.
    const idle = remediationForHolder({
      pid: 4242,
      heldForSeconds: 7200,
      state: 'idle in transaction',
      application: 'psql',
      query: undefined,
    });
    const working = remediationForHolder({
      pid: 4243,
      heldForSeconds: 3,
      state: 'active',
      application: 'ferret',
      query: undefined,
    });

    expect(idle).toContain('idle inside an open transaction');
    expect(idle).toContain('4242');
    expect(working).toContain('Another Ferret is migrating');
    expect(idle).not.toBe(working);
  });

  it('stays actionable when the holder cannot be identified', () => {
    const unknown = remediationForHolder(undefined);

    expect(unknown).toContain('could not identify');
    // Never claims a pid it did not read.
    expect(unknown).not.toMatch(/process \d/);
  });
});
