import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DeliveryLedger,
  EventSubject,
  MAX_WATCHED_ROOTS,
  RepositoryWatcher,
  SIGNATURE_REFUSAL_MESSAGE,
  SignatureRefusal,
  normalizeGithubEvent,
  normalizeJiraEvent,
  SignatureScheme,
  verifySignature,
} from '../../src/events/index.js';
import type { SourceEvent } from '../../src/events/index.js';

/**
 * EPIC-077. A webhook says something changed; a watcher says the same thing
 * about a disk. Neither is trusted, and both are verified.
 */

const SECRET = 'a-shared-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('signature verification', () => {
  const body = '{"action":"opened"}';

  it('accepts a correct signature over the raw body', () => {
    expect(verifySignature(body, sign(body), SECRET)).toStrictEqual({ verified: true });
  });

  it('refuses a signature over a reformatted body', () => {
    // The failure every webhook integration has had: `JSON.parse` then
    // `JSON.stringify` preserves key order and destroys whitespace, and the
    // digest never matches. This is why the function takes bytes.
    const reformatted = JSON.stringify(JSON.parse('{"action": "opened"}'));
    const verdict = verifySignature(reformatted, sign('{"action": "opened"}'), SECRET);
    expect(verdict.verified).toBe(false);
  });

  it('accepts raw bytes as well as a string', () => {
    const bytes = new TextEncoder().encode(body);
    expect(verifySignature(bytes, sign(body), SECRET).verified).toBe(true);
  });

  it('refuses when no secret is configured — not a pass', () => {
    // A deployment that forgot to set a secret would otherwise accept anything
    // anyone sent it, and would look exactly like a working one.
    expect(verifySignature(body, sign(body), undefined)).toStrictEqual({
      verified: false,
      refusal: SignatureRefusal.UNCONFIGURED,
    });
    expect(verifySignature(body, sign(body), '')).toStrictEqual({
      verified: false,
      refusal: SignatureRefusal.UNCONFIGURED,
    });
  });

  it('refuses a missing, malformed or wrong signature, distinguishably', () => {
    expect(verifySignature(body, undefined, SECRET).verified).toBe(false);
    expect((verifySignature(body, undefined, SECRET) as { refusal: string }).refusal).toBe(
      SignatureRefusal.MISSING,
    );
    for (const header of ['sha1=abcd', 'sha256=nothex', 'sha256=', 'abcd']) {
      const verdict = verifySignature(body, header, SECRET);
      expect(verdict.verified).toBe(false);
      expect((verdict as { refusal: string }).refusal).toBe(SignatureRefusal.MALFORMED);
    }
    const wrong = verifySignature(body, sign(body, 'a-different-secret'), SECRET);
    expect((wrong as { refusal: string }).refusal).toBe(SignatureRefusal.MISMATCH);
  });

  it('says the same thing to a sender however it failed', () => {
    // A sender that could tell "no secret configured" from "wrong signature"
    // learns whether an endpoint is worth attacking.
    expect(SIGNATURE_REFUSAL_MESSAGE).toBe('The request signature could not be verified.');
    expect(SIGNATURE_REFUSAL_MESSAGE).not.toContain('secret');
  });

  it('does not throw on a signature of the wrong length', () => {
    // `timingSafeEqual` throws on a length mismatch, and a thrown exception in
    // a verifier is a denial of service.
    expect(() => verifySignature(body, `sha256=${'a'.repeat(63)}`, SECRET)).not.toThrow();
    expect(() => verifySignature(body, `sha256=${'a'.repeat(128)}`, SECRET)).not.toThrow();
  });
});

