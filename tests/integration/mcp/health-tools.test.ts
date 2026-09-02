import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Permission, type Principal } from '../../../src/authorization/index.js';
import {
  DependencyStatus,
  HealthArea,
  type HealthComponent,
  type HealthReport,
} from '../../../src/diagnostics/index.js';
import { ErrorCode } from '../../../src/errors/index.js';
import { registerHealthTools, type HealthAccess, type IndexCounts } from '../../../src/mcp/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';

/**
 * Health over MCP — EPIC-070, through the real protocol.
 *
 * `validation/EPIC-004-VALIDATION.md` has carried one row since EPIC-004: an AI
 * client had to shell out to `ferret status --json`. Shelling out is the part
 * that does not work — an MCP client is often a process with no shell and no
 * `ferret` on its path — so "the report is already structured for it" has been
 * true and unreachable for the whole life of the project.
 */

const GRANTED: Principal = {
  id: 'test.health',
  class: 'agent',
  permissions: [Permission.READ],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const NO_READ: Principal = { ...GRANTED, id: 'test.blind', permissions: [Permission.INDEX] };

const HEALTHY: HealthComponent = {
  name: 'postgres',
  area: HealthArea.DATABASE,
  status: DependencyStatus.OK,
  required: true,
  detail: 'PostgreSQL 17.2 at db.internal:5432',
};

/** A check that could not run — the case §8.3 refuses to omit. */
const UNKNOWN: HealthComponent = {
  name: 'index-integrity',
  area: HealthArea.INDEX,
  status: DependencyStatus.UNKNOWN,
  required: false,
  detail: 'The index cannot be assessed without a database connection',
  remediation: 'Configure a database with `ferret init --save`, then run `ferret status` again.',
};

function reportOf(
  components: readonly HealthComponent[],
  status: DependencyStatus = DependencyStatus.OK,
): HealthReport {
  return {
    status,
    checkedAt: '2026-09-03T00:00:00.000Z',
    durationMs: 12,
    components,
    summary: components.length === 0 ? 'Nothing was checked' : `${String(components.length)} component(s) checked`,
    ferret: { version: '0.1.0-test', node: '22.0.0', platform: process.platform },
  };
}

const INVENTORY: IndexCounts = {
  entities: [
    { kind: 'file', count: 611 },
    { kind: 'commit', count: 128 },
  ],
  evidence: 1_560,
  relationships: 4_728,
  contentBlobs: 590,
  contentBytes: 2_400_000,
  lastRun: {
    repository: '/repos/ferret',
    outcome: 'succeeded',
    finishedAt: '2026-09-02T23:00:00.000Z',
    ageSeconds: 3_600,
  },
};

const EMPTY: IndexCounts = {
  entities: [],
  evidence: 0,
  relationships: 0,
  contentBlobs: 0,
  contentBytes: 0,
  lastRun: undefined,
};

interface Harness {
  readonly client: Client;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(health: HealthAccess, principal: Principal = GRANTED): Promise<Harness> {
  const server = new McpServer({ name: 'ferret-health-test', version: '0.0.0' });
  registerHealthTools(server, { health, principal, logger: new RecordingLogger() });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'health-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const created: Harness = { client, close: async () => client.close() };
  open.push(created);
  return created;
}

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly isError: boolean;
}

async function call(client: Client): Promise<CallResult> {
  const result = (await client.callTool({ name: 'ferret_health', arguments: {} })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    body: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
    isError: result.isError === true,
  };
}

afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

describe('the report reaches a client — AC-1 to AC-6', () => {
  it('returns the aggregate status and every component — AC-1, AC-2', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY, UNKNOWN], DependencyStatus.DEGRADED)),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { body } = await call(client);
    const components = body.components as HealthComponent[];

    expect(body.status).toBe(DependencyStatus.DEGRADED);
    expect(components).toHaveLength(2);
    expect(components[0]?.required).toBe(true);
    expect(components[1]?.remediation).toContain('ferret init --save');
  });

  it('reports a check that could not run rather than omitting it — AC-3', async () => {
    // EPIC-004's own reasoning: an operator must "see that a check did not run,
    // rather than having to notice that a name is missing" — and a client is
    // worse at noticing an absence than a person is.
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([UNKNOWN], DependencyStatus.UNKNOWN)),
      inventory: () => Promise.resolve(undefined),
    });

    const { body } = await call(client);
    const components = body.components as HealthComponent[];

    expect(components.map((one) => one.name)).toStrictEqual(['index-integrity']);
    expect(components[0]?.status).toBe(DependencyStatus.UNKNOWN);
  });

  it('names the versions and the platform — AC-4', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { body } = await call(client);

    expect(body.ferret).toMatchObject({ version: '0.1.0-test', node: '22.0.0' });
  });

  it('carries the inventory and the last run — AC-5, AC-6', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { body } = await call(client);
    const index = body.index as Record<string, unknown>;

    expect(index.available).toBe(true);
    expect(index.totalEntities).toBe(739);
    expect(index.evidence).toBe(1_560);
    expect(index.relationships).toBe(4_728);
    expect(index.contentBlobs).toBe(590);
    expect((index.lastRun as { ageSeconds: number }).ageSeconds).toBe(3_600);
  });
});

