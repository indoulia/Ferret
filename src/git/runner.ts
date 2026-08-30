import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';

/**
 * The single point at which Ferret executes `git`.
 *
 * Governance §12 forbids establishing unsafe subprocess primitives that later
 * Epics inherit, and every Git Epic after this one inherits whatever is built
 * here. So this module is written as though it were the only thing standing
 * between Ferret and a hostile repository — because for the next four Epics, it
 * is.
 *
 * Three distinct dangers, none of which is obvious:
 *
 * **The shell.** `exec('git -C ' + path + ' status')` runs a shell. A directory
 * named `foo; rm -rf ~` is then a command. Nothing here ever builds a command
 * string: `execFile` with an argument vector and `shell: false`, always.
 *
 * **The argument parser.** A directory named `--upload-pack=evil` is not a shell
 * problem — it is a *Git* problem, because Git will read it as an option. Paths
 * are resolved to absolute (so they begin with `/` or a drive letter) and are
 * passed positionally after `--` wherever the command accepts one.
 *
 * **Repository configuration.** This is the one people miss. Running `git`
 * inside a repository consults that repository's own `.git/config`, and several
 * configuration keys name *a program to run* — `core.hooksPath`,
 * `core.fsmonitor`, `core.pager`, `credential.helper`, `core.sshCommand`. A
 * repository Ferret cloned for indexing can therefore execute code simply by
 * being looked at. Every invocation here overrides those keys on the command
 * line, where they win over anything the repository says.
 *
 * What this module deliberately does **not** do is disable Git's
 * `safe.directory` ownership check. That check exists to protect against exactly
 * this class of attack, and Ferret surfaces its refusal as a reported state
 * rather than setting `safe.directory=*` to make an inconvenient error go away.
 */

/**
 * Configuration overrides applied to every invocation.
 *
 * Passed as `-c key=value` before the subcommand, which is the highest-precedence
 * layer Git has — it beats repository, global and system configuration. Each
 * entry disables a key whose value names a program.
 */
const SAFETY_CONFIG: readonly string[] = Object.freeze([
  // A hooks path pointing at a directory in the repository is the classic
  // "clone this and lose" vector. An empty value disables hook lookup.
  'core.hooksPath=',
  // The file-system monitor is a program Git starts to watch the worktree.
  'core.fsmonitor=false',
  // A pager is a program, and Ferret never pages anything.
  'core.pager=cat',
  // Credential helpers are programs. Ferret does no authenticated Git operation
  // in this Epic, and a helper being invoked at all would be a surprise.
  'credential.helper=',
  // Named by the repository, run by Git, for any transport that needs SSH.
  'core.sshCommand=',
  // `ext::` and `file::` transports run arbitrary commands by design.
  'protocol.ext.allow=never',
  'protocol.file.allow=user',
  // A clean/smudge filter is a program run over file contents.
  'filter.lfs.smudge=',
  'filter.lfs.clean=',
  'filter.lfs.process=',
  // Diff and merge drivers likewise name external programs.
  'diff.external=',
]);

/** Environment variables removed from what a Git subprocess inherits. */
const STRIPPED_ENV: readonly string[] = Object.freeze([
  // Any of these silently redirects Git at a different repository than the one
  // Ferret resolved, which would make every fact it reports attach to the wrong
  // entity.
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  // Config injection through the environment, equivalent to editing .git/config.
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  // Programs Git would run.
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PROXY_COMMAND',
]);

/** Environment variables set on every invocation. */
const FORCED_ENV: Readonly<Record<string, string>> = Object.freeze({
  // A repository that needs credentials must fail, not block a background index
  // on a prompt nobody is watching.
  GIT_TERMINAL_PROMPT: '0',
  // Ferret only ever reads. Taking a lock would make an index compete with the
  // developer working in the same repository.
  GIT_OPTIONAL_LOCKS: '0',
});

export interface GitRunOptions {
  /** Absolute path Git runs in. Passed as `-C`, never interpolated. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly logger?: Logger;
  /** Milliseconds before the process is killed. Default 30s. */
  readonly timeoutMs?: number;
  /** Bytes of stdout retained. Default 16 MiB. Default 64 KiB for stderr. */
  readonly maxBufferBytes?: number;
  /**
   * Whether a non-zero exit is an error.
   *
   * Some Git commands answer a *question* with their exit code — "is this a
   * repository" is exit 128 for "no". A caller asking such a question wants the
   * result, not an exception.
   */
  readonly allowFailure?: boolean;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/** Longest argument vector this module will assemble, as a sanity bound. */
const MAX_ARGUMENTS = 256;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Runs `git` with the given arguments.
 *
 * `args` is the subcommand and its arguments; the safety configuration and
 * `-C <cwd>` are prepended here so no caller can forget them. Every element is
 * passed to the OS verbatim as one argument — there is no parsing, quoting or
 * escaping step anywhere in the path, because there is no string to quote.
 *
 * @throws {FerretError} `E_DEPENDENCY_UNAVAILABLE` when Git is not installed,
 * `E_INTERRUPTED` on cancellation or timeout, `E_PROVIDER_INVALID` when Git
 * failed and `allowFailure` was not set.
 */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitResult> {
  if (!isAbsolute(options.cwd)) {
    // A relative path would resolve against whatever the process happens to be
    // in, which for a long-running server is not a knowable thing.
    throw new FerretError(ErrorCode.USAGE, 'Git must be run in an absolute directory', {
      details: { cwd: options.cwd },
      remediation: 'Resolve the path before passing it.',
    });
  }
  for (const argument of args) {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      // A NUL truncates the argument at the OS boundary, so what Git receives
      // is not what was inspected. Refusing is the only safe reading.
      throw new FerretError(ErrorCode.USAGE, 'A Git argument contains a null byte', {
        details: { argumentCount: args.length },
        remediation: 'Reject the path before it reaches the Git runner.',
      });
    }
  }

