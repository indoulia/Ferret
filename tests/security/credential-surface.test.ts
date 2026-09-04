import type * as ChildProcessModule from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * **No credential Ferret holds leaves this process — F-71.**
 *
 * `CREDENTIAL_ENV` named three variables. `FERRET_DATABASE_URL` was not one of
 * them, while two other modules read that variable *as a credential* and one of
 * them redacts it before printing. So the same value was a secret in
 * `storage/export.ts` and ordinary inheritance in `git/runner.ts`, and every
 * `git log` Ferret ran on a machine configured that way carried the database
 * password into a subprocess tree.
 *
 * Adding one name to the list closes that instance and nothing else. The list is
 * an enumeration, and this audit has now watched an enumeration fail towards
 * exposure four times — a prose allowlist keyed by attribute name (F-64), a
 * traversal that descended only into what it recognised (F-64), a notice test
 * carrying a hand-written list of tools (F-66), and eleven configuration keys
 * chosen for one property while a twelfth changed another (F-94). So the tests
 * below deliberately do **not** stop at the names Ferret knows: a variable named
 * by a secret reference the operator invented, a variable whose *value* is a
 * connection URL, and a variable whose name simply reads as a credential each
 * have to be handled by a rule rather than by a list.
 *
 * The boundary is the environment object handed to `execFile` and `spawn` — the
 * last thing Ferret controls and byte-for-byte what the operating system gives
 * the child. It is captured here by wrapping those two functions and calling
 * through to the real ones, so every assertion below is made about a `git`
 * process that actually ran.
 */

interface Started {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

const started: Started[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();

  const record = (file: string, args: unknown, options: unknown): void => {
    const environment = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    // `env: undefined` means "inherit everything", which is the defect this file
    // exists to catch. Recorded as the parent environment so an assertion sees
    // what the child would actually have received.
    started.push({
      file,
      args: Array.isArray(args) ? (args as string[]) : [],
      env: environment ?? process.env,
    });
  };

  const execFile = ((...parameters: unknown[]) => {
    record(parameters[0] as string, parameters[1], parameters[2]);
    return (actual.execFile as (...rest: unknown[]) => ChildProcess)(...parameters);
  }) as typeof actual.execFile;

  // `detectGit` uses `promisify(execFile)`, which resolves through this symbol.
  // Without it the wrapper is invisible to that call site — which is the one
  // that had the defect EPIC-100 found.
  const originalPromisified = (
    actual.execFile as unknown as Record<symbol, ((...rest: unknown[]) => Promise<unknown>) | undefined>
  )[promisify.custom];
  if (originalPromisified === undefined) throw new Error('execFile has no promisify.custom to wrap');
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: unknown) => {
      record(file, args, options);
      return originalPromisified(file, args, options);
    },
  });

  const spawn = ((...parameters: unknown[]) => {
    record(parameters[0] as string, parameters[1], parameters[2]);
    return (actual.spawn as (...rest: unknown[]) => ChildProcess)(...parameters);
  }) as typeof actual.spawn;

  return { ...actual, execFile, spawn, default: { ...actual, execFile, spawn } };
});


const { readBlob } = await import('../../src/git/files.js');
const { readHistory } = await import('../../src/git/history.js');
const { runGit, scrubEnvironment } = await import('../../src/git/runner.js');
const { detectGit } = await import('../../src/environment/detect.js');
const { ErrorCode, FerretError } = await import('../../src/errors/index.js');
const { redactString } = await import('../../src/errors/redact.js');
const credentials = await import('../../src/security/credentials.js');
const { resolveSecretRef } = await import('../../src/config/secret-ref.js');
const { createRepository, createWorkspace, git, gitVersion } = await import('../support/git-fixtures.js');

const version = await gitVersion();
const describeGit = version === undefined ? describe.skip : describe;

/**
 * Long and unique on purpose.
 *
 * Value-based stripping and value-based redaction both carry a minimum length,
 * because a four-character password would otherwise delete the word from every
 * diagnostic that happened to contain it. A test that used a short value would
 * be asserting the floor rather than the rule.
 */
const PASSWORD = 'ferret-f71-password-9f3a7c1e4b';
const URL_CREDENTIAL = `postgres://ferret:${PASSWORD}@db.example:5432/ferret`;

