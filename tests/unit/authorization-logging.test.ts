import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfirmationGate,
  EffectChange,
  Permission,
  type OperationPlan,
  type Principal,
} from '../../src/authorization/index.js';
import { AuditWriter, auditEventsPath, readAuditEvents, type AuditEvent } from '../../src/audit/index.js';
import { createDestructiveToolGuard, createToolGuard } from '../../src/mcp/index.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * The four lines four Epics wrote as "loggable" and never wrote — EPIC-091 §2.6.
 *
 * "Loggable" means the data was in hand and nobody emitted it. EPIC-083 is the
 * tell: it states the behaviour in the present tense and then explicitly
 * refuses to build EPIC-085's event shape, so somebody had to emit the ordinary
 * log line. That is this Epic, and these are the assertions.
 *
 * AC-18 runs through all of them: none of these records may carry an
 * audit-event shape or a durable identifier. A log line is level-gated,
 * best-effort and discardable; an audit event is a durable record with a schema
 * and a retention policy, and EPIC-085 owns it.
 */

const GRANTED: Principal = {
  id: 'test.granted',
  class: 'agent',
  permissions: [Permission.READ, Permission.CONFIG_WRITE],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const UNGRANTED: Principal = { ...GRANTED, id: 'test.ungranted', permissions: [Permission.READ] };

function planFor(path: string): OperationPlan {
  return {
    operation: 'test.set',
    summary: `Set ${path}`,
    effects: [{ change: EffectChange.OVERWRITE, target: path, from: 'warn', to: 'debug' }],
  };
}

describe('an authorization decision is logged — AC-13, AC-15', () => {
  it('logs the principal and the permission at debug when it permits', async () => {
    const logger = new RecordingLogger();
    const guard = createToolGuard({ principal: GRANTED, logger });

    await guard('config_set', Permission.CONFIG_WRITE, () => Promise.resolve({ ok: true }));

    const decision = logger.records.find((r) => r.fields['decision'] === 'permitted');
    expect(decision?.level).toBe('debug');
    expect(decision?.fields['principal']).toBe('test.granted');
    expect(decision?.fields['permission']).toBe(Permission.CONFIG_WRITE);
    expect(decision?.fields['operation']).toBe('mcp.config_set');
  });

  it('logs the operation and the missing permission when it denies — AC-15', async () => {
    const logger = new RecordingLogger();
    const guard = createToolGuard({ principal: UNGRANTED, logger });

    const result = await guard('config_set', Permission.CONFIG_WRITE, () =>
      Promise.resolve({ reached: true }),
    );

    expect(result.isError).toBe(true);
    const denial = logger.records.find((r) => r.fields['decision'] === 'denied');
    expect(denial).toBeDefined();
    expect(denial?.fields['permission']).toBe(Permission.CONFIG_WRITE);
    expect(denial?.fields['operation']).toBe('mcp.config_set');
    expect(denial?.fields['principal']).toBe('test.ungranted');
  });

  it('does not log a decision as permitted when it denied', async () => {
    // The failure that would make AC-13 worse than nothing: a decision line
    // written before the check, so every denial also reads as a grant.
    const logger = new RecordingLogger();
    const guard = createToolGuard({ principal: UNGRANTED, logger });

    await guard('config_set', Permission.CONFIG_WRITE, () => Promise.resolve({}));

    expect(logger.records.some((r) => r.fields['decision'] === 'permitted')).toBe(false);
  });

  it('carries no durable identifier and no audit-event shape — AC-18', () => {
    const logger = new RecordingLogger();
    const guard = createToolGuard({ principal: GRANTED, logger });

    return guard('config_set', Permission.CONFIG_WRITE, () => Promise.resolve({})).then(() => {
      for (const record of logger.records) {
        // EPIC-085 owns durable events. A log line that grew an `eventId` or a
        // `sequence` would be one being read as a compliance artefact.
        expect(record.fields).not.toHaveProperty('eventId');
        expect(record.fields).not.toHaveProperty('auditId');
        expect(record.fields).not.toHaveProperty('sequence');
      }
    });
  });
});

describe('a confirmation request and consume are logged — AC-14', () => {
  it('logs the request when no token is presented', async () => {
    const logger = new RecordingLogger();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({ principal: GRANTED, logger, confirmations: gate });

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(planFor('logLevel')),
      undefined,
      () => Promise.resolve({ applied: true }),
    );

    const requested = logger.records.find((r) => r.fields['phase'] === 'requested');
    expect(requested?.level).toBe('debug');
    expect(requested?.fields['operation']).toBe('mcp.config_set');
    expect(requested?.fields['effects']).toBe(1);
  });

  it('logs the consume when a token is presented', async () => {
    const logger = new RecordingLogger();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({ principal: GRANTED, logger, confirmations: gate });
    const plan = planFor('logLevel');
    const token = gate.request(plan).token;

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(plan),
      token,
      () => Promise.resolve({ applied: true }),
    );

    expect(logger.records.find((r) => r.fields['phase'] === 'consumed')).toBeDefined();
  });

  it('never logs the token itself', async () => {
    // The token authorises the change. Printing it to stderr would put it in a
    // CI transcript, where anything that reads the transcript could spend it.
    const logger = new RecordingLogger();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({ principal: GRANTED, logger, confirmations: gate });
    const plan = planFor('logLevel');
    const token = gate.request(plan).token;

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(plan),
      token,
      () => Promise.resolve({ applied: true }),
    );

    expect(JSON.stringify(logger.records)).not.toContain(token);
  });

  it('logs nothing about a plan a denied caller never received', async () => {
    // EPIC-069's ordering, restated as a logging property: the permission is
    // checked before `plan` is built, so a refused caller produces no
    // confirmation record at all — there was no plan to have one about.
    const logger = new RecordingLogger();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({ principal: UNGRANTED, logger, confirmations: gate });

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(planFor('logLevel')),
      undefined,
      () => Promise.resolve({}),
    );

    expect(logger.records.some((r) => r.fields['phase'] !== undefined)).toBe(false);
  });
});

