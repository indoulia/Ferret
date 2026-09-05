import { z } from 'zod';

import { AtlassianClient, type FetchLike } from '../atlassian/client.js';
import { EntityKind, RelationshipType } from '../domain/index.js';
import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import { Capability, CAPABILITY_VERSIONS, type CapabilityDeclaration } from '../providers/capabilities.js';
import {
  ConnectorOperation,
  SOURCE_CONNECTOR_CONTRACT_VERSION,
  type AcquiredRecord,
  type AcquisitionPage,
  type AcquisitionRequest,
  type NormalizationContext,
  type SkippedSourceRecord,
  type SourceConnector,
  type SourceContribution,
  type SourceIdentity,
} from '../providers/contracts/source-connector.js';
import { BaseProvider } from '../providers/sdk/base.js';
import { ProviderKind, type ProviderContext } from '../providers/contract.js';
import type { DependencyCheckResult } from '../diagnostics/index.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';
import { redactSecrets } from '../security/index.js';

import { findPageReferences, PageReferenceKind, type PageReference } from './references.js';

/**
 * Confluence as a source — EPIC-123.
 *
 * **The first provider to declare `source.connector`.** EPIC-119 wrote that
 * contract for "a source that is neither a Git checkout nor a tracker" and then
 * had nothing to point at: the repository and project connectors are *adapters*
 * over contracts that already existed, so the universal boundary had been
 * proven convenient and never proven necessary. A wiki page is not a branch and
 * is not an issue. There is no third contract to adapt, so this provider
 * implements the three verbs itself, which is the case EPIC-119 was written for
 * and the first real test of its claim.
 *
 * ```
 * identify → acquire → normalize
 * ```
 *
 * A **space** is the source, and a **page** is a `document`. No entity kind was
 * added: `document` already models text with a title, a body, a location and
 * two instants, which is a page. Hierarchy and links are two new edges, and the
 * reason each exists rather than one edge with a flag is recorded on the types.
 *
 * **Not a Confluence replacement.** Nothing here creates, edits, moves,
 * publishes or comments. `get` is the only HTTP verb the transport has, so a
 * token with write scope still cannot change anything through this provider.
 */

export const CONFLUENCE_PROVIDER_ID = 'ferret.source.confluence';

/** The system these observations are about, for evidence and identity. */
export const CONFLUENCE_SOURCE_SYSTEM = 'confluence';

/** Confluence Cloud's v2 REST surface. */
export const CONFLUENCE_API_PATH = '/wiki/api/v2';

/** Confluence's own ceiling for a page of results. Asking for more is clamped. */
export const CONFLUENCE_MAX_PAGE_SIZE = 250;

/** The record kinds this connector acquires. */
export const CONFLUENCE_PAGE_RECORD = 'page';