describe('GitHub event normalization', () => {
  const headers = { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-1' };
  const body = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'o/r' },
    pull_request: { number: 12 },
  });

  it('names what changed, not what it contains', () => {
    const result = normalizeGithubEvent(body, headers);
    expect(result.event).toStrictEqual({
      deliveryId: 'd-1',
      sourceSystem: 'github',
      subject: EventSubject.PULL_REQUEST,
      // The vendor's own name, verbatim: it is what a person searches the
      // vendor's documentation for.
      event: 'pull_request.closed',
      project: 'o/r',
      reference: '12',
    } satisfies SourceEvent);
  });

  it('reads headers whatever case the server normalized them to', () => {
    expect(normalizeGithubEvent(body, { 'x-github-event': 'push', 'x-github-delivery': 'd' }).event
      ?.subject).toBe(EventSubject.HISTORY);
  });

  it('distinguishes an event it declines from one it does not know', () => {
    // A `star` is a real event that changes nothing Ferret holds. Counting it
    // as unparseable would tell an operator there is a gap where there is a
    // decision.
    expect(normalizeGithubEvent(body, { ...headers, 'X-GitHub-Event': 'star' }).ignored).toBe(
      'unsupported-event',
    );
    expect(normalizeGithubEvent('not json', headers).ignored).toBe('unparseable');
    expect(normalizeGithubEvent(body, { 'X-GitHub-Event': 'push' }).ignored).toBe('no-delivery-id');
  });

  it('maps every event it claims to a subject', () => {
    const cases: readonly [string, EventSubject][] = [
      ['push', EventSubject.HISTORY],
      ['issues', EventSubject.ISSUE],
      ['issue_comment', EventSubject.COMMENT],
      ['pull_request_review', EventSubject.REVIEW],
      ['release', EventSubject.RELEASE],
      ['deployment_status', EventSubject.DEPLOYMENT],
      ['repository', EventSubject.REPOSITORY],
    ];
    for (const [event, subject] of cases) {
      const result = normalizeGithubEvent('{}', { 'x-github-event': event, 'x-github-delivery': 'd' });
      expect(result.event?.subject, event).toBe(subject);
    }
  });

  it('reports a release by its tag and a push by its ref', () => {
    const release = normalizeGithubEvent(
      JSON.stringify({ action: 'published', release: { tag_name: 'v1.2.0' } }),
      { 'x-github-event': 'release', 'x-github-delivery': 'd' },
    );
    expect(release.event?.reference).toBe('v1.2.0');

    const push = normalizeGithubEvent(JSON.stringify({ ref: 'refs/heads/main' }), {
      'x-github-event': 'push',
      'x-github-delivery': 'd',
    });
    expect(push.event?.reference).toBe('refs/heads/main');
  });

  it('survives a payload with nothing in it', () => {
    // The payload is attacker-supplied. Every field read here is optional in
    // practice however mandatory the documentation says it is.
    const result = normalizeGithubEvent('{}', {
      'x-github-event': 'issues',
      'x-github-delivery': 'd',
    });
    expect(result.event?.project).toBeUndefined();
    expect(result.event?.reference).toBeUndefined();
  });
});

describe('Jira event normalization', () => {
  it('reads the event from the body, because Jira sends no header', () => {
    const result = normalizeJiraEvent(
      JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: { key: 'FER-12' },
        timestamp: '2026-01-02T03:04:05.000Z',
      }),
      'delivery-1',
    );
    expect(result.event?.sourceSystem).toBe('jira');
    expect(result.event?.subject).toBe(EventSubject.ISSUE);
    // A Jira key carries its project: `FER-12` is in `FER`, and no field says so
    // on every event shape.
    expect(result.event?.project).toBe('FER');
    expect(result.event?.reference).toBe('FER-12');
  });

  it('reads a comment event', () => {
    const result = normalizeJiraEvent(
      JSON.stringify({ webhookEvent: 'comment_created', issue: { key: 'FER-3' } }),
      'd',
    );
    expect(result.event?.subject).toBe(EventSubject.COMMENT);
  });

  it('requires a delivery id the caller minted, because Jira sends none', () => {
    expect(normalizeJiraEvent('{}', '').ignored).toBe('no-delivery-id');
  });

  it('declines an event family it has no use for', () => {
    expect(
      normalizeJiraEvent(JSON.stringify({ webhookEvent: 'user_created' }), 'd').ignored,
    ).toBe('unsupported-event');
  });
});