/**
 * **A refused confirmation is not a consumed one — F-88.**
 *
 * The `CONFIRMATION` event was written before `consume()` ran, with
 * `outcome: PERMITTED` and `reason: 'consumed'` hard-coded. So every refusal the
 * gate exists to make — an absent token, an expired one, a spent one, one issued
 * for a different plan — was journalled as a confirmation that had been
 * consumed. The journal said the opposite of what happened, which is worse than
 * having no journal: an operator reading it would conclude the change was
 * authorised.
 *
 * Latent until now only because F-63 left `audit` undefined on every production
 * path. Wiring the writer without this fix would have turned a dormant defect
 * into a live one, which is the wrong order to find out.
 */
describe('the confirmation audit event records what happened — F-88', () => {
  /**
   * A real `AuditWriter` on a throwaway path.
   *
   * `GuardDependencies.audit` is the concrete class, and a stub shaped like it
   * would be a production type loosened for a test's convenience. The events are
   * read back through `readAuditEvents`, which is the reader an operator uses,
   * so this asserts the bytes that actually land rather than a call argument.
   */
  function recorder(): { path: string; audit: AuditWriter } {
    const directory = mkdtempSync(join(tmpdir(), 'ferret-f88-'));
    directories.push(directory);
    const path = auditEventsPath(directory);
    return { path, audit: new AuditWriter({ path, invocation: 'f88f88f88f88f88f', agent: 'ferret/test' }) };
  }

  function confirmationEvents(path: string): readonly AuditEvent[] {
    return readAuditEvents(path).filter((one) => one.category === 'confirmation');
  }

  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('journals a refused token as denied, not as consumed', async () => {
    const { path, audit } = recorder();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({
      principal: GRANTED,
      logger: new RecordingLogger(),
      confirmations: gate,
      audit,
    });

    // The guard catches and converts to an error *result* rather than throwing —
    // that is the MCP contract, and asserting a rejection here would be testing
    // the wrong mechanism.
    const refused = await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(planFor('logLevel')),
      'not-a-token-this-gate-ever-issued',
      () => Promise.resolve({ applied: true }),
    );
    expect(refused.isError, 'a bad token was accepted').toBe(true);

    const confirmation = confirmationEvents(path);
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]?.outcome, 'a refused token was journalled as permitted').toBe('denied');
    expect(confirmation[0]?.reason).toBe('refused');
  });

  it('journals the first half of the two-step flow as required, not consumed', async () => {
    // No token is not a caller error — it is how the flow starts. It is still
    // not a consumed confirmation, and nothing was permitted to proceed.
    const { path, audit } = recorder();
    const guard = createDestructiveToolGuard({
      principal: GRANTED,
      logger: new RecordingLogger(),
      confirmations: new ConfirmationGate(),
      audit,
    });

    const required = await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(planFor('logLevel')),
      undefined,
      () => Promise.resolve({ applied: true }),
    );
    expect(required.isError).toBe(true);

    const confirmation = confirmationEvents(path);
    expect(confirmation[0]?.outcome).toBe('denied');
    expect(confirmation[0]?.reason).toBe('required');
  });

  it('journals a genuine consume as permitted — the control', async () => {
    // Without this the fix is unfalsifiable: an event that is always `denied`
    // is as useless as one that is always `permitted`.
    const { path, audit } = recorder();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({
      principal: GRANTED,
      logger: new RecordingLogger(),
      confirmations: gate,
      audit,
    });
    const plan = planFor('logLevel');
    const token = gate.request(plan).token;

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(plan),
      token,
      () => Promise.resolve({ applied: true }),
    );

    const confirmation = confirmationEvents(path);
    expect(confirmation[0]?.outcome).toBe('permitted');
    expect(confirmation[0]?.reason).toBe('consumed');
  });

  it('never writes the token into the event', async () => {
    const { path, audit } = recorder();
    const gate = new ConfirmationGate();
    const guard = createDestructiveToolGuard({
      principal: GRANTED,
      logger: new RecordingLogger(),
      confirmations: gate,
      audit,
    });
    const plan = planFor('logLevel');
    const token = gate.request(plan).token;

    await guard(
      'config_set',
      Permission.CONFIG_WRITE,
      () => Promise.resolve(plan),
      token,
      () => Promise.resolve({ applied: true }),
    );

    expect(readFileSync(path, 'utf8')).not.toContain(token);
  });
});