export const confluenceOptionsSchema = z
  .object({
    /** `https://acme.atlassian.net`. */
    baseUrl: z.string().url(),
    /** Present for Cloud (Basic), absent for Server (Bearer). */
    email: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(CONFLUENCE_MAX_PAGE_SIZE).optional(),
    /** Space keys `ferret sync` reads when none is named. */
    spaces: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type ConfluenceProviderOptions = z.infer<typeof confluenceOptionsSchema> & {
  readonly fetch?: FetchLike;
};

export class ConfluenceProvider extends BaseProvider {
  readonly id = CONFLUENCE_PROVIDER_ID;
  readonly kind = ProviderKind.SOURCE;
  readonly description = 'Confluence pages, their hierarchy, their links and their versions';

  /**
   * The three verbs, declared as operations.
   *
   * All three, because a connector that cannot do one of them is not a
   * connector — the contract's own words. Declaring them individually anyway
   * keeps the shape every other capability uses, so a fourth verb added later
   * does not arrive already claimed.
   */
  readonly capabilities: readonly CapabilityDeclaration[] = [
    {
      capability: Capability.SOURCE_CONNECTOR,
      version: CAPABILITY_VERSIONS[Capability.SOURCE_CONNECTOR],
      operations: [
        ConnectorOperation.IDENTIFY,
        ConnectorOperation.ACQUIRE,
        ConnectorOperation.NORMALIZE,
      ],
      systems: [CONFLUENCE_SOURCE_SYSTEM],
      limits: {
        supportsPagination: true,
        supportsServerSideFilter: false,
        notes:
          'Paged by an opaque cursor Confluence issues; v2 offers no since-filter on a space listing.',
      },
    },
  ];

  readonly configSchema = confluenceOptionsSchema;

  /**
   * The token, declared so it is redactable.
   *
   * Redaction by key name cannot know that `token` is a credential, and a
   * provider that did not declare it would have it printed by `describeConfig`
   * the first time anybody ran `ferret config show`.
   */
  readonly secretOptions: readonly string[] = ['token'];

  /**
   * This provider's three verbs, as a connector.
   *
   * **The provider is not itself a `SourceConnector`, and it cannot be.** Both
   * `Provider` and `SourceConnector` declare a `contractVersion`, and they mean
   * different things: one is the provider platform's version (EPIC-010), the
   * other is the connector contract's (EPIC-119). A class implementing both has
   * one field for two facts. They are both `1` today, so a class that conflated
   * them would compile, pass, and be wrong the moment either moved — which is
   * the kind of defect that is discovered years later by the person debugging
   * the mismatch.
   *
   * Found by being the first provider to declare `source.connector`, which is
   * the only way it could have been found. Exposing the connector as a value
   * costs one property and keeps the two versions apart; `isSourceConnector`
   * answers true for it, and the registry still sees a provider.
   */
  readonly connector: SourceConnector = {
    connectorId: CONFLUENCE_PROVIDER_ID,
    contractVersion: SOURCE_CONNECTOR_CONTRACT_VERSION,
    system: CONFLUENCE_SOURCE_SYSTEM,
    // Confluence owns the pages it reports — EPIC-045. Unlike the repository
    // connector, which declines the claim because the Git provider's own
    // emitter declines it and the two must agree, nothing else in Ferret reads
    // Confluence. There is no second path for this to disagree with.
    systemOfRecord: true,
    identify: (resource) => this.identify(resource),
    acquire: (request, context) => this.acquire(request, context),
    normalize: (records, context) => this.normalize(records, context),
  };

  readonly #options: ConfluenceProviderOptions;
  #client: AtlassianClient | undefined;

  constructor(options: ConfluenceProviderOptions) {
    super();
    this.#options = options;
  }

  protected override onInitialize(_context: ProviderContext): void {
    this.#client = new AtlassianClient({
      baseUrl: this.#options.baseUrl,
      fetch: this.#options.fetch ?? platformFetch(),
      product: 'Confluence',
      ...(this.#options.email === undefined ? {} : { email: this.#options.email }),
      ...(this.#options.token === undefined ? {} : { token: this.#options.token }),
      ...(this.#options.userAgent === undefined ? {} : { userAgent: this.#options.userAgent }),
    });
  }

  checkDependencies(_context: ProviderContext): Promise<readonly DependencyCheckResult[]> {
    // No executable and no native module: the transport is the platform's
    // `fetch`. What could be missing is a credential, and a credential is
    // checked by using it rather than by asking about it.
    return Promise.resolve([]);
  }

  /**
   * A space key, as the identity this source is remembered by.
   *
   * Pure and total, and the resource is the **key** rather than the numeric id:
   * a key is what a person types and what a URL carries, and the contract
   * requires this to answer without a request. The numeric id is what the API
   * pages by, and `acquire` resolves it — which is a request, and is therefore
   * not allowed to happen here.
   */
  identify(resource: string): SourceIdentity {
    return {
      system: CONFLUENCE_SOURCE_SYSTEM,
      instance: hostOf(this.#options.baseUrl),
      resource: resource.trim(),
    };
  }

  async acquire(
    request: AcquisitionRequest,
    context: ProviderOperationContext,
  ): Promise<AcquisitionPage> {
    const client = this.#assertReady();
    const cursor = decodeCursor(request.cursor);

    // The space id, resolved once and carried in the cursor. Confluence pages a
    // space by its **numeric id** and people name it by its key, so one lookup
    // stands between the two — and putting the answer in the cursor means the
    // second page does not repeat it.
    const spaceId = cursor.spaceId ?? (await this.#resolveSpace(client, request.identity, context));

    const page = await client.get<PageListResponse>({
      path: `${CONFLUENCE_API_PATH}/spaces/${encodeURIComponent(spaceId)}/pages`,
      query: {
        limit: Math.min(request.pageSize ?? CONFLUENCE_MAX_PAGE_SIZE, CONFLUENCE_MAX_PAGE_SIZE),
        'body-format': 'storage',
        ...(cursor.next === undefined ? {} : { cursor: cursor.next }),
      },
      signal: context.signal,
    });

    const records = (page?.results ?? []).map((value) => toRecord(value));
    const next = nextCursor(page?._links?.next);

    return {
      records,
      ...(next === undefined ? {} : { cursor: encodeCursor({ spaceId, next }) }),
      // The space id, kept so a later pass does not resolve it again. Opaque to
      // the ingestor, which stores and returns it untouched.
      checkpoint: { spaceId },
    };
  }

  normalize(
    records: readonly AcquiredRecord[],
    context: NormalizationContext,
  ): SourceContribution {
    const emitter = context.emitter;
    const entities: CanonicalEntity[] = [];
    const relationships: CanonicalRelationship[] = [];
    const evidence: CanonicalEvidence[] = [];
    const placeholderEntityIds: string[] = [];
    const skipped: SkippedSourceRecord[] = [];

    /** Every page this batch read, by the id a link or a parent would name. */
    const byId = new Map<string, CanonicalEntity>();
    /** And by title, because storage-format links name a page by its title. */
    const byTitle = new Map<string, CanonicalEntity>();

    const pages: { record: AcquiredRecord; page: ConfluencePage; entity: CanonicalEntity }[] = [];

    for (const record of records) {
      if (record.kind !== CONFLUENCE_PAGE_RECORD) continue;
      const page = record.payload as ConfluencePage;
      if (page.id === undefined || page.title === undefined) {
        // One malformed record must not fail a source — EPIC-072 §8.9's rule.
        // A page with no id cannot be identified and one with no title cannot
        // be read; either way there is nothing to store.
        skipped.push({
          id: record.id,
          kind: CONFLUENCE_PAGE_RECORD,
          reason: page.id === undefined ? 'page has no id' : 'page has no title',
        });
        continue;
      }

      const entity = emitter.entity({
        kind: EntityKind.DOCUMENT,
        source: {
          id: page.id,
          // Scoped to the space, as the contract requires: two spaces' pages
          // are different pages even where a title is shared.
          scope: context.sourceEntityId,
          ...(record.metadata.url === undefined ? {} : { url: record.metadata.url }),
        },
        attributes: {
          title: page.title,
          // The body is **untrusted content a stranger wrote**, and a wiki page
          // is a place people paste terminal sessions into.
          ...(bodyOf(page) === undefined ? {} : { description: redactSecrets(bodyOf(page) as string).text }),
          mediaType: 'text/html',
          ...(record.metadata.url === undefined ? {} : { location: record.metadata.url }),
          ...(page.createdAt === undefined ? {} : { createdAt: page.createdAt }),
          ...(page.version?.createdAt === undefined ? {} : { modifiedAt: page.version.createdAt }),
        },
        unknownFields: {
          // The version *number* is Confluence's own, and `documentAttributes`
          // has no field for one. It is kept verbatim rather than dropped: a
          // page at version 18 and the same page at version 19 are one document
          // whose content changed, and the number is how a reader knows which
          // they are looking at. EPIC-006's rule for a field Ferret does not
          // model.
          ...(page.version?.number === undefined ? {} : { version: page.version.number }),
          ...(page.status === undefined ? {} : { status: page.status }),
          ...(page.spaceId === undefined ? {} : { spaceId: page.spaceId }),
          ...(page.parentId === undefined || page.parentId === null ? {} : { parentId: page.parentId }),
        },
        ...(page.version?.createdAt === undefined ? {} : { sourceObservedAt: page.version.createdAt }),
      });

      entities.push(entity);
      byId.set(page.id, entity);
      byTitle.set(page.title, entity);
      pages.push({ record, page, entity });

      evidence.push(emitter.about(entity, 'title', page.title));
      if (page.version?.number !== undefined) {
        evidence.push(emitter.about(entity, 'version', page.version.number));
      }
    }

    // Hierarchy and links **after** every page of the batch is an entity, so a
    // parent or a target read in the same pass is joined to the record rather
    // than to a stub standing in for it. The same rule EPIC-121 learned for a
    // closing reference, applied before it could be got wrong again.
    for (const { page, entity } of pages) {
      if (page.parentId !== undefined && page.parentId !== null) {
        const parent = byId.get(page.parentId);
        const target =
          parent ??
          placeholder(page.parentId, context.sourceEntityId, emitter, placeholderEntityIds, entities);
        if (target.id !== entity.id) {
          relationships.push(
            emitter.relationship({
              fromId: target.id,
              type: RelationshipType.DOCUMENT_CONTAINS_DOCUMENT,
              toId: entity.id,
              sourceId: page.id,
            }),
          );
        }
      }

      for (const reference of findPageReferences(bodyOf(page))) {
        const target = resolveReference(reference, byId, byTitle);
        if (target === undefined) continue;
        if (target.id === entity.id) continue;
        relationships.push(
          emitter.relationship({
            fromId: entity.id,
            type: RelationshipType.DOCUMENT_LINKS_DOCUMENT,
            toId: target.id,
            metadata: { by: reference.kind },
            sourceId: page.id,
          }),
        );
      }
    }

    return { entities, relationships, evidence, placeholderEntityIds, skipped };
  }

  /**
   * The numeric id Confluence pages a space by, from the key a person typed.
   *
   * One request, and it is why `identify` cannot do this: the contract requires
   * identity to resolve without a network, so that an unreachable space and an
   * unknown one stay distinguishable.
   */
  async #resolveSpace(
    client: AtlassianClient,
    identity: SourceIdentity,
    context: ProviderOperationContext,
  ): Promise<string> {
    const response = await client.get<SpaceListResponse>({
      path: `${CONFLUENCE_API_PATH}/spaces`,
      query: { keys: identity.resource, limit: 1 },
      signal: context.signal,
    });
    const id = response?.results?.[0]?.id;
    if (id === undefined) {
      throw new FerretError(
        ErrorCode.SOURCE_UNAVAILABLE,
        `Confluence has no space with the key "${identity.resource}"`,
        {
          details: { space: identity.resource, instance: identity.instance },
          remediation: 'Name the space by its key — the part a page URL carries after `/spaces/`.',
        },
      );
    }
    return id;
  }

  #assertReady(): AtlassianClient {
    if (this.#client === undefined) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        'The Confluence provider was used before it was initialized',
        {
          details: { providerId: this.id },
          remediation: 'Await runtime.initialize() first.',
        },
      );
    }
    return this.#client;
  }
}

/** Convenience constructor matching the style of the other providers. */
export function createConfluenceProvider(options: ConfluenceProviderOptions): ConfluenceProvider {
  return new ConfluenceProvider(options);
}

// ---------------------------------------------------------------------------
// Wire shapes, as Confluence v2 sends them
// ---------------------------------------------------------------------------

interface ConfluencePage {
  readonly id?: string;
  readonly status?: string;
  readonly title?: string;
  readonly spaceId?: string;
  readonly parentId?: string | null;
  readonly parentType?: string;
  readonly authorId?: string;
  readonly createdAt?: string;
  readonly version?: {
    readonly number?: number;
    readonly createdAt?: string;
    readonly authorId?: string;
    readonly message?: string;
  };
  /**
   * The body, in whichever representation was asked for.
   *
   * v2 answers `{ storage: { value, representation } }` for `body-format=storage`
   * and a bare string in some responses. Both are read rather than one being
   * declared correct, because a caller that guessed wrong would silently index
   * every page with no content at all.
   */
  readonly body?: unknown;
  readonly _links?: { readonly webui?: string };
}

interface PageListResponse {
  readonly results?: readonly ConfluencePage[];
  readonly _links?: { readonly next?: string; readonly base?: string };
}

interface SpaceListResponse {
  readonly results?: readonly { readonly id?: string; readonly key?: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Where a page's text is, whichever shape the response used. */
function bodyOf(page: ConfluencePage): string | undefined {
  const body = page.body;
  if (typeof body === 'string') return body === '' ? undefined : body;
  if (typeof body !== 'object' || body === null) return undefined;
  for (const key of ['storage', 'atlas_doc_format', 'view']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'object' && value !== null) {
      const inner = (value as { value?: unknown }).value;
      if (typeof inner === 'string' && inner !== '') return inner;
    }
  }
  return undefined;
}

function toRecord(page: ConfluencePage): AcquiredRecord {
  const url = page._links?.webui;
  return {
    // The page id: stable across a rename and across a move, which is what
    // makes repeated ingestion write one row rather than two.
    id: page.id ?? '',
    kind: CONFLUENCE_PAGE_RECORD,
    payload: page,
    metadata: {
      ...(page.title === undefined ? {} : { title: page.title }),
      ...(url === undefined ? {} : { url }),
      ...(page.createdAt === undefined ? {} : { createdAt: page.createdAt }),
      ...(page.version?.createdAt === undefined ? {} : { updatedAt: page.version.createdAt }),
      // Confluence's own version marker, which is a *number* and is exactly what
      // a change-detection pass would compare.
      ...(page.version?.number === undefined ? {} : { version: String(page.version.number) }),
      attributes: {
        ...(page.status === undefined ? {} : { status: page.status }),
        ...(page.parentId === undefined || page.parentId === null ? {} : { parentId: page.parentId }),
      },
    },
  };
}

/**
 * A page named by a link or a parent that this pass did not read.
 *
 * A stub carrying the id and nothing else. An id that resolves to nothing *yet*
 * is still the correct id, and it is written `ifAbsent` so the pass that does
 * read the page in full replaces it — issue #48's rule, one layer up.
 */
function placeholder(
  id: string,
  scope: string,
  emitter: NormalizationContext['emitter'],
  placeholderEntityIds: string[],
  entities: CanonicalEntity[],
): CanonicalEntity {
  const entity = emitter.entity({
    kind: EntityKind.DOCUMENT,
    source: { id, scope },
    attributes: {},
  });
  entities.push(entity);
  placeholderEntityIds.push(entity.id);
  return entity;
}

/**
 * The page a reference names, when this batch holds it.
 *
 * A reference by **title** is resolved only against pages read in this pass and
 * never turned into a stub: a title is unique within a space and not beyond it,
 * so minting an entity from one would invent an identity the source never
 * issued. A reference by id is unambiguous, and `normalize` may stub it.
 */
function resolveReference(
  reference: PageReference,
  byId: ReadonlyMap<string, CanonicalEntity>,
  byTitle: ReadonlyMap<string, CanonicalEntity>,
): CanonicalEntity | undefined {
  return reference.kind === PageReferenceKind.ID
    ? byId.get(reference.target)
    : byTitle.get(reference.target);
}

interface AcquisitionCursor {
  /** The space's numeric id, resolved once. */
  readonly spaceId?: string;
  /** Confluence's own opaque cursor for the next page. */
  readonly next?: string;
}

function encodeCursor(cursor: AcquisitionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Read a cursor, treating anything unreadable as the beginning.
 *
 * A cursor is opaque to the ingestor, which stores and returns it verbatim, so
 * a truncated or hand-edited one arrives here as a string that means nothing.
 * Starting over re-reads a space, which is free — every write is an idempotent
 * upsert. Throwing would fail a source over a value the source did not produce.
 */
function decodeCursor(cursor: string | undefined): AcquisitionCursor {
  if (cursor === undefined) return {};
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return {};
    const { spaceId, next } = decoded as { spaceId?: unknown; next?: unknown };
    return {
      ...(typeof spaceId === 'string' ? { spaceId } : {}),
      ...(typeof next === 'string' ? { next } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Confluence's next-page cursor, out of the URL it arrives in.
 *
 * v2 reports paging as `_links.next`, a *relative URL* rather than a token, so
 * the token has to come back out of its query string. Taken by parsing rather
 * than by string-slicing because the value is percent-encoded and the parameter
 * order is not promised.
 */
function nextCursor(next: string | undefined): string | undefined {
  if (next === undefined || next === '') return undefined;
  try {
    // A base is required because the value is relative; it is never requested.
    const value = new URL(next, 'https://placeholder.invalid').searchParams.get('cursor');
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** The deployment this base URL names, for {@link SourceIdentity.instance}. */
function hostOf(baseUrl: string): string {
  try {
    // The host only, and never the URL: a configured base URL carries a
    // credential more often than anyone expects, and `instance` is stored,
    // logged and shown. `SourceIdentity` states the rule.
    return new URL(baseUrl).host;
  } catch {
    return 'unknown';
  }
}

function platformFetch(): FetchLike {
  return (url, init) =>
    fetch(url, { method: init.method, headers: { ...init.headers }, signal: init.signal });
}
