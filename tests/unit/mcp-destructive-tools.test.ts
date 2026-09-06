import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A destructive MCP tool cannot be registered without its two controls —
 * EPIC-069 AC-12.
 *
 * `Checkpoints/EPIC-004.md` §100 left an instruction rather than a control: "Do
 * not add a repair path to `doctor`. It advises. Anything that changes state is an
 * explicitly requested operation and is governed by EPIC-069." An instruction in a
 * checkpoint is read by whoever finds it. This is read by CI.
 *
 * Source-level rather than behavioural, on the precedent of `boundaries.test.ts`:
 * the property is *how a tool is written*, and no runtime assertion can catch a
 * tool that simply never calls the gate. The first destructive tool registered
 * without `guardDestructive` fails here, which is the point at which someone is
 * still looking.
 *
 * Scans **every** module in `src/mcp/`, discovered by reading the directory
 * rather than listed here. EPIC-069 shipped this reading `server.ts` alone, and
 * EPIC-066 registers its tools from a second file — a control that named one file
 * would have silently stopped covering the surface at exactly the moment the
 * surface grew its first destructive tool.
 */

const MCP_DIR = fileURLToPath(new URL('../../src/mcp', import.meta.url));

/** Every MCP module, so a new one is covered the day it is added. */
function mcpSources(): { file: string; source: string }[] {
  return readdirSync(MCP_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => ({ file: `src/mcp/${name}`, source: readFileSync(`${MCP_DIR}/${name}`, 'utf8') }));
}

/** Block comments wholesale, line comments only when they start a line. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Registration {
  readonly name: string;
  readonly file: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly body: string;
}

/**
 * Every `server.registerTool(...)` in the file, as name, annotation and body.
 *
 * Split rather than parsed: a chunk runs from one registration to the next, which
 * is exactly the text belonging to that tool. A real parser would be more precise
 * and would also be a second implementation of TypeScript in the test suite.
 */
function registrations(file: string, source: string): Registration[] {
  const chunks = stripComments(source).split(/\.registerTool\(/);
  return chunks.slice(1).map((chunk) => {
    const name = /^\s*'([^']+)'/.exec(chunk)?.[1] ?? '<unnamed>';
    return {
      name,
      file,
      readOnly: /readOnlyHint:\s*true/.test(chunk),
      // EPIC-117. MCP's own word: `destructiveHint` is "the tool may perform
      // destructive updates", and `false` is "only additive updates". The
      // control keys on it because that is the property EPIC-069's confirmation
      // gate is about — see the amendment note below.
      destructive: /destructiveHint:\s*true/.test(chunk),
      body: chunk,
    };
  });
}

/** Every tool registered anywhere on the MCP surface. */
function allRegistrations(): Registration[] {
  return mcpSources().flatMap(({ file, source }) => registrations(file, source));
}