describe('an empty or unreachable index is a report, not an error — AC-7, AC-8', () => {
  it('says an empty index is empty, and why that is not a failure — AC-7', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.resolve(EMPTY),
    });

    const { body, isError } = await call(client);

    expect(isError).toBe(false);
    expect((body.index as { totalEntities: number }).totalEntities).toBe(0);
    // The reason this tool exists to be called first: an empty index and an
    // unmatched query look identical from a result set.
    expect(String(body.notice)).toContain('Nothing is indexed');
    expect(String(body.notice)).toContain('not a failure');
  });

  it('returns a report when the database is unreachable — AC-8', async () => {
    // Governance §20: `status` and `doctor` must stay dependable "when other
    // subsystems are unhealthy, which is precisely when they are worth
    // running". A health tool that failed then would be useless at the only
    // moment it matters.
    const { client } = await harness({
      probe: () =>
        Promise.resolve(
          reportOf(
            [{ ...HEALTHY, status: DependencyStatus.UNAVAILABLE, detail: 'Connection refused' }],
            DependencyStatus.UNAVAILABLE,
          ),
        ),
      inventory: () => Promise.resolve(undefined),
    });

    const { body, isError } = await call(client);

    expect(isError).toBe(false);
    expect(body.status).toBe(DependencyStatus.UNAVAILABLE);
    expect((body.index as { available: boolean }).available).toBe(false);
    expect(String((body.index as { detail: string }).detail)).toContain('No database is reachable');
  });

  it('reports an inventory that threw as an absence with a reason', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.reject(new Error('relation does not exist')),
    });

    const { body, isError } = await call(client);

    // The inventory needs a database and the report does not, so a failure
    // here must not fail the whole call.
    expect(isError).toBe(false);
    expect((body.index as { available: boolean }).available).toBe(false);
    // And the driver's message is not what a client is handed.
    expect(JSON.stringify(body)).not.toContain('relation does not exist');
  });
});

describe('the tool is guarded and bounded — AC-9 to AC-14', () => {
  it('is refused without READ — AC-9', async () => {
    const { client } = await harness(
      { probe: () => Promise.resolve(reportOf([HEALTHY])), inventory: () => Promise.resolve(INVENTORY) },
      NO_READ,
    );

    const { body, isError } = await call(client);

    expect(isError).toBe(true);
    expect(body.code).toBe(ErrorCode.NOT_PERMITTED);
  });

  it('is annotated read-only, and is the only tool registered — AC-10, AC-11, AC-14', async () => {
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toStrictEqual(['ferret_health']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    // AC-14 — MCP's own `listTools` is the discovery mechanism, and a
    // Ferret-specific catalogue would be a second copy that goes stale.
    expect(tools.map((tool) => tool.name)).not.toContain('ferret_tools');
  });

  it('leaks no credential or connection string — AC-12', async () => {
    const { client } = await harness({
      probe: () =>
        Promise.resolve(
          reportOf([{ ...HEALTHY, detail: 'PostgreSQL 17.2 at db.internal:5432' }]),
        ),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { body } = await call(client);

    // `probeHealth`'s components already carry no credential and
    // `describeConnection` redacts; this asserts it rather than trusting it,
    // because a health report is the response most likely to grow a connection
    // string by accident.
    expect(JSON.stringify(body)).not.toMatch(/postgres(?:ql)?:\/\//);
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('carries no capability list and no provider state — AC-13', async () => {
    // §8.4. Two tools that both drifted toward "everything about the server"
    // would end up disagreeing, and a client would have no way to know which
    // to trust. This one points at the other instead.
    const { client } = await harness({
      probe: () => Promise.resolve(reportOf([HEALTHY])),
      inventory: () => Promise.resolve(INVENTORY),
    });

    const { body } = await call(client);

    expect(body.availableCapabilities).toBeUndefined();
    expect(body.missingCapabilities).toBeUndefined();
    expect(String(body.providers)).toContain('ferret_providers');
  });
});
