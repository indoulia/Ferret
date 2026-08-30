import type { Logger } from '../../logging/index.js';
import { ErrorCode, FerretError } from '../../errors/index.js';
import type { Capability } from '../capabilities.js';

/**
 * The shape every capability operation shares.
 *
 * EPIC-011's checkpoint expected this Epic to pin the method signature of all
 * eight capabilities. It deliberately does not — four of them have no consumer
 * closer than EPIC-024, and a signature written against an imagined requirement
 * is worse than no signature at all. What *is* genuinely shared is pinned here:
 * how an operation is cancelled, bounded and resumed. Each capability's own
 * interface is defined by the Epic that first implements it, on top of this.
 */

export interface ProviderOperationContext {
  /** Already bound to the provider and, usually, to the operation. */
  readonly logger: Logger;
  /** Aborted on shutdown, on caller cancellation, or on deadline. */
  readonly signal: AbortSignal;
  /**
   * Monotonic timestamp after which the operation should give up, if any.
   *
   * Carried alongside the signal rather than only inside it so a provider can
   * *plan* — deciding not to start a page it cannot finish is better than
   * starting it and being aborted halfway.
   */
  readonly deadline?: number;
}

export interface PageRequest {
  /** Where to resume. Absent means "from the beginning". */
  readonly cursor?: string;
  /** Upper bound on items. A provider may return fewer; never more. */
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  /**
   * Where the next page begins, or `undefined` when the enumeration is over.
   *
   * Distinct from `items.length === 0`: a page can legitimately be empty and
   * still have a successor — a filtered enumeration that found nothing in this
   * window, for instance — and a caller that stops on an empty page silently
   * truncates the result.
   */
  readonly cursor: string | undefined;
}

/**
 * Longest cursor Ferret will attempt to decode.
 *
 * A bound rather than a guess: cursors hold a position, not a payload, and 4 KiB
 * is far more than any position needs. Without it, a hostile client can make
 * Ferret base64-decode and JSON-parse an arbitrarily large string on every
 * request, which is a denial of service that costs the attacker nothing.
 */
export const MAX_CURSOR_LENGTH = 4096;

const CURSOR_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** Keys that turn an innocent `{...spread}` downstream into prototype pollution. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

interface CursorEnvelope {
  /** Envelope version, so the encoding can change without misreading old tokens. */
  readonly v: 1;
  /** Issuing provider. */
  readonly p: string;
  /** Issuing capability. */
  readonly c: string;
  /** Provider-defined position. */
  readonly s: unknown;
}

function invalidCursor(message: string, details: Record<string, unknown>): FerretError {
  return new FerretError(ErrorCode.CURSOR_INVALID, message, {
    details,
    remediation: 'Restart the enumeration without a cursor. Cursors are only valid for the provider and capability that issued them.',
  });
}

/**
 * Encodes a provider's position into an opaque, bound token.
 *
 * Bound to the issuing provider and capability on purpose. A cursor travels out
 * to an AI client over MCP and comes back later, by which time nothing
 * guarantees it comes back to the same place it left. An unbound cursor handed
 * to a different provider decodes cleanly into a position that means something
 * else entirely, and the enumeration resumes at nonsense — silently, which is
 * the worst way for it to be wrong.
 */
export function encodeCursor(providerId: string, capability: Capability, state: unknown): string {
  const envelope: CursorEnvelope = { v: 1, p: providerId, c: capability, s: state };
  let json: string;
  try {
    json = JSON.stringify(envelope);
  } catch (error) {
    // A cyclic position or a BigInt throws a bare `TypeError` from
    // `JSON.stringify`, which would escape as an unclassified failure from a
    // function whose whole contract is "this is a Ferret error or it worked".
    throw new FerretError(ErrorCode.USAGE, 'A cursor position must be JSON-serializable', {
      details: { providerId, capability },
      remediation: 'Encode the position as plain data — an offset, a key or a timestamp. No cycles, no BigInt.',
      cause: error,
    });
  }
  const token = Buffer.from(json, 'utf8').toString('base64url');
  if (token.length > MAX_CURSOR_LENGTH) {
    throw new FerretError(ErrorCode.USAGE, 'The encoded cursor is too large', {
      details: { providerId, capability, length: token.length, maximum: MAX_CURSOR_LENGTH },
      remediation: 'Store a position, not a payload — an offset, a key or a timestamp rather than the page itself.',
    });
  }
  return token;
}

