import { readFileSync } from 'node:fs';

import { ErrorCode, FerretError } from '../errors/index.js';
import { registerCredentialValue, registerCredentialVariable } from '../security/credentials.js';

/**
 * Secret references.
 *
 * A user should be able to configure Ferret without writing a password into a
 * file at all. A secret reference stores *where the secret is* instead of what
 * it is:
 *
 * ```json
 * { "password": { "$secret": { "env": "FERRET_PG_PASSWORD" } } }
 * { "password": { "$secret": { "file": "/run/secrets/ferret-db" } } }
 * ```
 *
 * The object form is deliberate. A string convention such as `"env:VAR"` cannot
 * be distinguished from a literal password that happens to start with `env:`,
 * and guessing wrong either leaks a secret or silently uses the wrong one.
 *
 * References are resolved once, at configuration resolution, so no later code
 * has to know a value was indirect. An unresolvable reference is a hard error —
 * falling back to an empty password would turn a misconfiguration into a
 * confusing authentication failure much further away.
 *
 * **The source is a registration, not a branch — EPIC-081 §8.3.** `env` and
 * `file` are two {@link SecretResolver}s against one seam rather than two arms
 * of one `if`. Four approved records park "OS keychain, vault or credential
 * store" on EPIC-081, and the shape of that work is a third registration and no
 * change to `databaseConfigSchema`. That the seam admits a third source without
 * a schema change is EPIC-081 AC-5; which backend fills it is deferred under
 * §16-3, because a Windows keychain binding is a native module and Ferret's
 * eight runtime dependencies contain none.
 */

/** Property that marks an object as a secret reference. */
export const SECRET_REF_KEY = '$secret';

export interface EnvironmentSecretRef {
  readonly env: string;
}

export interface FileSecretRef {
  readonly file: string;
}

/**
 * The body of a reference: exactly one source name, and where in it to look.
 *
 * `env` and `file` are named for the callers that construct them by hand; the
 * index signature is what lets a registered third source be written without
 * this type changing.
 */
export type SecretRefBody = EnvironmentSecretRef | FileSecretRef | Readonly<Record<string, string>>;

export interface SecretRef {
  readonly [SECRET_REF_KEY]: SecretRefBody;
}

/** What a resolver is given. Never the configuration, and never another secret. */
export interface SecretResolverContext {
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (path: string) => string;
}

/**
 * One place a secret can come from.
 *
 * A resolver names its source in every failure and never its value — the rule
 * the `env` and `file` branches already followed, made a contract so a third
 * source cannot quietly break it.
 */
