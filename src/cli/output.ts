import { serializeError, type SerializedError } from '../errors/index.js';

/**
 * Output discipline for the CLI.
 *
 * - stdout carries the command result and nothing else. In `--json` mode it is
 *   exactly one JSON document, so a caller can pipe it straight into a parser.
 * - stderr carries human diagnostics and the structured NDJSON log stream.
 *
 * Keeping the two apart is what lets an AI client consume Ferret without
 * parsing decorative terminal text.
 */
export interface OutputOptions {
  readonly json: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface JsonSuccess {
  readonly ok: true;
  readonly data: unknown;
}

export interface JsonFailure {
  readonly ok: false;
  readonly error: SerializedError;
}

function writeOut(options: OutputOptions, text: string): void {
  (options.stdout ?? ((line: string) => process.stdout.write(line)))(text);
}

function writeErr(options: OutputOptions, text: string): void {
  (options.stderr ?? ((line: string) => process.stderr.write(line)))(text);
}

/** Emits a successful result: JSON envelope, or the supplied human rendering. */
export function emitResult(options: OutputOptions, data: unknown, human: () => string): void {
  if (options.json) {
    const payload: JsonSuccess = { ok: true, data };
    writeOut(options, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const text = human();
  if (text.length > 0) writeOut(options, `${text}\n`);
}

/**
 * Emits a failure. Always redacted, because it serializes through
 * {@link serializeError}.
 *
 * In JSON mode the envelope goes to stdout so a machine caller reads success
 * and failure from the same stream; the human rendering goes to stderr.
 */
export function emitError(options: OutputOptions, error: unknown): void {
  const serialized = serializeError(error);
  if (options.json) {
    const payload: JsonFailure = { ok: false, error: serialized };
    writeOut(options, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const lines = [`ferret: error: ${serialized.message}`, `  code: ${serialized.code}`];
  if (serialized.remediation !== undefined) lines.push(`  hint: ${serialized.remediation}`);
  writeErr(options, `${lines.join('\n')}\n`);
}
