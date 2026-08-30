import { describe, expect, it } from 'vitest';

import { ExitCode } from '../../src/cli/exit-codes.js';
import { run } from '../../src/cli/main.js';
import { PLANNED_COMMANDS } from '../../src/cli/commands/planned.js';
import { VERSION } from '../../src/index.js';

interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(...args: string[]): Promise<Invocation> {
  let stdout = '';
  let stderr = '';
  const code = await run({
    argv: ['node', 'ferret', ...args],
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('help', () => {
  it('lists usage on stdout and exits 0', async () => {
    const result = await invoke('--help');
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain('Usage: ferret');
    expect(result.stdout).toContain('--json');
  });

  it('prints help for a bare invocation without treating it as a failure', async () => {
    const result = await invoke();
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain('Usage: ferret');
  });

  it('advertises every implemented and planned command', async () => {
    const { stdout } = await invoke('--help');
    expect(stdout).toContain('version');
    expect(stdout).toContain('env');
    for (const command of PLANNED_COMMANDS) expect(stdout).toContain(command.name);
  });

  it('marks planned commands as planned, with the Epic that owns each', async () => {
    const { stdout } = await invoke('--help');
    for (const command of PLANNED_COMMANDS) {
      expect(stdout).toContain('planned');
      for (const owner of command.owners) expect(stdout).toContain(owner);
    }
  });
});

describe('version', () => {
  it('prints the version via the flag and exits 0', async () => {
    const result = await invoke('--version');
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain(VERSION);
  });

  it('prints structured version information as JSON', async () => {
    const result = await invoke('version', '--json');
    expect(result.code).toBe(ExitCode.OK);

    const payload = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.data).toMatchObject({ version: VERSION, node: process.versions.node });
  });

  it('emits nothing on stderr on the success path', async () => {
    expect((await invoke('version')).stderr).toBe('');
  });
});

describe('env', () => {
  it('reports environment facts and resolved configuration as JSON', async () => {
    const result = await invoke('env', '--json');
    expect(result.code).toBe(ExitCode.OK);

    const payload = JSON.parse(result.stdout) as { ok: boolean; data: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.data).toHaveProperty('node');
    expect(payload.data).toHaveProperty('git');
    expect(payload.data).toHaveProperty('config');
    expect(payload.data).toHaveProperty('providers');
  });

  it('produces exactly one JSON document on stdout', async () => {
    const { stdout } = await invoke('env', '--json');
    expect(() => {
      JSON.parse(stdout);
    }).not.toThrow();
  });
});

describe('planned commands', () => {
  it.each(PLANNED_COMMANDS.map((command) => command.name))(
    'fails `%s` with E_NOT_IMPLEMENTED and exit code 5',
    async (name) => {
      const result = await invoke(name);
      expect(result.code).toBe(ExitCode.NOT_IMPLEMENTED);
      expect(result.stderr).toContain('E_NOT_IMPLEMENTED');
      expect(result.stdout).toBe('');
    },
  );

  it('names the owning Epic so the response is actionable', async () => {
    const result = await invoke('status', '--json');
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      error: { code: string; details: { plannedIn: string[] } };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('E_NOT_IMPLEMENTED');
    expect(payload.error.details.plannedIn).toContain('EPIC-004');
  });

  it('does nothing silently — every planned command reports its status', async () => {
    for (const command of PLANNED_COMMANDS) {
      const result = await invoke(command.name);
      expect(result.code).not.toBe(ExitCode.OK);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });
});

describe('usage errors', () => {
  it('exits 2 for an unknown command', async () => {
    const result = await invoke('definitely-not-a-command');
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain('unknown command');
  });

  it('exits 2 for an unknown option', async () => {
    expect((await invoke('version', '--nope')).code).toBe(ExitCode.USAGE);
  });

  it('exits 2 for an invalid option value', async () => {
    const result = await invoke('--log-level', 'chatty', 'version');
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain('Allowed choices');
  });

  it('exits 2 for a missing option argument', async () => {
    expect((await invoke('--log-level')).code).toBe(ExitCode.USAGE);
  });

  it('reports a usage error as JSON when --json is requested', async () => {
    const result = await invoke('--json', 'definitely-not-a-command');
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('E_USAGE');
  });
});

describe('exit code contract', () => {
  it('assigns a distinct value to every documented outcome', () => {
    const values = Object.values(ExitCode);
    expect(new Set(values).size).toBe(values.length);
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.INTERRUPTED).toBe(130);
    expect(ExitCode.TERMINATED).toBe(143);
  });
});
