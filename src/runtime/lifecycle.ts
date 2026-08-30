/**
 * Runtime lifecycle states.
 *
 * ```text
 * created ──initialize()──▶ initializing ──▶ ready ──shutdown()──▶ stopping ──▶ stopped
 *                               │                                     │
 *                               └──────────── failed ◀────────────────┘
 * ```
 *
 * `stopped` and `failed` are terminal: a runtime instance is used once. A new
 * instance is cheap, and forbidding restart removes a class of half-restored
 * state bugs.
 */
export const RuntimeState = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;

export type RuntimeState = (typeof RuntimeState)[keyof typeof RuntimeState];

const TRANSITIONS: Readonly<Record<RuntimeState, readonly RuntimeState[]>> = {
  [RuntimeState.CREATED]: [RuntimeState.INITIALIZING, RuntimeState.STOPPED],
  [RuntimeState.INITIALIZING]: [RuntimeState.READY, RuntimeState.FAILED],
  [RuntimeState.READY]: [RuntimeState.STOPPING],
  [RuntimeState.STOPPING]: [RuntimeState.STOPPED, RuntimeState.FAILED],
  [RuntimeState.STOPPED]: [],
  [RuntimeState.FAILED]: [],
};

export function canTransition(from: RuntimeState, to: RuntimeState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: RuntimeState): boolean {
  return state === RuntimeState.STOPPED || state === RuntimeState.FAILED;
}
