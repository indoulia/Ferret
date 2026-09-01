import { describe, expect, it } from 'vitest';

import {
  ConfirmationGate,
  EffectChange,
  Permission,
  type OperationPlan,
  type Principal,
} from '../../src/authorization/index.js';
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
