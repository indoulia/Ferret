import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **A control Ferret declares is reached from a production path — AC-8.**
 *
 * The criterion EPIC-100 left undone, and the reason it matters is on record in
 * that Epic's own §Raised: `EvidenceStore.verify` was correct, tested, and
 * reachable from nothing for three Epics. A control with a passing test and no
 * caller is worse than a missing one, because the test says it works.
 *
 * ## What is enumerated, and why this is not the list §8 rejected
 *
 * EPIC-100 §8 rejects a hand-written list of controls to check, so the set is
 * read from the source: every **value** export of `src/security/index.ts` and
 * `src/authorization/index.ts`. Those two barrels are where Ferret declares its
 * security controls, and they say so themselves — `src/authorization/index.ts`
 * opens by drawing the line between them: "`security/` holds *content* controls
 * … This holds a *caller* control." Adding an export to either is what
 * declaring a control means, and this invariant covers it on that commit.
 *
 * Types are excluded: a type is a shape, not a control. Constants are not —
 * `CREDENTIAL_ENV` that nothing reads means nothing scrubs, which is exactly
 * the shape of the `detectGit` defect.
 *
 * ## Reachability is transitive, and the first draft of this file was wrong
 *
 * A direct-reference check reported thirteen controls dead, and every one was a
 * false positive: `classifyInstructionShape` is called by `contain`,
 * `CREDENTIAL_ENV` is read by `withoutCredentials`, `authorize` is called by
 * `assertPermitted`. Production reaches them *through* a sibling. Reporting
 * those would have trained the next reader to ignore this suite, which is the
 * failure mode EPIC-094 named when it excluded `content-index` artefacts from
 * its staleness check.
 *
 * So this walks the reference graph: a control is reachable when production
 * names it, or when something already reachable names it. Only a control no
 * chain ends at is dead.
 *
 * ## Why a general port sweep was rejected
 *
 * The obvious generalisation — every method on every port must have a non-test
 * caller — was tried and discarded, because it is a dead-code detector wearing
 * a security invariant's clothes, and it fails **today** on a gap EPIC-094
 * recorded and accepted: "`staleArtifacts` still has no production caller." The
 * only ways to make it green are to widen this Epic's scope into EPIC-094's, or
 * to add the exemption list §8 rejects. So the invariant covers the controls
 * Ferret *declares as controls*, and the residue is named in the validation
 * record rather than papered over here.
 */

const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

/** The barrels that constitute Ferret's declared security-control surface. */
const CONTROL_MODULES = ['security', 'authorization'] as const;

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

const ALL_SOURCES = sourceFiles(SRC);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function references(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(body);
}

/**
 * A file that only re-exports.
 *
 * Detected rather than assumed from the name, because the whole invariant turns
 * on it: `src/index.ts` re-exports every control in the codebase, so counting a
 * barrel as a call site would make every name reachable and the test would pass
 * while measuring nothing.
 */
function isBarrel(path: string): boolean {
  const statements = stripComments(readFileSync(path, 'utf8'))
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return statements.length > 0 && statements.every((part) => /^(export|import)\b/.test(part));
}

/**
 * The value exports of one control barrel.
 *
 * Read from `export { … } from '…'` lists, which is the only form these two
 * files use. The count is asserted below, so a barrel rewritten into a shape
 * this does not understand fails the suite instead of quietly enumerating
 * nothing.
 */
