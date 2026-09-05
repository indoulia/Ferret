import { EntityKind, RelationshipType } from '../domain/index.js';
import type { CanonicalEntity } from '../domain/index.js';
import type { RelationshipWriter } from '../indexing/ports.js';
import type { Logger } from '../logging/index.js';
import { throwIfAborted } from '../providers/sdk/cancellation.js';
import type { Emitter } from '../providers/sdk/emit.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';
import type { AccessContext, RetrievalPort } from '../retrieval/index.js';

/**
 * One context out of many sources — EPIC-124.
 *
 * The four connectors each produce a correct graph of their own source, and
 * three of the four hops in the question this Epic exists for already resolve:
 *
 * ```
 * Jira issue → GitHub pull request → commit → repository files → Confluence page
 *              └──── PULL_REQUEST_PROPOSES_COMMIT ──┘  └─ COMMIT_MODIFIES_FILE ─┘
 * ```
 *
 * The hops that did not are the **cross-source** ones, and they could not,
 * because of where a connector sits. `normalize` is pure by contract: it is
 * handed records and an emitter, and it cannot ask the database anything. A
 * pull request body saying `Fixes FER-12` knows a *key*; the Jira issue is
 * identified by a numeric id under a Jira scope. Nothing in the connector has
 * both halves, and nothing should — a connector that queried would be doing
 * retrieval during ingestion.
 *
 * So the join happens **after** ingestion, here, where a store can be read.
 * That is not a new idea in Ferret: `proposeResolutions` (EPIC-051) was written
 * for exactly this shape and has never had a caller.
 *
 * **This does not merge anything.** It asserts edges between entities that
 * already exist, using relationship types that already exist. Two records that
 * might be the same *thing* is `IdentityStore.merge`'s question and stays
 * there; this answers the far narrower one of whether a record *mentions*
 * another, which a quoted identifier settles.
 *
 * **Nothing here reasons.** It matches identifiers against `externalIds` and
 * stops. There is no model call, no scoring, no guess: a reference either names
 * an entity Ferret holds or it does not, and one that does not is counted
 * rather than invented.
 */

/**
 * How a reference named its target. Reported so a result is reviewable.
 *
 * `CrossSourceReferenceKind` rather than `ReferenceKind`: EPIC-035 already
 * exports a `ReferenceKind` for *code* reference resolution, and the codebase
 * has this exact note beside `CrossSourceRule` — two exports called the same
 * thing is how a consumer imports the wrong one. Found by the compiler, which
 * is where it should be found.
 */
export const CrossSourceReferenceKind = {
  /** `FER-12` — a tracker key. */
  TRACKER_KEY: 'tracker-key',
  /** `owner/repo#12` — a fully-qualified project reference. */
  PROJECT_NUMBER: 'project-number',
  /** A Confluence page URL, which carries the page id. */
  PAGE_URL: 'page-url',
  /** A Jira browse URL, which carries the key. */
  ISSUE_URL: 'issue-url',
} as const;

export type CrossSourceReferenceKind =
  (typeof CrossSourceReferenceKind)[keyof typeof CrossSourceReferenceKind];

export interface CrossSourceReference {
  readonly kind: CrossSourceReferenceKind;
  /** The system the identifier belongs to — `jira`, `github`, `confluence`. */
  readonly system: string;
  /** The identifier as another system would quote it. */
  readonly id: string;
  /** Whether the surrounding text closed the referenced work. */
  readonly closing: boolean;
  /** The text the reference was found in, for the evidence trail. */
  readonly text: string;
}

/**
 * Characters of a record scanned for references.
 *
 * The bound and the reason `MAX_REFERENCE_SCAN_CHARACTERS` gives: a body is
 * text somebody pasted, and a reference that appears only after 200 KB of one
 * is not the reference anybody is looking for.
 */
export const MAX_SCAN_CHARACTERS = 200_000;

/** `Fixes`, `Closes`, `Resolves` — the words that make a mention a resolution. */
const CLOSING_WORD = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)$/i;