describe('destructive MCP tools', () => {
  const tools = allRegistrations();
  const label = (tool: Registration): string => `${tool.name} (${tool.file})`;

  it('finds the tools, so a passing suite is not an empty one', () => {
    // Without this the whole file passes vacuously the day someone renames
    // `registerTool`.
    expect(tools.length).toBeGreaterThanOrEqual(5);
    for (const tool of tools) expect(tool.name).toMatch(/^ferret_/);
  });

  it('registers every tool with an explicit read-only annotation, either way', () => {
    // A tool that declares neither is the dangerous case: a client cannot tell
    // whether to prompt, and this test cannot tell whether to require a gate.
    for (const tool of tools) {
      expect(/readOnlyHint:\s*(true|false)/.test(tool.body), label(tool)).toBe(true);
    }
  });

  it('routes every destructive tool through the destructive guard — AC-12', () => {
    for (const tool of tools.filter((candidate) => candidate.destructive)) {
      expect(
        /guardDestructive\(|createDestructiveToolGuard\(/.test(tool.body),
        `${label(tool)} is annotated destructiveHint: true, so it must pass through ` +
          'the destructive guard — EPIC-069. Either it is additive and the ' +
          'annotation is wrong, or it destroys something and needs a plan, a ' +
          'permission and a confirmation.',
      ).toBe(true);
    }
  });

  /**
   * **The amendment, and what it does not relax — EPIC-117.**
   *
   * This control used to read "not read-only ⇒ destructive guard", and argued
   * its value was having no exceptions. The rule was right about every tool that
   * existed when it was written and wrong about the first tool that writes
   * something *additive*: `ferret_session_remember` records a sentence an agent
   * wants a later session to inherit, and putting it behind a human confirmation
   * would have made agent memory require a human per sentence — the capability
   * EPIC-117 exists to provide, removed by the control meant to protect it.
   *
   * So the control now keys on `destructiveHint`, which is the protocol's own
   * distinction and the one EPIC-069's gate is actually about. Nothing about a
   * destructive tool is relaxed: the gate, the annotation and the permission are
   * all still required, and a tool that writes must still say so. What is added
   * is that an additive tool must **declare itself** additive — silence is still
   * refused, because a client that cannot tell whether to prompt is the case
   * this file was written for.
   */
  it('declares destructiveHint either way on every non-read-only tool — §16', () => {
    // Ferret cannot enforce a human prompt; MCP's annotation is how it asks a
    // conforming client for one, and specification §16 records that the client's
    // approval UI is the client's control while the token is Ferret's.
    for (const tool of tools.filter((candidate) => !candidate.readOnly)) {
      expect(/destructiveHint:\s*(true|false)/.test(tool.body), label(tool)).toBe(true);
    }
  });

  it('never lets a tool claim to be both read-only and destructive', () => {
    for (const tool of tools) {
      expect(tool.readOnly && tool.destructive, label(tool)).toBe(false);
    }
  });

  it('names a permission at every tool call site — EPIC-068 AC-9', () => {
    for (const tool of tools) {
      expect(/Permission\.[A-Z_]+/.test(tool.body), label(tool)).toBe(true);
    }
  });

  it('names every tool that is not read-only, rather than assuming there are none', () => {
    // The measured state of `main`, pinned deliberately, so widening it is a
    // visible reviewable line in a diff rather than something that happens
    // quietly. EPIC-066 adds the first two; EPIC-067 adds the third.
    //
    // `ferret_provider_recover` is here because this test refused it as
    // read-only-adjacent and was right to. Its first draft argued a recovery is
    // not destructive — it re-runs an `initialize` the composition root already
    // registered — and took the plain guard. The control's contract is *not
    // read-only*, not "deletes something", and its value is having no
    // exceptions: a recovery does mutate what Ferret can do.
    expect(tools.filter((tool) => tool.destructive).map((tool) => tool.name)).toStrictEqual([
      'ferret_config_set',
      'ferret_config_unset',
      'ferret_provider_recover',
    ]);
  });

  it('names every additive tool too, so the second category is pinned as well', () => {
    // EPIC-117 adds the first tools that write without destroying. Pinned for
    // the same reason the destructive list is: growing this list should be a
    // visible line in a diff, and an additive tool that should have been
    // destructive is caught here rather than by a client that did not prompt.
    expect(
      tools.filter((tool) => !tool.readOnly && !tool.destructive).map((tool) => tool.name),
    ).toStrictEqual([
      // EPIC-128, and first because the list is in `readdir` order.
      // Recording durable context adds a row; a lifecycle transition writes one
      // column, destroys no observation, and archiving is reversible. Both are
      // additive in the protocol's sense and neither is ungoverned:
      // `ferret_context_record` needs `record`, and `ferret_context_lifecycle`
      // needs `mutate`, which nothing holds by default.
      'ferret_context_record',
      // EPIC-129. Promotion records what a session already decided; it adds
      // rows and rewrites no observation.
      'ferret_context_promote',
      'ferret_context_lifecycle',
      'ferret_session_start',
      'ferret_session_remember',
      'ferret_session_checkpoint',
      'ferret_session_end',
    ]);
  });

  it('checks the permission in one place rather than in each handler', () => {
    // EPIC-068 AC-9, restated as a source property now that the guards have moved
    // out of `server.ts`: a check a handler performs is a check a handler can
    // forget. `guards.ts` is the one place allowed to make it.
    for (const { file, source } of mcpSources()) {
      if (file === 'src/mcp/guards.ts') continue;
      expect(stripComments(source), file).not.toContain('assertPermitted(');
    }
  });

  it('consumes the confirmation gate only through the guard', () => {
    // No tool module may call `consume` for itself. If one did, the ordering
    // guarantee — authorization first, so a refused caller sees no plan — would be
    // restated per handler rather than held in one place.
    for (const { file, source } of mcpSources()) {
      if (file === 'src/mcp/guards.ts') continue;
      expect(stripComments(source), file).not.toContain('.consume(');
    }
  });
});
