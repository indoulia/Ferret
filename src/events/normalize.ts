/**
 * A webhook payload as a change notification — EPIC-077 §8.4.
 *
 * Ferret does not ingest a webhook's *contents*. A payload is a vendor's own
 * JSON, shaped for its own convenience, and modelling it would be a third
 * extraction path beside EPIC-021's records and EPIC-072's modelling — with the
 * additional property that its input is attacker-supplied.
 *
 * What a webhook is good for is saying **what changed**, so that the next
 * incremental read is targeted rather than a poll of everything. That is all
 * this produces: a subject, a source, and a delivery id for idempotence.
 */

/** What kind of thing changed. Coarse, because a re-read is coarse. */
export const EventSubject = {
  REPOSITORY: 'repository',
  ISSUE: 'issue',
  PULL_REQUEST: 'pull-request',
  REVIEW: 'review',
  RELEASE: 'release',
  DEPLOYMENT: 'deployment',
  COMMENT: 'comment',
  /** A push: commits changed, so the repository's history is stale. */
  HISTORY: 'history',
} as const;

export type EventSubject = (typeof EventSubject)[keyof typeof EventSubject];

export interface SourceEvent {
  /**
   * The delivery's own id, for idempotence — §8.5.
   *
   * EPIC-080 requires reprocessing not to duplicate. A webhook is redelivered
   * on any non-2xx, and every vendor redelivers on a timeout it decided about
   * unilaterally, so "have I already seen this one" is the question that keeps
   * a retry from becoming a second write.
   */
  readonly deliveryId: string;
  readonly sourceSystem: string;
  readonly subject: EventSubject;
  /** The project the change is in: `owner/repo`, `FER`. */
  readonly project?: string;
  /** The record's own identifier, when the payload names one. */
  readonly reference?: string;
  /** The vendor's event name, verbatim — `pull_request.closed`. */
  readonly event: string;
  /** When the sender says it happened, when it says. */
  readonly occurredAt?: string;
}

export interface NormalizeResult {
  readonly event?: SourceEvent;
  /**
   * Why nothing was produced.
   *
   * A recognised event Ferret has no use for and an unrecognised one are
   * different facts: the first is a decision and the second is a gap, and an
   * operator counting webhook traffic needs to tell them apart.
   */
  readonly ignored?: 'unsupported-event' | 'unparseable' | 'no-delivery-id';
}

/**
 * GitHub's event names, mapped to what they invalidate.
 *
 * Only events that change something Ferret indexes. `star`, `watch`, `fork` and
 * `member` are real events and change nothing Ferret holds, so they are
 * *unsupported* rather than unrecognised — and the distinction is in the result.
 */
const GITHUB_SUBJECTS: Readonly<Record<string, EventSubject>> = Object.freeze({
  push: EventSubject.HISTORY,
  create: EventSubject.HISTORY,
  delete: EventSubject.HISTORY,
  issues: EventSubject.ISSUE,
  issue_comment: EventSubject.COMMENT,
  pull_request: EventSubject.PULL_REQUEST,
  pull_request_review: EventSubject.REVIEW,
  pull_request_review_comment: EventSubject.COMMENT,
  release: EventSubject.RELEASE,
  deployment: EventSubject.DEPLOYMENT,
  deployment_status: EventSubject.DEPLOYMENT,
  repository: EventSubject.REPOSITORY,
});

/**
 * A GitHub delivery, as a change notification.
 *
 * `body` is parsed here rather than taken as an object, because the *caller*
 * must have kept the raw bytes for `verifySignature` and asking it for both a
 * string and an object invites it to re-serialize one from the other — which is
 * the failure §8.2 exists to prevent.
 */
export function normalizeGithubEvent(
  body: string,
  headers: Readonly<Record<string, string | undefined>>,
): NormalizeResult {
  const event = header(headers, 'x-github-event');
  const deliveryId = header(headers, 'x-github-delivery');
  if (deliveryId === undefined) return { ignored: 'no-delivery-id' };
  if (event === undefined) return { ignored: 'unsupported-event' };

  const subject = GITHUB_SUBJECTS[event];
  if (subject === undefined) return { ignored: 'unsupported-event' };

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return { ignored: 'unparseable' };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ignored: 'unparseable' };
  }

  const action = text(payload['action']);
  const repository = payload['repository'];
  const project =
    typeof repository === 'object' && repository !== null
      ? text((repository as { full_name?: unknown }).full_name)
      : undefined;

  return {
    event: {
      deliveryId,
      sourceSystem: 'github',
      subject,
      // The vendor's own name, verbatim: `pull_request.closed` is what a person
      // will search the vendor's documentation for, and a normalized rewording
      // would be a second vocabulary nobody else uses.
      event: action === undefined ? event : `${event}.${action}`,
      ...(project === undefined ? {} : { project }),
      ...(referenceOf(payload, subject) === undefined
        ? {}
        : { reference: referenceOf(payload, subject) }),
    },
  };
}

/**
 * Jira's event names, mapped the same way.
 *
 * Jira sends `webhookEvent` in the body rather than a header, and has no
 * delivery id at all — §17. The caller supplies one, because a caller that
 * terminated the request has something unique about it and this module does
 * not.
 */
const JIRA_SUBJECTS: Readonly<Record<string, EventSubject>> = Object.freeze({
  jira: EventSubject.ISSUE,
  comment: EventSubject.COMMENT,
});

export function normalizeJiraEvent(body: string, deliveryId: string): NormalizeResult {
  if (deliveryId.length === 0) return { ignored: 'no-delivery-id' };

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return { ignored: 'unparseable' };
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ignored: 'unparseable' };
  }

  const name = text(payload['webhookEvent']);
  if (name === undefined) return { ignored: 'unsupported-event' };
  // `jira:issue_updated`, `comment_created`. The prefix before the colon and
  // the first word after it are what identify the family.
  const family = name.includes(':') ? (name.split(':')[0] ?? '') : (name.split('_')[0] ?? '');
  const subject = JIRA_SUBJECTS[family];
  if (subject === undefined) return { ignored: 'unsupported-event' };

  const issue = payload['issue'];
  const key =
    typeof issue === 'object' && issue !== null ? text((issue as { key?: unknown }).key) : undefined;

  return {
    event: {
      deliveryId,
      sourceSystem: 'jira',
      subject,
      event: name,
      // A Jira key carries its project: `FER-12` is in `FER`, and there is no
      // separate field that says so on every event shape.
      ...(key === undefined ? {} : { project: key.split('-')[0] ?? key, reference: key }),
      ...(text(payload['timestamp']) === undefined
        ? {}
        : { occurredAt: text(payload['timestamp']) }),
    },
  };
}

function referenceOf(payload: Record<string, unknown>, subject: EventSubject): string | undefined {
  if (subject === EventSubject.ISSUE || subject === EventSubject.COMMENT) {
    return numberOf(payload['issue']);
  }
  if (subject === EventSubject.PULL_REQUEST || subject === EventSubject.REVIEW) {
    return numberOf(payload['pull_request']);
  }
  if (subject === EventSubject.RELEASE) {
    const release = payload['release'];
    return typeof release === 'object' && release !== null
      ? text((release as { tag_name?: unknown }).tag_name)
      : undefined;
  }
  if (subject === EventSubject.HISTORY) return text(payload['ref']);
  return undefined;
}

function numberOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const number = (value as { number?: unknown }).number;
  return typeof number === 'number' && Number.isInteger(number) ? String(number) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  // Header names are case-insensitive and every server normalizes differently.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