/**
 * `FER-12`, and not `HTTP-2` or `UTF-8`.
 *
 * Two to ten uppercase letters, a hyphen, digits — Atlassian's own shape for a
 * project key. Bounded on both sides so `NOT-FER-12` and `FER-12x` do not
 * match: a reference has to be a whole token to be a reference.
 */
const TRACKER_KEY = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9-])/g;

/** `owner/repo#12`. The unqualified `#12` is same-repository and already modelled. */
const PROJECT_NUMBER = /(?<![A-Za-z0-9_/-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,9})(?![A-Za-z0-9-])/g;

/** `https://acme.atlassian.net/wiki/spaces/DEV/pages/12345/Title`. */
const PAGE_URL = /https?:\/\/[^\s"'<>]*\/wiki\/(?:spaces\/[^\s"'<>/]+\/)?pages\/(\d{2,})/g;

/** `https://acme.atlassian.net/browse/FER-12`. */
const ISSUE_URL = /https?:\/\/[^\s"'<>]*\/browse\/([A-Z][A-Z0-9]{1,9}-\d{1,9})/g;

/**
 * Every distinct cross-source reference in a piece of text.
 *
 * Order is first appearance, so a given text always yields the same list — the
 * property a deterministic pass depends on.
 *
 * The text is **untrusted content a stranger wrote**. Nothing here fetches what
 * it names or executes any part of it; a match produces an identifier, and what
 * that identifier turns into is settled by a lookup against what Ferret already
 * holds.
 */
export function findCrossSourceReferences(
  text: string | undefined,
  options: { readonly projects?: ReadonlySet<string> } = {},
): readonly CrossSourceReference[] {
  if (text === undefined || text.length === 0) return [];
  const scanned = text.length > MAX_SCAN_CHARACTERS ? text.slice(0, MAX_SCAN_CHARACTERS) : text;

  const found: CrossSourceReference[] = [];
  const seen = new Set<string>();
  const add = (reference: CrossSourceReference): void => {
    const key = `${reference.system}:${reference.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(reference);
  };

  for (const match of scanned.matchAll(ISSUE_URL)) {
    const key = match[1];
    if (key !== undefined) {
      add({
        kind: CrossSourceReferenceKind.ISSUE_URL,
        system: 'jira',
        id: key,
        closing: closes(scanned, match.index),
        text: match[0],
      });
    }
  }

  for (const match of scanned.matchAll(PAGE_URL)) {
    const id = match[1];
    if (id !== undefined) {
      add({
        kind: CrossSourceReferenceKind.PAGE_URL,
        system: 'confluence',
        id,
        closing: false,
        text: match[0],
      });
    }
  }

  for (const match of scanned.matchAll(PROJECT_NUMBER)) {
    const [, project, number] = match;
    if (project === undefined || number === undefined) continue;
    add({
      kind: CrossSourceReferenceKind.PROJECT_NUMBER,
      system: 'github',
      id: `${project}#${number}`,
      closing: closes(scanned, match.index),
      text: match[0],
    });
  }

  for (const match of scanned.matchAll(TRACKER_KEY)) {
    const [, project, number] = match;
    if (project === undefined || number === undefined) continue;
    // **A key is only a key if Ferret holds that project.**
    //
    // `UTF-8`, `HTTP-2` and `RFC-7540` are all the shape of a tracker key, and
    // no pattern distinguishes them from `FER-12` — because nothing about the
    // text does. What distinguishes them is whether anybody has a project
    // called `UTF`. Filtering on the projects actually ingested turns an
    // unanswerable question about English into a lookup, and keeps `unresolved`
    // meaning "a source has not been ingested yet" rather than "this body
    // mentions a character encoding".
    //
    // A caller that passes no set gets every candidate, which is what a
    // diagnostic asking "what does this text mention" wants.
    if (options.projects !== undefined && !options.projects.has(project)) continue;
    add({
      kind: CrossSourceReferenceKind.TRACKER_KEY,
      system: 'jira',
      id: `${project}-${number}`,
      closing: closes(scanned, match.index),
      text: match[0],
    });
  }

  return found;
}