/**
 * Decodes a cursor, treating it as input from a system Ferret does not control.
 *
 * Every step assumes hostility: the length before the decode, the alphabet
 * before the parse, the parse inside a guard, the envelope before its contents,
 * and the contents only through `validate`. Governance §12 — repository and
 * client content is data, never policy.
 *
 * @throws {FerretError} `E_CURSOR_INVALID`.
 */
export function decodeCursor<T>(
  providerId: string,
  capability: Capability,
  cursor: string,
  validate: (state: unknown) => T,
): T {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw invalidCursor('Cursor is empty', { providerId, capability });
  }
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor('Cursor is too long to be one Ferret issued', {
      providerId,
      capability,
      length: cursor.length,
      maximum: MAX_CURSOR_LENGTH,
    });
  }
  if (!CURSOR_ALPHABET.test(cursor)) {
    throw invalidCursor('Cursor is not base64url', { providerId, capability });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    // The cursor's contents are never echoed. It came from outside, and a
    // hostile one is a fine place to hide a value that should not reach a log.
    throw invalidCursor('Cursor could not be decoded', { providerId, capability });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor('Cursor does not contain a cursor envelope', { providerId, capability });
  }
  assertNoForbiddenKeys(parsed, providerId, capability);

  const envelope = parsed as Partial<CursorEnvelope>;
  if (envelope.v !== 1) {
    throw invalidCursor('Cursor was issued by an encoding this build does not understand', {
      providerId,
      capability,
      version: typeof envelope.v === 'number' ? envelope.v : undefined,
    });
  }
  if (envelope.p !== providerId) {
    throw invalidCursor(
      `Cursor was issued by provider "${String(envelope.p)}" and cannot be used by "${providerId}"`,
      { providerId, capability, issuedBy: String(envelope.p) },
    );
  }
  if (envelope.c !== capability) {
    throw invalidCursor(
      `Cursor was issued for capability "${String(envelope.c)}" and cannot be used for "${capability}"`,
      { providerId, capability, issuedFor: String(envelope.c) },
    );
  }

  try {
    return validate(envelope.s);
  } catch (error) {
    if (error instanceof FerretError && error.code === ErrorCode.CURSOR_INVALID) throw error;
    throw invalidCursor('Cursor position is not a shape this provider issued', { providerId, capability });
  }
}

/**
 * Walks a decoded cursor for keys that are harmless in JSON and dangerous once
 * the value is spread, merged or assigned into another object.
 *
 * Depth-bounded, because the guard itself must not be the denial of service it
 * exists to prevent.
 */
function assertNoForbiddenKeys(value: unknown, providerId: string, capability: Capability, depth = 0): void {
  if (depth > 32) {
    throw invalidCursor('Cursor is nested more deeply than any position needs', { providerId, capability });
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenKeys(item, providerId, capability, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw invalidCursor('Cursor contains a reserved key', { providerId, capability, key });
    }
    assertNoForbiddenKeys((value as Record<string, unknown>)[key], providerId, capability, depth + 1);
  }
}

/**
 * Walks every page of an enumeration as one stream.
 *
 * The loop is identical everywhere it is written by hand, and the two ways to
 * get it wrong are always the same: stopping on an empty page that still has a
 * successor, and failing to check cancellation between pages so a cancelled
 * enumeration runs to completion anyway.
 */
export async function* paginate<T>(
  fetchPage: (request: PageRequest) => Promise<Page<T>>,
  context: ProviderOperationContext,
  request: PageRequest = {},
): AsyncGenerator<T, void, undefined> {
  let cursor = request.cursor;
  const seen = new Set<string>();

  for (;;) {
    if (context.signal.aborted) {
      throw new FerretError(ErrorCode.INTERRUPTED, 'Pagination was cancelled', {
        details: { pagesFetched: seen.size },
        retryable: true,
      });
    }

    const page = await fetchPage(cursor === undefined ? stripCursor(request) : { ...request, cursor });
    yield* page.items;

    if (page.cursor === undefined) return;

    // A provider that returns the cursor it was given would loop forever, and
    // an upstream that echoes a stale cursor under load would do the same. The
    // failure is a hang, so it is worth one set lookup per page to turn it into
    // an error that names the provider.
    if (seen.has(page.cursor)) {
      throw new FerretError(ErrorCode.PROVIDER_INVALID, 'Provider returned a cursor it had already issued', {
        details: { pagesFetched: seen.size },
        remediation: 'The provider is not advancing its enumeration. Report this as a provider defect.',
      });
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}

function stripCursor(request: PageRequest): PageRequest {
  const { cursor: _cursor, ...rest } = request;
  return rest;
}
