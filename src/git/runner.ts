import { execFile, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { ErrorCode, FerretError, redactString } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { carriesRefusableCredential } from '../security/credentials.js';
import { GIT_ENVIRONMENT_STRIPPED, scrubEnvironment } from '../security/subprocess.js';

/**
 * Re-exported, not redefined.
 *
 * The child-environment policy moved to `security/subprocess.ts` so that
 * `environment/detect.ts` could share it without the core importing `git/`.
 * These export paths are unchanged for every caller and every test.
 */
export { scrubEnvironment };

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
 * layer Git has — it beats repository, global and system configuration, and it
 * beats every path a repository can reach one through: `include.path`,
 * `includeIf`, and the `config.worktree` file `extensions.worktreeConfig` turns
 * on. Each of those was measured rather than assumed; see
 * `tests/security/git-output-integrity.test.ts`.
 *
 * **Two properties, not one — F-94.** The first eleven entries disable a key
 * whose value *names a program*, which is what this list was written for. That
 * is half the threat. A key that changes the **shape of Git's output** needs no
 * program: it rewrites the stream Ferret's parser is reading, and the parser
 * reports whatever it makes of the result as fact. `i18n.logOutputEncoding=UTF-16`
 * re-encodes the whole of `git log`'s output, and against the version this was
 * found in that produced a fabricated commit under a SHA the repository chose.
 *
 * A pin is still an enumeration, and this audit has watched enumerations fail
 * four times. So it is not the only defence: `parseHistoryOutput` counts every
 * region of Git's output it cannot read and `readHistory` reports the page as
 * incomplete, which catches the key nobody has found yet by its *effect* rather
 * than by its name.
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
  // Signature verification runs `gpg.program`, which the repository names. This
  // is a *program* vector the first eleven entries missed, found by re-auditing
  // F-94 rather than by the report: `log.showSignature=true` plus a
  // `gpg.program` in `.git/config` executes it on every `git log`, on Windows
  // too. Pinning `showSignature` closes it without pinning `gpg.program`, since
  // nothing else Ferret runs verifies a signature — and an empty `gpg.program`
  // would make Git try to execute the empty string.
  'log.showSignature=false',

  // Output shape. Everything below decides what Git's output *looks like*
  // rather than what it runs — F-94.
  //
  // Both encodings re-encode the entire `git log` stream, including the NUL
  // separators `-z` and the record marker depend on. Measured: nine commits in,
  // zero out, with no error.
  'i18n.logOutputEncoding=UTF-8',
  'i18n.commitEncoding=UTF-8',
  // Path shape. Inert for the readers Ferret has today — they all pass `-z`,
  // which suppresses quoting — and pinned so a reader added later inherits a
  // shape the repository does not choose.
  'core.quotePath=false',
  // `diff.relative=true` truncates `--name-status` paths to the directory Git
  // was run in. Ferret runs at the repository root, so it is inert today and
  // would silently produce a *wrong* path rather than no path if that changed.
  'diff.relative=false',
]);

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
 * The argument vector Git is actually given, with its safety overrides.
 *
 * Shared by every entry point in this module, so that adding one cannot lose
 * them. Both `runGit` and `runGitBytes` build their vector here and nowhere
 * else.
 */
