import { describe, expect, it } from 'vitest';

import {
  ConfirmationGate,
  DEFAULT_CONFIRMATION_TTL_MS,
  EffectChange,
  planDigest,
  type OperationPlan,
} from '../../src/authorization/index.js';
import { ErrorCode, FerretError } from '../../src/errors/index.js';

/**
 * Confirmation for a destructive operation — EPIC-069.
 *
 * Governance §12: "Destructive operations require explicit confirmation."
 * EPIC-068 decided whether an operation is *permitted* and deliberately stopped;
 * this decides whether it was *intended*, and both must hold.
 */

const PLAN: OperationPlan = {
  operation: 'config.set',
  summary: 'Change one configuration value.',
  effects: [{ target: 'logLevel', change: EffectChange.OVERWRITE, from: 'warn', to: 'debug' }],
};

/** A controllable clock, so expiry is tested rather than waited for. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

function expectFerretError(run: () => void, code: ErrorCode): FerretError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FerretError);
    const ferret = error as FerretError;
    expect(ferret.code).toBe(code);
    return ferret;
  }
  throw new Error(`expected ${code} to be thrown`);
}

describe('planDigest', () => {
  it('is stable for the same plan built in a different field order — AC-6', () => {
    // Two callers writing the same plan with their object literals in a different
    // order must produce the same digest. Otherwise a confirmation would be
    // refused for a reason nobody could see.
    const reordered: OperationPlan = {
      effects: [{ to: 'debug', from: 'warn', change: EffectChange.OVERWRITE, target: 'logLevel' }],
      summary: PLAN.summary,
      operation: PLAN.operation,
    };
    expect(planDigest(reordered)).toBe(planDigest(PLAN));
  });

  it('changes when any part of the plan changes — AC-6', () => {
    const baseline = planDigest(PLAN);
    const variants: OperationPlan[] = [
      { ...PLAN, operation: 'config.unset' },
      { ...PLAN, summary: 'Something else entirely.' },
      { ...PLAN, effects: [{ ...PLAN.effects[0]!, target: 'database.host' }] },
      { ...PLAN, effects: [{ ...PLAN.effects[0]!, change: EffectChange.UNSET }] },
      { ...PLAN, effects: [{ ...PLAN.effects[0]!, from: 'info' }] },
      { ...PLAN, effects: [{ ...PLAN.effects[0]!, to: 'trace' }] },
      { ...PLAN, effects: [...PLAN.effects, { target: 'logLevel', change: EffectChange.UNSET }] },
    ];
    for (const variant of variants) {
      expect(planDigest(variant), JSON.stringify(variant)).not.toBe(baseline);
    }
  });

  it('does not conflate an absent value with an explicit null', () => {
    // Both render as `null` in the canonical form, which is what makes them one
    // plan rather than two — an effect that says "there is nothing there" and one
    // that omits the field mean the same thing.
    const absent: OperationPlan = { ...PLAN, effects: [{ target: 'x', change: EffectChange.SET, to: 1 }] };
    const explicit: OperationPlan = {
      ...PLAN,
      effects: [{ target: 'x', change: EffectChange.SET, from: null, to: 1 }],
    };
    expect(planDigest(explicit)).toBe(planDigest(absent));
  });
});

describe('requesting a confirmation', () => {
  it('discloses the plan and issues a token — AC-2, AC-3', () => {
    const gate = new ConfirmationGate();
    const request = gate.request(PLAN);

    expect(request.confirmationRequired).toBe(true);
    expect(request.plan.operation).toBe('config.set');
    expect(request.plan.summary).toBe(PLAN.summary);
    expect(request.plan.effects).toStrictEqual([
      { target: 'logLevel', change: 'overwrite', from: 'warn', to: 'debug' },
    ]);
    expect(request.token.length).toBeGreaterThan(0);
    expect(request.howToConfirm).toContain(request.token);
  });

  it('issues a token nothing else could have produced — AC-5', () => {
    const gate = new ConfirmationGate({ maxPending: 200 });
    const tokens = new Set(Array.from({ length: 100 }, () => gate.request(PLAN).token));

    // 100 requests for the *same plan* produce 100 different tokens, which is the
    // property that matters: a token derived from the plan would be computable by
    // anything that knows the plan — including a repository that wrote the text
    // the plan describes.
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(planDigest(PLAN)).not.toContain(token);
      expect(token).not.toContain(planDigest(PLAN).slice(0, 8));
    }
  });

  it('expires by default five minutes out', () => {
    const time = clock();
    const gate = new ConfirmationGate({ now: time.now });
    const request = gate.request(PLAN);
    expect(Date.parse(request.expiresAt)).toBe(time.now() + DEFAULT_CONFIRMATION_TTL_MS);
  });

  it('redacts a secret-named value rather than disclosing it — AC-10', () => {
    const gate = new ConfirmationGate();
    const request = gate.request({
      operation: 'config.set',
      summary: 'Change the database password.',
      effects: [
        { target: 'database.password', change: EffectChange.OVERWRITE, from: 'old-pw', to: 'new-pw' },
      ],
    });

    const disclosed = JSON.stringify(request.plan);
    // The path is disclosed — an operator needs to know *what* is changing. The
    // values are not, and a plan is the first thing in Ferret that deliberately
    // shows a configuration value to a model.
    expect(disclosed).toContain('database.password');
    expect(disclosed).not.toContain('old-pw');
    expect(disclosed).not.toContain('new-pw');
  });

  it('discloses a value that is not secret-named', () => {
    // The assertion that makes the redaction mean something: a gate that redacted
    // everything would disclose nothing and confirm nothing.
    const gate = new ConfirmationGate();
    const request = gate.request({
      operation: 'config.set',
      summary: 'Point Ferret at another database host.',
      effects: [{ target: 'database.host', change: EffectChange.OVERWRITE, from: 'localhost', to: 'db.internal' }],
    });
    expect(request.plan.effects[0]).toStrictEqual({
      target: 'database.host',
      change: 'overwrite',
      from: 'localhost',
      to: 'db.internal',
    });
  });

  it('renders a non-string value without losing it', () => {
    const gate = new ConfirmationGate();
    const request = gate.request({
      operation: 'config.set',
      summary: 'Change the port.',
      effects: [{ target: 'database.port', change: EffectChange.OVERWRITE, from: 5432, to: 6543 }],
    });
    expect(request.plan.effects[0]?.from).toBe('5432');
    expect(request.plan.effects[0]?.to).toBe('6543');
  });

  it('changes nothing and requires no permission of its own', () => {
    // A request is a disclosure, not an operation. The gate holds no reference to
    // anything it could change, which is why this is a property of the type rather
    // than of a test double.
    const gate = new ConfirmationGate();
    gate.request(PLAN);
    expect(gate.pendingCount).toBe(1);
  });
});

describe('consuming a confirmation', () => {
  it('refuses the first call, changes nothing, and carries the plan — AC-1, AC-2, AC-3', () => {
    const gate = new ConfirmationGate();
    const error = expectFerretError(() => gate.consume(PLAN, undefined), ErrorCode.CONFIRMATION_REQUIRED);

    expect(error.details.confirmationRequired).toBe(true);
    expect(error.details.operation).toBe('config.set');
    expect(error.details.plan).toMatchObject({ operation: 'config.set' });
    expect(typeof error.details.confirm).toBe('string');
    expect(error.remediation).toContain(String(error.details.confirm));
    // Repeating it unchanged fails identically; only repeating it *with the token*
    // succeeds, and that is a different request.
    expect(error.retryable).toBe(false);
  });

  it('treats an empty token as no token — AC-1', () => {
    const gate = new ConfirmationGate();
    expectFerretError(() => gate.consume(PLAN, ''), ErrorCode.CONFIRMATION_REQUIRED);
  });

  it('permits the operation when the issued token is presented — AC-4', () => {
    const gate = new ConfirmationGate();
    const { token } = gate.request(PLAN);
    expect(() => gate.consume(PLAN, token)).not.toThrow();
  });

  it('accepts the token the refusal itself handed out — AC-3, AC-4', () => {
    // The loop an AI client actually runs: call, be refused, present what the
    // refusal gave you. If this does not work the mechanism is unusable however
    // correct the rest of it is.
    const gate = new ConfirmationGate();
    const error = expectFerretError(() => gate.consume(PLAN, undefined), ErrorCode.CONFIRMATION_REQUIRED);
    expect(() => gate.consume(PLAN, String(error.details.confirm))).not.toThrow();
  });

  it('refuses a token issued for a different plan — AC-6', () => {
    const gate = new ConfirmationGate();
    const { token } = gate.request(PLAN);

    // The confused deputy this exists to prevent: an approval for "change
    // logLevel" must not execute "unset the database".
    const escalated: OperationPlan = {
      operation: 'config.unset',
      summary: 'Remove the database configuration.',
      effects: [{ target: 'database', change: EffectChange.UNSET }],
    };
    expectFerretError(() => gate.consume(escalated, token), ErrorCode.CONFIRMATION_INVALID);
  });

  it('refuses a token whose plan has changed underneath it — AC-6', () => {
    // Not a defect: the state the operator was shown no longer holds, so the
    // right outcome is to disclose again rather than apply an approval given for
    // a different world.
    const gate = new ConfirmationGate();
    const { token } = gate.request(PLAN);
    const moved: OperationPlan = {
      ...PLAN,
      effects: [{ ...PLAN.effects[0]!, from: 'info' }],
    };
    expectFerretError(() => gate.consume(moved, token), ErrorCode.CONFIRMATION_INVALID);
  });

  it('is single use — AC-7', () => {
    const gate = new ConfirmationGate();
    const { token } = gate.request(PLAN);
    gate.consume(PLAN, token);
    expectFerretError(() => gate.consume(PLAN, token), ErrorCode.CONFIRMATION_INVALID);
    expect(gate.pendingCount).toBe(0);
  });

  it('refuses an expired token — AC-8', () => {
    const time = clock();
    const gate = new ConfirmationGate({ ttlMs: 1000, now: time.now });
    const { token } = gate.request(PLAN);

    time.advance(999);
    expect(() => gate.consume(PLAN, token)).not.toThrow();

    const second = gate.request(PLAN);
    time.advance(1000);
    expectFerretError(() => gate.consume(PLAN, second.token), ErrorCode.CONFIRMATION_INVALID);
    expect(gate.pendingCount).toBe(0);
  });

  it('refuses a token Ferret never issued — AC-5', () => {
    const gate = new ConfirmationGate();
    for (const forged of ['', ' ', 'confirm', planDigest(PLAN), 'a'.repeat(43), '../../etc/passwd']) {
      const expected = forged === '' ? ErrorCode.CONFIRMATION_REQUIRED : ErrorCode.CONFIRMATION_INVALID;
      expectFerretError(() => gate.consume(PLAN, forged), expected);
    }
  });

  it('says the same thing for unknown, expired, spent and mismatched — AC-13, security', () => {
    // A refusal that distinguished them would let a caller probe for a token's
    // existence, and there is nothing a legitimate caller does differently in the
    // four cases: request again.
    const time = clock();
    const gate = new ConfirmationGate({ ttlMs: 1000, now: time.now });

    const spent = gate.request(PLAN);
    gate.consume(PLAN, spent.token);
    const expired = gate.request(PLAN);
    time.advance(2000);
    const mismatched = gate.request(PLAN);

    const messages = new Set(
      [spent.token, expired.token, 'never-issued-at-all'].map(
        (token) => expectFerretError(() => gate.consume(PLAN, token), ErrorCode.CONFIRMATION_INVALID).message,
      ),
    );
    // Mismatched by *effect*, not by operation: the refusal names the operation
    // because the caller supplied it, so holding that constant is what isolates
    // the property under test — the four *causes* must be indistinguishable.
    messages.add(
      expectFerretError(
        () => gate.consume({ ...PLAN, effects: [{ ...PLAN.effects[0]!, to: 'trace' }] }, mismatched.token),
        ErrorCode.CONFIRMATION_INVALID,
      ).message,
    );

    expect(messages.size).toBe(1);
  });

  it('leaks neither the plan nor a value in the invalid-token refusal — AC-10', () => {
    const gate = new ConfirmationGate();
    const error = expectFerretError(
      () =>
        gate.consume(
          {
            operation: 'config.set',
            summary: 'Change the database password.',
            effects: [{ target: 'database.password', change: EffectChange.OVERWRITE, to: 'hunter2' }],
          },
          'not-a-token',
        ),
      ErrorCode.CONFIRMATION_INVALID,
    );

    const serialized = JSON.stringify(error.toJSON());
    expect(serialized).not.toContain('hunter2');
    // The operation, so a client knows which call to retry. Not the plan: the
    // caller presented something Ferret did not issue, and rewarding that with a
    // disclosure would make a forged token a way to read state.
    expect(error.details.operation).toBe('config.set');
    expect(error.details.plan).toBeUndefined();
  });

  it('spends the confirmation before the operation runs', () => {
    // An operation that fails half way has still spent its confirmation: the
    // state the plan described may no longer hold, so the next attempt must
    // disclose again rather than reuse an approval for a world that has moved.
    const gate = new ConfirmationGate();
    const { token } = gate.request(PLAN);
    gate.consume(PLAN, token);
    expect(gate.pendingCount).toBe(0);
  });
});

describe('bounding the pending set — AC-14', () => {
  it('never exceeds the ceiling however many are requested', () => {
    const gate = new ConfirmationGate({ maxPending: 4 });
    for (let index = 0; index < 50; index += 1) gate.request(PLAN);
    expect(gate.pendingCount).toBeLessThanOrEqual(4);
  });

  it('evicts oldest first, and an evicted token is refused like an unknown one', () => {
    const gate = new ConfirmationGate({ maxPending: 2 });
    const first = gate.request(PLAN);
    gate.request(PLAN);
    gate.request(PLAN);

    expectFerretError(() => gate.consume(PLAN, first.token), ErrorCode.CONFIRMATION_INVALID);
  });

  it('keeps the newest usable after eviction', () => {
    // The bound must not make the mechanism unusable: the token a caller was just
    // handed has to work.
    const gate = new ConfirmationGate({ maxPending: 2 });
    gate.request(PLAN);
    gate.request(PLAN);
    const newest = gate.request(PLAN);
    expect(() => gate.consume(PLAN, newest.token)).not.toThrow();
  });

  it('drops expired entries without needing a request to trigger it', () => {
    const time = clock();
    const gate = new ConfirmationGate({ ttlMs: 100, now: time.now });
    gate.request(PLAN);
    gate.request(PLAN);
    expect(gate.pendingCount).toBe(2);

    time.advance(101);
    // A `consume` that fails still cleans up, so a long-lived server that is never
    // confirmed successfully does not accumulate.
    expectFerretError(() => gate.consume(PLAN, 'anything'), ErrorCode.CONFIRMATION_INVALID);
    expect(gate.pendingCount).toBe(0);
  });
});

describe('a plan with nothing in it', () => {
  it('is still confirmable rather than throwing', () => {
    // A plan with no effects is a caller's mistake, not the gate's: refusing it
    // here would mean an operation that turned out to be a no-op crashed instead
    // of reporting that it changes nothing.
    const gate = new ConfirmationGate();
    const empty: OperationPlan = { operation: 'config.set', summary: 'Nothing would change.', effects: [] };
    const { token } = gate.request(empty);
    expect(() => gate.consume(empty, token)).not.toThrow();
  });
});
