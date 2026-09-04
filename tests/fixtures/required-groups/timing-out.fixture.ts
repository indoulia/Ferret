import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Stands in for `packaging.test.ts`: a group whose assertions all depend on one
 * expensive file-scope hook.
 *
 * The hook blocks the event loop rather than awaiting a timer, because that is
 * the shape the defect has — `execFileSync` cannot be interrupted, so Vitest
 * discovers the overrun only after the hook returns and can do nothing with it
 * but fail the module and mark the tests skipped. An asynchronous sleep
 * reproduces the same report but not the same mechanism.
 */
const blockFor = Number(process.env['FERRET_FIXTURE_HOOK_MS'] ?? '4000');

let prepared = false;

beforeAll(() => {
  const end = Date.now() + blockFor;
  while (Date.now() < end) {
    /* deliberately synchronous */
  }
  prepared = true;
}, 1_000);

describe('a required group', () => {
  it('asserts something the gate depends on', () => {
    expect(prepared).toBe(true);
  });

  it('asserts a second thing the gate depends on', () => {
    expect(prepared).toBe(true);
  });
});