function gitVector(args: readonly string[], cwd: string): readonly string[] {
  if (!isAbsolute(cwd)) {
    // A relative path would resolve against whatever the process happens to be
    // in, which for a long-running server is not a knowable thing.
    throw new FerretError(ErrorCode.USAGE, 'Git must be run in an absolute directory', {
      details: { cwd },
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
    if (carriesRefusableCredential(argument)) {
      // An argument vector is readable by other processes on every platform
      // Ferret supports — `/proc/<pid>/cmdline`, `ps`, Windows' process list —
      // so passing a credential here discloses it whether or not the child
      // reads it. Refusing rather than redacting, because a redacted argument
      // is a *different argument* and Git would act on it.
      //
      // Only values Ferret resolved as its own credentials, and only from
      // twelve characters up: the consequence is a stopped index, and a
      // coincidence is what would stop it. See `MIN_REFUSABLE_VALUE`.
      throw new FerretError(ErrorCode.USAGE, 'A Git argument carries a credential Ferret holds', {
        details: { argumentCount: args.length, operation: args[0] ?? 'git' },
        remediation: 'Pass the object id or ref a previous read returned, never a configured secret.',
      });
    }
  }
  if (carriesRefusableCredential(cwd)) {
    throw new FerretError(ErrorCode.USAGE, 'A Git working directory carries a credential Ferret holds', {
      details: { operation: args[0] ?? 'git' },
      remediation: 'Index a path that does not contain a configured secret.',
    });
  }

  const vector = [...SAFETY_CONFIG.flatMap((entry) => ['-c', entry]), '-C', cwd, ...args];
  if (vector.length > MAX_ARGUMENTS) {
    throw new FerretError(ErrorCode.USAGE, 'Git argument vector is longer than Ferret will assemble', {
      details: { length: vector.length, maximum: MAX_ARGUMENTS },
      remediation: 'Split the operation into smaller invocations.',
    });
  }

  return vector;
}

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
  const vector = gitVector(args, options.cwd);
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

/** Bytes of stderr retained by {@link runGitBytes}. */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * How a byte-bounded read ended.
 *
 * `truncated` is a discriminated *result* rather than an exception, because a
 * blob over the bound is a fact about the repository and not a fault, and
 * EPIC-108 §8.8 counts it separately from a read that failed. Everything that
 * genuinely went wrong — Git missing, cancellation, a timeout — still throws.
 */
export interface GitBytesResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /** Output passed `maxOutputBytes`; the child was killed and `stdout` is partial. */
  readonly truncated: boolean;
}

export interface GitBytesOptions extends Omit<GitRunOptions, 'maxBufferBytes' | 'allowFailure'> {
  /**
   * Bytes of stdout retained before the child is killed.
   *
   * Applied to the accumulating chunks, so the process is stopped as soon as it
   * is passed and nothing larger is ever held. EPIC-108 §8.3: a caller that
   * receives 400 MB in order to reject it has already paid the cost the bound
   * exists to avoid.
   */
  readonly maxOutputBytes: number;
}

/**
 * Runs `git` and keeps its stdout as bytes, under a hard output bound.
 *
 * Separate from {@link runGit} because {@link runGit} decodes as UTF-8, and a
 * repository holds files that are not UTF-8: a Latin-1 source file, a file with
 * a lone surrogate, a file with a NUL in it. Decoding those and re-encoding them
 * would hand a parser bytes the repository does not contain, and would change
 * what a content hash is computed over. `git cat-file` output is content, so it
 * is never decoded here.
 *
 * `spawn` rather than `execFile` for one reason: `execFile`'s `maxBuffer` kills
 * the child with a generic error that cannot be told apart from a real failure,
 * and this caller has to distinguish "too large" from "broken". Everything that
 * makes {@link runGit} safe is applied identically — the same argument vector
 * through `gitVector`, the same scrubbed environment, no shell — so this is a
 * second *encoding*, not a second subprocess primitive.
 *
 * @throws {FerretError} `E_DEPENDENCY_UNAVAILABLE` when Git is not installed,
 * `E_INTERRUPTED` on cancellation or timeout.
 */
export async function runGitBytes(
  args: readonly string[],
  options: GitBytesOptions,
): Promise<GitBytesResult> {
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new FerretError(ErrorCode.USAGE, 'A byte-bounded Git read needs a positive bound', {
      details: { maxOutputBytes: options.maxOutputBytes },
      remediation: 'Pass a positive integer byte bound.',
    });
  }

  const vector = gitVector(args, options.cwd);
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GitBytesResult>((resolve, reject) => {
    const child = spawn('git', [...vector], {
      shell: false,
      windowsHide: true,
      env: scrubEnvironment(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;

    // `SIGKILL` is right even though it is blunt: the child is a `cat-file`
    // read, it holds no lock (`GIT_OPTIONAL_LOCKS=0`), and by the time this is
    // called it has either been cancelled or produced more than Ferret accepts.
    const stop = (): void => {
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const onAbort = (): void => {
      stop();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      outcome();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxOutputBytes - size;
      if (chunk.length > room) {
        // Keep exactly the bound and not one byte more, then stop the child.
        // The partial buffer is kept rather than discarded so a caller can say
        // how far it got, and so the bound is provably never exceeded.
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          size += room;
        }
        truncated = true;
        stop();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      // Bounded independently and small: stderr is a diagnostic, and a Git
      // command that writes megabytes to it is itself the problem.
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(
            new FerretError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'The git executable was not found', {
              details: { operation: args[0] ?? 'git' },
              remediation: 'Install Git and ensure it is on PATH. Run `ferret doctor` to confirm.',
            }),
          );
          return;
        }
        reject(
          new FerretError(ErrorCode.PROVIDER_INVALID, `git ${args[0] ?? ''} could not be started`, {
            details: { operation: args[0] ?? 'git' },
            cause: error,
          }),
        );
      });
    });

    child.on('close', (code: number | null) => {
      const durationMs = performance.now() - started;
      finish(() => {
        options.logger?.trace(
          {
            operation: 'git.run',
            args: redactVector(args),
            cwd: options.cwd,
            exitCode: code ?? -1,
            bytes: size,
            truncated,
            durationMs,
          },
          'git invoked',
        );

        // Cancellation and the timeout are answered before the bound, because a
        // child killed for either also looks truncated, and a cancelled run must
        // fail rather than quietly report a short read.
        if (options.signal.aborted) {
          reject(
            new FerretError(ErrorCode.INTERRUPTED, 'Git was cancelled', {
              details: { operation: args[0] ?? 'git', durationMs: Math.round(durationMs) },
              retryable: true,
            }),
          );
          return;
        }
        if (timedOut) {
          reject(
            new FerretError(
              ErrorCode.INTERRUPTED,
              `Git did not finish within ${String(timeoutMs)}ms and was stopped`,
              {
                details: { operation: args[0] ?? 'git', durationMs: Math.round(durationMs) },
                remediation: 'Raise the timeout, or narrow the operation.',
                retryable: true,
              },
            ),
          );
          return;
        }

        resolve({
          stdout: concat(chunks, size),
          stderr,
          // A child killed for passing the bound has no meaningful exit code;
          // `truncated` is what a caller reads, and the code is reported as Git
          // left it.
          exitCode: code ?? (truncated ? 0 : 1),
          durationMs,
          truncated,
        });
      });
    });
  });
}

function concat(chunks: readonly Buffer[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
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

/** The safety overrides, exported so a test can assert they are actually applied. */
export const GIT_SAFETY_CONFIG = SAFETY_CONFIG;
/** The variables removed from a Git subprocess's environment. */
export const GIT_STRIPPED_ENV = GIT_ENVIRONMENT_STRIPPED;

/**
 * A logged argument vector.
 *
 * Arguments can carry a remote URL, and a remote URL frequently carries a
 * personal access token. `FerretError` redacts its message but a `trace` log
 * field is not a message, so it is redacted here.
 *
 * Through the same `redactString` every error and log line uses, rather than the
 * one URL-userinfo expression that used to be here — F-71. That expression knew
 * about `//user:token@` and nothing else, so a token in any other position, and
 * a credential Ferret itself resolved, were both written out verbatim.
 */
function redactVector(args: readonly string[]): readonly string[] {
  return args.map((argument) => redactString(argument));
}

export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 0 ? line.slice(0, 500) : 'no detail on stderr';
}