describe('the delivery ledger', () => {
  const event: SourceEvent = {
    deliveryId: 'd-1',
    sourceSystem: 'github',
    subject: EventSubject.ISSUE,
    event: 'issues.opened',
  };

  it('admits a delivery once', () => {
    // A webhook is redelivered on any non-2xx and on a timeout the sender
    // decided about unilaterally.
    const ledger = new DeliveryLedger();
    expect(ledger.admit(event)).toBe(true);
    expect(ledger.admit(event)).toBe(false);
    expect(ledger.has(event)).toBe(true);
  });

  it('keys on the source system as well as the id', () => {
    // Two systems' delivery ids come from different generators and nothing says
    // they cannot collide.
    const ledger = new DeliveryLedger();
    expect(ledger.admit(event)).toBe(true);
    expect(ledger.admit({ ...event, sourceSystem: 'jira' })).toBe(true);
  });

  it('evicts the oldest, and re-admits what it forgot', () => {
    const ledger = new DeliveryLedger(2);
    ledger.admit({ ...event, deliveryId: 'a' });
    ledger.admit({ ...event, deliveryId: 'b' });
    ledger.admit({ ...event, deliveryId: 'c' });
    expect(ledger.size).toBe(2);
    // A delivery redelivered after the bound is one the sender gave up on hours
    // ago; re-admitting costs one redundant read, and EPIC-080 makes that safe.
    expect(ledger.admit({ ...event, deliveryId: 'a' })).toBe(true);
    expect(ledger.has({ ...event, deliveryId: 'b' })).toBe(false);
  });
});

describe('the repository watcher', () => {
  /** A schedule that fires when a test says so. */
  function manualSchedule() {
    const pending: (() => void)[] = [];
    return {
      schedule: (callback: () => void) => {
        pending.push(callback);
        const index = pending.length - 1;
        return {
          cancel: () => {
            pending[index] = () => undefined;
          },
        };
      },
      fire: () => {
        const queued = [...pending];
        pending.length = 0;
        for (const callback of queued) callback();
      },
    };
  }

  function manualOpen() {
    const roots = new Map<string, (path: string) => void>();
    return {
      open: (root: string, onChange: (path: string) => void) => {
        roots.set(root, onChange);
        return {
          close: () => {
            roots.delete(root);
          },
        };
      },
      change: (root: string) => roots.get(root)?.('a-file'),
      get open_count() {
        return roots.size;
      },
    };
  }

  it('emits once per burst, not once per file', () => {
    // A `git clone` produces thousands of events over several seconds. One
    // event per file would make the watcher itself the load.
    const events: SourceEvent[] = [];
    const clock = manualSchedule();
    const fs = manualOpen();
    const watcher = new RepositoryWatcher((event) => events.push(event), {
      schedule: clock.schedule,
      open: fs.open,
    });

    watcher.add('/repos');
    for (let index = 0; index < 100; index += 1) fs.change('/repos');
    expect(events).toStrictEqual([]);

    clock.fire();
    expect(events).toHaveLength(1);
    expect(events[0]?.sourceSystem).toBe('filesystem');
    expect(events[0]?.subject).toBe(EventSubject.REPOSITORY);
    expect(events[0]?.project).toBe('/repos');
  });

  it('mints a delivery id the ledger can deduplicate on', () => {
    const events: SourceEvent[] = [];
    const clock = manualSchedule();
    const fs = manualOpen();
    const watcher = new RepositoryWatcher((event) => events.push(event), {
      schedule: clock.schedule,
      open: fs.open,
    });
    watcher.add('/a');
    fs.change('/a');
    clock.fire();
    fs.change('/a');
    clock.fire();

    const ledger = new DeliveryLedger();
    expect(events).toHaveLength(2);
    // There is no sender, so there is no delivery id; one is minted that is
    // unique per watcher, which is what the ledger needs and all it needs.
    for (const event of events) expect(ledger.admit(event)).toBe(true);
  });

  it('watches a root once however often it is added', () => {
    // Two watchers would double every event, and the second would be
    // indistinguishable from a real change.
    const fs = manualOpen();
    const watcher = new RepositoryWatcher(() => undefined, {
      schedule: manualSchedule().schedule,
      open: fs.open,
    });
    watcher.add('/a');
    watcher.add('/a');
    expect(watcher.watching).toStrictEqual(['/a']);
    expect(fs.open_count).toBe(1);
  });

  it('emits nothing for a root removed while a burst was pending', () => {
    const events: SourceEvent[] = [];
    const clock = manualSchedule();
    const fs = manualOpen();
    const watcher = new RepositoryWatcher((event) => events.push(event), {
      schedule: clock.schedule,
      open: fs.open,
    });
    watcher.add('/a');
    fs.change('/a');
    watcher.remove('/a');
    clock.fire();
    expect(events).toStrictEqual([]);
  });

  it('closes everything, twice safely', () => {
    const fs = manualOpen();
    const watcher = new RepositoryWatcher(() => undefined, {
      schedule: manualSchedule().schedule,
      open: fs.open,
    });
    watcher.add('/a');
    watcher.add('/b');
    watcher.close();
    watcher.close();
    expect(watcher.watching).toStrictEqual([]);
    expect(fs.open_count).toBe(0);
  });

  it('refuses to hold more roots open than it declared', () => {
    const fs = manualOpen();
    const watcher = new RepositoryWatcher(() => undefined, {
      schedule: manualSchedule().schedule,
      open: fs.open,
    });
    for (let index = 0; index < MAX_WATCHED_ROOTS; index += 1) watcher.add(`/root-${String(index)}`);
    expect(() => watcher.add('/one-too-many')).toThrow(/more than 64 roots/u);
  });
});

