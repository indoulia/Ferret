import { readFileSync } from 'node:fs';

import { ErrorCode, FerretError } from '../errors/index.js';

import { CONFIG_FILE_VERSION } from './schema.js';
import { ConfigPrecedence, type ConfigSource } from './resolve.js';
import { userConfigPath } from './paths.js';

/**
 * The persisted configuration file.
 *
 * Ferret must start with no configuration file at all, so a missing file
 * contributes nothing and is not an error. A file that *exists* but cannot be
 * understood is a different matter: silently ignoring it would run Ferret with
 * settings the user believes are in force, which is worse than refusing.
 */

/** On-disk shape. The envelope exists so the format can change later. */
export interface ConfigFile {
  readonly version: number;
  readonly config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string, cause?: unknown): FerretError {
  return new FerretError(ErrorCode.CONFIG_INVALID, `${message} (${path})`, {
    details: { path },
    remediation: `Fix or delete ${path}. Ferret starts with no configuration file at all, so removing it is always safe.`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Parses a configuration document.
 *
 * A bare object without the envelope is accepted as version 1, so a
 * hand-written file does not have to know about the versioning scheme to work.
 */
export function parseConfigFile(text: string, path: string): ConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(path, `Configuration file is not valid JSON: ${(error as Error).message}`, error);
  }

  if (!isRecord(parsed)) {
    throw invalid(path, 'Configuration file must contain a JSON object');
  }

  const rawVersion: unknown = parsed['version'];
  if (rawVersion === undefined) {
    // No envelope: treat the whole document as the configuration itself.
    const { version: _ignored, ...rest } = parsed;
    return { version: CONFIG_FILE_VERSION, config: rest };
  }

  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    throw invalid(path, `Configuration file version must be a positive integer, found ${JSON.stringify(rawVersion)}`);
  }
  if (rawVersion > CONFIG_FILE_VERSION) {
    // Refused rather than guessed at. A newer Ferret may have moved a key, and
    // reading it under the old meaning would apply settings the user never made.
    throw new FerretError(
      ErrorCode.CONFIG_INVALID,
      `Configuration file is version ${String(rawVersion)}, but this Ferret understands up to ${String(CONFIG_FILE_VERSION)}`,
      {
        details: { path, fileVersion: rawVersion, supported: CONFIG_FILE_VERSION },
        remediation:
          'This file was written by a newer Ferret. Upgrade Ferret (`npm install -g @indoulia/ferret@latest`) rather than editing the file down.',
      },
    );
  }

  const config: unknown = parsed['config'];
  if (config === undefined) {
    const { version: _ignored, ...rest } = parsed;
    return { version: rawVersion, config: rest };
  }
  if (!isRecord(config)) {
    throw invalid(path, 'Configuration file "config" must be an object');
  }
  return { version: rawVersion, config };
}

/**
 * Reads a configuration file, or returns `undefined` when there is none.
 *
 * Distinguishes "absent" from "unreadable": the first is normal, the second is
 * a permission or corruption problem the user needs told about.
 */
export function readConfigFile(path: string): ConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FerretError(ErrorCode.CONFIG_INVALID, `Configuration file cannot be read (${path})`, {
        details: { path, code },
        remediation: `Ferret's user needs read access to ${path}.`,
        cause: error,
      });
    }
    if (code === 'EISDIR') {
      throw invalid(path, 'Configuration path is a directory, not a file', error);
    }
    throw invalid(path, `Configuration file could not be read: ${(error as Error).message}`, error);
  }
  return parseConfigFile(text, path);
}

/**
 * The user configuration layer.
 *
 * Governance §16 fixes the ladder as *defaults → environment discovery → user
 * configuration → repository policy → session scope → explicit operation*, so a
 * stored setting **outranks** an environment variable. That is deliberate: the
 * file is what the user chose, and an inherited environment is not.
 *
 * To override a stored value for one run, use an explicit operation (a CLI
 * flag) or point `FERRET_CONFIG` at a different file — both rank above this
 * layer. `ferret config list --explain` shows which layer supplied each value.
 */
export function userFileSource(
  env: NodeJS.ProcessEnv = process.env,
  path: string = userConfigPath(env),
): ConfigSource {
  return {
    name: `file:${path}`,
    precedence: ConfigPrecedence.USER,
    read(): Record<string, unknown> {
      return readConfigFile(path)?.config ?? {};
    },
  };
}
