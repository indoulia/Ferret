import { readFileSync } from 'node:fs';
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
 */

const SERVER = fileURLToPath(new URL('../../src/mcp/server.ts', import.meta.url));

/** Block comments wholesale, line comments only when they start a line. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

interface Registration {
  readonly name: string;
  readonly readOnly: boolean;
  readonly body: string;
}

/**
 * Every `server.registerTool(...)` in the file, as name, annotation and body.
 *
 * Split rather than parsed: a chunk runs from one registration to the next, which
 * is exactly the text belonging to that tool. A real parser would be more precise
 * and would also be a second implementation of TypeScript in the test suite.
 */
function registrations(source: string): Registration[] {
  const chunks = stripComments(source).split('server.registerTool(');
  return chunks.slice(1).map((chunk) => {
    const name = /^\s*'([^']+)'/.exec(chunk)?.[1] ?? '<unnamed>';
    return {
      name,
      readOnly: /readOnlyHint:\s*true/.test(chunk),
      body: chunk,
    };
  });
}

describe('destructive MCP tools', () => {
  const source = readFileSync(SERVER, 'utf8');
  const tools = registrations(source);

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
      expect(/readOnlyHint:\s*(true|false)/.test(tool.body), tool.name).toBe(true);
    }
  });

  it('routes every non-read-only tool through the destructive guard — AC-12', () => {
    for (const tool of tools.filter((candidate) => !candidate.readOnly)) {
      expect(
        /guardDestructive\(|createDestructiveToolGuard\(/.test(tool.body),
        `${tool.name} is not annotated readOnlyHint: true, so it must pass through ` +
          'the destructive guard — EPIC-069. Either it is read-only and the ' +
          'annotation is wrong, or it changes something and needs a plan, a ' +
          'permission and a confirmation.',
      ).toBe(true);
    }
  });

  it('declares destructiveHint on every non-read-only tool — §16', () => {
    // Ferret cannot enforce a human prompt; MCP's annotation is how it asks a
    // conforming client for one, and specification §16 records that the client's
    // approval UI is the client's control while the token is Ferret's.
    for (const tool of tools.filter((candidate) => !candidate.readOnly)) {
      expect(/destructiveHint:\s*true/.test(tool.body), tool.name).toBe(true);
    }
  });

  it('names a permission at every tool call site — EPIC-068 AC-9', () => {
    for (const tool of tools) {
      expect(/Permission\.[A-Z_]+/.test(tool.body), tool.name).toBe(true);
    }
  });

  it('is currently all read-only, and says so rather than assuming it', () => {
    // The measured state of `main`, pinned deliberately. EPIC-069 §4 excludes
    // adding a destructive tool and EPIC-066 registers the first, so this
    // assertion is expected to be *changed* by that Epic — and changing it is a
    // visible, reviewable line in that diff rather than a silent widening.
    expect(tools.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toStrictEqual([]);
  });

  it('checks the permission in one place rather than in each handler', () => {
    // EPIC-068 AC-9, restated as a source property now that the guards have moved
    // out of this file: a check a handler performs is a check a handler can
    // forget, and `server.ts` must not perform one itself.
    expect(stripComments(source)).not.toContain('assertPermitted(');
  });

  it('consumes the confirmation gate only through the guard', () => {
    // `server.ts` must not call `consume` for itself either. If it did, the
    // ordering guarantee — authorization first, so a refused caller sees no plan —
    // would be restated in each handler rather than held in one place.
    expect(stripComments(source)).not.toContain('.consume(');
  });
});
