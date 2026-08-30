import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/**
 * Where Ferret keeps configuration, and how it finds a repository's own policy.
 *
 * Two locations, with different trust levels:
 *
 * - **User configuration** — one file per machine, holding the database details
 *   the user supplied once. It is trusted: the user wrote it.
 * - **Repository policy** — `.ferret/config.json` inside a repository. It is
 *   *shared with everyone who clones that repository*, so it is trusted only to
 *   express intent about that repository's own content. `repository-source.ts`
 *   enforces what it may and may not set.
 */

/** Directory name used under the platform's configuration root. */
export const CONFIG_DIRECTORY_NAME = 'ferret';
export const CONFIG_FILE_NAME = 'config.json';

/** Marker directory that identifies a repository's Ferret policy. */
export const REPOSITORY_CONFIG_DIRECTORY = '.ferret';

/** Environment variable naming an explicit configuration *file*. */
export const CONFIG_FILE_ENV = 'FERRET_CONFIG';
/** Environment variable naming an explicit configuration *directory*. */
export const CONFIG_HOME_ENV = 'FERRET_CONFIG_HOME';

/**
 * The directory Ferret stores its own state in.
 *
 * Follows each platform's convention rather than inventing one, so the file
 * lands where a user's backup and sync tooling already looks:
 * `%APPDATA%\ferret` on Windows, `$XDG_CONFIG_HOME/ferret` or
 * `~/.config/ferret` elsewhere.
 */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CONFIG_HOME_ENV];
  if (explicit !== undefined && explicit !== '') return resolve(explicit);

  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData !== undefined && appData !== '') return join(appData, CONFIG_DIRECTORY_NAME);
    return join(homedir(), 'AppData', 'Roaming', CONFIG_DIRECTORY_NAME);
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') return join(xdg, CONFIG_DIRECTORY_NAME);
  return join(homedir(), '.config', CONFIG_DIRECTORY_NAME);
}

/**
 * The user configuration file.
 *
 * `FERRET_CONFIG` names a file directly, which is what lets a test — or a user
 * running two Ferret instances — keep them apart without touching the real one.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[CONFIG_FILE_ENV];
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  return join(configHome(env), CONFIG_FILE_NAME);
}

/** Where configuration changes are journalled, beside the configuration itself. */
export function auditLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userConfigPath(env)), 'config-audit.log');
}

/**
 * Finds the repository policy file governing `startDirectory`, if any.
 *
 * Walks upward to the filesystem root. The nearest `.ferret/config.json` wins,
 * so a nested worktree or sub-project can hold its own policy without the parent
 * having to know about it.
 *
 * Returns `undefined` rather than throwing when there is none: not being inside
 * a repository is the ordinary case, not an error.
 */
export function findRepositoryConfig(startDirectory: string = process.cwd()): string | undefined {
  let current = resolve(startDirectory);
  const { root } = parse(current);

  for (;;) {
    const candidate = join(current, REPOSITORY_CONFIG_DIRECTORY, CONFIG_FILE_NAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // An unreadable directory on the way up is not a reason to fail the walk.
    }
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** True when `path` is inside `directory`, used to keep file reads in bounds. */
export function isInside(directory: string, path: string): boolean {
  const base = resolve(directory);
  const target = resolve(path);
  if (!isAbsolute(base) || !isAbsolute(target)) return false;
  const relative = target.slice(base.length);
  return target === base || (target.startsWith(base) && (relative.startsWith('/') || relative.startsWith('\\')));
}