export interface SecretResolver {
  /** The key inside `$secret` this resolver claims, e.g. `env`. */
  readonly source: string;
  /** Where the secret is, in words. Contains no secret. */
  describe(target: string): string;
  /**
   * Why this source cannot be used here, or `undefined` when it can.
   *
   * EPIC-081 AC-7. A keychain that does not exist on this platform is an
   * *unavailable source*, which is a different fact from a secret that is not
   * there — and neither is an empty password.
   */
  unavailableReason?(): string | undefined;
  /** @throws {FerretError} `E_CONFIG_INVALID`, naming the source, never the value. */
  resolve(target: string, context: SecretResolverContext): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RESOLVERS = new Map<string, SecretResolver>();

/**
 * Registers a secret source.
 *
 * Replacing a registration is allowed and is how a test substitutes a resolver;
 * it is not how production composes one, which is why nothing calls this at
 * runtime except this module.
 */
export function registerSecretResolver(resolver: SecretResolver): void {
  RESOLVERS.set(resolver.source, resolver);
}

/** The source names a reference may use, in registration order. */
export function secretResolverSources(): readonly string[] {
  return [...RESOLVERS.keys()];
}

/** The resolver for a source, or `undefined` when nothing claims it. */
export function secretResolverFor(source: string): SecretResolver | undefined {
  return RESOLVERS.get(source);
}

registerSecretResolver({
  source: 'env',
  describe: (target) => `environment variable ${target}`,
  resolve: (target, context) => {
    const value = context.env[target];
    if (value === undefined || value === '') {
      throw new FerretError(
        ErrorCode.CONFIG_INVALID,
        `Secret reference to environment variable ${target} could not be resolved: the variable is unset or empty`,
        {
          details: { source: 'env', variable: target },
          remediation: `Set ${target} in the environment Ferret runs in, or replace the reference with a different secret source.`,
        },
      );
    }
    // F-71. The operator chose this variable's name, so no list in
    // `security/credentials.ts` can contain it; recording it here is the only
    // way the subprocess scrub can know to remove it.
    registerCredentialVariable(target);
    return value;
  },
});

registerSecretResolver({
  source: 'file',
  describe: (target) => `file ${target}`,
  resolve: (target, context) => {
    let contents: string;
    try {
      contents = context.readFile(target);
    } catch (error) {
      throw new FerretError(ErrorCode.CONFIG_INVALID, `Secret reference to file ${target} could not be read`, {
        details: { source: 'file', path: target },
        remediation: `Check that ${target} exists and that Ferret's user can read it.`,
        cause: error,
      });
    }

    // A trailing newline is what `echo secret > file` and most secret mounts
    // produce; treating it as part of the password would be a silent failure.
    const value = contents.replace(/\r?\n$/, '');
    if (value === '') {
      throw new FerretError(
        ErrorCode.CONFIG_INVALID,
        `Secret reference to file ${target} resolved to an empty value`,
        {
          details: { source: 'file', path: target },
          remediation: `Write the secret into ${target}, or remove the reference.`,
        },
      );
    }
    return value;
  },
});

/**
 * The one source name and target a reference body carries.
 *
 * `undefined` when the body is not exactly one non-empty string — which is what
 * makes `{ $secret: {} }` and `{ $secret: { env: 'X', file: '/x' } }` not
 * references rather than broken ones. Two sources would be ambiguous, and
 * guessing between them is how the wrong secret gets used.
 */
function refBody(value: unknown): { source: string; target: string } | undefined {
  if (!isRecord(value)) return undefined;
  const body: unknown = value[SECRET_REF_KEY];
  if (!isRecord(body)) return undefined;
  const entries = Object.entries(body);
  if (entries.length !== 1) return undefined;
  const [source, target] = entries[0] as [string, unknown];
  if (typeof target !== 'string' || target === '') return undefined;
  return { source, target };
}

/**
 * True when `value` has the shape of a secret reference.
 *
 * Shape only: a body naming a source nothing has registered is still a
 * reference, and saying so is what lets resolution fail with "unknown secret
 * source" instead of writing `{ $secret: { keychain: … } }` into a password
 * field as though it were a literal.
 */
export function isSecretRef(value: unknown): value is SecretRef {
  return refBody(value) !== undefined;
}

/** Human-readable description of where a secret comes from. Contains no secret. */
export function describeSecretRef(ref: SecretRef): string {
  const body = refBody(ref);
  if (body === undefined) return 'an unrecognised secret reference';
  const resolver = RESOLVERS.get(body.source);
  return resolver === undefined ? `${body.source} ${body.target}` : resolver.describe(body.target);
}

/**
 * Resolves a secret reference to its value.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` when the source is unknown,
 * unavailable, missing or empty. The error names the *source*, never the value.
 */
export function resolveSecretRef(
  ref: SecretRef,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const body = refBody(ref);
  if (body === undefined) {
    throw new FerretError(ErrorCode.CONFIG_INVALID, 'A secret reference must name exactly one source', {
      details: { sources: secretResolverSources() },
      remediation: `Write the reference as { "$secret": { "<source>": "<where>" } } using one of: ${secretResolverSources().join(', ')}.`,
    });
  }

  const resolver = RESOLVERS.get(body.source);
  if (resolver === undefined) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Secret reference names an unknown source: ${body.source}`,
      {
        details: { source: body.source, known: secretResolverSources() },
        remediation: `Use one of the registered secret sources: ${secretResolverSources().join(', ')}.`,
      },
    );
  }

  // AC-7 — an unavailable source is reported as one. Falling through to the
  // resolver would produce whatever a missing keychain returns, and the most
  // likely answer is nothing, which is the empty password this module has
  // refused to produce since it was written.
  const unavailable = resolver.unavailableReason?.();
  if (unavailable !== undefined) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Secret source ${body.source} is not available here: ${unavailable}`,
      {
        details: { source: body.source, reason: unavailable },
        remediation: `Use a secret source available on this platform: ${secretResolverSources().join(', ')}.`,
      },
    );
  }

  const resolved = resolver.resolve(body.target, {
    env,
    readFile,
  });
  // Every source, not only the two registered here — F-71. A resolver added
  // later hands back a credential the same way, and registering at the seam
  // rather than inside each arm is what stops the next one being forgotten.
  registerCredentialValue(resolved);
  return resolved;
}

export interface ResolveSecretsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly readFile?: (path: string) => string;
  /**
   * When false, references are replaced by a description of their source rather
   * than by the secret. Used by configuration introspection so `ferret config`
   * can show *where* a secret comes from without reading it.
   */
  readonly resolve?: boolean;
}

const MAX_DEPTH = 12;

/**
 * Walks a configuration fragment and replaces every secret reference in it.
 *
 * Applied to the merged fragment before validation, so the schema only ever
 * sees plain values and no downstream code has to handle both shapes.
 */
export function resolveSecrets(value: unknown, options: ResolveSecretsOptions = {}): unknown {
  const resolve = options.resolve ?? true;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node;
    if (isSecretRef(node)) {
      return resolve ? resolveSecretRef(node, options.env, options.readFile) : `[from ${describeSecretRef(node)}]`;
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (isRecord(node)) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) output[key] = walk(entry, depth + 1);
      return output;
    }
    return node;
  };
  return walk(value, 0);
}
