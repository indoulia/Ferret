import { defaultConfigSourceList, resolveConfig } from '../config/index.js';
import type { LogLevel } from '../logging/index.js';

/**
 * The level a command should log at — EPIC-091 AC-7, AC-8.
 *
 * `ferret status` and `ferret doctor` built a logger **only** when the
 * `--log-level` flag was present, so `FERRET_LOG_LEVEL=trace ferret status`
 * emitted nothing while `ferret env` emitted records: the configured value was
 * simply never consulted. The runtime already honours it
 * (`runtime.ts` — `this.#options.logLevel ?? config.logLevel`); these two
 * commands do not build a runtime, so they need the same rule spelled out.
 *
 * **Resolution failure is not an error here.** `status` and `doctor` are the
 * commands a user runs *because* something is broken, and a configuration file
 * that cannot be parsed is one of the things they exist to report. Falling back
 * to the flag — or to nothing — keeps them dependable, which is exactly what
 * Governance §20 asks of these two by name.
 */
export function effectiveLogLevel(flag: LogLevel | undefined): LogLevel | undefined {
  // The flag wins, and wins without reading anything: EPIC-003's precedence
  // ladder puts an explicit operation above stored configuration, and there is
  // no point resolving a file to discard the answer.
  if (flag !== undefined) return flag;
  try {
    return resolveConfig(defaultConfigSourceList()).config.logLevel;
  } catch {
    return undefined;
  }
}