let workspace: { path: string; cleanup: () => Promise<void> };
let repository: string;
let blobOid: string;

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** Sets variables on the parent environment for the duration of one body. */
async function withEnvironment(
  variables: Readonly<Record<string, string>>,
  body: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Every environment a child was actually started with since the last reset. */
function environmentsSeen(): readonly NodeJS.ProcessEnv[] {
  return started.map((entry) => entry.env);
}

beforeAll(async () => {
  workspace = await createWorkspace('ferret-cred-surface-');
  repository = await createRepository(workspace.path, 'target', { commit: false });
  await writeFile(join(repository, 'file.txt'), 'contents\n', 'utf8');
  await git(repository, ['add', 'file.txt']);
  await git(repository, ['commit', '-m', 'only commit']);
  blobOid = (await git(repository, ['rev-parse', 'HEAD:file.txt'])).trim();
}, 60_000);

afterEach(() => {
  started.length = 0;
});

afterAll(async () => {
  await workspace?.cleanup();
});

/**
 * The variables a machine running Ferret can plausibly have set, and what has
 * to happen to each.
 *
 * Written as one table because the failure mode is *asymmetric*: getting a
 * credential wrong leaks it, and getting a non-credential wrong removes the
 * diagnostic that makes a failure explicable. Both halves are asserted from the
 * same place so neither can be improved at the other's expense.
 */
const SURFACE: readonly { name: string; value: string; stripped: boolean; why: string }[] = [
  { name: 'FERRET_DATABASE_PASSWORD', value: PASSWORD, stripped: true, why: 'Ferret’s own password input' },
  { name: 'FERRET_DATABASE_URL', value: URL_CREDENTIAL, stripped: true, why: 'F-71: the same password, in a URL' },
  { name: 'PGPASSWORD', value: PASSWORD, stripped: true, why: 'pg’s password variable' },
  { name: 'PGPASSFILE', value: '/home/u/.pgpass', stripped: true, why: 'names a file of passwords' },
  { name: 'PGSERVICEFILE', value: '/home/u/.pg_service.conf', stripped: true, why: 'a service file carries a password' },
  { name: 'PGSSLKEY', value: '/home/u/.postgresql/postgresql.key', stripped: true, why: 'a private key' },
  { name: 'DATABASE_URL', value: URL_CREDENTIAL, stripped: true, why: 'shape: a URL carrying a password' },
  { name: 'SOME_VENDOR_API_TOKEN', value: 'a-token-nobody-here-registered', stripped: true, why: 'shape: the name reads as a credential' },
  { name: 'ANONYMOUS_HOLDER', value: PASSWORD, stripped: true, why: 'value: it is the password, under a name nothing lists' },

  { name: 'PATH', value: process.env['PATH'] ?? '/usr/bin', stripped: false, why: 'git cannot run without it' },
  { name: 'FERRET_DATABASE_HOST', value: 'db.example', stripped: false, why: 'not a credential; useful in a diagnostic' },
  { name: 'FERRET_DATABASE_USER', value: 'ferret', stripped: false, why: 'not a credential' },
  { name: 'FERRET_DATABASE_PORT', value: '5432', stripped: false, why: 'not a credential' },
  { name: 'FERRET_DATABASE_NAME', value: 'ferret', stripped: false, why: 'not a credential' },
  { name: 'FERRET_LOG_LEVEL', value: 'debug', stripped: false, why: 'not a credential' },
  { name: 'LANG', value: 'en_GB.UTF-8', stripped: false, why: 'not a credential' },
];

describe('the credential-bearing environment surface, enumerated', () => {
  it.each(SURFACE)('$name — $why', ({ name, value, stripped }) => {
    credentials.registerCredentialValue(PASSWORD);
    const scrubbed = credentials.withoutCredentials({ [name]: value, PATH: '/usr/bin' });

    expect(name in scrubbed, `${name} should ${stripped ? '' : 'not '}be removed`).toBe(!stripped);
  });

  it('leaves nothing of a stripped variable behind in the values it keeps', () => {
    credentials.registerCredentialValue(PASSWORD);
    const scrubbed = credentials.withoutCredentials({
      FERRET_DATABASE_URL: URL_CREDENTIAL,
      PATH: '/usr/bin',
      HOME: '/home/u',
    });

    expect(JSON.stringify(scrubbed)).not.toContain(PASSWORD);
    expect(scrubbed['PATH']).toBe('/usr/bin');
    expect(scrubbed['HOME']).toBe('/home/u');
  });

  it('removes a variable a secret reference named, whatever the operator called it', () => {
    // The case a list cannot cover. `{ "$secret": { "env": "MY_OWN_NAME" } }` is
    // a supported configuration, so the set of credential-bearing variable names
    // is decided by the operator at run time and cannot be written down here.
    const name = 'AN_OPERATOR_INVENTED_THIS_NAME';
    expect(resolveSecretRef({ $secret: { env: name } }, { [name]: PASSWORD })).toBe(PASSWORD);

    const scrubbed = credentials.withoutCredentials({ [name]: 'some-other-value', PATH: '/usr/bin' });

    expect(name in scrubbed).toBe(false);
    expect(scrubbed['PATH']).toBe('/usr/bin');
  });

  it('registers what a file-backed secret reference resolved, not only an env-backed one', () => {
    const resolved = resolveSecretRef({ $secret: { file: '/run/secrets/db' } }, {}, () => `${PASSWORD}\n`);

    expect(resolved).toBe(PASSWORD);
    expect(credentials.knownCredentialValues()).toContain(PASSWORD);
  });
});

describeGit('a git subprocess is started without any of them', () => {
  const hostile = {
    FERRET_DATABASE_PASSWORD: PASSWORD,
    FERRET_DATABASE_URL: URL_CREDENTIAL,
    PGPASSWORD: PASSWORD,
    DATABASE_URL: URL_CREDENTIAL,
    ANONYMOUS_HOLDER: PASSWORD,
    SOME_VENDOR_API_TOKEN: 'a-token-nobody-here-registered',
    FERRET_DATABASE_HOST: 'db.example',
  };

  function expectCleanEnvironments(label: string): void {
    const environments = environmentsSeen();
    expect(environments.length, `${label}: nothing was started`).toBeGreaterThan(0);

    for (const environment of environments) {
      for (const name of Object.keys(hostile)) {
        if (name === 'FERRET_DATABASE_HOST') continue;
        expect(environment[name], `${label}: ${name} reached the child`).toBeUndefined();
      }
      expect(JSON.stringify(environment), `${label}: the value reached the child`).not.toContain(PASSWORD);
      // Preserved, because a subprocess environment stripped of everything is a
      // different defect: `git` needs PATH, and an operator debugging a failure
      // needs to see the connection it was configured with.
      expect(environment['PATH'], `${label}: PATH was removed`).toBeDefined();
      expect(environment['FERRET_DATABASE_HOST'], `${label}: a non-secret was removed`).toBe('db.example');
    }
  }

  it('readHistory — execFile', async () => {
    credentials.registerCredentialValue(PASSWORD);
    await withEnvironment(hostile, async () => {
      const page = await readHistory({ cwd: repository, signal: signal(), withChanges: true });
      expect(page.commits).toHaveLength(1);
    });

    expectCleanEnvironments('readHistory');
  });

  it('readBlob — spawn', async () => {
    credentials.registerCredentialValue(PASSWORD);
    await withEnvironment(hostile, async () => {
      const blob = await readBlob({ cwd: repository, signal: signal(), oid: blobOid, maxBytes: 4096 });
      expect(blob.read).toBe(true);
    });

    expectCleanEnvironments('readBlob');
  });

  it('detectGit — promisified execFile, the call site that had no env at all', async () => {
    credentials.registerCredentialValue(PASSWORD);
    await withEnvironment(hostile, async () => {
      await detectGit();
    });

    expectCleanEnvironments('detectGit');
  });

  it('every child started in this file was started with an explicit environment', () => {
    // Failing closed. `env: undefined` is recorded as the parent environment, so
    // a spawner that forgets to pass one is caught by the assertions above
    // rather than passing because nothing was recorded.
    expect(scrubEnvironment({ FERRET_DATABASE_URL: URL_CREDENTIAL })['FERRET_DATABASE_URL']).toBeUndefined();
  });
});

describeGit('a credential cannot be handed to a child as an argument', () => {
  it('refuses an argument carrying a registered credential value', async () => {
    credentials.registerCredentialValue(PASSWORD);

    // argv is readable by other processes on every platform Ferret supports, so
    // this is a disclosure whether or not the child reads it.
    await expect(
      runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${PASSWORD}`], {
        cwd: repository,
        signal: signal(),
        allowFailure: true,
      }),
    ).rejects.toThrow(/credential/iu);

    expect(started, 'the process was started anyway').toHaveLength(0);
  });

  it('names no value when it refuses', async () => {
    credentials.registerCredentialValue(PASSWORD);
    try {
      await runGit(['rev-parse', PASSWORD], { cwd: repository, signal: signal(), allowFailure: true });
      expect.unreachable('the argument should have been refused');
    } catch (error) {
      expect(FerretError.is(error)).toBe(true);
      expect(JSON.stringify((error as InstanceType<typeof FerretError>).toJSON())).not.toContain(PASSWORD);
    }
  });

  it('still runs an ordinary argument that merely resembles one', async () => {
    credentials.registerCredentialValue(PASSWORD);

    const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: repository,
      signal: signal(),
      allowFailure: true,
    });

    expect(result.stdout.trim()).toHaveLength(40);
  });
});

describe('a credential cannot reach a log line, an error envelope or a command string', () => {
  it('removes a registered credential from any string that leaves the process', () => {
    credentials.registerCredentialValue(PASSWORD);

    const redacted = redactString(`git failed: could not connect using ${PASSWORD} to db.example`);

    expect(redacted).not.toContain(PASSWORD);
    // The diagnostic survives. Replacing the whole line would solve the leak by
    // removing the only thing that makes the failure explicable.
    expect(redacted).toContain('db.example');
    expect(redacted).toContain('git failed');
  });

  it('removes it from an error envelope, message and details alike', () => {
    credentials.registerCredentialValue(PASSWORD);

    const error = new FerretError(ErrorCode.PROVIDER_INVALID, `git log failed: ${PASSWORD}`, {
      details: { operation: 'log', connection: URL_CREDENTIAL },
    });

    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain(PASSWORD);
    expect(error.message).not.toContain(PASSWORD);
    // Still says which operation failed.
    expect(serialized).toContain('log');
  });

  it('keeps the parts of a connection URL that are not the secret', () => {
    const redacted = redactString(URL_CREDENTIAL);

    expect(redacted).not.toContain(PASSWORD);
    expect(redacted).toContain('db.example');
    expect(redacted).toContain('ferret');
    expect(redacted).toContain('postgres://');
  });
});

describeGit('what git writes about itself is redacted before Ferret repeats it', () => {
  it('does not repeat a credential Git echoed on stderr', async () => {
    credentials.registerCredentialValue(PASSWORD);

    // Git echoes an unknown revision back on stderr. The value here is not a
    // registered credential, so it reaches the classifier exactly as a remote
    // URL bearing a token would.
    await expect(
      runGit(['rev-parse', '--verify', 'refs/heads/https://user:tok3n-in-a-url@example.com'], {
        cwd: repository,
        signal: signal(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const text = JSON.stringify((error as InstanceType<typeof FerretError>).toJSON());
      return !text.includes('tok3n-in-a-url');
    });
  });

  it('reports an incomplete read without losing the reason it was incomplete', async () => {
    // `incomplete.reason` is Git's stderr, and it now passes through the same
    // redaction as every other string that leaves the process. The assertion
    // that matters is the *other* direction: redaction must not empty it. A
    // page that says it is incomplete and cannot say why is worse than one that
    // says nothing, because a caller then has no way to tell a corrupt object
    // from a bug in Ferret.
    //
    // Driven through real Git: an object deleted from the middle of a history,
    // so Git streams the newer commits and *then* exits non-zero. A commit with
    // a merely missing parent is not enough — Git fails before flushing
    // anything, and an empty stdout is the "no history here" branch rather than
    // this one. Measured, after the first version of this test asserted the
    // wrong branch and passed nothing.
    const corrupt = await createRepository(workspace.path, 'corrupt');
    for (let index = 0; index < 10; index += 1) {
      await git(corrupt, ['commit', '-q', '--allow-empty', '-m', `commit ${String(index)}`]);
    }
    const all = (await git(corrupt, ['log', '--format=%H']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const missing = all[5] ?? '';
    rmSync(join(corrupt, '.git', 'objects', missing.slice(0, 2), missing.slice(2)), { force: true });

    const page = await readHistory({ cwd: corrupt, signal: signal() });

    expect(page.incomplete, 'Git failed part-way and the page did not say so').toBeDefined();
    expect(page.incomplete?.reason ?? '', 'redaction emptied the diagnostic').not.toBe('');
    expect(page.incomplete?.reason ?? '').toMatch(/object|fatal|error/iu);
    expect(page.commits.length, 'the commits Git did stream were thrown away').toBeGreaterThan(0);
  }, 120_000);
});
