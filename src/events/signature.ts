import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifying that a webhook came from who it says — EPIC-077 §8.2.
 *
 * A webhook payload is the most attacker-reachable input Ferret will ever have:
 * it arrives unsolicited, over the network, at an endpoint whose URL is
 * frequently discoverable. Everything else Ferret reads at least required
 * somebody to have write access to a repository.
 *
 * So verification is not a feature of this module; it is the module. A payload
 * that does not verify is not a payload with a warning attached — it is not a
 * payload.
 */

/** How a source system signs. */
export const SignatureScheme = {
  /** GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
  GITHUB_SHA256: 'github-sha256',
  /** Jira Cloud and Bitbucket: `X-Hub-Signature: sha256=<hex>`, same digest. */
  HUB_SHA256: 'hub-sha256',
} as const;

export type SignatureScheme = (typeof SignatureScheme)[keyof typeof SignatureScheme];

/** Why a payload was refused. Never surfaced to the sender — §8.3. */
export const SignatureRefusal = {
  /** No signature header was present. */
  MISSING: 'missing',
  /** Present but not in the scheme's format. */
  MALFORMED: 'malformed',
  /** Correctly formed and wrong. */
  MISMATCH: 'mismatch',
  /** No secret is configured, so nothing can be verified. */
  UNCONFIGURED: 'unconfigured',
} as const;

export type SignatureRefusal = (typeof SignatureRefusal)[keyof typeof SignatureRefusal];

export type SignatureVerdict =
  | { readonly verified: true }
  | { readonly verified: false; readonly refusal: SignatureRefusal };

/**
 * Verify a signature over the **raw body**.
 *
 * Raw, not parsed and re-serialized. `JSON.parse` followed by `JSON.stringify`
 * reorders nothing but reformats everything — key order survives, whitespace
 * does not — and a digest over the reformatted bytes never matches. Every
 * webhook integration that has ever mysteriously failed to verify has failed
 * here, which is why this takes bytes and not an object.
 */
export function verifySignature(
  body: Uint8Array | string,
  header: string | undefined,
  secret: string | undefined,
  scheme: SignatureScheme = SignatureScheme.GITHUB_SHA256,
): SignatureVerdict {
  // Unconfigured is a refusal, not a pass. A deployment that forgot to set a
  // secret would otherwise accept anything anyone sent it, and would look
  // exactly like a working one.
  if (secret === undefined || secret.length === 0) {
    return { verified: false, refusal: SignatureRefusal.UNCONFIGURED };
  }
  if (header === undefined || header.length === 0) {
    return { verified: false, refusal: SignatureRefusal.MISSING };
  }

  const prefix = scheme === SignatureScheme.GITHUB_SHA256 ? 'sha256=' : 'sha256=';
  if (!header.startsWith(prefix)) {
    return { verified: false, refusal: SignatureRefusal.MALFORMED };
  }
  const provided = header.slice(prefix.length);
  if (!/^[0-9a-fA-F]{64}$/u.test(provided)) {
    return { verified: false, refusal: SignatureRefusal.MALFORMED };
  }

  const expected = createHmac('sha256', secret)
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest();
  const candidate = Buffer.from(provided, 'hex');

  // Length is checked before the comparison because `timingSafeEqual` throws on
  // a mismatch — and the regular expression above already fixed the length, so
  // this branch is unreachable and stays anyway: an unreachable guard costs
  // nothing and a thrown exception in a verifier is a denial of service.
  if (candidate.length !== expected.length) {
    return { verified: false, refusal: SignatureRefusal.MISMATCH };
  }
  return timingSafeEqual(candidate, expected)
    ? { verified: true }
    : { verified: false, refusal: SignatureRefusal.MISMATCH };
}

/**
 * What a caller should tell the sender — §8.3.
 *
 * The same sentence for every refusal, deliberately. A sender that could tell
 * "no secret configured" from "wrong signature" learns whether an endpoint is
 * worth attacking, and a sender that could tell "malformed" from "mismatch"
 * learns the format. Neither is information the legitimate sender needs: it
 * signed correctly or it did not.
 */
export const SIGNATURE_REFUSAL_MESSAGE = 'The request signature could not be verified.';