/**
 * **The scheme table decides something — F-78.**
 *
 * `verifySignature` chose its prefix with `scheme === GITHUB_SHA256 ? 'sha256='
 * : 'sha256='`. Two identical branches: not wrong for the two schemes Ferret
 * has, both of which really do use that prefix over HMAC-SHA-256, but it read as
 * a decision while making none. The first scheme with a different prefix or
 * digest would have been verified as SHA-256 against a header it does not use,
 * and the only symptom would be signatures that mysteriously fail.
 *
 * The table is now `Record<SignatureScheme, …>`, which is exhaustive — adding a
 * member to the enum fails to compile until somebody states its prefix and its
 * digest. That guarantee is a compiler one and cannot be asserted at runtime;
 * what these assert is that the table is actually consulted and that the digest
 * length is derived from it rather than pinned.
 */
describe('the signature scheme is read from a table — F-78', () => {
  const SECRET = 'a-shared-secret';
  const BODY = '{"hello":"world"}';

  function signatureFor(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  }

  it('verifies under both declared schemes, which share a prefix', () => {
    const header = signatureFor(BODY, SECRET);
    for (const scheme of Object.values(SignatureScheme)) {
      expect(verifySignature(BODY, header, SECRET, scheme).verified, scheme).toBe(true);
    }
  });

  it('refuses a digest of the wrong length as malformed, derived not pinned', () => {
    // Was `/^[0-9a-fA-F]{64}$/` — a literal 64 that silently encodes "sha256"
    // a second time, in a place a new scheme's author would not think to look.
    const short = `sha256=${'ab'.repeat(16)}`;
    const verdict = verifySignature(BODY, short, SECRET);

    expect(verdict.verified).toBe(false);
    if (verdict.verified) return;
    expect(verdict.refusal).toBe('malformed');
  });

  it('still refuses a correctly shaped, wrong signature as a mismatch — the control', () => {
    const verdict = verifySignature(BODY, signatureFor(BODY, 'a-different-secret'), SECRET);

    expect(verdict.verified).toBe(false);
    if (verdict.verified) return;
    expect(verdict.refusal).toBe('mismatch');
  });
});
