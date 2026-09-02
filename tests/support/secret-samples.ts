import { SECRET_KINDS } from '../../src/security/secrets.js';

/**
 * One synthetic instance of every credential format Ferret knows — EPIC-100.
 *
 * **Enumerated against `SECRET_KINDS`, never listed independently.** A table
 * written by hand goes stale on the next commit, silently, in the direction of
 * checking less: a kind added to `security/secrets.ts` would simply not be
 * covered, and every suite using this would still be green. {@link SECRET_SAMPLES}
 * is therefore asserted total by {@link assertSamplesAreTotal}, which every
 * caller runs first.
 *
 * The values are synthetic and inert. `secretHalf` exists because two kinds —
 * `url-credential` and `assigned-secret` — match only the credential *inside* a
 * larger string by design, so "the sample is absent" is the wrong assertion for
 * them and "the secret half is absent" is the right one.
 */

export interface SecretSample {
  /** The full string to plant. */
  readonly text: string;
  /** The part that must not survive redaction. */
  readonly secretHalf: string;
}

const SAMPLES: Readonly<Record<string, SecretSample>> = {
  'private-key': {
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEbogusbogusbogus\n-----END RSA PRIVATE KEY-----',
    secretHalf: 'MIIEbogusbogusbogus',
  },
  'aws-access-key-id': { text: 'AKIAQRSTUVWXYZ234567', secretHalf: 'AKIAQRSTUVWXYZ234567' },
  'github-token': { text: `ghp_${'a'.repeat(36)}`, secretHalf: `ghp_${'a'.repeat(36)}` },
  'github-fine-grained-token': {
    text: `github_pat_${'b'.repeat(30)}`,
    secretHalf: `github_pat_${'b'.repeat(30)}`,
  },
  'slack-token': { text: 'xoxb-1234567890-abcdefghijkl', secretHalf: 'xoxb-1234567890-abcdefghijkl' },
  'google-api-key': { text: `AIza${'C'.repeat(35)}`, secretHalf: `AIza${'C'.repeat(35)}` },
  'openai-api-key': { text: `sk-${'d'.repeat(24)}`, secretHalf: `sk-${'d'.repeat(24)}` },
  'stripe-key': { text: `sk_live_${'e'.repeat(20)}`, secretHalf: `sk_live_${'e'.repeat(20)}` },
  'npm-token': { text: `npm_${'f'.repeat(36)}`, secretHalf: `npm_${'f'.repeat(36)}` },
  jwt: {
    text: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    secretHalf: 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  },
  'url-credential': {
    text: 'postgres://ferret:supersecretvalue@db:5432/x',
    secretHalf: 'supersecretvalue',
  },
  'assigned-secret': {
    text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY',
    secretHalf: 'wJalrXUtnFEMIK7MDENGbPxRfiCY',
  },
};

export const SECRET_SAMPLES = SAMPLES;

/** Every kind, paired with its sample, in `SECRET_KINDS` order. */
export function eachSecretKind(): readonly { kind: string; sample: SecretSample }[] {
  return SECRET_KINDS.map((entry) => {
    const sample = SAMPLES[entry.kind];
    if (sample === undefined) {
      throw new Error(
        `No sample for secret kind "${entry.kind}". Add one to tests/support/secret-samples.ts — ` +
          'a kind without a sample is a credential format nothing tests the redaction of.',
      );
    }
    return { kind: entry.kind, sample };
  });
}

/**
 * Fails when the table and `SECRET_KINDS` have drifted apart, in either
 * direction — EPIC-100 AC-3.
 *
 * The failing-closed half of the enumeration. Without it a renamed or removed
 * kind would shrink the set silently and every invariant over it would keep
 * passing while checking less, which is the one failure mode a security suite
 * must not have.
 */
export function assertSamplesAreTotal(): { kinds: number } {
  const declared = SECRET_KINDS.map((entry) => entry.kind).sort();
  const sampled = Object.keys(SAMPLES).sort();

  if (declared.length === 0) {
    throw new Error('SECRET_KINDS is empty — the enumeration would check nothing.');
  }
  if (declared.join(',') !== sampled.join(',')) {
    throw new Error(
      `Secret kinds and samples disagree.\n  declared: ${declared.join(', ')}\n  sampled:  ${sampled.join(', ')}`,
    );
  }
  return { kinds: declared.length };
}
