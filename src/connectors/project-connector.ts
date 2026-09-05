import {
  ProjectOperation,
  type ProjectIssue,
  type ProjectQuery,
  type ProjectSource,
} from '../providers/contracts/source-project.js';
import type {
  AcquiredRecord,
  AcquisitionPage,
  AcquisitionRequest,
  NormalizationContext,
  SourceConnector,
  SourceContribution,
  SourceIdentity,
} from '../providers/contracts/source-connector.js';
import { SOURCE_CONNECTOR_CONTRACT_VERSION } from '../providers/contracts/source-connector.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

import { modelProject } from '../project/model.js';

/**
 * The first connector, and it is a real one — EPIC-119 §8.5.
 *
 * A contract that has only ever been implemented by a test double is a contract
 * nobody has checked. This adapts the providers Ferret already ships — the
 * GitHub provider (EPIC-021) and the Jira provider (EPIC-071), both of which
 * implement `ProjectSource` — onto the universal boundary, without either of
 * them changing a line.
 *
 * That is the acceptance criterion stated as code: *a concrete source can
 * implement the contract without bespoke ingestion architecture*. This file is
 * the entire adaptation. There is no transport in it, no paging of its own, no
 * storage, and no second model — `acquire` calls the operation the provider
 * declared, and `normalize` calls EPIC-072's `modelProject`, which is the same
 * function `ferret sync` calls.
 *
 * **Issues only, deliberately.** `ProjectSource` requires `listIssues` and makes
 * everything else optional, so issues are the only collection every project
 * provider has. Widening this to pull requests and reviews would mean paging
 * three collections against one cursor, which is `ProjectSynchronizer`'s job and
 * is already done well; EPIC-119 is the boundary, not a second synchronizer.
 */

/** The record kind this connector acquires. */
export const PROJECT_ISSUE_RECORD = 'issue';

export interface ProjectConnectorOptions {
  readonly source: ProjectSource;
  /** The provider id, which is what the connector is attributed as. */
  readonly connectorId: string;
  /** The external system observed — `github`, `jira`. */
  readonly system: string;
  /**
   * Which deployment of that system: `github.com`, `acme.atlassian.net`.
   *
   * Required rather than defaulted. A default would silently file a self-hosted
   * GitHub Enterprise repository under the same identity as a public one with
   * the same `owner/repo`, and the two are not the same source.
   */
  readonly instance: string;
  /** Operations the provider declared. An undeclared one is never called. */
  readonly operations: readonly string[];
  /** A tracker is the system of record for its own issues. Default: true. */
  readonly systemOfRecord?: boolean;
}

export function projectSourceConnector(options: ProjectConnectorOptions): SourceConnector {
  const operations = new Set(options.operations);
  return {
    connectorId: options.connectorId,
    contractVersion: SOURCE_CONNECTOR_CONTRACT_VERSION,
    system: options.system,
    systemOfRecord: options.systemOfRecord ?? true,

    identify(resource: string): SourceIdentity {
      return { system: options.system, instance: options.instance, resource: resource.trim() };
    },

    async acquire(
      request: AcquisitionRequest,
      context: ProviderOperationContext,
    ): Promise<AcquisitionPage> {
      // An operation the provider did not declare is not called. The alternative
      // is discovering it by exception at the call site, which `source.project`
      // already refused for the same reason.
      if (!operations.has(ProjectOperation.LIST_ISSUES)) return { records: [] };

      const query: ProjectQuery = {
        project: request.identity.resource,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
      };
      const page = await options.source.listIssues(query, context);

      // `304 Not Modified` is carried through rather than collapsed into an
      // empty page: the caller's copy being current is a different fact from
      // there being nothing.
      if (page.unchanged === true) {
        return {
          records: [],
          unchanged: true,
          ...(page.etag === undefined ? {} : { checkpoint: { etag: page.etag } }),
        };
      }

      return {
        records: page.items.map(toRecord),
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page.etag === undefined ? {} : { checkpoint: { etag: page.etag } }),
      };
    },

    normalize(
      records: readonly AcquiredRecord[],
      context: NormalizationContext,
    ): SourceContribution {
      // The payloads are the provider's own `ProjectIssue` values, put back the
      // way they came. Nothing is re-parsed: `toRecord` carried the issue whole
      // precisely so this step is a projection rather than a second decoding.
      const issues = records
        .filter((record) => record.kind === PROJECT_ISSUE_RECORD)
        .map((record) => record.payload as ProjectIssue);

      const modelled = modelProject(
        {
          repositoryId: context.sourceEntityId,
          project: context.identity.resource,
          ...(issues.length === 0 ? {} : { issues }),
        },
        context.emitter,
      );

      return {
        entities: modelled.entities,
        relationships: modelled.relationships,
        evidence: modelled.evidence,
        placeholderEntityIds: modelled.placeholderEntityIds,
        skipped: modelled.skipped.map((record) => ({
          id: record.id,
          kind: PROJECT_ISSUE_RECORD,
          reason: record.reason,
        })),
      };
    },
  };
}

/**
 * One issue, as an acquired record.
 *
 * The id is the tracker's own — `owner/repo#123`, `FER-12` — which is what makes
 * repeated ingestion idempotent: the canonical entity id derives from it, so
 * acquiring the same issue on Monday and again on Tuesday writes one row.
 */
function toRecord(issue: ProjectIssue): AcquiredRecord {
  return {
    id: issue.id,
    kind: PROJECT_ISSUE_RECORD,
    payload: issue,
    metadata: {
      title: issue.title,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      ...(issue.createdAt === undefined ? {} : { createdAt: issue.createdAt }),
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
      ...(issue.labels === undefined ? {} : { labels: issue.labels }),
      attributes: { state: issue.state, lifecycle: issue.lifecycle },
    },
  };
}