  const vector = [...SAFETY_CONFIG.flatMap((entry) => ['-c', entry]), '-C', options.cwd, ...args];
  if (vector.length > MAX_ARGUMENTS) {
    throw new FerretError(ErrorCode.USAGE, 'Git argument vector is longer than Ferret will assemble', {
      details: { length: vector.length, maximum: MAX_ARGUMENTS },
      remediation: 'Split the operation into smaller invocations.',
    });
  }

  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GitResult>((resolve, reject) => {
    const child = execFile(
      'git',
      vector,
      {
        // No shell. This is the property the rest of the module depends on.
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
        env: scrubEnvironment(process.env),
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const durationMs = performance.now() - started;
        const exitCode = child.exitCode ?? (error === null ? 0 : 1);

        options.logger?.trace(
          { operation: 'git.run', args: redactVector(args), cwd: options.cwd, exitCode, durationMs },
          'git invoked',
        );

        if (error === null) {
          resolve({ stdout, stderr, exitCode: 0, durationMs });
          return;
        }

        const failure = classify(error, stderr, args, options, durationMs);
        if (failure === undefined) {
          resolve({ stdout, stderr, exitCode, durationMs });
          return;
        }
        reject(failure);
      },
    );
  });
}

interface ExecFailure extends Error {
  readonly code?: string | number | null;
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
}

/**
 * Turns a subprocess failure into something an operator can act on.
 *
 * Returns `undefined` when the caller asked to be told about a non-zero exit
 * rather than to have it raised — several Git commands answer a question with
 * their exit code.
 */
function classify(
  error: ExecFailure,
  stderr: string,
  args: readonly string[],
  options: GitRunOptions,
  durationMs: number,
): FerretError | undefined {
  if (error.code === 'ENOENT') {
    return new FerretError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'The git executable was not found', {
      details: { operation: args[0] ?? 'git' },
      remediation: 'Install Git and ensure it is on PATH. Run `ferret doctor` to confirm.',
    });
  }

  if (options.signal.aborted) {
    return new FerretError(ErrorCode.INTERRUPTED, 'Git was cancelled', {
      details: { operation: args[0] ?? 'git', durationMs: Math.round(durationMs) },
      retryable: true,
    });
  }

  if (error.killed === true || error.signal === 'SIGTERM') {
    return new FerretError(
      ErrorCode.INTERRUPTED,
      `Git did not finish within ${String(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms and was stopped`,
      {
        details: { operation: args[0] ?? 'git', durationMs: Math.round(durationMs) },
        remediation: 'Raise the timeout, or narrow the operation. A repository under active rewrite can be slow.',
        retryable: true,
      },
    );
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new FerretError(ErrorCode.PROVIDER_INVALID, 'Git produced more output than Ferret will buffer', {
      details: { operation: args[0] ?? 'git', maximum: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER },
      remediation: 'Narrow the operation — page it, or bound it by count.',
    });
  }

  if (options.allowFailure === true) return undefined;

  // Git's own stderr is the most useful thing available, and it is content from
  // a repository Ferret does not trust, so it goes through the same redaction
  // as everything else before it is stored or shown. `FerretError` redacts its
  // message on construction.
  return new FerretError(ErrorCode.PROVIDER_INVALID, `git ${args[0] ?? ''} failed: ${firstLine(stderr)}`, {
    details: { operation: args[0] ?? 'git', durationMs: Math.round(durationMs) },
    remediation: 'Check that the path is a readable Git repository.',
  });
}

/**
 * The environment a Git subprocess receives.
 *
 * Inherit-then-remove rather than build-from-nothing: Git legitimately needs
 * `PATH`, `HOME`, `SystemRoot` and a dozen platform-specific variables, and a
 * hand-built environment would break in ways that are tedious to discover one
 * platform at a time. What is removed is the specific set that can redirect Git
 * at a different repository or name a program for it to run.
 */
export function scrubEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const name of STRIPPED_ENV) delete environment[name];
  return { ...environment, ...FORCED_ENV };
}

/** The safety overrides, exported so a test can assert they are actually applied. */
export const GIT_SAFETY_CONFIG = SAFETY_CONFIG;
/** The variables removed from a Git subprocess's environment. */
export const GIT_STRIPPED_ENV = STRIPPED_ENV;

/**
 * A logged argument vector.
 *
 * Arguments can carry a remote URL, and a remote URL frequently carries a
 * personal access token. `FerretError` redacts its message but a `trace` log
 * field is not a message, so it is redacted here.
 */
function redactVector(args: readonly string[]): readonly string[] {
  return args.map((argument) => argument.replace(/\/\/[^/@\s]+@/g, '//***@'));
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 0 ? line.slice(0, 500) : 'no detail on stderr';
}
