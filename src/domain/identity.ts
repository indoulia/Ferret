import { createHash } from 'node:crypto';

/**
 * Canonical identity.
 *
 * A canonical id must be **stable across repeated ingestion** (EPIC-006 AC-2):
 * indexing the same repository twice has to produce the same entity, or every
 * re-index would duplicate the knowledge base and every relationship recorded
 * against the old id would dangle.
 *
 * So ids are *derived*, never generated. The id is a pure function of the
 * entity's natural identity, which means idempotency is a property of the
 * identifier itself rather than something the ingestion code has to remember to
 * preserve.
 */

/**
 * Length-prefixed join.
 *
 * `["a", "b:c"]` and `["a:b", "c"]` must not produce the same key. A plain
 * separator cannot guarantee that, because source identifiers are arbitrary
 * strings from systems Ferret does not control — a branch really can be called
 * `feature/a:b`. Prefixing each part with its byte length makes the encoding
 * unambiguous, so two different identities can never collide by construction
 * rather than by hoping the separator is exotic enough.
 */
export function encodeKeyParts(parts: readonly string[]): string {
  return parts.map((part) => `${String(Buffer.byteLength(part, 'utf8'))}:${part}`).join('');
}

export interface CanonicalKeyInput {
  /** Entity kind, e.g. `repository`. */
  readonly kind: string;
  /** The system the object came from, e.g. `git`, `github`, `jira`. */
  readonly sourceSystem: string;
  /**
   * The identifier that system uses, already normalized by the provider.
   *
   * Normalization is the provider's job because only it knows what is
   * equivalent — that a Git remote is the same whether written as an SSH or an
   * HTTPS URL, for instance.
   */
  readonly sourceId: string;
  /**
   * The entity this one is identified *within*, when its source id is only
   * unique in context: a file path is unique within a repository, a branch
   * within a repository, a review within a pull request. Omitted for globally
   * identified objects.
   */
  readonly scope?: string | undefined;
}

/** The stable string an entity's identity reduces to. */
export function canonicalKey(input: CanonicalKeyInput): string {
  return encodeKeyParts([input.kind, input.sourceSystem, input.scope ?? '', input.sourceId]);
}

/**
 * Derives a UUID from a canonical key.
 *
 * **SHA-256, not the SHA-1 of UUIDv5.** UUIDv5 would be the conventional
 * choice, but its digest is SHA-1, for which chosen-prefix collisions are
 * practical. Ferret derives ids from identifiers found in repositories it did
 * not write (Governance §12 — repository content is untrusted), so a feasible
 * collision would let a hostile repository alias one entity onto another and
 * silently corrupt the knowledge base. The cost of SHA-256 here is nothing.
 *
 * The result is a valid RFC 9562 **UUIDv8** — the version reserved for
 * application-defined generation — so it stores in PostgreSQL's native `uuid`
 * type, indexes as 16 bytes, and is recognisable as deliberately derived rather
 * than mistaken for a random v4.
 */
export function canonicalId(key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);

  // RFC 9562 §4.1: version in the high nibble of octet 6, variant in the two
  // high bits of octet 8. Setting them is what makes this a well-formed UUID
  // rather than 16 arbitrary bytes wearing a UUID's punctuation.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Convenience: canonical key and id together. */
export function identify(input: CanonicalKeyInput): { key: string; id: string } {
  const key = canonicalKey(input);
  return { key, id: canonicalId(key) };
}

/**
 * Fingerprints an entity's canonical content.
 *
 * Ingestion compares this to decide whether anything actually changed. Without
 * it, re-indexing an unchanged repository would rewrite every row and make
 * "when did this last change" unanswerable — Governance §10 requires
 * reprocessing unchanged content not to create duplicate logical entities.
 *
 * Object keys are sorted so that two encodings of the same content hash
 * identically; `JSON.stringify` alone preserves insertion order, and a provider
 * returning the same fields in a different order would otherwise look like a
 * change.
 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/**
 * An instant in one spelling, so the same moment hashes identically.
 *
 * **Found by EPIC-094, measured.** A commit's `sourceObservedAt` arrived from
 * Git as `2026-09-01T21:33:28+05:30` and was hashed in that form; the column is
 * a `timestamptz`, so it reads back as `2026-09-01T16:03:28.000Z`. The same
 * instant, different bytes — which meant `content_hash` was a function of the
 * *spelling* a source happened to use rather than of the value, and could not
 * be recomputed from a stored row at all. On Ferret's own index that was 135
 * commits, 14 files and 16 relationships reported as corrupt when nothing was.
 *
 * `contentHash`'s own doc comment already promised that "two encodings of the
 * same content hash identically". For strings and objects it was true. For
 * instants it was not, and this is what makes it true.
 *
 * **Hashing only.** Canonical keys and ids are deliberately not touched: they
 * are stored identifiers, and renormalising them would re-point every row that
 * carries a timestamp in its key. A value that does not parse is returned
 * unchanged rather than replaced — Governance §6, an unparseable instant is
 * data Ferret does not understand, not a reason to invent one.
 */
export function canonicalInstant(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Deterministic JSON: object keys sorted, arrays left in order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absent, not a value: including it would make an entity that
    // omits a field hash differently from one that sets it to undefined.
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/** Matches a UUID in the canonical textual form. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
