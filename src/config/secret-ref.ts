import { readFileSync } from 'node:fs';

import { ErrorCode, FerretError } from '../errors/index.js';

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
 */

/** Property that marks an object as a secret reference. */
export const SECRET_REF_KEY = '$secret';

export interface EnvironmentSecretRef {
  readonly env: string;
}

export interface FileSecretRef {
  readonly file: string;
}

export type SecretRefBody = EnvironmentSecretRef | FileSecretRef;

export interface SecretRef {
  readonly [SECRET_REF_KEY]: SecretRefBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has the shape of a secret reference. */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) return false;
  const body: unknown = value[SECRET_REF_KEY];
  if (!isRecord(body)) return false;
  const hasEnv = typeof body['env'] === 'string' && body['env'] !== '';
  const hasFile = typeof body['file'] === 'string' && body['file'] !== '';
  // Exactly one source. Both would be ambiguous; neither is not a reference.
  return hasEnv !== hasFile;
}

/** Human-readable description of where a secret comes from. Contains no secret. */
export function describeSecretRef(ref: SecretRef): string {
  const body = ref[SECRET_REF_KEY];
  return 'env' in body ? `environment variable ${body.env}` : `file ${body.file}`;
}

/**
 * Resolves a secret reference to its value.
 *
 * @throws {FerretError} `E_CONFIG_INVALID` when the source is missing or empty.
 * The error names the *source*, never the value.
 */
export function resolveSecretRef(
  ref: SecretRef,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  const body = ref[SECRET_REF_KEY];

  if ('env' in body) {
    const value = env[body.env];
    if (value === undefined || value === '') {
      throw new FerretError(
        ErrorCode.CONFIG_INVALID,
        `Secret reference to ${describeSecretRef(ref)} could not be resolved: the variable is unset or empty`,
        {
          details: { source: 'env', variable: body.env },
          remediation: `Set ${body.env} in the environment Ferret runs in, or replace the reference with a different secret source.`,
        },
      );
    }
    return value;
  }

  let contents: string;
  try {
    contents = readFile(body.file);
  } catch (error) {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Secret reference to ${describeSecretRef(ref)} could not be read`,
      {
        details: { source: 'file', path: body.file },
        remediation: `Check that ${body.file} exists and that Ferret's user can read it.`,
        cause: error,
      },
    );
  }

  // A trailing newline is what `echo secret > file` and most secret mounts
  // produce; treating it as part of the password would be a silent failure.
  const value = contents.replace(/\r?\n$/, '');
  if (value === '') {
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Secret reference to ${describeSecretRef(ref)} resolved to an empty value`,
      {
        details: { source: 'file', path: body.file },
        remediation: `Write the secret into ${body.file}, or remove the reference.`,
      },
    );
  }
  return value;
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
