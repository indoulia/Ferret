import { ConfigPrecedence, type ConfigSource } from './resolve.js';

/**
 * Session and explicit-operation layers.
 *
 * A *session* scope is what an AI client sets for the duration of one
 * conversation — "for this session, also exclude `docs/archive`" — without
 * writing anything to disk. Governance §9 makes sessions first-class and §16
 * gives them their own rung on the precedence ladder, above repository policy
 * and below an explicit operation.
 *
 * An *explicit operation* is a CLI flag or a direct API argument: the highest
 * rung, because the user is asking for it right now and nothing stored should
 * silently win over that.
 *
 * Both are in-memory only. Nothing here persists, so a session cannot leave a
 * setting behind that surprises the next one — which is also why a session may
 * carry values a repository never could: its scope ends with the process.
 */

export interface MutableSourceOptions {
  /** Identifier reported by configuration introspection. */
  readonly name?: string;
}

/**
 * A source whose fragment can be replaced while the process runs.
 *
 * The fragment is **deep**-copied on write and on read. A shallow copy would
 * leave nested objects shared, so a caller holding the result of `read()` could
 * reach into `database` and change what the layer reports next — configuration
 * mutating from underneath the process that resolved it.
 */
export class MutableConfigSource implements ConfigSource {
  readonly name: string;
  readonly precedence: number;
  #fragment: Record<string, unknown>;

  constructor(precedence: number, fragment: Record<string, unknown> = {}, options: MutableSourceOptions = {}) {
    this.precedence = precedence;
    this.#fragment = structuredClone(fragment);
    this.name = options.name ?? `scope:${String(precedence)}`;
  }

  read(): Record<string, unknown> {
    return structuredClone(this.#fragment);
  }

  /** Replaces the whole fragment. */
  set(fragment: Record<string, unknown>): void {
    this.#fragment = structuredClone(fragment);
  }

  /** Merges into the current fragment, replacing top-level keys. */
  merge(fragment: Record<string, unknown>): void {
    this.#fragment = { ...this.#fragment, ...structuredClone(fragment) };
  }

  /** Removes everything this layer contributes. */
  clear(): void {
    this.#fragment = {};
  }

  get isEmpty(): boolean {
    return Object.keys(this.#fragment).length === 0;
  }
}

/** Configuration scoped to one AI or CLI session. */
export function sessionSource(
  fragment: Record<string, unknown> = {},
  options: MutableSourceOptions = {},
): MutableConfigSource {
  return new MutableConfigSource(ConfigPrecedence.SESSION, fragment, {
    name: options.name ?? 'session',
  });
}

/**
 * Values supplied by the operation being run, such as a CLI flag.
 *
 * Highest precedence: when a user passes a flag, nothing stored may override it.
 */
export function explicitSource(
  fragment: Record<string, unknown> = {},
  options: MutableSourceOptions = {},
): MutableConfigSource {
  return new MutableConfigSource(ConfigPrecedence.EXPLICIT, fragment, {
    name: options.name ?? 'explicit',
  });
}
