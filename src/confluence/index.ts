/**
 * The Confluence provider — EPIC-123.
 *
 * The first provider to declare `source.connector`. EPIC-119 wrote that
 * contract for a source that is neither a Git checkout nor a tracker, and until
 * now every implementation of it was an *adapter* over a contract that already
 * existed. A wiki page is neither, so this one implements the three verbs
 * itself — which is the case the boundary was cut for.
 *
 * Like the other providers it brings no dependency: the transport is the
 * platform's `fetch`, through the Atlassian client it shares with Jira.
 */

export {
  CONFLUENCE_API_PATH,
  CONFLUENCE_MAX_PAGE_SIZE,
  CONFLUENCE_PAGE_RECORD,
  CONFLUENCE_PROVIDER_ID,
  CONFLUENCE_SOURCE_SYSTEM,
  ConfluenceProvider,
  confluenceOptionsSchema,
  createConfluenceProvider,
  type ConfluenceProviderOptions,
} from './provider.js';

export {
  MAX_BODY_SCAN_CHARACTERS,
  PageReferenceKind,
  findPageReferences,
  type PageReference,
} from './references.js';