function declaredControls(module: string): readonly string[] {
  const source = readFileSync(resolve(SRC, module, 'index.ts'), 'utf8');
  const names: string[] = [];
  for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    for (const raw of (block[1] ?? '').split(',')) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      // `export { type Foo }` — a shape, not a control.
      if (/^type\s/.test(entry)) continue;
      const [exported] = entry.split(/\s+as\s+/);
      const name = (exported ?? '').trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

/**
 * Every top-level declaration in a module, as `name → body`.
 *
 * Split on column-zero declaration keywords, which this codebase's formatting
 * makes reliable — and the reliability is *checked* rather than assumed: the
 * caller asserts every declared control was found, so a file this fails to
 * parse fails the suite instead of reporting its contents unreachable.
 *
 * Internal helpers are included, not just exports. Production can reach a
 * control through a private function, and a graph that only knew about exports
 * would miss that edge and report a live control dead.
 */
function topLevelDeclarations(module: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const moduleDir = resolve(SRC, module) + sep;
  for (const path of ALL_SOURCES.filter((file) => file.startsWith(moduleDir) && !isBarrel(file))) {
    const body = stripComments(readFileSync(path, 'utf8'));
    const pattern = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
    const marks: { name: string; at: number }[] = [];
    for (const match of body.matchAll(pattern)) {
      marks.push({ name: match[1] ?? '', at: match.index ?? 0 });
    }
    for (const [position, mark] of marks.entries()) {
      const end = marks[position + 1]?.at ?? body.length;
      // Concatenated rather than overwritten: an overload or a re-declaration
      // across files must contribute both bodies, or an edge goes missing.
      declarations.set(mark.name, (declarations.get(mark.name) ?? '') + body.slice(mark.at, end));
    }
  }
  return declarations;
}

/**
 * Controls no chain of references reaches from production code.
 *
 * Seeded from outside the module, then closed transitively over the module's
 * own declarations.
 */
function unreachableControls(module: string, extra: readonly string[] = []): string[] {
  const controls = [...declaredControls(module), ...extra];
  const moduleDir = resolve(SRC, module) + sep;
  const declarations = topLevelDeclarations(module);

  const productionBodies = ALL_SOURCES.filter((path) => !path.startsWith(moduleDir) && !isBarrel(path)).map((path) =>
    stripComments(readFileSync(path, 'utf8')),
  );

  // Seeds: named directly by production code.
  const reachable = new Set(controls.filter((name) => productionBodies.some((body) => references(body, name))));

  // Close over the module: anything a reachable declaration names is reachable
  // too. Bounded by the declaration count, so it terminates on a cycle.
  const queue = [...reachable];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const body = declarations.get(current);
    if (body === undefined) continue;
    for (const [name] of declarations) {
      if (name === current || reachable.has(name)) continue;
      if (!references(body, name)) continue;
      reachable.add(name);
      queue.push(name);
    }
  }

  return controls.filter((name) => !reachable.has(name));
}

describe('no declared security control is unreachable from a production path — AC-8', () => {
  it.each([...CONTROL_MODULES])('finds %s’s control surface, so an empty enumeration cannot pass', (module) => {
    // The failure mode every enumerated invariant in this suite guards: a regex
    // that stops matching turns a real check into a green one. EPIC-100 AC-3's
    // shape, applied here.
    const controls = declaredControls(module);
    expect(controls.length, `${module} declared no controls — the barrel's shape changed`).toBeGreaterThan(5);

    // And the declaration parser found each of them. Without this a file this
    // cannot parse would contribute no edges, and every control reached only
    // through it would be reported dead.
    const declarations = topLevelDeclarations(module);
    const missing = controls.filter((name) => !declarations.has(name));
    expect(missing, `declarations not found in ${module}/: ${missing.join(', ')}`).toStrictEqual([]);
  });

  it('excludes barrels, so a re-export cannot count as a caller', () => {
    // `src/index.ts` re-exports the whole package. If it counted, every control
    // would be trivially reachable — so this asserts the exclusion works rather
    // than trusting it.
    expect(isBarrel(resolve(SRC, 'index.ts'))).toBe(true);
    expect(isBarrel(resolve(SRC, 'security', 'index.ts'))).toBe(true);
    expect(isBarrel(resolve(SRC, 'indexing', 'indexer.ts'))).toBe(false);
  });

  it.each([...CONTROL_MODULES])('every control %s declares is reached from src/', (module) => {
    const dead = unreachableControls(module);
    expect(
      dead,
      `${module} declares ${String(dead.length)} control(s) no production path reaches: ${dead.join(', ')}. ` +
        'A control with a passing test and no caller is worse than a missing one — EPIC-100 AC-8.',
    ).toStrictEqual([]);
  });

  it.each([...CONTROL_MODULES])('reports a control of %s’s that nothing calls — AC-11', (module) => {
    // AC-11 asks that every invariant fails when its property breaks, proved by
    // a deliberate break rather than by trusting that a passing test would
    // fail. `planted` is a name no source file contains, pushed through the
    // same function the assertion above uses — so a detector that stopped
    // detecting fails here.
    const planted = 'aControlNoProductionPathReaches';
    expect(unreachableControls(module, [planted])).toStrictEqual([planted]);
  });

  it('does not reach a control through a dead sibling', () => {
    // The transitive closure is the part most likely to over-report reachable.
    // This pins the direction: being named by an *unreachable* declaration is
    // not reachability. `aControlNoProductionPathReaches` is named by nothing,
    // and a second planted name reached only from it stays dead.
    const dead = unreachableControls('security', ['aControlNoProductionPathReaches', 'norIsThisOne']);
    expect(dead).toStrictEqual(['aControlNoProductionPathReaches', 'norIsThisOne']);
  });
});
