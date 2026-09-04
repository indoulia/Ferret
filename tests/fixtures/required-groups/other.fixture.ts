import { describe, expect, it } from 'vitest';

/** An unrelated group, so a *filtered* run of this fixture project is possible. */
describe('an ordinary group', () => {
  it('passes', () => {
    expect(1).toBe(1);
  });
});