/**
 * Whether the words immediately before a reference closed it.
 *
 * The same convention GitHub and Jira both use, read the same way
 * `findClosingReferences` reads it — a keyword, optional punctuation, then the
 * reference. Looking backwards a fixed distance rather than parsing a sentence:
 * "fixes FER-12" is a claim about FER-12, and "we discussed fixing the approach
 * in FER-12" is not, but no amount of regular expression settles the hard cases
 * and pretending otherwise would put a guess in the graph.
 */
function closes(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 24), at).trimEnd().replace(/[\s:,-]+$/, '');
  return CLOSING_WORD.test(before);
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface CrossSourceDependencies {
  /** Reads what has already been ingested. Never writes. */
  readonly retrieval: RetrievalPort;
  /** Asserts the edges. The same port every other write path uses. */
  readonly relationships: RelationshipWriter;
  /** Attaches provenance, exactly as a connector's would. */
  readonly emitter: Emitter;
  readonly logger?: Logger;
}

export interface CrossSourceOptions {
  /**
   * The source entities to link, by the id each was ingested under.
   *
   * Required, and deliberately not "everything": a pass over the whole store
   * would grow with the database and would cross an authorization boundary the
   * caller never named. The scopes a caller passes are the scopes it already
   * had the right to read.
   */
  readonly scopes: readonly string[];
  /** Entities examined per scope. A ceiling the caller may lower. */
  readonly limit?: number;
  /** Find the references and report them, and write nothing. */
  readonly dryRun?: boolean;
}

/** One reference that resolved, and what it became. */
export interface ResolvedLink {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
  readonly reference: CrossSourceReference;
}

export interface CrossSourceReport {
  /** Entities read and scanned. */
  readonly examined: number;
  /** References found in them, resolved or not. */
  readonly references: number;
  readonly links: readonly ResolvedLink[];
  /**
   * References that named nothing Ferret holds.
   *
   * Counted rather than dropped, and **not** turned into placeholder entities:
   * a key quoted in a body is somebody's assertion that a thing exists, and
   * minting an entity from it would let a typo create an issue. `unresolved`
   * being large is the honest signal that a source has not been ingested yet.
   */
  readonly unresolved: number;
  readonly dryRun: boolean;
}

/** Entities read per scope when a caller does not say. */
export const DEFAULT_EXAMINE_LIMIT = 500;

/**
 * Link what one source says about another — EPIC-124.
 *
 * Reads the entities in the given scopes, finds the identifiers their text
 * quotes, resolves each against `externalIds`, and asserts an edge. Idempotent
 * by construction: the edge is keyed by its endpoints and the relationship
 * writer asserts rather than appends, so running it twice changes nothing.
 */
export async function linkCrossSourceReferences(
  dependencies: CrossSourceDependencies,
  options: CrossSourceOptions,
  access: AccessContext,
  context: ProviderOperationContext,
): Promise<CrossSourceReport> {
  const limit = options.limit ?? DEFAULT_EXAMINE_LIMIT;

  // Phase one: read every scope once, and learn which projects Ferret holds.
  //
  // Reading first is what makes the scan answerable at all: a tracker key is
  // only a key if somebody has that project, and the pass cannot know which
  // projects it has until it has looked.
  //
  // The prefixes come from each issue's `key` attribute rather than from its
  // `externalIds`, because `RetrievalStore.findEntities` deliberately does not
  // hydrate external ids — its own comment says so, and it is right to: a
  // search result would pay a second query per row for a field almost no caller
  // reads. So they are resolved one at a time below, and only for references
  // that were actually found.
  const entities: CanonicalEntity[] = [];
  const projects = new Set<string>();

  for (const scope of options.scopes) {
    throwIfAborted(context.signal, 'cross-source');
    const page = await dependencies.retrieval.findEntities({ scope, limit }, access);
    for (const entity of page.entities) {
      entities.push(entity);
      const key = entity.attributes['key'];
      const prefix = typeof key === 'string' ? /^([A-Z][A-Z0-9]{1,9})-\d{1,9}$/.exec(key)?.[1] : undefined;
      if (prefix !== undefined) projects.add(prefix);
    }
  }

  /** Resolved targets, so a key quoted on forty records is looked up once. */
  const resolved = new Map<string, CanonicalEntity | undefined>();

  const links: ResolvedLink[] = [];
  let references = 0;
  let unresolved = 0;

  // Phase two: scan, in the order the entities were read, so the result is the
  // same list every time it is asked for.
  for (const entity of entities) {
    throwIfAborted(context.signal, 'cross-source');

    // Title and body, which is all of an entity's own words. Attributes like a
    // branch name are the source's structure rather than somebody's prose, and
    // scanning them would turn a ref called `FER-12` into a claim about an
    // issue.
    const text = [entity.attributes['title'], entity.attributes['description']]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');

    for (const reference of findCrossSourceReferences(text, { projects })) {
      references += 1;
      const key = `${reference.system}:${reference.id}`;
      if (!resolved.has(key)) {
        const found = await dependencies.retrieval.findEntities(
          { externalId: { system: reference.system, id: reference.id }, limit: 1 },
          access,
        );
        resolved.set(key, found.entities[0]);
      }
      const target = resolved.get(key);

      // A reference that names nothing Ferret holds is counted, not invented.
      if (target === undefined) {
        unresolved += 1;
        continue;
      }
      // A record referring to itself is not a cross-source link.
      if (target.id === entity.id) continue;

      const type = edgeFor(entity, target, reference);
      if (type === undefined) continue;

      links.push({ fromId: entity.id, toId: target.id, type, reference });
    }
  }

  if (options.dryRun !== true) {
    const now = new Date();
    for (const link of links) {
      throwIfAborted(context.signal, 'cross-source');
      await dependencies.relationships.assert(
        {
          fromId: link.fromId,
          type: link.type,
          toId: link.toId,
          metadata: { via: link.reference.kind, quoted: link.reference.text },
          sourceSystem: dependencies.emitter.identity.sourceSystem,
        },
        now,
      );
    }
  }

  const examined = entities.length;
  dependencies.logger?.info(
    {
      operation: 'context.cross-source',
      scopes: options.scopes.length,
      examined,
      linked: links.length,
      unresolved,
    },
    `Linked ${String(links.length)} cross-source references`,
  );

  return {
    examined,
    references,
    links,
    unresolved,
    dryRun: options.dryRun === true,
  };
}

/**
 * Which existing edge a reference becomes — **no new relationship type**.
 *
 * The three cases Ferret's model already had a word for:
 *
 * - A pull request whose body *closes* an issue resolves it. EPIC-072's own
 *   edge, reached across sources for the first time.
 * - A document — a wiki page, a comment — that names anything *describes* it.
 *   `DOCUMENT_DESCRIBES_ENTITY` has always been "this document is about that
 *   thing", and a page linking to an issue is exactly that.
 * - Anything else between two issues is a link, carrying the word `mentions`
 *   in its metadata. `ISSUE_LINKS_ISSUE` was made generic in EPIC-122 precisely
 *   so a relation Ferret cannot name still arrives intact.
 *
 * A pair with no sensible edge yields none. Inventing one would put a
 * relationship in the graph that nothing can interpret.
 */
function edgeFor(
  from: CanonicalEntity,
  to: CanonicalEntity,
  reference: CrossSourceReference,
): string | undefined {
  if (from.kind === EntityKind.DOCUMENT) return RelationshipType.DOCUMENT_DESCRIBES_ENTITY;

  if (from.kind === EntityKind.PULL_REQUEST && to.kind === EntityKind.ISSUE) {
    return reference.closing
      ? RelationshipType.PULL_REQUEST_RESOLVES_ISSUE
      : // A pull request that merely mentions an issue has not resolved it, and
        // there is no `pull_request_mentions_issue`. Saying nothing is better
        // than saying the wrong thing about whether work is done.
        undefined;
  }

  if (from.kind === EntityKind.ISSUE && to.kind === EntityKind.ISSUE) {
    return RelationshipType.ISSUE_LINKS_ISSUE;
  }

  if (to.kind === EntityKind.DOCUMENT) return undefined;

  return undefined;
}
